import { DatabaseSync } from "node:sqlite";

import {
  BridgeErrorResponseSchema,
  CreateScanRunRequestSchema,
  DecisionRequestSchema,
  DiagnosticEventRequestSchema,
  DiagnosticListQuerySchema,
  DiagnosticListResponseSchema,
  EvaluateJobRequestSchema,
  EvaluationResponseSchema,
  EvaluationResultSchema,
  HealthRequestSchema,
  HealthResponseSchema,
  InterruptScanRunRequestSchema,
  JobDetailSchema,
  JobIdParamsSchema,
  JobListResponseSchema,
  LatestScanRunResponseSchema,
  ObserveJobsRequestSchema,
  ObserveJobsResponseSchema,
  RequestScanRunCancelSchema,
  SaveJobRequestSchema,
  ScanRunIdParamsSchema,
  ScanRunSchema,
  ScanRunSnapshotSchema,
  JobResponseSchema,
  ScreenRequestSchema,
  ScreenResponseSchema,
  UpdateScanRunRequestSchema,
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
  findEvaluationByCacheKey,
  findLatestScanRun,
  findScanRun,
  initializeDatabase,
  interruptRunningScanRuns,
  interruptScanRun,
  listDiagnostics,
  listJobs,
  listJobsForScanRun,
  observeJobs,
  requestScanRunCancel,
  saveDecision,
  saveDiagnostic,
  saveEvaluation,
  saveJob,
  createScanRun,
  updateScanRun,
} from "./database.js";
import { buildEvaluationCacheMetadata } from "./evaluation-cache.js";
import {
  bridgeFailure,
  isBridgeFailure,
  type BridgeErrorCode,
} from "./errors.js";

export { BRIDGE_HOST } from "./config.js";

const PortSchema = z.number().int().min(0).max(65_535);
const AuthorizationHeaderSchema = z.string().min(1);
const OriginHeaderSchema = z.string().min(1);
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

