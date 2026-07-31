import { DatabaseSync } from "node:sqlite";

import {
  HealthBadRequestResponseSchema,
  HealthRequestSchema,
  HealthResponseSchema,
} from "@career-ops-cn/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import { readBridgeConfig } from "./config.js";

export const BRIDGE_HOST = "127.0.0.1";

const PortSchema = z.number().int().min(0).max(65_535);

export interface CreateBridgeOptions {
  environment?: NodeJS.ProcessEnv;
  database?: DatabaseSync;
}

export interface StartBridgeOptions extends CreateBridgeOptions {
  port?: number;
}

function probeDatabase(database: DatabaseSync): void {
  const row = database.prepare("SELECT 1 AS ok").get() as
    | { ok?: unknown }
    | undefined;

  if (row?.ok !== 1) {
    throw new Error("SQLite 健康检查失败。");
  }
}

function buildBridge(options: CreateBridgeOptions): FastifyInstance {
  const ownsDatabase = options.database === undefined;
  const database = options.database ?? new DatabaseSync(":memory:");
  const bridge = Fastify({ logger: false });

  bridge.get("/health", async (request, reply) => {
    const query = HealthRequestSchema.safeParse(request.query);

    if (!query.success) {
      const response = HealthBadRequestResponseSchema.parse({
        error: "invalid_request",
      });
      return reply.code(400).send(response);
    }

    probeDatabase(database);

    const response = HealthResponseSchema.parse({ status: "ok" });
    return reply.code(200).send(response);
  });

  if (ownsDatabase) {
    bridge.addHook("onClose", async () => {
      database.close();
    });
  }

  return bridge;
}

export function createBridge(
  options: CreateBridgeOptions = {},
): FastifyInstance {
  readBridgeConfig(options.environment);
  return buildBridge(options);
}

export async function startBridge(
  options: StartBridgeOptions = {},
): Promise<FastifyInstance> {
  const config = readBridgeConfig(options.environment);
  const port = PortSchema.parse(options.port ?? config.port);
  const bridge = buildBridge(options);

  try {
    await bridge.listen({ host: BRIDGE_HOST, port });
    return bridge;
  } catch (error) {
    await bridge.close();
    throw error;
  }
}
