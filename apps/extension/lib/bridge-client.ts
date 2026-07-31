import {
  BridgeSettingsSchema,
  CreateJobRequestSchema,
  EvaluationResultSchema,
  JobResponseSchema,
  type CreateJobRequest,
  type EvaluationResult,
  type JobDetail,
  type JobResponse,
} from '@career-ops-cn/shared';

export const DEFAULT_BRIDGE_BASE_URL = 'http://127.0.0.1:3210';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface BridgeClient {
  saveJob(job: JobDetail): Promise<JobResponse>;
  evaluateJob(jobId: string): Promise<EvaluationResult>;
}

export interface CreateBridgeClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export class BridgeClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BridgeClientError';
  }
}

export class BridgeUnavailableError extends BridgeClientError {
  constructor(baseUrl: string, options?: ErrorOptions) {
    super(`无法连接本机 Bridge（${baseUrl}），请确认 Bridge 已启动。`, options);
    this.name = 'BridgeUnavailableError';
  }
}

export function toCreateJobRequest(job: JobDetail): CreateJobRequest {
  return CreateJobRequestSchema.parse({
    source: 'boss',
    sourceJobId: job.jobId,
    title: job.title,
    company: job.companyName,
    salary: job.salaryText,
    location: job.location,
    description: job.description,
    url: job.detailUrl,
  });
}

async function fetchBridge(
  fetchImpl: FetchLike,
  baseUrl: string,
  token: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });
  } catch (error) {
    throw new BridgeUnavailableError(baseUrl, { cause: error });
  }
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new BridgeClientError(`Bridge 请求失败（HTTP ${response.status}）。`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new BridgeClientError('Bridge 返回了无法解析的 JSON。', { cause: error });
  }
}

export function createBridgeClient({
  token,
  baseUrl = DEFAULT_BRIDGE_BASE_URL,
  fetchImpl = fetch,
}: CreateBridgeClientOptions): BridgeClient {
  const settings = BridgeSettingsSchema.parse({ bridgeToken: token });
  const normalizedBaseUrl = baseUrl.replace(/\/$/u, '');

  return {
    async saveJob(job) {
      const request = toCreateJobRequest(job);
      const response = await fetchBridge(fetchImpl, normalizedBaseUrl, settings.bridgeToken, '/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

      const parsed = JobResponseSchema.safeParse(await readResponse(response));
      if (!parsed.success) {
        throw new BridgeClientError('Bridge 返回的 Job 数据不符合约定。', {
          cause: parsed.error,
        });
      }

      return parsed.data;
    },

    async evaluateJob(jobId) {
      const response = await fetchBridge(
        fetchImpl,
        normalizedBaseUrl,
        settings.bridgeToken,
        `/jobs/${encodeURIComponent(jobId)}/evaluate`,
        { method: 'POST' },
      );

      const parsed = EvaluationResultSchema.safeParse(await readResponse(response));
      if (!parsed.success) {
        throw new BridgeClientError('Bridge 返回的 Evaluation 数据不符合约定。', {
          cause: parsed.error,
        });
      }

      return parsed.data;
    },
  };
}
