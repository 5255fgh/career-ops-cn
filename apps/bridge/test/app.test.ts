import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  BridgeErrorResponseSchema,
  EvaluationResultSchema,
  HealthBadRequestResponseSchema,
  HealthResponseSchema,
  JobResponseSchema,
  type CreateJobRequest,
} from "@career-ops-cn/shared";
import { afterEach, describe, expect, it } from "vitest";

import { BRIDGE_HOST, createBridge, startBridge } from "../src/app.js";

const TEST_ENVIRONMENT = {
  CAREER_OPS_CN_TOKEN: "test-token",
} satisfies NodeJS.ProcessEnv;

const AUTHORIZATION = {
  authorization: "Bearer test-token",
};

const JOB: CreateJobRequest = {
  source: "boss",
  sourceJobId: "123456789",
  title: "前端开发工程师",
  company: "示例科技",
  salary: "20-30K·14薪",
  location: "上海·浦东新区",
  description:
    "负责招聘产品的前端功能开发与维护，要求熟悉 TypeScript 和 React。",
  url: "https://www.zhipin.com/job_detail/123456789.html",
};

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

afterEach(async () => {
  await Promise.all(cleanupTasks.splice(0).map((cleanup) => cleanup()));
});

describe("Bridge API", () => {
  it("创建 jobs、evaluations 两张表并返回 health", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({
      environment: TEST_ENVIRONMENT,
      database,
    });

    try {
      const response = await bridge.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(HealthResponseSchema.parse(response.json())).toEqual({
        status: "ok",
      });

      const tables = database
        .prepare(
          `
            SELECT name
            FROM sqlite_schema
            WHERE type = 'table'
            ORDER BY name
          `,
        )
        .all() as Array<{ name: string }>;
      expect(tables.map(({ name }) => name)).toEqual([
        "evaluations",
        "jobs",
      ]);
    } finally {
      await bridge.close();
    }
  });

  it("拒绝未知 health 查询参数", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const response = await bridge.inject({
        method: "GET",
        url: "/health?unexpected=true",
      });

      expect(response.statusCode).toBe(400);
      expect(HealthBadRequestResponseSchema.parse(response.json())).toEqual({
        error: "invalid_request",
      });
    } finally {
      await bridge.close();
    }
  });

  it("业务路由需要 Bearer token，并允许扩展预检", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const unauthorized = await bridge.inject({
        method: "POST",
        url: "/jobs",
        payload: JOB,
      });
      expect(unauthorized.statusCode).toBe(401);
      expect(BridgeErrorResponseSchema.parse(unauthorized.json())).toEqual({
        error: "unauthorized",
      });

      const preflight = await bridge.inject({
        method: "OPTIONS",
        url: "/jobs",
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers["access-control-allow-origin"]).toBe("*");
      expect(preflight.headers["access-control-allow-headers"]).toContain(
        "Authorization",
      );
    } finally {
      await bridge.close();
    }
  });

  it("保存并读取通过 shared Schema 校验的职位", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const createdResponse = await bridge.inject({
        method: "POST",
        url: "/jobs",
        headers: AUTHORIZATION,
        payload: JOB,
      });
      expect(createdResponse.statusCode).toBe(200);
      const created = JobResponseSchema.parse(createdResponse.json());
      expect(created).toMatchObject(JOB);

      const readResponse = await bridge.inject({
        method: "GET",
        url: `/jobs/${created.id}`,
        headers: AUTHORIZATION,
      });
      expect(readResponse.statusCode).toBe(200);
      expect(JobResponseSchema.parse(readResponse.json())).toEqual(created);
    } finally {
      await bridge.close();
    }
  });

  it("以 400 拒绝不符合职位契约的请求", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const response = await bridge.inject({
        method: "POST",
        url: "/jobs",
        headers: AUTHORIZATION,
        payload: { ...JOB, source: "other" },
      });

      expect(response.statusCode).toBe(400);
      expect(BridgeErrorResponseSchema.parse(response.json())).toEqual({
        error: "invalid_request",
      });
    } finally {
      await bridge.close();
    }
  });

  it("以 400 拒绝业务路由的未知 query 或 evaluate body", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const createdResponse = await bridge.inject({
        method: "POST",
        url: "/jobs",
        headers: AUTHORIZATION,
        payload: JOB,
      });
      const created = JobResponseSchema.parse(createdResponse.json());

      const queryResponse = await bridge.inject({
        method: "GET",
        url: `/jobs/${created.id}?unexpected=true`,
        headers: AUTHORIZATION,
      });
      expect(queryResponse.statusCode).toBe(400);

      const bodyResponse = await bridge.inject({
        method: "POST",
        url: `/jobs/${created.id}/evaluate`,
        headers: AUTHORIZATION,
        payload: { unexpected: true },
      });
      expect(bodyResponse.statusCode).toBe(400);
      expect(BridgeErrorResponseSchema.parse(bodyResponse.json())).toEqual({
        error: "invalid_request",
      });
    } finally {
      await bridge.close();
    }
  });

  it("不存在的职位返回 404", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const response = await bridge.inject({
        method: "GET",
        url: "/jobs/missing",
        headers: AUTHORIZATION,
      });

      expect(response.statusCode).toBe(404);
      expect(BridgeErrorResponseSchema.parse(response.json())).toEqual({
        error: "not_found",
      });
    } finally {
      await bridge.close();
    }
  });

  it("evaluate 返回 fixture 并保存 evaluation", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const createdResponse = await bridge.inject({
        method: "POST",
        url: "/jobs",
        headers: AUTHORIZATION,
        payload: JOB,
      });
      const created = JobResponseSchema.parse(createdResponse.json());

      const response = await bridge.inject({
        method: "POST",
        url: `/jobs/${created.id}/evaluate`,
        headers: AUTHORIZATION,
      });

      expect(response.statusCode).toBe(200);
      const result = EvaluationResultSchema.parse(response.json());
      expect(result).toEqual({
        score: 86,
        recommendation: "建议申请",
        rawReport:
          "岗位技术方向与求职偏好较匹配；技术栈包含 TypeScript 和 React。职位描述未说明团队规模，建议面试时进一步确认。",
      });

      const saved = database
        .prepare(
          `
            SELECT job_id, score, recommendation, raw_report
            FROM evaluations
          `,
        )
        .get() as {
        job_id: string;
        score: number;
        recommendation: string;
        raw_report: string;
      };
      expect(saved).toEqual({
        job_id: created.id,
        score: result.score,
        recommendation: result.recommendation,
        raw_report: result.rawReport,
      });
    } finally {
      await bridge.close();
    }
  });
});

