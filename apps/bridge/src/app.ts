import { DatabaseSync } from "node:sqlite";

import {
  BridgeErrorResponseSchema,
  CreateJobRequestSchema,
  DecisionRequestSchema,
  EvaluationResultSchema,
  HealthRequestSchema,
  HealthResponseSchema,
  JobDetailSchema,
  JobIdParamsSchema,
  JobListResponseSchema,
  JobResponseSchema,
  ScreenRequestSchema,
  ScreenResponseSchema,
} from "@career-ops-cn/shared";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z } from "zod";

import {
  BRIDGE_HOST,
  readBridgeConfig,
  type BridgeConfig,
} from "./config.js";
import {
  createRealEvaluator,
  createRealScreenJob,
  toScreenableJob,
  toScreeningPreferences,
  toScreeningResult,
  type Evaluator,
  type ScreenJob,
} from "./dependencies.js";
import {
  findJob,
  initializeDatabase,
  listJobs,
  saveDecision,
  saveEvaluation,
  saveJob,
} from "./database.js";
import {
  bridgeFailure,
  isBridgeFailure,
  type BridgeErrorCode,
} from "./errors.js";

export { BRIDGE_HOST } from "./config.js";

const PortSchema = z.number().int().min(0).max(65_535);
const AuthorizationHeaderSchema = z.string().min(1);
const OriginHeaderSchema = z.string().min(1);
const EmptyBodySchema = z.undefined();
const ExtensionOriginSchema = z
  .string()
  .regex(/^chrome-extension:\/\/[a-p]{32}$/u);

const ERROR_STATUS: Record<BridgeErrorCode, number> = {
  UNAUTHORIZED: 401,
  INVALID_REQUEST: 400,
  JOB_NOT_FOUND: 404,
  INVALID_JOB_DETAIL: 422,
  DETAIL_IDENTITY_UNVERIFIED: 422,
  EVALUATION_FAILED: 502,
  EVALUATION_TIMEOUT: 504,
  CANCELLED: 499,
  CAREER_OPS_NOT_FOUND: 503,
  DATABASE_ERROR: 500,
};

export interface CreateBridgeOptions {
  environment?: NodeJS.ProcessEnv;
  database?: DatabaseSync;
  databasePath?: string;
  evaluator?: Evaluator;
  screenJob?: ScreenJob;
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
  error: BridgeErrorCode,
): FastifyReply {
  return reply
    .code(ERROR_STATUS[error])
    .send(BridgeErrorResponseSchema.parse({ error }));
}

function isExtensionOrigin(origin: string): boolean {
  return ExtensionOriginSchema.safeParse(origin).success;
}

function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
): FastifyReply | undefined {
  const origin = OriginHeaderSchema.safeParse(request.headers.origin);
  if (origin.success && !isExtensionOrigin(origin.data)) {
    return sendError(reply, "UNAUTHORIZED");
  }

  const authorization = AuthorizationHeaderSchema.safeParse(
    request.headers.authorization,
  );

  if (
    !authorization.success ||
    authorization.data !== `Bearer ${token}`
  ) {
    return sendError(reply, "UNAUTHORIZED");
  }

  return undefined;
}

function runDatabaseOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw bridgeFailure("DATABASE_ERROR", "SQLite 操作失败。", {
      cause: error,
    });
  }
}

function validateEmptyRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply | undefined {
  if (!HealthRequestSchema.safeParse(request.query).success) {
    return sendError(reply, "INVALID_REQUEST");
  }

  return undefined;
}

function buildJobDetail(job: ReturnType<typeof findJob>) {
  if (job === undefined || job.description === undefined) {
    return undefined;
  }

  const detail = JobDetailSchema.safeParse({
    jobId: job.sourceJobId ?? job.id,
    title: job.title,
    companyName: job.company,
    salaryText: job.salary,
    location: job.location,
    experienceText: job.experience,
    educationText: job.education,
    detailUrl: job.url,
    description: job.description,
    identityVerified: job.identityVerified,
  });

  return detail.success ? detail.data : undefined;
}

