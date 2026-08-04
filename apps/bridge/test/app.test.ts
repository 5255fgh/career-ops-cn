import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  BridgeErrorResponseSchema,
  CandidateRecordSchema,
  DiagnosticEventSchema,
  DiagnosticListResponseSchema,
  EvaluationResponseSchema,
  EvaluationResultSchema,
  HealthResponseSchema,
  JobListResponseSchema,
  JobResponseSchema,
  LatestScanRunResponseSchema,
  ObserveJobsResponseSchema,
  ScanRunSchema,
  ScreenResponseSchema,
  type CreateJobRequest,
  type JobCard,
  type Preferences,
} from "@career-ops-cn/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BRIDGE_HOST, createBridge, startBridge } from "../src/app.js";
import { DEFAULT_BRIDGE_PORT, readBridgeConfig } from "../src/config.js";
import {
  createScanRun,
  initializeDatabase,
  updateScanRun,
} from "../src/database.js";
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
        "candidate_records",
        "diagnostics",
        "evaluations",
        "jobs",
        "scan_runs",
        "screenings",
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

describe("scan run 持久化", () => {
  it("创建、更新、查询并请求取消同一个 scan run", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const createdResponse = await bridge.inject({
        method: "POST",
        url: "/scan-runs",
        headers: AUTHORIZATION,
        payload: {},
      });
      expect(createdResponse.statusCode).toBe(200);
      const created = ScanRunSchema.parse(createdResponse.json());
      expect(created).toMatchObject({
        status: "running",
        phase: "starting",
        pageCount: 0,
      });

      const updatedResponse = await bridge.inject({
        method: "POST",
        url: `/scan-runs/${created.id}/progress`,
        headers: AUTHORIZATION,
        payload: {
          phase: "reading-details",
          pageCount: 2,
          discoveredCount: 18,
          newJobCount: 5,
          detailSuccessCount: 3,
          detailFailureCount: 1,
        },
      });
      expect(ScanRunSchema.parse(updatedResponse.json())).toMatchObject({
        id: created.id,
        status: "running",
        phase: "reading-details",
        pageCount: 2,
        discoveredCount: 18,
        newJobCount: 5,
        detailSuccessCount: 3,
        detailFailureCount: 1,
      });

      const latestResponse = await bridge.inject({
        method: "GET",
        url: "/scan-runs/latest",
        headers: AUTHORIZATION,
      });
      const latest = LatestScanRunResponseSchema.parse(latestResponse.json());
      expect(latest?.run).toMatchObject({
        id: created.id,
        pageCount: 2,
        discoveredCount: 18,
      });
      expect(latest?.jobs).toEqual([]);

      const cancelResponse = await bridge.inject({
        method: "POST",
        url: `/scan-runs/${created.id}/cancel`,
        headers: AUTHORIZATION,
        payload: {},
      });
      expect(ScanRunSchema.parse(cancelResponse.json()).cancelRequested).toBe(
        true,
      );

      const rejectedWork = await bridge.inject({
        method: "POST",
        url: "/jobs/observe",
        headers: AUTHORIZATION,
        payload: {
          scanRunId: created.id,
          sourceQuery: "boss:/web/geek/job?query=TypeScript",
          jobs: [JOB_CARD],
        },
      });
      expect(rejectedWork.statusCode).toBe(400);

      const finishedResponse = await bridge.inject({
        method: "POST",
        url: `/scan-runs/${created.id}/progress`,
        headers: AUTHORIZATION,
        payload: { status: "cancelled", stopReason: "user-requested" },
      });
      expect(ScanRunSchema.parse(finishedResponse.json())).toMatchObject({
        status: "cancelled",
        phase: "finished",
        finishedAt: expect.any(String),
      });
    } finally {
      await bridge.close();
    }
  });

  it("异常重启时把未完成任务标记为 interrupted 并保留进度", async () => {
    const databasePath = await createTempDatabasePath();
    const crashedDatabase = new DatabaseSync(databasePath);
    initializeDatabase(crashedDatabase);
    const running = createScanRun(crashedDatabase);
    updateScanRun(crashedDatabase, running.id, {
      phase: "reading-details",
      pageCount: 2,
      discoveredCount: 14,
      detailSuccessCount: 4,
      detailFailureCount: 2,
      errorSummary: "2 个职位详情失败。",
    });
    crashedDatabase.close();

    const restarted = createBridge({
      environment: TEST_ENVIRONMENT,
      databasePath,
    });
    try {
      const response = await restarted.inject({
        method: "GET",
        url: "/scan-runs/latest",
        headers: AUTHORIZATION,
      });
      const snapshot = LatestScanRunResponseSchema.parse(response.json());
      expect(snapshot?.run).toMatchObject({
        id: running.id,
        status: "interrupted",
        phase: "finished",
        pageCount: 2,
        discoveredCount: 14,
        detailSuccessCount: 4,
        detailFailureCount: 2,
        stopReason: "bridge-restarted",
      });
    } finally {
      await restarted.close();
    }
  });

  it("interrupted 终态仍合并浏览器侧最后完成的单调计数", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const created = ScanRunSchema.parse(
        (
          await bridge.inject({
            method: "POST",
            url: "/scan-runs",
            headers: AUTHORIZATION,
            payload: {},
          })
        ).json(),
      );
      const interrupted = ScanRunSchema.parse(
        (
          await bridge.inject({
            method: "POST",
            url: `/scan-runs/${created.id}/interrupted`,
            headers: AUTHORIZATION,
            payload: {
              reason: "side-panel-closed",
              errorSummary: "浏览器上下文已关闭。",
            },
          })
        ).json(),
      );

      const merged = ScanRunSchema.parse(
        (
          await bridge.inject({
            method: "POST",
            url: `/scan-runs/${created.id}/progress`,
            headers: AUTHORIZATION,
            payload: {
              status: "interrupted",
              pageCount: 2,
              discoveredCount: 14,
              detailSuccessCount: 4,
              stopReason: null,
            },
          })
        ).json(),
      );

      expect(merged).toMatchObject({
        status: "interrupted",
        pageCount: 2,
        discoveredCount: 14,
        detailSuccessCount: 4,
        stopReason: "side-panel-closed",
      });
      expect(merged.finishedAt).toBe(interrupted.finishedAt);
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
          reasons: [],
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
        "list",
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
  it("Extension 可写入并按时间读取扫描诊断", async () => {
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

  it("详情阶段把完整 JD 和 phase 交给硬规则筛选", async () => {
    const { database } = await createTempDatabase();
    const screenJob = vi.fn<ScreenJob>(() => ({
      decision: "pass",
      rules: [{ decision: "pass", reason: "详情规则通过" }],
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
        payload: {
          jobs: [
            {
              ...JOB_CARD,
              description: JOB.description,
              identityVerified: true,
            },
          ],
          phase: "detail",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(screenJob).toHaveBeenCalledWith(
        expect.objectContaining({ description: JOB.description }),
        PREFERENCES,
        "detail",
      );
      expect(ScreenResponseSchema.parse(response.json())[0]?.reasons).toEqual(
        [],
      );
    } finally {
      await bridge.close();
    }
  });

  it("重复出现时更新 last_seen/source_query，并在 run 快照中返回复用结果", async () => {
    const { database } = await createTempDatabase();
    const evaluator = vi.fn<Evaluator>(async () => ({
      score: 91,
      recommendation: "apply",
      rawReport: "可复用评估。",
    }));
    const bridge = createBridge({
      environment: TEST_ENVIRONMENT,
      database,
      evaluator,
      screenJob: PASS_SCREEN_JOB,
    });

    try {
      const run = ScanRunSchema.parse(
        (
          await bridge.inject({
            method: "POST",
            url: "/scan-runs",
            headers: AUTHORIZATION,
            payload: {},
          })
        ).json(),
      );
      const savedResponse = await bridge.inject({
        method: "POST",
        url: "/jobs",
        headers: AUTHORIZATION,
        payload: {
          ...JOB,
          scanRunId: run.id,
          sourceQuery: "boss:/web/geek/job?query=TypeScript",
        },
      });
      const saved = JobResponseSchema.parse(savedResponse.json());
      const evaluated = await bridge.inject({
        method: "POST",
        url: `/jobs/${saved.id}/evaluate`,
        headers: AUTHORIZATION,
        payload: { scanRunId: run.id },
      });
      expect(EvaluationResponseSchema.parse(evaluated.json()).cacheHit).toBe(
        false,
      );

      const observedResponse = await bridge.inject({
        method: "POST",
        url: "/jobs/observe",
        headers: AUTHORIZATION,
        payload: {
          scanRunId: run.id,
          sourceQuery: "boss:/web/geek/job?query=TypeScript&city=101020100",
          jobs: [JOB_CARD],
        },
      });
      const [observed] = ObserveJobsResponseSchema.parse(
        observedResponse.json(),
      );
      expect(observed).toMatchObject({
        sourceJobId: JOB_CARD.jobId,
        action: "reuse",
        cacheHit: true,
        evaluation: { score: 91 },
      });

      const snapshot = LatestScanRunResponseSchema.parse(
        (
          await bridge.inject({
            method: "GET",
            url: "/scan-runs/latest",
            headers: AUTHORIZATION,
          })
        ).json(),
      );
      expect(snapshot?.jobs).toHaveLength(1);
      expect(snapshot?.jobs[0]).toMatchObject({
        id: saved.id,
        lastScanRunId: run.id,
        sourceQuery:
          "boss:/web/geek/job?query=TypeScript&city=101020100",
        latestEvaluation: { score: 91 },
      });
      const restoredJob = snapshot?.jobs[0];
      if (restoredJob === undefined) {
        throw new Error("scan run 快照缺少已观察职位。");
      }
      expect(restoredJob.lastSeenAt >= saved.lastSeenAt).toBe(true);
      expect(evaluator).toHaveBeenCalledOnce();
    } finally {
      await bridge.close();
    }
  });

});

describe("evaluate", () => {
  it("相同 cache_key 直接复用，JD 变化后重新评估并保存元数据", async () => {
    const { database } = await createTempDatabase();
    const evaluator = vi.fn<Evaluator>(async (job) => ({
      score: job.description.includes("新版") ? 93 : 88,
      recommendation: "apply",
      rawReport: `评估：${job.description}`,
    }));
    const screenJob = vi.fn<ScreenJob>(PASS_SCREEN_JOB);
    const bridge = createBridge({
      environment: TEST_ENVIRONMENT,
      database,
      evaluator,
      screenJob,
    });

    try {
      const normalizedDescription = `${JOB.description}\n补充一行。`;
      const job = await postJob(bridge, {
        ...JOB,
        description: normalizedDescription.replace(/\n/gu, "\r\n"),
        url: `${JOB.url}?securityId=volatile-first`,
      });
      expect(job.url).toBe(JOB.url);
      const first = EvaluationResponseSchema.parse(
        (
          await bridge.inject({
            method: "POST",
            url: `/jobs/${job.id}/evaluate`,
            headers: AUTHORIZATION,
            payload: {},
          })
        ).json(),
      );
      const second = EvaluationResponseSchema.parse(
        (
          await bridge.inject({
            method: "POST",
            url: `/jobs/${job.id}/evaluate`,
            headers: AUTHORIZATION,
            payload: {},
          })
        ).json(),
      );
      expect(first.cacheHit).toBe(false);
      expect(second).toEqual({ ...first, cacheHit: true });
      expect(evaluator).toHaveBeenCalledOnce();
      expect(screenJob).toHaveBeenCalledOnce();

      const formattingOnly = await postJob(bridge, {
        ...JOB,
        description: normalizedDescription,
        url: `${JOB.url}?securityId=volatile-second`,
      });
      expect(formattingOnly.url).toBe(JOB.url);
      expect(formattingOnly.jdHash).toBe(job.jdHash);
      const formattingOnlyEvaluation = EvaluationResponseSchema.parse(
        (
          await bridge.inject({
            method: "POST",
            url: `/jobs/${job.id}/evaluate`,
            headers: AUTHORIZATION,
            payload: {},
          })
        ).json(),
      );
      expect(formattingOnlyEvaluation.cacheHit).toBe(true);
      expect(evaluator).toHaveBeenCalledOnce();
      expect(screenJob).toHaveBeenCalledOnce();

      const beforeHash = job.jdHash;
      const changed = await postJob(bridge, {
        ...JOB,
        description:
          "新版职位描述：负责 TypeScript、React、性能治理和工程平台建设。",
      });
      expect(changed.id).toBe(job.id);
      expect(changed.jdHash).not.toBe(beforeHash);

      const changedEvaluation = EvaluationResponseSchema.parse(
        (
          await bridge.inject({
            method: "POST",
            url: `/jobs/${job.id}/evaluate`,
            headers: AUTHORIZATION,
            payload: {},
          })
        ).json(),
      );
      expect(changedEvaluation).toMatchObject({
        cacheHit: false,
        evaluation: { score: 93 },
      });
      expect(evaluator).toHaveBeenCalledTimes(2);
      expect(screenJob).toHaveBeenCalledTimes(2);

      const metadata = database
        .prepare(
          `SELECT jd_hash, profile_hash, rules_hash, prompt_version, model_id,
                  evaluation_schema_version, input_hash, cache_key,
                  created_at, latency_ms
           FROM evaluations
           WHERE job_id = ?
           ORDER BY rowid DESC`,
        )
        .all(job.id) as Array<Record<string, unknown>>;
      expect(metadata).toHaveLength(2);
      expect(metadata[0]).toMatchObject({
        jd_hash: changed.jdHash,
        profile_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        rules_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        prompt_version: "career-ops-cn-openai-v1",
        model_id: "gpt-4o-mini",
        evaluation_schema_version: "1",
        input_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        cache_key: expect.stringMatching(/^[a-f0-9]{64}$/u),
        created_at: expect.any(String),
        latency_ms: expect.any(Number),
      });
    } finally {
      await bridge.close();
    }
  });

  it("完整硬规则 block 时拒绝 AI 调用且不伪造评估", async () => {
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
      expect(response.statusCode).toBe(422);
      expect(BridgeErrorResponseSchema.parse(response.json())).toMatchObject({
        error: "HARD_RULE_BLOCKED",
        message: expect.stringContaining("命中硬规则"),
      });

      expect(evaluator).not.toHaveBeenCalled();

      expect(
        database
          .prepare(
            "SELECT job_id FROM evaluations WHERE job_id = ?",
          )
          .get(job.id),
      ).toBeUndefined();
      expect(
        database
          .prepare(
            "SELECT matched, reasons_json FROM screenings WHERE job_id = ?",
          )
          .get(job.id),
      ).toEqual({ matched: 0, reasons_json: '["命中硬规则"]' });
    } finally {
      await bridge.close();
    }
  });

  it("diagnostics 表写入失败不改变已通过硬规则的评估结果", async () => {
    const { database } = await createTempDatabase();
    const evaluator = vi.fn<Evaluator>(async () => ({
      score: 90,
      recommendation: "apply",
      rawReport: "业务评估成功。",
    }));
    const bridge = createBridge({
      environment: TEST_ENVIRONMENT,
      database,
      evaluator,
      screenJob: PASS_SCREEN_JOB,
    });

    try {
      database.exec(`
        CREATE TRIGGER fail_diagnostics_insert
        BEFORE INSERT ON diagnostics
        BEGIN
          SELECT RAISE(FAIL, 'diagnostics unavailable');
        END;
      `);
      const job = await postJob(bridge);
      const response = await bridge.inject({
        method: "POST",
        url: `/jobs/${job.id}/evaluate`,
        headers: AUTHORIZATION,
      });

      expect(response.statusCode).toBe(200);
      expect(EvaluationResponseSchema.parse(response.json())).toMatchObject({
        evaluation: { score: 90, recommendation: "apply" },
        cacheHit: false,
      });
      expect(evaluator).toHaveBeenCalledOnce();
      expect(
        database
          .prepare("SELECT recommendation FROM evaluations WHERE job_id = ?")
          .get(job.id),
      ).toEqual({ recommendation: "apply" });
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

describe("候选池与持久化", () => {
  it("GET /jobs 分开返回硬规则、AI 原文和候选池记录", async () => {
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
      const candidate = await bridge.inject({
        method: "POST",
        url: `/jobs/${job.id}/candidate`,
        headers: AUTHORIZATION,
        payload: {
          decision: "apply",
          note: "优先跟进",
          applicationStatus: "applied",
        },
      });
      expect(candidate.statusCode).toBe(200);

      const response = await bridge.inject({
        method: "GET",
        url: "/jobs",
        headers: AUTHORIZATION,
      });
      const [history] = JobListResponseSchema.parse(response.json());
      expect(history).toMatchObject({
        id: job.id,
        latestScreening: {
          jobId: JOB.sourceJobId,
          matched: true,
          reasons: [],
        },
        latestEvaluation: {
          score: 89,
          recommendation: "apply",
          archetype: "Builder",
          legitimacy: "high",
          rawReport: "完整评估报告",
        },
        candidate: {
          jobId: job.id,
          decision: "apply",
          note: "优先跟进",
          applicationStatus: "applied",
        },
      });
    } finally {
      await bridge.close();
    }
  });

  it("对同一 job 幂等更新备注、用户判断和投递状态", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const job = await postJob(bridge);
      const first = await bridge.inject({
        method: "POST",
        url: `/jobs/${job.id}/candidate`,
        headers: AUTHORIZATION,
        payload: {
          decision: "apply",
          note: "匹配目标",
          applicationStatus: "not_applied",
        },
      });
      expect(first.statusCode).toBe(200);

      const second = await bridge.inject({
        method: "POST",
        url: `/jobs/${job.id}/candidate`,
        headers: AUTHORIZATION,
        payload: { decision: "skip", applicationStatus: "withdrawn" },
      });
      expect(CandidateRecordSchema.parse(second.json())).toEqual({
        jobId: job.id,
        decision: "skip",
        note: "匹配目标",
        applicationStatus: "withdrawn",
        updatedAt: expect.any(String),
      });
      expect(
        database.prepare("SELECT count(*) AS count FROM candidate_records").get(),
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
  it("缺少 token 时拒绝，并使用默认端口 3847", () => {
    expect(() => readBridgeConfig({})).toThrow(/CAREER_OPS_CN_TOKEN/);
    expect(readBridgeConfig(TEST_ENVIRONMENT).port).toBe(
      DEFAULT_BRIDGE_PORT,
    );
    expect(
      readBridgeConfig({ ...TEST_ENVIRONMENT, OPENAI_MODEL: "model-from-openai" })
        .modelId,
    ).toBe("model-from-openai");
    expect(
      readBridgeConfig({
        ...TEST_ENVIRONMENT,
        OPENAI_MODEL: "model-from-openai",
        CAREER_OPS_CN_MODEL_ID: "model-from-bridge",
      }).modelId,
    ).toBe("model-from-bridge");
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
