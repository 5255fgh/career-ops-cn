import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  BridgeErrorResponseSchema,
  DecisionResponseSchema,
  DiagnosticEventSchema,
  DiagnosticListResponseSchema,
  EvaluationResultSchema,
  HealthResponseSchema,
  JobListResponseSchema,
  JobResponseSchema,
  ScreenResponseSchema,
  type CreateJobRequest,
  type JobCard,
  type Preferences,
} from "@career-ops-cn/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BRIDGE_HOST, createBridge, startBridge } from "../src/app.js";
import { DEFAULT_BRIDGE_PORT, readBridgeConfig } from "../src/config.js";
import type { Evaluator, ScreenJob } from "../src/dependencies.js";

const PREFERENCES: Preferences = {
  location: { allowed: ["上海"] },
  salary: { minimum: 20_000, period: "month" },
  company: { blocklist: ["风险公司"] },
  keyword: { blocklist: ["外包"], warning: ["大小周"] },
  skill: { requiredAny: ["TypeScript"] },
  jd: { minimumLength: 20 },
};

const TEST_ENVIRONMENT = {
  CAREER_OPS_CN_TOKEN: "test-token",
  CAREER_OPS_CN_CAREER_OPS_ROOT: "D:\\career-ops-test",
  CAREER_OPS_CN_PREFERENCES: JSON.stringify(PREFERENCES),
  CAREER_OPS_CN_EVALUATION_TIMEOUT_MS: "5000",
} satisfies NodeJS.ProcessEnv;

const AUTHORIZATION = {
  authorization: "Bearer test-token",
};

const EXTENSION_ORIGIN = `chrome-extension://${"a".repeat(32)}`;

const JOB: CreateJobRequest = {
  source: "boss",
  sourceJobId: "123456789",
  title: "前端开发工程师",
  company: "示例科技",
  salary: "20-30K·14薪",
  location: "上海·浦东新区",
  experience: "3-5年",
  education: "本科",
  description:
    "负责招聘产品的前端功能开发与维护，要求熟悉 TypeScript 和 React。",
  url: "https://www.zhipin.com/job_detail/123456789.html",
  identityVerified: true,
};

const JOB_CARD: JobCard = {
  jobId: "123456789",
  title: "前端开发工程师",
  companyName: "示例科技",
  salaryText: "20-30K·14薪",
  location: "上海·浦东新区",
  experienceText: "3-5年",
  educationText: "本科",
  detailUrl: "https://www.zhipin.com/job_detail/123456789.html",
};

const PASS_SCREEN_JOB: ScreenJob = () => ({
  decision: "pass",
  rules: [{ decision: "pass", reason: "通过全部硬规则" }],
});

const cleanupTasks: Array<() => Promise<void>> = [];

async function createTempDatabase(): Promise<{
  database: DatabaseSync;
  path: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "career-ops-cn-bridge-"));
  const path = join(directory, "bridge.sqlite");
  const database = new DatabaseSync(path);

  cleanupTasks.push(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  return { database, path };
}

async function createTempDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "career-ops-cn-path-"));
  cleanupTasks.push(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return join(directory, "bridge.sqlite");
}

async function postJob(
  bridge: ReturnType<typeof createBridge>,
  job: object = JOB,
) {
  const response = await bridge.inject({
    method: "POST",
    url: "/jobs",
    headers: AUTHORIZATION,
    payload: job,
  });
  expect(response.statusCode).toBe(200);
  return JobResponseSchema.parse(response.json());
}

afterEach(async () => {
  await Promise.all(cleanupTasks.splice(0).map((cleanup) => cleanup()));
});

describe("Bridge 健康、认证与 CORS", () => {
  it("health 无需 token，并创建业务表与 diagnostics 表", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const response = await bridge.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
      expect(HealthResponseSchema.parse(response.json())).toEqual({
        status: "ok",
      });

      const tables = database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map(({ name }) => name)).toEqual([
        "decisions",
        "diagnostics",
        "evaluations",
        "jobs",
      ]);
    } finally {
      await bridge.close();
    }
  });

  it("拒绝无 token 的业务请求，并只为扩展 origin 返回 CORS 许可", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const unauthorized = await bridge.inject({
        method: "GET",
        url: "/jobs",
      });
      expect(unauthorized.statusCode).toBe(401);
      expect(BridgeErrorResponseSchema.parse(unauthorized.json())).toEqual({
        error: "UNAUTHORIZED",
      });

      const allowed = await bridge.inject({
        method: "OPTIONS",
        url: "/jobs",
        headers: { origin: EXTENSION_ORIGIN },
      });
      expect(allowed.statusCode).toBe(204);
      expect(allowed.headers["access-control-allow-origin"]).toBe(
        EXTENSION_ORIGIN,
      );
      expect(allowed.headers["access-control-allow-headers"]).toContain(
        "Authorization",
      );

      const website = await bridge.inject({
        method: "OPTIONS",
        url: "/jobs",
        headers: { origin: "https://example.com" },
      });
      expect(website.statusCode).toBe(204);
      expect(website.headers["access-control-allow-origin"]).toBeUndefined();

      const websiteRequest = await bridge.inject({
        method: "GET",
        url: "/jobs",
        headers: {
          ...AUTHORIZATION,
          origin: "https://example.com",
        },
      });
      expect(websiteRequest.statusCode).toBe(401);
    } finally {
      await bridge.close();
    }
  });
});