async function evaluateJob(
  request: FastifyRequest,
  reply: FastifyReply,
  evaluator: Evaluator,
  screenJob: ScreenJob,
  config: BridgeConfig,
  job: NonNullable<ReturnType<typeof findJob>>,
) {
  const detail = buildJobDetail(job);
  if (detail === undefined) {
    throw bridgeFailure(
      "INVALID_JOB_DETAIL",
      "职位详情不完整，无法评估。",
    );
  }

  if (!job.identityVerified) {
    throw bridgeFailure(
      "DETAIL_IDENTITY_UNVERIFIED",
      "职位详情身份尚未验证。",
    );
  }

  const screening = await screenJob(
    toScreenableJob(detail),
    toScreeningPreferences(config.preferences),
  );
  const hardRuleBlocked = screening.decision === "block";

  const controller = new AbortController();
  const cancel = () => {
    if (!controller.signal.aborted) {
      controller.abort(
        bridgeFailure("CANCELLED", "评估请求已由客户端取消。"),
      );
    }
  };
  const cancelOnClosedResponse = () => {
    if (!reply.raw.writableEnded) {
      cancel();
    }
  };
  request.raw.once("aborted", cancel);
  reply.raw.once("close", cancelOnClosedResponse);

  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(
        bridgeFailure("EVALUATION_TIMEOUT", "career-ops 评估超时。"),
      );
    }
  }, config.evaluationTimeoutMs);
  timeout.unref();

  try {
    const output = await evaluator(detail, {
      careerOpsRoot: config.careerOpsRoot,
      timeoutMs: config.evaluationTimeoutMs,
      signal: controller.signal,
    });
    const evaluation = EvaluationResultSchema.safeParse({
      ...output,
      recommendation: hardRuleBlocked ? "skip" : output.recommendation,
    });

    if (!evaluation.success) {
      throw bridgeFailure(
        "EVALUATION_FAILED",
        "career-ops 返回了无效评估结果。",
        { cause: evaluation.error },
      );
    }

    return evaluation.data;
  } catch (error) {
    if (isBridgeFailure(error)) {
      throw error;
    }

    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (isBridgeFailure(reason)) {
        throw reason;
      }
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw bridgeFailure("CANCELLED", "career-ops 评估已取消。", {
        cause: error,
      });
    }

    if (error instanceof Error && "code" in error) {
      if (error.code === "SCRIPT_NOT_FOUND") {
        throw bridgeFailure(
          "CAREER_OPS_NOT_FOUND",
          "未找到 career-ops evaluator。",
          { cause: error },
        );
      }
      if (error.code === "TIMEOUT") {
        throw bridgeFailure("EVALUATION_TIMEOUT", "career-ops 评估超时。", {
          cause: error,
        });
      }
      if (error.code === "CANCELLED") {
        throw bridgeFailure("CANCELLED", "career-ops 评估已取消。", {
          cause: error,
        });
      }
    }

    throw bridgeFailure("EVALUATION_FAILED", "career-ops 评估失败。", {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
    request.raw.removeListener("aborted", cancel);
    reply.raw.removeListener("close", cancelOnClosedResponse);
  }
}

