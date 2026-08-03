import {
  bossSelectors,
  detectBossPage,
  detectBossPageBlock,
  findBossJobCardElement,
  normalizeBossDetailUrl,
  parseBossDetail,
  parseVisibleBossCards,
  scanSelectedBossDetails,
  verifyDetailIdentity,
  type BossDetailScanResult,
  type BossDetailSelection,
  type BossCardMatchMethod,
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
  failureKind:
    | 'network'
    | 'http'
    | 'missing_fields'
    | 'layout'
    | 'navigation_changed'
    | 'unknown',
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
  matchedBy?: BossCardMatchMethod;
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
    ...(input.matchedBy === undefined ? {} : { matchedBy: input.matchedBy }),
  });
}

function diagnosticTrail(
  previous: readonly DetailReadDiagnostic[] | undefined,
  diagnostic: DetailReadDiagnostic,
): DetailReadDiagnostic[] {
  return [...(previous ?? []), diagnostic].slice(-4);
}

export interface BossCardActivationSnapshot {
  href: string;
  pathname: string;
  listSignature: string;
  detailJobId: string | null;
  detailTitle: string | null;
}

export interface BossCardActivationGuard {
  before: BossCardActivationSnapshot;
  navigationFailure(): string | null;
  dispose(): void;
}

class BossNavigationChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BossNavigationChangedError';
  }
}

function currentPageUrl(document: Document, fallbackUrl: string): string {
  return document.defaultView?.location.href ?? fallbackUrl;
}

function bossSearchListSignature(document: Document, url: string): string {
  return parseVisibleBossCards(document, url)
    .map((card) =>
      [
        card.sourceJobId,
        normalizeBossDetailUrl(card.url),
        card.title,
        card.company,
      ]
        .map((value) => value ?? '')
        .join('\u001f'),
    )
    .join('\u001e');
}

function activationSnapshot(
  document: Document,
  fallbackUrl: string,
): BossCardActivationSnapshot {
  const href = currentPageUrl(document, fallbackUrl);
  const detail = parseBossDetail(document, href);
  let pathname = '';
  try {
    pathname = new URL(href).pathname;
  } catch {
    pathname = '';
  }
  return {
    href,
    pathname,
    listSignature: bossSearchListSignature(document, href),
    detailJobId: detail?.sourceJobId ?? null,
    detailTitle: detail?.title ?? null,
  };
}

function isBossSearchPath(pathname: string): boolean {
  return /^\/web\/geek\/jobs?\/?$/u.test(pathname);
}

export function activateBossCardWithoutNavigation(options: {
  document: Document;
  url: string;
  selection: BossDetailSelection;
  isContentScriptConnected?: () => boolean;
}): BossCardActivationGuard {
  const view = options.document.defaultView;
  if (view === null) {
    throw new BossNavigationChangedError(
      'BOSS 页面发生跳转，已跳过当前职位；已完成结果已保存。',
    );
  }

  const before = activationSnapshot(options.document, options.url);
  let lifecycleNavigation = false;
  let disposed = false;
  const markLifecycleNavigation = (): void => {
    lifecycleNavigation = true;
  };
  view.addEventListener('pagehide', markLifecycleNavigation, true);
  view.addEventListener('beforeunload', markLifecycleNavigation, true);

  const guard: BossCardActivationGuard = {
    before,
    navigationFailure() {
      if (
        lifecycleNavigation ||
        options.isContentScriptConnected?.() === false
      ) {
        return 'BOSS 页面发生跳转，已跳过当前职位；已完成结果已保存。';
      }
      const after = activationSnapshot(options.document, options.url);
      const pageType = detectBossPage(options.document, after.href);
      if (
        !isBossSearchPath(after.pathname) ||
        (pageType !== 'search-list' && pageType !== 'search-detail-panel') ||
        after.listSignature === ''
      ) {
        return 'BOSS 页面发生跳转，已跳过当前职位；已完成结果已保存。';
      }
      return null;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      view.removeEventListener('pagehide', markLifecycleNavigation, true);
      view.removeEventListener('beforeunload', markLifecycleNavigation, true);
    },
  };

  if (
    !isBossSearchPath(before.pathname) ||
    before.listSignature === '' ||
    options.isContentScriptConnected?.() === false
  ) {
    guard.dispose();
    throw new BossNavigationChangedError(
      'BOSS 页面发生跳转，已跳过当前职位；已完成结果已保存。',
    );
  }

  const target = options.selection.element;
  const nonLinkInteractive = Array.from(
    target.querySelectorAll(
      'button:not([disabled]), [role="button"], [tabindex]:not([tabindex="-1"])',
    ),
  ).find((element) => element.closest('a[href]') === null);
  const activationLink = target.matches('a[href]')
    ? target
    : target.querySelector('a[href]');
  const linkedNonAnchorTarget =
    activationLink?.querySelector(
      '.job-name, .job-title, [data-role="job-title"], span, div',
    ) ?? null;
  const activationTarget =
    nonLinkInteractive ?? linkedNonAnchorTarget ?? activationLink ?? target;
  const click = new view.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
  });
  if (activationLink !== null) {
    const preventTargetNavigation = (event: Event): void => {
      if (event.composedPath().includes(activationLink)) {
        event.preventDefault();
      }
    };
    options.document.addEventListener('click', preventTargetNavigation, true);
    try {
      activationTarget.dispatchEvent(click);
    } finally {
      options.document.removeEventListener(
        'click',
        preventTargetNavigation,
        true,
      );
    }
  } else {
    activationTarget.dispatchEvent(click);
  }

  const navigationFailure = guard.navigationFailure();
  if (navigationFailure !== null) {
    guard.dispose();
    throw new BossNavigationChangedError(navigationFailure);
  }
  return guard;
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

