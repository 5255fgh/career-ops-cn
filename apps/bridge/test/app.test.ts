import { DatabaseSync } from "node:sqlite";

import {
  HealthBadRequestResponseSchema,
  HealthResponseSchema,
} from "@career-ops-cn/shared";
import { describe, expect, it } from "vitest";

import { BRIDGE_HOST, createBridge, startBridge } from "../src/app.js";

const TEST_ENVIRONMENT = {
  CAREER_OPS_CN_TOKEN: "test-token",
} satisfies NodeJS.ProcessEnv;

describe("Bridge", () => {
  it("在 SQLite 探测成功后返回最小 health 响应", async () => {
    const database = new DatabaseSync(":memory:");
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

      const tableCount = database
        .prepare(
          "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table'",
        )
        .get() as { count: number };
      expect(tableCount.count).toBe(0);
    } finally {
      await bridge.close();
      database.close();
    }
  });

  it("缺少 token 时拒绝创建 Bridge", () => {
    expect(() => createBridge({ environment: {} })).toThrow(
      /CAREER_OPS_CN_TOKEN/,
    );
  });

  it("以 400 拒绝未知 health 查询参数", async () => {
    const bridge = createBridge({ environment: TEST_ENVIRONMENT });

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

  it("空白 token 时拒绝创建 Bridge", () => {
    expect(() =>
      createBridge({
        environment: { CAREER_OPS_CN_TOKEN: "   " },
      }),
    ).toThrow(/CAREER_OPS_CN_TOKEN/);
  });

  it("启动时固定监听 IPv4 回环地址", async () => {
    const bridge = await startBridge({
      environment: TEST_ENVIRONMENT,
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