function buildBridge(
  options: CreateBridgeOptions,
  config: BridgeConfig,
): FastifyInstance {
  const ownsDatabase = options.database === undefined;
  const database =
    options.database ??
    new DatabaseSync(options.databasePath ?? config.databasePath);
  const evaluator = options.evaluator ?? createRealEvaluator();
  const screenJob = options.screenJob ?? createRealScreenJob();

  try {
    initializeDatabase(database);
  } catch (error) {
    if (ownsDatabase) {
      database.close();
    }
    throw error;
  }

  const bridge = Fastify({ logger: false });

  bridge.setErrorHandler((error, _request, reply) => {
    if (isBridgeFailure(error)) {
      return sendError(reply, error.code);
    }

    return sendError(reply, "EVALUATION_FAILED");
  });

  bridge.addHook("onRequest", async (request, reply) => {
    const origin = OriginHeaderSchema.safeParse(request.headers.origin);
    if (origin.success && isExtensionOrigin(origin.data)) {
      reply
        .header("Access-Control-Allow-Origin", origin.data)
        .header("Vary", "Origin")
        .header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
  });

  bridge.options("*", async (_request, reply) => reply.code(204).send());

  bridge.get("/health", async (request, reply) => {
    const invalidRequest = validateEmptyRequest(request, reply);
    if (invalidRequest !== undefined) {
      return invalidRequest;
    }

    runDatabaseOperation(() => probeDatabase(database));
    return reply.code(200).send(HealthResponseSchema.parse({ status: "ok" }));
  });

  bridge.post(
    "/screen",
    {
      preHandler: async (request, reply) =>
        authenticate(request, reply, config.token),
    },
    async (request, reply) => {
      const query = HealthRequestSchema.safeParse(request.query);
      const body = ScreenRequestSchema.safeParse(request.body);
      if (!query.success || !body.success) {
        return sendError(reply, "INVALID_REQUEST");
      }

      const preferences = body.data.preferences ?? config.preferences;
      const screeningPreferences = toScreeningPreferences(preferences);
      const results = await Promise.all(
        body.data.jobs.map(async (job) =>
          toScreeningResult(
            job.jobId,
            await screenJob(toScreenableJob(job), screeningPreferences),
          ),
        ),
      );
      return reply.code(200).send(ScreenResponseSchema.parse(results));
    },
  );

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
        return sendError(reply, "INVALID_REQUEST");
      }

      const result = runDatabaseOperation(() => saveJob(database, body.data));
      const response = JobResponseSchema.parse({
        ...result.job,
        ...(result.possibleDuplicateJobId === undefined
          ? {}
          : {
              possibleDuplicate: {
                jobId: result.possibleDuplicateJobId,
                reason: "same_company_and_title",
              },
            }),
      });
      return reply.code(200).send(response);
    },
  );

  bridge.get(
    "/jobs",
    {
      preHandler: async (request, reply) =>
        authenticate(request, reply, config.token),
    },
    async (request, reply) => {
      const invalidRequest = validateEmptyRequest(request, reply);
      if (invalidRequest !== undefined) {
        return invalidRequest;
      }

      const jobs = runDatabaseOperation(() => listJobs(database));
      return reply.code(200).send(JobListResponseSchema.parse(jobs));
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
        return sendError(reply, "INVALID_REQUEST");
      }

      const job = runDatabaseOperation(() => findJob(database, params.data.id));
      if (job === undefined) {
        return sendError(reply, "JOB_NOT_FOUND");
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
        return sendError(reply, "INVALID_REQUEST");
      }

      const job = runDatabaseOperation(() => findJob(database, params.data.id));
      if (job === undefined) {
        return sendError(reply, "JOB_NOT_FOUND");
      }

      const evaluation = await evaluateJob(
        request,
        reply,
        evaluator,
        screenJob,
        config,
        job,
      );
      runDatabaseOperation(() =>
        saveEvaluation(database, params.data.id, evaluation),
      );
      return reply.code(200).send(evaluation);
    },
  );

  bridge.post(
    "/jobs/:id/decision",
    {
      preHandler: async (request, reply) =>
        authenticate(request, reply, config.token),
    },
    async (request, reply) => {
      const params = JobIdParamsSchema.safeParse(request.params);
      const query = HealthRequestSchema.safeParse(request.query);
      const body = DecisionRequestSchema.safeParse(request.body);
      if (!params.success || !query.success || !body.success) {
        return sendError(reply, "INVALID_REQUEST");
      }

      const job = runDatabaseOperation(() => findJob(database, params.data.id));
      if (job === undefined) {
        return sendError(reply, "JOB_NOT_FOUND");
      }

      const decision = runDatabaseOperation(() =>
        saveDecision(database, params.data.id, body.data),
      );
      return reply.code(200).send(decision);
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
    await bridge.listen({ host: config.host, port });
    return bridge;
  } catch (error) {
    await bridge.close();
    throw error;
  }
}
