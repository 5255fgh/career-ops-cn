import { DatabaseSync } from "node:sqlite";

import {
  BridgeErrorResponseSchema,
  CreateJobRequestSchema,
  DecisionRequestSchema,
  DiagnosticEventRequestSchema,
  DiagnosticListQuerySchema,
  DiagnosticListResponseSchema,
  EvaluationResultSchema,
  HealthRequestSchema,
  HealthResponseSchema,
  JobDetailSchema,
  JobIdParamsSchema,
  JobListResponseSchema,
  JobResponseSchema,
  ScreenRequestSchema,
  ScreenResponseSchema,
  type DiagnosticEvent,
  type DiagnosticEventRequest,
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
  listDiagnostics,
  listJobs,
  saveDecision,
  saveDiagnostic,
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
  HARD_RULE_BLOCKED: 422,
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
  details: { message?: string; diagnosticId?: string } = {},
): FastifyReply {
  return reply
    .code(ERROR_STATUS[error])
    .send(BridgeErrorResponseSchema.parse({ error, ...details }));
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

function redactDiagnosticText(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]+\b/gu, "[REDACTED]")
    .replace(/(OPENAI_API_KEY\s*[=:]\s*)\S+/giu, "$1[REDACTED]")
    .replace(/(Authorization\s*:\s*Bearer\s+)\S+/giu, "$1[REDACTED]");
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
  recordDiagnostic: (
    input: DiagnosticEventRequest,
  ) => DiagnosticEvent | undefined,
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
    "detail",
  );
  const hardRuleBlocked = screening.decision === "block";
  if (hardRuleBlocked) {
    const reasons = screening.rules
      .filter(({ decision }) => decision === "block")
      .map(({ reason }) => reason);
    throw bridgeFailure(
      "HARD_RULE_BLOCKED",
      "职位未通过完整硬规则筛选。",
      {
        publicMessage:
          reasons.length === 0
            ? "职位未通过完整硬规则筛选。"
            : `职位未通过完整硬规则筛选：${reasons.join("；")}`,
      },
    );
  }

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
    recordDiagnostic({
      source: "bridge",
      level: "info",
      event: "evaluation_started",
      jobId: job.id,
      ...(job.sourceJobId === undefined
        ? {}
        : { details: { sourceJobId: job.sourceJobId } }),
    });
    const output = await evaluator(detail, {
      careerOpsRoot: config.careerOpsRoot,
      timeoutMs: config.evaluationTimeoutMs,
      signal: controller.signal,
    });
    const evaluation = EvaluationResultSchema.safeParse({
      ...output,
      recommendation: output.recommendation,
    });

    if (!evaluation.success) {
      throw bridgeFailure(
        "EVALUATION_FAILED",
        "career-ops 返回了无效评估结果。",
        { cause: evaluation.error },
      );
    }

    recordDiagnostic({
      source: "bridge",
      level: "info",
      event: "evaluation_completed",
      jobId: job.id,
      outcome: evaluation.data.recommendation,
      details: {
        score: evaluation.data.score,
        rawReportLength: evaluation.data.rawReport.length,
      },
    });
    return evaluation.data;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "UPSTREAM_UNAVAILABLE"
    ) {
      const httpStatus =
        "httpStatus" in error && typeof error.httpStatus === "number"
          ? error.httpStatus
          : null;
      const attempts =
        "attempts" in error && typeof error.attempts === "number"
          ? error.attempts
          : 1;
      const diagnostic = redactDiagnosticText(
        "diagnostic" in error && typeof error.diagnostic === "string"
          ? error.diagnostic
          : error.message,
      );
      const savedDiagnostic = recordDiagnostic({
        source: "bridge",
        level: "error",
        event: "evaluation_upstream_failed",
        jobId: job.id,
        outcome:
          httpStatus === null ? "upstream_unavailable" : `http_${httpStatus}`,
        message: `上游 evaluator 在 ${attempts} 次尝试后仍不可用。`,
        details: { httpStatus, attempts, diagnostic },
      });
      const statusLabel =
        httpStatus === null ? "不可用" : `HTTP ${httpStatus}`;
      throw bridgeFailure(
        "EVALUATION_FAILED",
        `career-ops provider ${statusLabel}，${attempts} 次尝试均失败。`,
        {
          cause: error,
          publicMessage:
            savedDiagnostic === undefined
              ? `provider ${statusLabel}，已尝试 ${attempts} 次。`
              : `provider ${statusLabel}，已尝试 ${attempts} 次；诊断 ${savedDiagnostic.id}。`,
          ...(savedDiagnostic === undefined
            ? {}
            : { diagnosticId: savedDiagnostic.id }),
        },
      );
    }

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

    recordDiagnostic({
      source: "bridge",
      level: "error",
      event: "evaluation_failed",
      jobId: job.id,
      message: redactDiagnosticText(
        error instanceof Error ? error.message : "未知 evaluator 错误。",
      ),
      details: {
        adapterCode:
          error instanceof Error &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : null,
      },
    });

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
  const recordDiagnostic = (
    input: DiagnosticEventRequest,
  ): DiagnosticEvent =>
    runDatabaseOperation(() => saveDiagnostic(database, input));
  const recordDiagnosticBestEffort = (
    input: DiagnosticEventRequest,
  ): DiagnosticEvent | undefined => {
    try {
      return recordDiagnostic(input);
    } catch {
      return undefined;
    }
  };

  bridge.setErrorHandler((error, _request, reply) => {
    if (isBridgeFailure(error)) {
      return sendError(reply, error.code, {
        ...(error.publicMessage === undefined
          ? {}
          : { message: error.publicMessage }),
        ...(error.diagnosticId === undefined
          ? {}
          : { diagnosticId: error.diagnosticId }),
      });
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
            await screenJob(
              toScreenableJob(job),
              screeningPreferences,
              body.data.phase,
            ),
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

  bridge.post(
    "/diagnostics",
    {
      preHandler: async (request, reply) =>
        authenticate(request, reply, config.token),
    },
    async (request, reply) => {
      const query = HealthRequestSchema.safeParse(request.query);
      const body = DiagnosticEventRequestSchema.safeParse(request.body);
      if (
        !query.success ||
        !body.success ||
        body.data.source !== "extension"
      ) {
        return sendError(reply, "INVALID_REQUEST");
      }
      return reply.code(200).send(recordDiagnostic(body.data));
    },
  );

  bridge.get(
    "/diagnostics",
    {
      preHandler: async (request, reply) =>
        authenticate(request, reply, config.token),
    },
    async (request, reply) => {
      const query = DiagnosticListQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendError(reply, "INVALID_REQUEST");
      }
      const diagnostics = runDatabaseOperation(() =>
        listDiagnostics(database, query.data.limit),
      );
      return reply
        .code(200)
        .send(DiagnosticListResponseSchema.parse(diagnostics));
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
        recordDiagnosticBestEffort,
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