describe("screen", () => {
  it("把每个 JobCard 和 Preferences 交给注入的 screenJob", async () => {
    const { database } = await createTempDatabase();
    const screenJob = vi.fn<ScreenJob>((job, preferences) => ({
      decision: preferences.skill?.requiredAny?.includes("TypeScript")
        ? "pass"
        : "block",
      rules: [{ decision: "pass", reason: "命中 TypeScript" }],
    }));
    const bridge = createBridge({
      environment: TEST_ENVIRONMENT,
      database,
      screenJob,
    });

    try {
      const response = await bridge.inject({
        method: "POST",
        url: "/screen",
        headers: AUTHORIZATION,
        payload: { jobs: [JOB_CARD] },
      });
      expect(response.statusCode).toBe(200);
      expect(ScreenResponseSchema.parse(response.json())).toEqual([
        {
          jobId: JOB_CARD.jobId,
          matched: true,
          reasons: ["命中 TypeScript"],
        },
      ]);
      expect(screenJob).toHaveBeenCalledWith(
        {
          title: JOB_CARD.title,
          companyName: JOB_CARD.companyName,
          salaryText: JOB_CARD.salaryText,
          location: JOB_CARD.location,
          description: "",
        },
        PREFERENCES,
      );
    } finally {
      await bridge.close();
    }
  });

  it("review 属于非 block，允许进入详情 Top N", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({
      environment: TEST_ENVIRONMENT,
      database,
      screenJob: () => ({
        decision: "review",
        rules: [{ decision: "warning", reason: "需要人工复核" }],
      }),
    });

    try {
      const response = await bridge.inject({
        method: "POST",
        url: "/screen",
        headers: AUTHORIZATION,
        payload: { jobs: [JOB_CARD] },
      });
      expect(ScreenResponseSchema.parse(response.json())).toEqual([
        {
          jobId: JOB_CARD.jobId,
          matched: true,
          reasons: ["需要人工复核"],
        },
      ]);
    } finally {
      await bridge.close();
    }
  });
});

describe("职位 upsert 与读取", () => {
  it("相同 sourceJobId 更新同一记录，并可通过列表和详情读取", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const first = await postJob(bridge);
      const second = await postJob(bridge, {
        ...JOB,
        title: "高级前端开发工程师",
      });
      expect(second.id).toBe(first.id);
      expect(second.title).toBe("高级前端开发工程师");

      const listResponse = await bridge.inject({
        method: "GET",
        url: "/jobs",
        headers: AUTHORIZATION,
      });
      expect(JobListResponseSchema.parse(listResponse.json())).toEqual([
        second,
      ]);

      const detailResponse = await bridge.inject({
        method: "GET",
        url: `/jobs/${first.id}`,
        headers: AUTHORIZATION,
      });
      expect(JobResponseSchema.parse(detailResponse.json())).toEqual(second);
      expect(
        database.prepare("SELECT count(*) AS count FROM jobs").get(),
      ).toEqual({ count: 1 });
    } finally {
      await bridge.close();
    }
  });

  it("sourceJobId 缺失时使用规范化 URL 去重", async () => {
    const { sourceJobId: _sourceJobId, ...withoutSourceJobId } = JOB;
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const first = await postJob(bridge, {
        ...withoutSourceJobId,
        url: `${JOB.url}?ka=search_list_jname#detail`,
      });
      const second = await postJob(bridge, {
        ...withoutSourceJobId,
        url: JOB.url,
        salary: "25-35K·14薪",
      });
      expect(second.id).toBe(first.id);
      expect(second.salary).toBe("25-35K·14薪");
      expect(
        database.prepare("SELECT count(*) AS count FROM jobs").get(),
      ).toEqual({ count: 1 });
    } finally {
      await bridge.close();
    }
  });

  it("公司名和标题相同只返回 possible duplicate，不自动合并", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const first = await postJob(bridge);
      const second = await postJob(bridge, {
        ...JOB,
        sourceJobId: "987654321",
        url: "https://www.zhipin.com/job_detail/987654321.html",
      });
      expect(second.id).not.toBe(first.id);
      expect(second.possibleDuplicate).toEqual({
        jobId: first.id,
        reason: "same_company_and_title",
      });
      expect(
        database.prepare("SELECT count(*) AS count FROM jobs").get(),
      ).toEqual({ count: 2 });
    } finally {
      await bridge.close();
    }
  });
});

