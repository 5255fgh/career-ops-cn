import {
  bossSelectors,
  detectBossPage,
  detectBossPageBlock,
  parseBossDetail,
  verifyStrictDetailIdentity,
  type BossIdentityVerification,
  type BossJobCard,
  type BossJobDetail,
} from '@career-ops-cn/boss-adapter';
import {
  DetailReadDiagnosticSchema,
  JobCardSchema,
  JobDetailSchema,
  StartDetailScanResponseSchema,
  type DetailReadDiagnostic,
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
  diagnostics?: readonly DetailReadDiagnostic[],
): StartDetailScanResponse {
  return StartDetailScanResponseSchema.parse({
    type: 'boss/start-detail-scan/response',
    outcome: 'failed',
    message,
    failureKind,
    retryable,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });
}

function sanitizeDiagnosticUrl(value: string | null): string | null {
  if (value === null || value === '') {
    return null;
  }
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function hasDetailContainer(document: Document): boolean {
  return bossSelectors.page.detailContainers.some(
    (selector) => document.querySelector(selector) !== null,
  );
}

function missingDetailFields(
  document: Document,
  detail: BossJobDetail | null,
): string[] {
  if (!hasDetailContainer(document)) {
    return ['detail_container'];
  }
  if (detail === null) {
    return ['detail'];
  }
  return detail.warnings.map((warning) =>
    warning.startsWith('missing_') ? warning.slice('missing_'.length) : warning,
  );
}

function createDiagnostic(input: {
  source: 'fetch' | 'live-panel';
  card: VisibleJobCard;
  responseUrl: string | null;
  httpStatus: number | null;
  detectedPageType: ReturnType<typeof detectBossPage> | null;
  hasDetailContainer: boolean;
  missingFields: readonly string[];
  outcome: string;
}): DetailReadDiagnostic {
  const detailUrl =
    sanitizeDiagnosticUrl(input.card.job.detailUrl) ??
    input.card.job.detailUrl;
  return DetailReadDiagnosticSchema.parse({
    source: input.source,
    sourceJobId: input.card.job.jobId,
    detailUrl,
    responseUrl: sanitizeDiagnosticUrl(input.responseUrl),
    httpStatus: input.httpStatus,
    detectedPageType: input.detectedPageType,
    hasDetailContainer: input.hasDetailContainer,
    missingFields: [...input.missingFields],
    outcome: input.outcome,
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
  rawDetailUrl: string;
  timeoutMs: number;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  parseDocument?: (html: string) => Document;
}

export async function fetchBossDetail({
  card,
  rawDetailUrl,
  timeoutMs,
  signal,
  fetchImpl = fetch,
  parseDocument = (html) => new DOMParser().parseFromString(html, 'text/html'),
}: FetchBossDetailOptions): Promise<StartDetailScanResponse> {
  if (signal.aborted) {
    const diagnostic = createDiagnostic({
      source: 'fetch',
      card,
      responseUrl: null,
      httpStatus: null,
      detectedPageType: null,
      hasDetailContainer: false,
      missingFields: [],
      outcome: 'cancelled',
    });
    return StartDetailScanResponseSchema.parse({
      type: 'boss/start-detail-scan/response',
      outcome: 'cancelled',
      diagnostics: [diagnostic],
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
      fetchImpl(rawDetailUrl, {
        method: 'GET',
        credentials: 'include',
        redirect: 'follow',
        signal: requestController.signal,
      }),
      interrupted,
    ]);
    const html = await Promise.race([response.text(), interrupted]);
    const responseUrl = response.url === '' ? rawDetailUrl : response.url;
    const detailDocument = parseDocument(html);
    const pageType = detectBossPage(detailDocument, responseUrl);
    const block = detectBossPageBlock(detailDocument, responseUrl);
    const detail = parseBossDetail(detailDocument, responseUrl);
    const diagnosticFor = (outcome: string): DetailReadDiagnostic =>
      createDiagnostic({
        source: 'fetch',
        card,
        responseUrl,
        httpStatus: response.status,
        detectedPageType: pageType,
        hasDetailContainer: hasDetailContainer(detailDocument),
        missingFields: missingDetailFields(detailDocument, detail),
        outcome,
      });

    if (block !== null && FATAL_DETAIL_BLOCKS.has(block.reason)) {
      return StartDetailScanResponseSchema.parse({
        type: 'boss/start-detail-scan/response',
        outcome: 'blocked',
        reason: block.reason,
        diagnostics: [diagnosticFor(block.reason)],
      });
    }
    if (!response.ok) {
      return failed(
        `职位详情请求失败（HTTP ${response.status}）。`,
        'http',
        TRANSIENT_HTTP_STATUSES.has(response.status),
        [diagnosticFor(`http_${response.status}`)],
      );
    }
    if (block !== null) {
      return failed(
        `单个职位详情布局异常：${block.reason}。`,
        'layout',
        false,
        [diagnosticFor(block.reason)],
      );
    }

    if (detail === null) {
      return failed('单个职位详情布局无法识别。', 'layout', false, [
        diagnosticFor('layout'),
      ]);
    }
    const identity = verifyStrictDetailIdentity({
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
        diagnostics: [diagnosticFor('identity_failure')],
      });
    }

    const job = toJobDetail(detail, true, card.job);
    return job === null
      ? failed('职位详情缺少必要字段。', 'missing_fields', false, [
          diagnosticFor('missing_fields'),
        ])
      : StartDetailScanResponseSchema.parse({
          type: 'boss/start-detail-scan/response',
          outcome: 'success',
          job,
          diagnostics: [diagnosticFor('success')],
        });
  } catch (error) {
    const diagnostic = createDiagnostic({
      source: 'fetch',
      card,
      responseUrl: null,
      httpStatus: null,
      detectedPageType: null,
      hasDetailContainer: false,
      missingFields: [],
      outcome: timedOut ? 'timeout' : signal.aborted ? 'cancelled' : 'network',
    });
    if (timedOut) {
      return StartDetailScanResponseSchema.parse({
        type: 'boss/start-detail-scan/response',
        outcome: 'timeout',
        diagnostics: [diagnostic],
      });
    }
    if (signal.aborted) {
      return StartDetailScanResponseSchema.parse({
        type: 'boss/start-detail-scan/response',
        outcome: 'cancelled',
        diagnostics: [diagnostic],
      });
    }
    return failed(
      `职位详情网络请求失败：${error instanceof Error ? error.message : '未知网络错误。'}`,
      'network',
      true,
      [diagnostic],
    );
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    signal.removeEventListener('abort', onAbort);
    rejectInterrupt = undefined;
  }
}
