import {
  BridgeErrorResponseSchema,
  BridgeSettingsSchema,
  CreateJobRequestSchema,
  DecisionRequestSchema,
  DecisionResponseSchema,
  DiagnosticEventRequestSchema,
  DiagnosticEventSchema,
  DiagnosticListResponseSchema,
  EvaluationResultSchema,
  HealthResponseSchema,
  JobListResponseSchema,
  JobResponseSchema,
  ScreenRequestSchema,
  ScreenResponseSchema,
  type CreateJobRequest,
  type DecisionRequest,
  type DecisionResponse,
  type DiagnosticEvent,
  type DiagnosticEventRequest,
  type EvaluationResult,
  type JobCard,
  type JobDetail,
  type JobHistoryEntry,
  type JobResponse,
  type Preferences,
  type ScreeningResult,
} from '@career-ops-cn/shared';

export const DEFAULT_BRIDGE_BASE_URL = 'http://127.0.0.1:3847';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface BridgeClient {
  health(signal?: AbortSignal): Promise<boolean>;
  screenJobs(jobs: readonly JobCard[], preferences?: Preferences, signal?: AbortSignal): Promise<ScreeningResult[]>;
  saveJob(job: JobDetail, signal?: AbortSignal): Promise<JobResponse>;
  evaluateJob(jobId: string, signal?: AbortSignal): Promise<EvaluationResult>;
  listJobs(signal?: AbortSignal): Promise<JobHistoryEntry[]>;
  saveDecision(jobId: string, decision: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse>;
  recordDiagnostic(event: DiagnosticEventRequest, signal?: AbortSignal): Promise<DiagnosticEvent>;
  listDiagnostics(limit?: number, signal?: AbortSignal): Promise<DiagnosticEvent[]>;
}

export interface CreateBridgeClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

interface BridgeClientErrorOptions extends ErrorOptions {
  status?: number;
  code?: string;
}

export class BridgeClientError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, options: BridgeClientErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BridgeClientError';
    this.status = options.status;
    this.code = options.code;
  }
}

export class BridgeUnavailableError extends BridgeClientError {
  constructor(baseUrl: string, options?: ErrorOptions) {
    super(`无法连接本机 Bridge（${baseUrl}），请确认 Bridge 已启动。`, options);
    this.name = 'BridgeUnavailableError';
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function toCreateJobRequest(job: JobDetail): CreateJobRequest {
  return CreateJobRequestSchema.parse({
    source: 'boss',
    sourceJobId: job.jobId,
    title: job.title,
    company: job.companyName,
    salary: job.salaryText,
    location: job.location,
    experience: job.experienceText,
    education: job.educationText,
    description: job.description,
    url: job.detailUrl,
    identityVerified: job.identityVerified,
  });
}

async function fetchBridge(
  fetchImpl: FetchLike,
  baseUrl: string,
  token: string,
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      ...(signal === undefined ? {} : { signal }),
      headers: {
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) {
      throw error;
    }
    throw new BridgeUnavailableError(baseUrl, { cause: error });
  }
}

async function readResponse(response: Response): Promise<unknown> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new BridgeClientError('Bridge 返回了无法解析的 JSON。', {
      cause: error,
      status: response.status,
    });
  }

  if (!response.ok) {
    const bridgeError = BridgeErrorResponseSchema.safeParse(payload);
    throw new BridgeClientError(
      bridgeError.success
        ? `Bridge 请求失败：${bridgeError.data.message ?? bridgeError.data.error}（HTTP ${response.status}）。`
        : `Bridge 请求失败（HTTP ${response.status}）。`,
      {
        status: response.status,
        ...(bridgeError.success ? { code: bridgeError.data.error } : {}),
      },
    );
  }

  return payload;
}

interface SafeSchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: unknown };
}

function parseBridgePayload<T>(schema: SafeSchema<T>, payload: unknown, label: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new BridgeClientError(`Bridge 返回的 ${label} 数据不符合约定。`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export function createBridgeClient({
  token,
  baseUrl = DEFAULT_BRIDGE_BASE_URL,
  fetchImpl = fetch,
}: CreateBridgeClientOptions): BridgeClient {
  const settings = BridgeSettingsSchema.parse({ bridgeToken: token });
  const normalizedBaseUrl = baseUrl.replace(/\/$/u, '');

  return {
    async health(signal) {
      const response = await fetchBridge(
        fetchImpl,
        normalizedBaseUrl,
        settings.bridgeToken,
        '/health',
        { method: 'GET' },
        signal,
      );
      return parseBridgePayload(
        HealthResponseSchema,
        await readResponse(response),
        'Health',
      ).status === 'ok';
    },

    async screenJobs(jobs, preferences, signal) {
      const request = ScreenRequestSchema.parse({
        jobs: [...jobs],
        ...(preferences === undefined ? {} : { preferences }),
      });
      const response = await fetchBridge(
        fetchImpl,
        normalizedBaseUrl,
        settings.bridgeToken,
        '/screen',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
        signal,
      );
      return parseBridgePayload(
        ScreenResponseSchema,
        await readResponse(response),
        'Screening',
      );
    },

    async saveJob(job, signal) {
      const request = toCreateJobRequest(job);
      const response = await fetchBridge(
        fetchImpl,
        normalizedBaseUrl,
        settings.bridgeToken,
        '/jobs',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
        signal,
      );

      return parseBridgePayload(JobResponseSchema, await readResponse(response), 'Job');
    },

    async evaluateJob(jobId, signal) {
      const response = await fetchBridge(
        fetchImpl,
        normalizedBaseUrl,
        settings.bridgeToken,
        `/jobs/${encodeURIComponent(jobId)}/evaluate`,
        { method: 'POST' },
        signal,
      );
      return parseBridgePayload(
        EvaluationResultSchema,
        await readResponse(response),
        'Evaluation',
      );
    },

    async listJobs(signal) {
      const response = await fetchBridge(
        fetchImpl,
        normalizedBaseUrl,
        settings.bridgeToken,
        '/jobs',
        { method: 'GET' },
        signal,
      );
      return parseBridgePayload(
        JobListResponseSchema,
        await readResponse(response),
        'Job history',
      );
    },

    async saveDecision(jobId, decision, signal) {
      const request = DecisionRequestSchema.parse(decision);
      const response = await fetchBridge(
        fetchImpl,
        normalizedBaseUrl,
        settings.bridgeToken,
        `/jobs/${encodeURIComponent(jobId)}/decision`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
        signal,
      );
      return parseBridgePayload(
        DecisionResponseSchema,
        await readResponse(response),
        'Decision',
      );
    },

    async recordDiagnostic(event, signal) {
      const request = DiagnosticEventRequestSchema.parse(event);
      const response = await fetchBridge(
        fetchImpl,
        normalizedBaseUrl,
        settings.bridgeToken,
        '/diagnostics',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
        signal,
      );
      return parseBridgePayload(
        DiagnosticEventSchema,
        await readResponse(response),
        'Diagnostic',
      );
    },

    async listDiagnostics(limit = 100, signal) {
      const response = await fetchBridge(
        fetchImpl,
        normalizedBaseUrl,
        settings.bridgeToken,
        `/diagnostics?limit=${encodeURIComponent(String(limit))}`,
        { method: 'GET' },
        signal,
      );
      return parseBridgePayload(
        DiagnosticListResponseSchema,
        await readResponse(response),
        'Diagnostics',
      );
    },
  };
}
