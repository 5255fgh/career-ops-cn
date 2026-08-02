import {
  detectBossPageBlock,
  parseBossDetail,
  verifyDetailIdentity,
  type BossIdentityVerification,
  type BossJobCard,
  type BossJobDetail,
} from '@career-ops-cn/boss-adapter';
import {
  JobCardSchema,
  JobDetailSchema,
  StartDetailScanResponseSchema,
  type JobCard,
  type JobDetail,
  type StartDetailScanResponse,
  type VisibleJobCard,
} from '@career-ops-cn/shared';

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const FATAL_DETAIL_BLOCKS = new Set([
  'login_required',
  'challenge',
  'account_risk',
]);

export const JOB_CARD_FIELDS = [
  'jobId',
  'title',
  'companyName',
  'salaryText',
  'location',
  'experienceText',
  'educationText',
  'detailUrl',
] as const;

export type JobCardField = (typeof JOB_CARD_FIELDS)[number];

export function toJobCard(card: BossJobCard): {
  job: JobCard | null;
  invalidFields: JobCardField[];
} {
  const parsed = JobCardSchema.safeParse({
    jobId: card.sourceJobId,
    title: card.title,
    companyName: card.company,
    ...(card.salaryRaw === null ? {} : { salaryText: card.salaryRaw }),
    ...(card.city === null ? {} : { location: card.city }),
    ...(card.experience === null
      ? {}
      : { experienceText: card.experience }),
    ...(card.education === null
      ? {}
      : { educationText: card.education }),
    detailUrl: card.url,
  });
  if (parsed.success) {
    return { job: parsed.data, invalidFields: [] };
  }

  const invalidFields = new Set<JobCardField>();
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (
      typeof field === 'string' &&
      JOB_CARD_FIELDS.includes(field as JobCardField)
    ) {
      invalidFields.add(field as JobCardField);
    }
  }
  return { job: null, invalidFields: [...invalidFields] };
}

export function toJobDetail(
  detail: BossJobDetail,
  identityVerified: boolean,
  fallback?: JobCard,
): JobDetail | null {
  const parsed = JobDetailSchema.safeParse({
    jobId: detail.sourceJobId ?? fallback?.jobId,
    title: detail.title ?? fallback?.title,
    companyName: detail.company ?? fallback?.companyName,
    salaryText: detail.salaryRaw ?? fallback?.salaryText,
    location: detail.city ?? fallback?.location,
    experienceText: detail.experience ?? fallback?.experienceText,
    educationText: detail.education ?? fallback?.educationText,
    detailUrl: detail.url ?? fallback?.detailUrl,
    description: detail.description,
    identityVerified,
  });
  return parsed.success ? parsed.data : null;
}

function detailEvidence(
  detail: BossJobDetail | null,
  identity: BossIdentityVerification | null,
) {
  return {
    detailFound: detail !== null,
    ...(detail?.sourceJobId === null || detail?.sourceJobId === undefined
      ? {}
      : { actualJobId: detail.sourceJobId }),
    ...(detail?.title === null || detail?.title === undefined
      ? {}
      : { actualTitle: detail.title }),
    ...(identity === null ? {} : { signals: identity.signals }),
  };
}

function failed(
  message: string,
  failureKind: 'network' | 'http' | 'missing_fields' | 'layout' | 'unknown',
  retryable: boolean,
): StartDetailScanResponse {
  return StartDetailScanResponseSchema.parse({
    type: 'boss/start-detail-scan/response',
    outcome: 'failed',
    message,
    failureKind,
    retryable,
  });
}

function timeoutError(): DOMException {
  return new DOMException('职位详情请求超时。', 'TimeoutError');
}

function cancelError(): DOMException {
  return new DOMException('职位详情请求已取消。', 'AbortError');
}

export interface FetchBossDetailOptions {
  card: VisibleJobCard;
  timeoutMs: number;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  parseDocument?: (html: string) => Document;
}

export async function fetchBossDetail({
  card,
  timeoutMs,
  signal,
  fetchImpl = fetch,
  parseDocument = (html) => new DOMParser().parseFromString(html, 'text/html'),
}: FetchBossDetailOptions): Promise<StartDetailScanResponse> {
  if (signal.aborted) {
    return StartDetailScanResponseSchema.parse({
      type: 'boss/start-detail-scan/response',
      outcome: 'cancelled',
    });
  }

  const requestController = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectInterrupt: ((reason: unknown) => void) | undefined;
  const onAbort = (): void => {
    requestController.abort(signal.reason ?? cancelError());
    rejectInterrupt?.(cancelError());
  };
  signal.addEventListener('abort', onAbort, { once: true });

  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupt = reject;
    timer = setTimeout(() => {
      timedOut = true;
      const error = timeoutError();
      requestController.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      fetchImpl(card.job.detailUrl, {
        method: 'GET',
        credentials: 'include',
        redirect: 'follow',
        signal: requestController.signal,
      }),
      interrupted,
    ]);
    const html = await Promise.race([response.text(), interrupted]);
    const responseUrl = response.url === '' ? card.job.detailUrl : response.url;
    const detailDocument = parseDocument(html);
    const block = detectBossPageBlock(detailDocument, responseUrl);

    if (block !== null && FATAL_DETAIL_BLOCKS.has(block.reason)) {
      return StartDetailScanResponseSchema.parse({
        type: 'boss/start-detail-scan/response',
        outcome: 'blocked',
        reason: block.reason,
      });
    }
    if (!response.ok) {
      return failed(
        `职位详情请求失败（HTTP ${response.status}）。`,
        'http',
        TRANSIENT_HTTP_STATUSES.has(response.status),
      );
    }
    if (block !== null) {
      return failed(`单个职位详情布局异常：${block.reason}。`, 'layout', false);
    }

    const detail = parseBossDetail(detailDocument, responseUrl);
    if (detail === null) {
      return failed('单个职位详情布局无法识别。', 'layout', false);
    }
    const identity = verifyDetailIdentity({
      expected: {
        sourceJobId: card.job.jobId,
        url: card.job.detailUrl,
        title: card.job.title,
        company: card.job.companyName,
      },
      detail,
    });
    if (!identity.verified) {
      return StartDetailScanResponseSchema.parse({
        type: 'boss/start-detail-scan/response',
        outcome: 'identity_failure',
        evidence: detailEvidence(detail, identity),
      });
    }

    const job = toJobDetail(detail, true, card.job);
    return job === null
      ? failed('职位详情缺少必要字段。', 'missing_fields', false)
      : StartDetailScanResponseSchema.parse({
          type: 'boss/start-detail-scan/response',
          outcome: 'success',
          job,
        });
  } catch (error) {
    if (timedOut) {
      return StartDetailScanResponseSchema.parse({
        type: 'boss/start-detail-scan/response',
        outcome: 'timeout',
      });
    }
    if (signal.aborted) {
      return StartDetailScanResponseSchema.parse({
        type: 'boss/start-detail-scan/response',
        outcome: 'cancelled',
      });
    }
    return failed(
      `职位详情网络请求失败：${error instanceof Error ? error.message : '未知网络错误。'}`,
      'network',
      true,
    );
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    signal.removeEventListener('abort', onAbort);
    rejectInterrupt = undefined;
  }
}