describe("职位幂等 upsert", () => {
  it("同一 source 与 sourceJobId 更新同一条记录", async () => {
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const firstResponse = await bridge.inject({
        method: "POST",
        url: "/jobs",
        headers: AUTHORIZATION,
        payload: JOB,
      });
      const first = JobResponseSchema.parse(firstResponse.json());

      const secondResponse = await bridge.inject({
        method: "POST",
        url: "/jobs",
        headers: AUTHORIZATION,
        payload: { ...JOB, title: "高级前端开发工程师" },
      });
      const second = JobResponseSchema.parse(secondResponse.json());

      expect(second.id).toBe(first.id);
      expect(second.title).toBe("高级前端开发工程师");
      expect(
        database.prepare("SELECT count(*) AS count FROM jobs").get(),
      ).toEqual({ count: 1 });
    } finally {
      await bridge.close();
    }
  });

  it("没有 sourceJobId 时每次创建新记录", async () => {
    const { sourceJobId: _sourceJobId, ...jobWithoutSourceId } = JOB;
    const { database } = await createTempDatabase();
    const bridge = createBridge({ environment: TEST_ENVIRONMENT, database });

    try {
      const first = JobResponseSchema.parse(
        (
          await bridge.inject({
            method: "POST",
            url: "/jobs",
            headers: AUTHORIZATION,
            payload: jobWithoutSourceId,
          })
        ).json(),
      );
      const second = JobResponseSchema.parse(
        (
          await bridge.inject({
            method: "POST",
            url: "/jobs",
            headers: AUTHORIZATION,
            payload: jobWithoutSourceId,
          })
        ).json(),
      );

      expect(second.id).not.toBe(first.id);
      expect(
        database.prepare("SELECT count(*) AS count FROM jobs").get(),
      ).toEqual({ count: 2 });
    } finally {
      await bridge.close();
    }
  });
});

describe("Bridge 启动配置", () => {
  it("缺少或使用空白 token 时拒绝创建 Bridge", () => {
    expect(() => createBridge({ environment: {} })).toThrow(
      /CAREER_OPS_CN_TOKEN/,
    );
    expect(() =>
      createBridge({
        environment: { CAREER_OPS_CN_TOKEN: "   " },
      }),
    ).toThrow(/CAREER_OPS_CN_TOKEN/);
  });

  it("支持临时文件数据库并固定监听 IPv4 回环地址", async () => {
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

  it("databasePath 使用可重开的持久 SQLite 文件", async () => {
    const directory = await mkdtemp(join(tmpdir(), "career-ops-cn-path-"));
    const databasePath = join(directory, "bridge.sqlite");
    cleanupTasks.push(async () => {
      await rm(directory, { recursive: true, force: true });
    });
    const bridge = createBridge({
      environment: TEST_ENVIRONMENT,
      databasePath,
    });

    try {
      const response = await bridge.inject({
        method: "POST",
        url: "/jobs",
        headers: AUTHORIZATION,
        payload: JOB,
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await bridge.close();
    }

    const reopened = new DatabaseSync(databasePath);
    try {
      expect(
        reopened.prepare("SELECT count(*) AS count FROM jobs").get(),
      ).toEqual({ count: 1 });
    } finally {
      reopened.close();
    }
  });
});