describe("diagnostics", () => {
  it("Extension 可写入并按时间读取验收诊断", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const created = await bridge.inject({
        method: "POST",
        url: "/diagnostics",
        headers: AUTHORIZATION,
        payload: {
          source: "extension",
          level: "info",
          event: "detail_mapping",
          scanId: "scan-1",
          expectedJobId: "boss-a",
          actualJobId: "boss-a",
          outcome: "success",
        },
      });
      expect(created.statusCode).toBe(200);
      const diagnostic = DiagnosticEventSchema.parse(created.json());

      const response = await bridge.inject({
        method: "GET",
        url: "/diagnostics?limit=20",
        headers: AUTHORIZATION,
      });
      expect(response.statusCode).toBe(200);
      expect(DiagnosticListResponseSchema.parse(response.json())).toEqual([
        diagnostic,
      ]);
    } finally {
      await bridge.close();
    }
  });

  it("HTTP 接口拒绝伪造 Bridge 来源的诊断", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const response = await bridge.inject({
        method: "POST",
        url: "/diagnostics",
        headers: AUTHORIZATION,
        payload: {
          source: "bridge",
          level: "info",
          event: "forged",
        },
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await bridge.close();
    }
  });
});

describe("evaluate", () => {
  it("传入 JobDetail、配置与 AbortSignal，硬规则 block 强制 skip 并立即保存", async () => {
    const { database } = await createTempDatabase();
    const evaluator = vi.fn<Evaluator>(async (_job, _options) => ({
      score: 92,
      recommendation: "apply",
      rawReport: "命中硬规则，必须跳过。",
    }));
    const screenJob: ScreenJob = () => ({
      decision: "block",
      rules: [{ decision: "block", reason: "命中硬规则" }],
    });
    const bridge = createBridge({
      environment: TEST_ENVIRONMENT,
      database,
      evaluator,
      screenJob,
    });

    try {
      const job = await postJob(bridge);
      const response = await bridge.inject({
        method: "POST",
        url: `/jobs/${job.id}/evaluate`,
        headers: AUTHORIZATION,
      });
      expect(response.statusCode).toBe(200);
      const evaluation = EvaluationResultSchema.parse(response.json());
      expect(evaluation.recommendation).toBe("skip");

      expect(evaluator).toHaveBeenCalledOnce();
      const [detail, options] = evaluator.mock.calls[0] ?? [];
      expect(detail).toMatchObject({
        jobId: JOB.sourceJobId,
        description: JOB.description,
        identityVerified: true,
      });
      expect(options).toMatchObject({
        careerOpsRoot: TEST_ENVIRONMENT.CAREER_OPS_CN_CAREER_OPS_ROOT,
        timeoutMs: 5000,
      });
      expect(options?.signal).toBeInstanceOf(AbortSignal);

      expect(
        database
          .prepare(
            "SELECT job_id, recommendation FROM evaluations WHERE job_id = ?",
          )
          .get(job.id),
      ).toEqual({ job_id: job.id, recommendation: "skip" });
    } finally {
      await bridge.close();
    }
  });

  it("provider 网关持续失败时返回诊断 ID 并保存脱敏详情", async () => {
    const { database } = await createTempDatabase();
    const evaluator: Evaluator = async () => {
      throw Object.assign(new Error("provider HTTP 503"), {
        code: "UPSTREAM_UNAVAILABLE",
        httpStatus: 503,
        attempts: 3,
        diagnostic:
          "HTTP 503 Authorization: Bearer sk-THIS_IS_A_SYNTHETIC_TEST_KEY_NOT_VALID_000000",
      });
    };
    const bridge = createBridge({
      environment: TEST_ENVIRONMENT,
      database,
      evaluator,
      screenJob: PASS_SCREEN_JOB,
    });

    try {
      const job = await postJob(bridge);
      const response = await bridge.inject({
        method: "POST",
        url: `/jobs/${job.id}/evaluate`,
        headers: AUTHORIZATION,
      });
      expect(response.statusCode).toBe(502);
      const failure = BridgeErrorResponseSchema.parse(response.json());
      expect(failure).toMatchObject({
        error: "EVALUATION_FAILED",
        message: expect.stringContaining("HTTP 503"),
      });
      expect(failure.diagnosticId).toBeDefined();

      const diagnostics = DiagnosticListResponseSchema.parse(
        (
          await bridge.inject({
            method: "GET",
            url: "/diagnostics?limit=10",
            headers: AUTHORIZATION,
          })
        ).json(),
      );
      const diagnostic = diagnostics.find(
        (entry) => entry.id === failure.diagnosticId,
      );
      expect(diagnostic).toMatchObject({
        event: "evaluation_upstream_failed",
        details: { httpStatus: 503, attempts: 3 },
      });
      expect(JSON.stringify(diagnostic)).not.toContain(
        "sk-THIS_IS_A_SYNTHETIC_TEST_KEY_NOT_VALID_000000",
      );
    } finally {
      await bridge.close();
    }
  });

  it("identityVerified=false 时拒绝且不调用 evaluator", async () => {
    const { database } = await createTempDatabase();
    const evaluator = vi.fn<Evaluator>();
    const bridge = createBridge({
      environment: TEST_ENVIRONMENT,
      database,
      evaluator,
      screenJob: PASS_SCREEN_JOB,
    });

    try {
      const job = await postJob(bridge, { ...JOB, identityVerified: false });
      const response = await bridge.inject({
        method: "POST",
        url: `/jobs/${job.id}/evaluate`,
        headers: AUTHORIZATION,
      });
      expect(response.statusCode).toBe(422);
      expect(BridgeErrorResponseSchema.parse(response.json())).toEqual({
        error: "DETAIL_IDENTITY_UNVERIFIED",
      });
      expect(evaluator).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
    }
  });

  it("description 缺失时以 INVALID_JOB_DETAIL 拒绝", async () => {
    const { description: _description, ...withoutDescription } = JOB;
    const { database } = await createTempDatabase();
    const evaluator = vi.fn<Evaluator>();
    const bridge = createBridge({
      environment: TEST_ENVIRONMENT,
      database,
      evaluator,
      screenJob: PASS_SCREEN_JOB,
    });

    try {
      const job = await postJob(bridge, withoutDescription);
      const response = await bridge.inject({
        method: "POST",
        url: `/jobs/${job.id}/evaluate`,
        headers: AUTHORIZATION,
      });
      expect(response.statusCode).toBe(422);
      expect(BridgeErrorResponseSchema.parse(response.json())).toEqual({
        error: "INVALID_JOB_DETAIL",
      });
      expect(evaluator).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
    }
  });

  it("超时时中止 adapter 并返回 EVALUATION_TIMEOUT", async () => {
    const { database } = await createTempDatabase();
    const evaluator: Evaluator = async (_job, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    const bridge = createBridge({
      environment: {
        ...TEST_ENVIRONMENT,
        CAREER_OPS_CN_EVALUATION_TIMEOUT_MS: "10",
      },
      database,
      evaluator,
      screenJob: PASS_SCREEN_JOB,
    });

    try {
      const job = await postJob(bridge);
      const response = await bridge.inject({
        method: "POST",
        url: `/jobs/${job.id}/evaluate`,
        headers: AUTHORIZATION,
      });
      expect(response.statusCode).toBe(504);
      expect(BridgeErrorResponseSchema.parse(response.json())).toEqual({
        error: "EVALUATION_TIMEOUT",
      });
    } finally {
      await bridge.close();
    }
  });

  it("客户端中止时把取消传递给 adapter AbortSignal", async () => {
    const { database } = await createTempDatabase();
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let adapterSignal: AbortSignal | undefined;
    const evaluator: Evaluator = async (_job, { signal }) => {
      adapterSignal = signal;
      notifyStarted?.();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    };
    const bridge = await startBridge({
      environment: TEST_ENVIRONMENT,
      database,
      evaluator,
      screenJob: PASS_SCREEN_JOB,
      port: 0,
    });

    try {
      const address = bridge.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Bridge 未返回 TCP 地址。");
      }
      const baseUrl = `http://${BRIDGE_HOST}:${address.port}`;
      const createResponse = await fetch(`${baseUrl}/jobs`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(JOB),
      });
      const job = JobResponseSchema.parse(await createResponse.json());

      const clientController = new AbortController();
      const pending = fetch(`${baseUrl}/jobs/${job.id}/evaluate`, {
        method: "POST",
        headers: { Authorization: "Bearer test-token" },
        signal: clientController.signal,
      });
      await started;
      clientController.abort();
      await expect(pending).rejects.toThrow();

      await vi.waitFor(() => expect(adapterSignal?.aborted).toBe(true));
      expect(
        database.prepare("SELECT count(*) AS count FROM evaluations").get(),
      ).toEqual({ count: 0 });
    } finally {
      await bridge.close();
    }
  });
});