export function shouldUseLivePanelFallback(
  result: StartDetailScanResponse,
): boolean {
  return (
    result.outcome === 'failed' &&
    (result.failureKind === 'layout' || result.failureKind === 'missing_fields')
  );
}

export interface ReadBossDetailFromLivePanelOptions {
  document: Document;
  url: string;
  card: VisibleJobCard;
  timeoutMs: number;
  signal: AbortSignal;
  previousDiagnostics?: readonly DetailReadDiagnostic[];
  isContentScriptConnected?: () => boolean;
}

export async function readBossDetailFromLivePanel({
  document,
  url,
  card,
  timeoutMs,
  signal,
  previousDiagnostics,
  isContentScriptConnected,
}: ReadBossDetailFromLivePanelOptions): Promise<StartDetailScanResponse> {
  const expected = {
    sourceJobId: card.job.jobId,
    url: card.job.detailUrl,
    title: card.job.title,
    company: card.job.companyName,
  };
  const pageType = detectBossPage(document, url);
  const block = detectBossPageBlock(document, url);
  const beforeDetail = parseBossDetail(document, url);
  const diagnosticFor = (
    outcome: string,
    matchedBy?: BossCardMatchMethod,
    detail: BossJobDetail | null = parseBossDetail(
      document,
      currentPageUrl(document, url),
    ),
  ): DetailReadDiagnostic => {
    const responseUrl = currentPageUrl(document, url);
    return createDiagnostic({
      source: 'live-panel',
      card,
      responseUrl,
      httpStatus: null,
      detectedPageType: detectBossPage(document, responseUrl),
      hasDetailContainer: hasDetailContainer(document),
      missingFields: missingDetailFields(document, detail),
      outcome,
      ...(matchedBy === undefined ? {} : { matchedBy }),
    });
  };

  if (signal.aborted) {
    return StartDetailScanResponseSchema.parse({
      type: 'boss/start-detail-scan/response',
      outcome: 'cancelled',
      diagnostics: diagnosticTrail(
        previousDiagnostics,
        diagnosticFor('cancelled'),
      ),
    });
  }

  if (block !== null) {
    if (FATAL_DETAIL_BLOCKS.has(block.reason)) {
      return StartDetailScanResponseSchema.parse({
        type: 'boss/start-detail-scan/response',
        outcome: 'blocked',
        reason: block.reason,
        diagnostics: diagnosticTrail(
          previousDiagnostics,
          diagnosticFor(block.reason),
        ),
      });
    }
    return failed(
      `实时详情面板不可用：${block.reason}。`,
      'layout',
      false,
      diagnosticTrail(previousDiagnostics, diagnosticFor(block.reason)),
    );
  }

  if (pageType !== 'search-detail-panel' && pageType !== 'search-list') {
    return failed(
      `当前页面不支持实时详情面板兜底：${pageType}。`,
      'layout',
      false,
      diagnosticTrail(previousDiagnostics, diagnosticFor('unsupported_page')),
    );
  }

  const match = findBossJobCardElement(document, url, expected);
  if (match === null) {
    const diagnostic = diagnosticFor('card_not_found');
    diagnostic.missingFields = [
      ...new Set([...diagnostic.missingFields, 'job_card']),
    ];
    return failed(
      '实时详情面板中找不到对应职位卡片。',
      'layout',
      false,
      diagnosticTrail(previousDiagnostics, diagnostic),
    );
  }

  const activationState: { guard: BossCardActivationGuard | null } = {
    guard: null,
  };
  let scan: BossDetailScanResult;
  try {
    scan = await scanSelectedBossDetails({
      document,
      url,
      selections: [{ element: match.element, expected }],
      timeoutMs,
      signal,
      predicate: ({ detail }) => detail.description !== null,
      activate: (selection) => {
        activationState.guard?.dispose();
        activationState.guard = activateBossCardWithoutNavigation({
          document,
          url,
          selection,
          ...(isContentScriptConnected === undefined
            ? {}
            : { isContentScriptConnected }),
        });
      },
    });
    const navigationFailure =
      activationState.guard?.navigationFailure() ?? null;
    if (navigationFailure !== null) {
      return failed(
        navigationFailure,
        'navigation_changed',
        false,
        diagnosticTrail(
          previousDiagnostics,
          diagnosticFor('navigation_changed', match.matchedBy),
        ),
      );
    }
  } catch (error) {
    if (error instanceof BossNavigationChangedError) {
      return failed(
        error.message,
        'navigation_changed',
        false,
        diagnosticTrail(
          previousDiagnostics,
          diagnosticFor('navigation_changed', match.matchedBy),
        ),
      );
    }
    throw error;
  } finally {
    activationState.guard?.dispose();
  }
  const result = scan.entries[0]?.result;
  const currentDetail =
    result?.status === 'verified'
      ? result.detail
      : parseBossDetail(document, url) ?? beforeDetail;

  if (scan.block !== null && result === undefined) {
    if (FATAL_DETAIL_BLOCKS.has(scan.block.reason)) {
      return StartDetailScanResponseSchema.parse({
        type: 'boss/start-detail-scan/response',
        outcome: 'blocked',
        reason: scan.block.reason,
        diagnostics: diagnosticTrail(
          previousDiagnostics,
          diagnosticFor(scan.block.reason, match.matchedBy, currentDetail),
        ),
      });
    }
    return failed(
      `实时详情面板不可用：${scan.block.reason}。`,
      'layout',
      false,
      diagnosticTrail(
        previousDiagnostics,
        diagnosticFor(scan.block.reason, match.matchedBy, currentDetail),
      ),
    );
  }

  if (result?.status === 'verified') {
    const job = toJobDetail(result.detail, true, card.job);
    return job === null
      ? failed(
          '实时详情面板缺少必要字段。',
          'missing_fields',
          false,
          diagnosticTrail(
            previousDiagnostics,
            diagnosticFor('missing_fields', match.matchedBy, result.detail),
          ),
        )
      : StartDetailScanResponseSchema.parse({
          type: 'boss/start-detail-scan/response',
          outcome: 'success',
          job,
          diagnostics: diagnosticTrail(
            previousDiagnostics,
            diagnosticFor('success', match.matchedBy, result.detail),
          ),
        });
  }

  if (result?.status === 'aborted') {
    return StartDetailScanResponseSchema.parse({
      type: 'boss/start-detail-scan/response',
      outcome: 'cancelled',
      diagnostics: diagnosticTrail(
        previousDiagnostics,
        diagnosticFor('cancelled', match.matchedBy, currentDetail),
      ),
    });
  }

  if (result?.status === 'blocked') {
    return StartDetailScanResponseSchema.parse({
      type: 'boss/start-detail-scan/response',
      outcome: 'blocked',
      reason: result.block.reason,
      diagnostics: diagnosticTrail(
        previousDiagnostics,
        diagnosticFor(result.block.reason, match.matchedBy, currentDetail),
      ),
    });
  }

  if (
    result?.status === 'timeout' &&
    result.lastIdentity !== null &&
    !result.lastIdentity.verified
  ) {
    return StartDetailScanResponseSchema.parse({
      type: 'boss/start-detail-scan/response',
      outcome: 'identity_failure',
      evidence: detailEvidence(currentDetail, result.lastIdentity),
      diagnostics: diagnosticTrail(
        previousDiagnostics,
        diagnosticFor('identity_failure', match.matchedBy, currentDetail),
      ),
    });
  }

  if (currentDetail === null) {
    return failed(
      '实时详情面板未生成可解析详情。',
      'layout',
      false,
      diagnosticTrail(
        previousDiagnostics,
        diagnosticFor('layout', match.matchedBy, currentDetail),
      ),
    );
  }

  if (currentDetail.description === null) {
    return failed(
      '实时详情面板缺少职位描述。',
      'missing_fields',
      false,
      diagnosticTrail(
        previousDiagnostics,
        diagnosticFor('missing_fields', match.matchedBy, currentDetail),
      ),
    );
  }

  return StartDetailScanResponseSchema.parse({
    type: 'boss/start-detail-scan/response',
    outcome: 'timeout',
    evidence: detailEvidence(currentDetail, null),
    diagnostics: diagnosticTrail(
      previousDiagnostics,
      diagnosticFor('timeout', match.matchedBy, currentDetail),
    ),
  });
}