function findCurrentEvaluation(
  database: DatabaseSync,
  config: BridgeConfig,
  job: NonNullable<ReturnType<typeof findJob>>,
) {
  const detail = buildJobDetail(job);
  if (detail === undefined || !job.identityVerified) {
    return undefined;
  }
  const metadata = buildEvaluationCacheMetadata(detail, config);
  const evaluation = findEvaluationByCacheKey(
    database,
    job.id,
    metadata.cacheKey,
  );
  return evaluation === undefined ? undefined : { evaluation, metadata };
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
    interruptRunningScanRuns(
      database,
      "bridge-restarted",
      "Bridge 在扫描完成前重启。",
    );
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
    "/scan-runs",
    {
      preHandler: async (request, reply) =>
        authenticate(request, reply, config.token),
    },
    async (request, reply) => {
      const query = HealthRequestSchema.safeParse(request.query);
      const body = CreateScanRunRequestSchema.safeParse(request.body ?? {});
      if (!query.success || !body.success) {
        return sendError(reply, "INVALID_REQUEST");
      }
      const run = runDatabaseOperation(() => createScanRun(database));
      return reply.code(200).send(ScanRunSchema.parse(run));
    },
  );

  bridge.get(
    "/scan-runs/latest",
    {
      preHandler: async (request, reply) =>
        authenticate(request, reply, config.token),
    },
    async (request, reply) => {
      const invalidRequest = validateEmptyRequest(request, reply);
      if (invalidRequest !== undefined) {
        return invalidRequest;
      }
      const snapshot = runDatabaseOperation(() => {
        const run = findLatestScanRun(database);
        const jobs =
          run === undefined
            ? []
            : listJobsForScanRun(database, run.id).map((job) => {
                const {
                  latestEvaluation: _latestEvaluation,
                  ...jobWithoutEvaluation
                } = job;
                const current = findCurrentEvaluation(database, config, job);
                return {
                  ...jobWithoutEvaluation,
                  ...(current === undefined
                    ? {}
                    : { latestEvaluation: current.evaluation }),
                };
              });
        return run === undefined
          ? null
          : ScanRunSnapshotSchema.parse({
              run,
              jobs,
            });
      });
      return reply
        .code(200)
        .send(LatestScanRunResponseSchema.parse(snapshot));
    },
  );

  bridge.post(
    "/scan-runs/:id/progress",
    {
      preHandler: async (request, reply) =>
        authenticate(request, reply, config.token),
    },
    async (request, reply) => {
      const params = ScanRunIdParamsSchema.safeParse(request.params);
      const query = HealthRequestSchema.safeParse(request.query);
      const body = UpdateScanRunRequestSchema.safeParse(request.body);
      if (!params.success || !query.success || !body.success) {
        return sendError(reply, "INVALID_REQUEST");
      }
      const run = runDatabaseOperation(() =>
        updateScanRun(database, params.data.id, body.data),
      );
      if (run === undefined) {
        return sendError(reply, "INVALID_REQUEST", {
          message: "scan run 不存在。",
        });
      }
      return reply.code(200).send(ScanRunSchema.parse(run));
    },
  );

  bridge.post(
    "/scan-runs/:id/cancel",
    {
      preHandler: async (request, reply) =>
        authenticate(request, reply, config.token),
    },
    async (request, reply) => {
      const params = ScanRunIdParamsSchema.safeParse(request.params);
      const query = HealthRequestSchema.safeParse(request.query);
      const body = RequestScanRunCancelSchema.safeParse(request.body ?? {});
      if (!params.success || !query.success || !body.success) {
        return sendError(reply, "INVALID_REQUEST");
      }
      const run = runDatabaseOperation(() =>
        requestScanRunCancel(database, params.data.id),
      );
      if (run === undefined) {
        return sendError(reply, "INVALID_REQUEST", {
          message: "scan run 不存在。",
        });
      }
      return reply.code(200).send(ScanRunSchema.parse(run));
    },
  );

  bridge.post(
    "/scan-runs/:id/interrupted",
    {
      preHandler: async (request, reply) =>
        authenticate(request, reply, config.token),
    },
    async (request, reply) => {
      const params = ScanRunIdParamsSchema.safeParse(request.params);
      const query = HealthRequestSchema.safeParse(request.query);
      const body = InterruptScanRunRequestSchema.safeParse(request.body ?? {});
      if (!params.success || !query.success || !body.success) {
        return sendError(reply, "INVALID_REQUEST");
      }
      const run = runDatabaseOperation(() =>
        interruptScanRun(
          database,
          params.data.id,
          body.data.reason ?? "extension-disconnected",
          body.data.errorSummary,
        ),
      );
      if (run === undefined) {
        return sendError(reply, "INVALID_REQUEST", {
          message: "scan run 不存在。",
        });
      }
      return reply.code(200).send(ScanRunSchema.parse(run));
    },
  );

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
    "/jobs/observe",
    {
      preHandler: async (request, reply) =>
        authenticate(request, reply, config.token),
    },
    async (request, reply) => {
      const query = HealthRequestSchema.safeParse(request.query);
      const body = ObserveJobsRequestSchema.safeParse(request.body);
      if (!query.success || !body.success) {
        return sendError(reply, "INVALID_REQUEST");
      }
      const scanRun = runDatabaseOperation(() =>
        findScanRun(database, body.data.scanRunId),
      );
      if (scanRun?.status !== "running" || scanRun.cancelRequested) {
        return sendError(reply, "INVALID_REQUEST", {
          message: "scan run 不存在、已结束或已请求取消。",
        });
      }

      const observations = runDatabaseOperation(() =>
        observeJobs(
          database,
          body.data.scanRunId,
          body.data.sourceQuery,
          body.data.jobs,
        ).map((observation) => {
          if (observation.action === "read-detail") {
            return observation;
          }
          const current = findCurrentEvaluation(
            database,
            config,
            observation.job,
          );
          return {
            ...observation,
            evaluation: current?.evaluation ?? null,
            cacheHit: current !== undefined,
          };
        }),
      );
      return reply
        .code(200)
        .send(ObserveJobsResponseSchema.parse(observations));
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
      const body = SaveJobRequestSchema.safeParse(request.body);
      if (!query.success || !body.success) {
        return sendError(reply, "INVALID_REQUEST");
      }

      if (body.data.scanRunId !== undefined) {
        const scanRun = runDatabaseOperation(() =>
          findScanRun(database, body.data.scanRunId!),
        );
        if (
          scanRun?.status !== "running" ||
          scanRun.cancelRequested ||
          body.data.sourceQuery === undefined
        ) {
          return sendError(reply, "INVALID_REQUEST", {
            message: "保存扫描职位需要有效的 scan run 和 sourceQuery。",
          });
        }
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
      const body = EvaluateJobRequestSchema.safeParse(request.body ?? {});
      if (!params.success || !query.success || !body.success) {
        return sendError(reply, "INVALID_REQUEST");
      }

      if (body.data.scanRunId !== undefined) {
        const scanRun = runDatabaseOperation(() =>
          findScanRun(database, body.data.scanRunId!),
        );
        if (scanRun?.status !== "running" || scanRun.cancelRequested) {
          return sendError(reply, "INVALID_REQUEST", {
            message: "scan run 不存在、已结束或已请求取消。",
          });
        }
      }

      const job = runDatabaseOperation(() => findJob(database, params.data.id));
      if (job === undefined) {
        return sendError(reply, "JOB_NOT_FOUND");
      }

      const detail = buildJobDetail(job);
      if (detail === undefined) {
        return sendError(reply, "INVALID_JOB_DETAIL");
      }
      if (!job.identityVerified) {
        return sendError(reply, "DETAIL_IDENTITY_UNVERIFIED");
      }
      const metadata = buildEvaluationCacheMetadata(detail, config);
      const cached = runDatabaseOperation(() =>
        findEvaluationByCacheKey(database, job.id, metadata.cacheKey),
      );
      if (cached !== undefined) {
        recordDiagnosticBestEffort({
          source: "bridge",
          level: "info",
          event: "evaluation_cache_hit",
          jobId: job.id,
          ...(body.data.scanRunId === undefined
            ? {}
            : { scanId: body.data.scanRunId }),
          details: { cacheKey: metadata.cacheKey },
        });
        return reply.code(200).send(
          EvaluationResponseSchema.parse({
            evaluation: cached,
            cacheHit: true,
          }),
        );
      }

      const startedAt = performance.now();
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
        saveEvaluation(
          database,
          params.data.id,
          evaluation,
          metadata,
          Math.max(0, Math.round(performance.now() - startedAt)),
        ),
      );
      return reply.code(200).send(
        EvaluationResponseSchema.parse({ evaluation, cacheHit: false }),
      );
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

  bridge.addHook("onClose", async () => {
    try {
      interruptRunningScanRuns(
        database,
        "bridge-stopped",
        "Bridge 在扫描完成前停止。",
      );
    } finally {
      if (ownsDatabase) {
        database.close();
      }
    }
  });

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