describe("decision 与持久化", () => {
  it("GET /jobs 返回最近评估与用户判断", async () => {
    const { database } = await createTempDatabase();
    const evaluator = vi.fn<Evaluator>(async () => ({
      score: 89,
      recommendation: "apply",
      rawReport: "完整评估报告",
      company: "示例科技",
      role: "前端开发工程师",
      archetype: "Builder",
      legitimacy: "high",
    }));
    const bridge = createBridge({
      environment: TEST_ENVIRONMENT,
      database,
      evaluator,
      screenJob: PASS_SCREEN_JOB,
    });

    try {
      const job = await postJob(bridge);
      const evaluation = await bridge.inject({
        method: "POST",
        url: `/jobs/${job.id}/evaluate`,
        headers: AUTHORIZATION,
      });
      expect(evaluation.statusCode).toBe(200);
      const decision = await bridge.inject({
        method: "POST",
        url: `/jobs/${job.id}/decision`,
        headers: AUTHORIZATION,
        payload: { decision: "apply" },
      });
      expect(decision.statusCode).toBe(200);

      const response = await bridge.inject({
        method: "GET",
        url: "/jobs",
        headers: AUTHORIZATION,
      });
      const [history] = JobListResponseSchema.parse(response.json());
      expect(history).toMatchObject({
        id: job.id,
        latestEvaluation: {
          score: 89,
          recommendation: "apply",
          archetype: "Builder",
          legitimacy: "high",
          rawReport: "完整评估报告",
        },
        decision: { jobId: job.id, decision: "apply" },
      });
    } finally {
      await bridge.close();
    }
  });

  it("对同一 job 幂等更新 decision", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const job = await postJob(bridge);
      const first = await bridge.inject({
        method: "POST",
        url: `/jobs/${job.id}/decision`,
        headers: AUTHORIZATION,
        payload: { decision: "apply", reason: "匹配目标" },
      });
      expect(first.statusCode).toBe(200);

      const second = await bridge.inject({
        method: "POST",
        url: `/jobs/${job.id}/decision`,
        headers: AUTHORIZATION,
        payload: { decision: "skip", outcome: "已人工确认" },
      });
      expect(DecisionResponseSchema.parse(second.json())).toEqual({
        jobId: job.id,
        decision: "skip",
        outcome: "已人工确认",
      });
      expect(
        database.prepare("SELECT count(*) AS count FROM decisions").get(),
      ).toEqual({ count: 1 });
    } finally {
      await bridge.close();
    }
  });

  it("Bridge 重启后职位仍存在", async () => {
    const databasePath = await createTempDatabasePath();
    const firstBridge = createBridge({
      environment: TEST_ENVIRONMENT,
      databasePath,
    });
    const saved = await postJob(firstBridge);
    await firstBridge.close();

    const secondBridge = createBridge({
      environment: TEST_ENVIRONMENT,
      databasePath,
    });
    try {
      const response = await secondBridge.inject({
        method: "GET",
        url: `/jobs/${saved.id}`,
        headers: AUTHORIZATION,
      });
      expect(response.statusCode).toBe(200);
      expect(JobResponseSchema.parse(response.json())).toEqual(saved);
    } finally {
      await secondBridge.close();
    }
  });
});

describe("Bridge 配置与监听", () => {
  it("缺少 token 或 careerOpsRoot 时拒绝，并使用默认端口 3847", () => {
    expect(() => readBridgeConfig({})).toThrow(/CAREER_OPS_CN_TOKEN/);
    expect(() =>
      readBridgeConfig({ CAREER_OPS_CN_TOKEN: "token" }),
    ).toThrow(/CAREER_OPS_CN_CAREER_OPS_ROOT/);
    expect(readBridgeConfig(TEST_ENVIRONMENT).port).toBe(
      DEFAULT_BRIDGE_PORT,
    );
  });

  it("固定监听 IPv4 回环地址", async () => {
    const { database } = await createTempDatabase();
    const bridge = await startBridge({
      environment: TEST_ENVIRONMENT,
      database,
      port: 0,
    });

    try {
      const address = bridge.server.address();
      expect(address).not.toBeNull();
      expect(typeof address).not.toBe("string");
      if (address === null || typeof address === "string") {
        throw new Error("Bridge 未返回 TCP 监听地址。");
      }
      expect(address.address).toBe(BRIDGE_HOST);
    } finally {
      await bridge.close();
    }
  });
});
