import { DatabaseSync } from "node:sqlite";

import {
  BridgeErrorResponseSchema,
  CreateJobRequestSchema,
  HealthBadRequestResponseSchema,
  HealthRequestSchema,
  HealthResponseSchema,
  JobIdParamsSchema,
} from "@career-ops-cn/shared";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z } from "zod";

import { readBridgeConfig, type BridgeConfig } from "./config.js";
import {
  findJob,
  initializeDatabase,
  saveEvaluation,
  saveJob,
} from "./database.js";
import { createFakeEvaluator, type Evaluator } from "./fake-evaluator.js";

export const BRIDGE_HOST = "127.0.0.1";

const PortSchema = z.number().int().min(0).max(65_535);
const AuthorizationHeaderSchema = z.string().min(1);
const EmptyBodySchema = z.undefined();

export interface CreateBridgeOptions {
  environment?: NodeJS.ProcessEnv;
  database?: DatabaseSync;
  databasePath?: string;
  evaluator?: Evaluator;
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

function sendError(
  reply: FastifyReply,
  statusCode: 400 | 401 | 404,
  error: "invalid_request" | "unauthorized" | "not_found",
): FastifyReply {
  return reply.code(statusCode).send(BridgeErrorResponseSchema.parse({ error }));
}

function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
): FastifyReply | undefined {
  const authorization = AuthorizationHeaderSchema.safeParse(
    request.headers.authorization,
  );

  if (
    !authorization.success ||
    authorization.data !== `Bearer ${token}`
  ) {
    return sendError(reply, 401, "unauthorized");
  }

  return undefined;
}

function buildBridge(
  options: CreateBridgeOptions,
  config: BridgeConfig,
): FastifyInstance {
  const ownsDatabase = options.database === undefined;
  const database =
    options.database ??
    new DatabaseSync(options.databasePath ?? config.databasePath);
  const evaluator = options.evaluator ?? createFakeEvaluator();

  try {
    initializeDatabase(database);
  } catch (error) {
    if (ownsDatabase) {
      database.close();
    }
    throw error;
  }

  const bridge = Fastify({ logger: false });

  bridge.addHook("onRequest", async (_request, reply) => {
    reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Headers", "Authorization, Content-Type")
      .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  });

  bridge.options("*", async (_request, reply) => reply.code(204).send());

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

  bridge.post(
    "/jobs",
    {
      preHandler: async (request, reply) =>
        authenticate(request, reply, config.token),
    },
    async (request, reply) => {
      const query = HealthRequestSchema.safeParse(request.query);
      const body = CreateJobRequestSchema.safeParse(request.body);

      if (!query.success || !body.success) {
        return sendError(reply, 400, "invalid_request");
      }

      const job = saveJob(database, body.data);
      return reply.code(200).send(job);
    },
  );

  bridge.get(
    "/jobs/:id",
    {
      preHandler: async (request, reply) =>
        authenticate(request, reply, config.token),
    },
    async (request, reply) => {
      const params = JobIdParamsSchema.safeParse(request.params);
      const query = HealthRequestSchema.safeParse(request.query);

      if (!params.success || !query.success) {
        return sendError(reply, 400, "invalid_request");
      }

      const job = findJob(database, params.data.id);

      if (job === undefined) {
        return sendError(reply, 404, "not_found");
      }

      return reply.code(200).send(job);
    },
  );

  bridge.post(
    "/jobs/:id/evaluate",
    {
      preHandler: async (request, reply) =>
        authenticate(request, reply, config.token),
    },
    async (request, reply) => {
      const params = JobIdParamsSchema.safeParse(request.params);
      const query = HealthRequestSchema.safeParse(request.query);
      const body = EmptyBodySchema.safeParse(request.body);

      if (!params.success || !query.success || !body.success) {
        return sendError(reply, 400, "invalid_request");
      }

      if (findJob(database, params.data.id) === undefined) {
        return sendError(reply, 404, "not_found");
      }

      const result = await evaluator();
      saveEvaluation(database, params.data.id, result);
      return reply.code(200).send(result);
    },
  );

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
  return buildBridge(options, readBridgeConfig(options.environment));
}

export async function startBridge(
  options: StartBridgeOptions = {},
): Promise<FastifyInstance> {
  const config = readBridgeConfig(options.environment);
  const port = PortSchema.parse(options.port ?? config.port);
  const bridge = buildBridge(options, config);

  try {
    await bridge.listen({ host: BRIDGE_HOST, port });
    return bridge;
  } catch (error) {
    await bridge.close();
    throw error;
  }
}
