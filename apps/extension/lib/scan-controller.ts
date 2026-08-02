import {
  ScanConfigSchema,
  type BossPageBlockReason,
  type DecisionResponse,
  type DiagnosticEventRequest,
  type EvaluationResult,
  type JobCard,
  type JobDetail,
  type JobHistoryEntry,
  type JobResponse,
  type ScanConfig,
  type ScreeningResult,
  type StartDetailScanResponse,
  type VisibleJobCard,
} from '@career-ops-cn/shared';

import { isAbortError, type BridgeClient } from './bridge-client';
import type { ContentClient } from './content-client';

export const DEFAULT_SCAN_CONFIG: ScanConfig = Object.freeze({
  maxPages: 3,
  maxNewJobs: 60,
  maxAiJobs: 30,
  detailTimeoutMs: 8_000,
  requestIntervalMs: 1_800,
  maxRoundMs: 10 * 60_000,
});

const CONSECUTIVE_PARSER_FAILURE_LIMIT = 3;
const DIAGNOSTIC_TIMEOUT_MS = 2_000;

export type ScanStatus =
  | 'idle'
  | 'reading-list'
  | 'screening'
  | 'reading-details'
  | 'evaluating'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type ScanStopReason =
  | BossPageBlockReason
  | 'parser_failure_limit'
  | 'page_navigation_failed'
  | 'page_limit'
  | 'new_job_limit'
  | 'no_new_jobs'
  | 'end_of_results'
  | 'round_time_limit';

export interface ScanProgress {
  pagesVisited: number;
  listJobs: number;
  newJobs: number;
  screenedJobs: number;
  detailCompleted: number;
  detailTarget: number;
  aiCompleted: number;
  aiTarget: number;
}

export interface ScannedJob {
  card: VisibleJobCard;
  preScreening?: ScreeningResult;
  screening?: ScreeningResult;
  detail?: JobDetail;
  savedJob?: JobResponse;
  evaluation?: EvaluationResult;
  decision?: DecisionResponse;
  detailError?: string;
  evaluationError?: string;
}

export interface ScanState {
  status: ScanStatus;
  progress: ScanProgress;
  results: ScannedJob[];
  stopReason: ScanStopReason | null;
  error: string | null;
  warnings: string[];
}

export interface ScanControllerOptions {
  content: ContentClient;
  bridge: BridgeClient;
  config?: Partial<ScanConfig>;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

export interface ScanRunOptions {
  maxPages?: number;
  maxNewJobs?: number;
  maxAiJobs?: number;
  maxRoundMs?: number;
}

export type ScanStateListener = (state: ScanState) => void;

const ACTIVE_STATUSES = new Set<ScanStatus>([
  'reading-list',
  'screening',
  'reading-details',
  'evaluating',
]);

const FATAL_PAGE_BLOCKS = new Set<BossPageBlockReason>([
  'login_required',
  'challenge',
  'account_risk',
  'unsupported_layout',
  'empty_page',
]);

function emptyProgress(): ScanProgress {
  return {
    pagesVisited: 0,
    listJobs: 0,
    newJobs: 0,
    screenedJobs: 0,
    detailCompleted: 0,
    detailTarget: 0,
    aiCompleted: 0,
    aiTarget: 0,
  };
}

function abortError(): DOMException {
  return new DOMException('扫描已取消。', 'AbortError');
}

function roundTimeoutError(): DOMException {
  return new DOMException('本轮扫描已达到最长运行时间。', 'TimeoutError');
}

async function defaultDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (milliseconds === 0) {
    return;
  }
  if (signal.aborted) {
    throw abortError();
  }

  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '扫描流程发生未知错误。';
}

function visibleCardFromDetail(detail: JobDetail): VisibleJobCard {
  return {
    index: 0,
    job: {
      jobId: detail.jobId,
      title: detail.title,
      companyName: detail.companyName,
      ...(detail.salaryText === undefined
        ? {}
        : { salaryText: detail.salaryText }),
      ...(detail.location === undefined ? {} : { location: detail.location }),
      ...(detail.experienceText === undefined
        ? {}
        : { experienceText: detail.experienceText }),
      ...(detail.educationText === undefined
        ? {}
        : { educationText: detail.educationText }),
      detailUrl: detail.detailUrl,
    },
  };
}

function normalizeDetailUrl(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  try {
    const parsed = new URL(value);
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/';
    return parsed.toString();
  } catch {
    return null;
  }
}

function jobKeys(job: Pick<JobCard, 'jobId' | 'detailUrl'>): string[] {
  const normalizedUrl = normalizeDetailUrl(job.detailUrl);
  return [
    `id:${job.jobId}`,
    ...(normalizedUrl === null ? [] : [`url:${normalizedUrl}`]),
  ];
}

function historyKeys(job: JobHistoryEntry): string[] {
  const normalizedUrl = normalizeDetailUrl(job.url ?? null);
  return [
    ...(job.sourceJobId === undefined ? [] : [`id:${job.sourceJobId}`]),
    ...(normalizedUrl === null ? [] : [`url:${normalizedUrl}`]),
  ];
}

function parserFailureKind(
  result: StartDetailScanResponse,
): string | null {
  if (result.outcome === 'identity_failure') {
    return 'identity_failure';
  }
  if (
    result.outcome === 'failed' &&
    (result.failureKind === 'layout' || result.failureKind === 'missing_fields')
  ) {
    return result.failureKind;
  }
  return null;
}

export class ScanController {
  readonly config: ScanConfig;
  private readonly content: ContentClient;
  private readonly bridge: BridgeClient;
  private readonly delay: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private readonly random: () => number;
  private readonly listeners = new Set<ScanStateListener>();
  private abortController: AbortController | null = null;
  private currentScanId: string | null = null;
  private diagnosticError: string | null = null;
  private hasIssuedBossRequest = false;
  private currentState: ScanState = {
    status: 'idle',
    progress: emptyProgress(),
    results: [],
    stopReason: null,
    error: null,
    warnings: [],
  };

  constructor(options: ScanControllerOptions) {
    this.content = options.content;
    this.bridge = options.bridge;
    this.config = ScanConfigSchema.parse({
      ...DEFAULT_SCAN_CONFIG,
      ...options.config,
    });
    this.delay = options.delay ?? defaultDelay;
    this.random = options.random ?? Math.random;
  }

  get state(): ScanState {
    return this.currentState;
  }

  subscribe(listener: ScanStateListener): () => void {
    this.listeners.add(listener);
    listener(this.currentState);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private update(patch: Partial<ScanState>): void {
    this.currentState = { ...this.currentState, ...patch };
    for (const listener of this.listeners) {
      listener(this.currentState);
    }
  }

  private updateProgress(patch: Partial<ScanProgress>): void {
    this.update({
      progress: { ...this.currentState.progress, ...patch },
    });
  }

  private updateResult(jobId: string, patch: Partial<ScannedJob>): void {
    this.update({
      results: this.currentState.results.map((result) =>
        result.card.job.jobId === jobId ? { ...result, ...patch } : result,
      ),
    });
  }

  private appendDetailError(jobId: string, message: string): void {
    const result = this.currentState.results.find(
      (candidate) => candidate.card.job.jobId === jobId,
    );
    this.updateResult(jobId, {
      detailError:
        result?.detailError === undefined
          ? message
          : `${result.detailError}；${message}`,
    });
  }

  private addWarning(message: string): void {
    if (!this.currentState.warnings.includes(message)) {
      this.update({ warnings: [...this.currentState.warnings, message] });
    }
  }

  private stop(reason: ScanStopReason, message: string): void {
    this.update({ status: 'failed', stopReason: reason, error: message });
  }

  private complete(reason: ScanStopReason): void {
    this.update({ status: 'completed', stopReason: reason, error: null });
  }

  private async diagnose(
    event: Omit<DiagnosticEventRequest, 'source' | 'scanId'>,
  ): Promise<void> {
    if (this.currentScanId === null || this.diagnosticError !== null) {
      return;
    }

    const controller = new AbortController();
    let rejectTimeout: ((reason: unknown) => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      controller.abort();
      rejectTimeout?.(new Error('diagnostics 写入超时。'));
    }, DIAGNOSTIC_TIMEOUT_MS);
    try {
      await Promise.race([
        this.bridge.recordDiagnostic(
          {
            source: 'extension',
            scanId: this.currentScanId,
            ...event,
          },
          controller.signal,
        ),
        timeout,
      ]);
    } catch (error) {
      this.diagnosticError = errorMessage(error);
      this.addWarning(`diagnostics 写入失败：${this.diagnosticError}`);
    } finally {
      clearTimeout(timer);
      rejectTimeout = undefined;
    }
  }

  private async beforeBossRequest(signal: AbortSignal): Promise<void> {
    if (!this.hasIssuedBossRequest) {
      this.hasIssuedBossRequest = true;
      return;
    }
    const sample = Math.min(1, Math.max(0, this.random()));
    const milliseconds = Math.round(
      this.config.requestIntervalMs * (0.8 + sample * 0.4),
    );
    await this.delay(milliseconds, signal);
  }

  private async readDetailWithRetry(
    card: VisibleJobCard,
    signal: AbortSignal,
  ): Promise<StartDetailScanResponse> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await this.beforeBossRequest(signal);
      const result = await this.content.startDetailScan(
        card,
        this.config.detailTimeoutMs,
        signal,
      );
      if (
        result.outcome !== 'failed' ||
        !result.retryable ||
        attempt === 2
      ) {
        return result;
      }
      await this.diagnose({
        level: 'warning',
        event: 'detail_retry',
        expectedJobId: card.job.jobId,
        expectedTitle: card.job.title,
        outcome: result.failureKind,
        message: result.message,
        details: { nextAttempt: attempt + 1 },
      });
    }
    throw new Error('详情重试流程出现不可达状态。');
  }

  private async recordDetailDiagnostic(
    card: VisibleJobCard,
    result: StartDetailScanResponse,
  ): Promise<void> {
    await this.diagnose({
      level:
        result.outcome === 'success'
          ? 'info'
          : result.outcome === 'cancelled'
            ? 'warning'
            : 'error',
      event: 'detail_mapping',
      expectedJobId: card.job.jobId,
      expectedTitle: card.job.title,
      ...(result.outcome === 'success'
        ? {
            actualJobId: result.job.jobId,
            actualTitle: result.job.title,
          }
        : result.outcome === 'timeout' || result.outcome === 'identity_failure'
          ? {
              ...(result.evidence?.actualJobId === undefined
                ? {}
                : { actualJobId: result.evidence.actualJobId }),
              ...(result.evidence?.actualTitle === undefined
                ? {}
                : { actualTitle: result.evidence.actualTitle }),
            }
          : {}),
      outcome: result.outcome,
      ...(result.outcome === 'failed' ? { message: result.message } : {}),
      ...(result.outcome === 'blocked'
        ? {
            message: `页面已停止扫描：${result.reason}`,
            details: { blockReason: result.reason },
          }
        : {}),
      ...(result.outcome === 'timeout' || result.outcome === 'identity_failure'
        ? {
            details: {
              detailFound: result.evidence?.detailFound ?? false,
              signalJobIdentity:
                result.evidence?.signals?.jobIdentity ?? null,
              signalTitle: result.evidence?.signals?.title ?? null,
              signalCompany: result.evidence?.signals?.company ?? null,
              signalActiveCard:
                result.evidence?.signals?.activeCard ?? null,
              signalContentChanged:
                result.evidence?.signals?.contentChanged ?? null,
            },
          }
        : {}),
    });
  }

  private async processStandaloneDetail(
    controller: AbortController,
    maxAiJobs: number,
  ): Promise<ScanState> {
    this.update({ status: 'reading-details' });
    this.updateProgress({ pagesVisited: 1, detailTarget: 1 });
    const detail = await this.content.extractCurrentDetail(controller.signal);
    this.updateProgress({
      listJobs: detail === null ? 0 : 1,
      newJobs: detail === null ? 0 : 1,
      detailCompleted: 1,
    });

    if (detail === null) {
      this.addWarning('当前职位详情缺少必要字段。');
      await this.diagnose({
        level: 'error',
        event: 'detail_mapping',
        outcome: 'missing_fields',
        message: '当前职位详情缺少必要字段。',
      });
      this.complete('end_of_results');
      return this.currentState;
    }

    const card = visibleCardFromDetail(detail);
    this.update({ results: [{ card, detail }] });
    if (!detail.identityVerified) {
      this.appendDetailError(detail.jobId, '职位详情身份校验失败。');
      await this.diagnose({
        level: 'error',
        event: 'detail_mapping',
        expectedJobId: detail.jobId,
        actualJobId: detail.jobId,
        expectedTitle: detail.title,
        actualTitle: detail.title,
        outcome: 'identity_failure',
      });
      this.complete('end_of_results');
      return this.currentState;
    }

    let screening: ScreeningResult | undefined;
    try {
      [screening] = await this.bridge.screenJobs(
        [detail],
        undefined,
        controller.signal,
        'detail',
      );
      if (screening !== undefined) {
        this.updateResult(detail.jobId, { screening });
        this.updateProgress({ screenedJobs: 1 });
      }
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw error;
      }
      this.appendDetailError(
        detail.jobId,
        `完整筛选失败：${errorMessage(error)}`,
      );
    }

    let savedJob: JobResponse | undefined;
    try {
      savedJob = await this.bridge.saveJob(detail, controller.signal);
      this.updateResult(detail.jobId, { savedJob });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw error;
      }
      this.appendDetailError(detail.jobId, `保存职位失败：${errorMessage(error)}`);
    }

    if (screening?.matched === true && savedJob !== undefined && maxAiJobs > 0) {
      this.update({ status: 'evaluating' });
      this.updateProgress({ aiTarget: 1 });
      try {
        const evaluation = await this.bridge.evaluateJob(
          savedJob.id,
          controller.signal,
        );
        this.updateResult(detail.jobId, { evaluation });
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          throw error;
        }
        this.updateResult(detail.jobId, { evaluationError: errorMessage(error) });
      }
      this.updateProgress({ aiCompleted: 1 });
    }

    this.complete('end_of_results');
    return this.currentState;
  }

  async run(options: ScanRunOptions = {}): Promise<ScanState> {
    if (ACTIVE_STATUSES.has(this.currentState.status)) {
      throw new Error('扫描已在进行中。');
    }

    const controller = new AbortController();
    this.abortController = controller;
    this.currentScanId = globalThis.crypto.randomUUID();
    this.diagnosticError = null;
    this.hasIssuedBossRequest = false;
    const maxPages = options.maxPages ?? this.config.maxPages;
    const maxNewJobs = options.maxNewJobs ?? this.config.maxNewJobs;
    const maxAiJobs = options.maxAiJobs ?? this.config.maxAiJobs;
    const maxRoundMs = options.maxRoundMs ?? this.config.maxRoundMs;
    let deadlineReached = false;
    const deadlineTimer = setTimeout(() => {
      deadlineReached = true;
      controller.abort(roundTimeoutError());
    }, maxRoundMs);

    this.update({
      status: 'reading-list',
      progress: emptyProgress(),
      results: [],
      stopReason: null,
      error: null,
      warnings: [],
    });

    try {
      const firstPage = await this.content.detectPage(controller.signal);
      if (
        firstPage.block !== null &&
        FATAL_PAGE_BLOCKS.has(firstPage.block.reason)
      ) {
        this.stop(
          firstPage.block.reason,
          `页面已停止扫描：${firstPage.block.reason}`,
        );
        await this.diagnose({
          level: 'warning',
          event: 'page_detected',
          outcome: firstPage.pageType,
          details: { block: firstPage.block.reason },
        });
        await this.diagnose({
          level: 'warning',
          event: 'scan_stopped',
          outcome: firstPage.block.reason,
          message: `页面已停止扫描：${firstPage.block.reason}`,
        });
        return this.currentState;
      }

      await this.diagnose({
        level: 'info',
        event: 'scan_started',
        details: { maxPages, maxNewJobs, maxAiJobs, maxRoundMs },
      });
      await this.diagnose({
        level: firstPage.block === null ? 'info' : 'warning',
        event: 'page_detected',
        outcome: firstPage.pageType,
        details: { block: firstPage.block?.reason ?? null },
      });
      if (firstPage.pageType === 'job-detail') {
        return await this.processStandaloneDetail(controller, maxAiJobs);
      }

      const knownKeys = new Set<string>();
      try {
        const history = await this.bridge.listJobs(controller.signal);
        for (const job of history) {
          for (const key of historyKeys(job)) {
            knownKeys.add(key);
          }
        }
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          throw error;
        }
        this.addWarning(`历史职位去重不可用：${errorMessage(error)}`);
      }

      let consecutiveNoNewPages = 0;
      let consecutiveParserFailureKind: string | null = null;
      let consecutiveParserFailures = 0;
      let discoveryStopReason: ScanStopReason = 'page_limit';

      discovery: while (this.currentState.progress.pagesVisited < maxPages) {
        if (controller.signal.aborted) {
          throw controller.signal.reason ?? abortError();
        }

        const page =
          this.currentState.progress.pagesVisited === 0
            ? firstPage
            : await this.content.detectPage(controller.signal);
        if (page.block !== null && FATAL_PAGE_BLOCKS.has(page.block.reason)) {
          this.stop(page.block.reason, `页面已停止扫描：${page.block.reason}`);
          await this.diagnose({
            level: 'warning',
            event: 'scan_stopped',
            outcome: page.block.reason,
            message: `页面已停止扫描：${page.block.reason}`,
          });
          return this.currentState;
        }
        if (
          page.pageType !== 'search-list' &&
          page.pageType !== 'search-detail-panel' &&
          page.pageType !== 'company-job-list'
        ) {
          this.stop('unsupported_layout', '搜索页面整体无法识别。');
          return this.currentState;
        }

        this.update({ status: 'reading-list' });
        const visible = await this.content.extractVisibleCards(
          controller.signal,
        );
        const nextPagesVisited = this.currentState.progress.pagesVisited + 1;
        this.updateProgress({
          pagesVisited: nextPagesVisited,
          listJobs: this.currentState.progress.listJobs + visible.totalVisible,
        });
        await this.diagnose({
          level:
            visible.cards.length === 0 && visible.invalidCount > 0
              ? 'error'
              : 'info',
          event: 'visible_cards_extracted',
          outcome:
            visible.cards.length === 0
              ? visible.invalidCount > 0
                ? 'parser_failure'
                : 'empty'
              : 'success',
          details: {
            page: nextPagesVisited,
            totalVisible: visible.totalVisible,
            validCards: visible.cards.length,
            invalidCards: visible.invalidCount,
            ...Object.fromEntries(
              Object.entries(visible.invalidFieldCounts ?? {}).map(
                ([field, count]) => [`invalid_${field}`, count],
              ),
            ),
          },
        });
        if (visible.cards.length === 0 && visible.invalidCount > 0) {
          this.stop('unsupported_layout', '搜索页职位卡片整体无法识别。');
          return this.currentState;
        }

        const remainingBudget = maxNewJobs - this.currentState.progress.newJobs;
        const pageCards: VisibleJobCard[] = [];
        for (const card of visible.cards) {
          const keys = jobKeys(card.job);
          if (keys.some((key) => knownKeys.has(key))) {
            continue;
          }
          for (const key of keys) {
            knownKeys.add(key);
          }
          pageCards.push(card);
          if (pageCards.length >= remainingBudget) {
            break;
          }
        }

        consecutiveNoNewPages =
          pageCards.length === 0 ? consecutiveNoNewPages + 1 : 0;
        if (pageCards.length > 0) {
          this.update({
            results: [
              ...this.currentState.results,
              ...pageCards.map((card) => ({ card })),
            ],
          });
          this.updateProgress({
            newJobs: this.currentState.progress.newJobs + pageCards.length,
          });

          this.update({ status: 'screening' });
          const screenings = await this.bridge.screenJobs(
            pageCards.map(({ job }) => job),
            undefined,
            controller.signal,
            'list',
          );
          const screeningById = new Map(
            screenings.map((result) => [result.jobId, result]),
          );
          for (const card of pageCards) {
            const screening = screeningById.get(card.job.jobId);
            if (screening === undefined) {
              this.appendDetailError(
                card.job.jobId,
                '列表预筛未返回该职位结果。',
              );
            } else {
              this.updateResult(card.job.jobId, { preScreening: screening });
            }
          }
          this.updateProgress({
            screenedJobs:
              this.currentState.progress.screenedJobs + pageCards.length,
          });

          const detailTargets = pageCards.filter(
            (card) => screeningById.get(card.job.jobId)?.matched === true,
          );
          this.update({ status: 'reading-details' });
          this.updateProgress({
            detailTarget:
              this.currentState.progress.detailTarget + detailTargets.length,
          });

          for (const card of detailTargets) {
            const detailResult = await this.readDetailWithRetry(
              card,
              controller.signal,
            );
            this.updateProgress({
              detailCompleted: this.currentState.progress.detailCompleted + 1,
            });
            await this.recordDetailDiagnostic(card, detailResult);

            if (detailResult.outcome === 'cancelled') {
              throw abortError();
            }
            if (detailResult.outcome === 'blocked') {
              if (FATAL_PAGE_BLOCKS.has(detailResult.reason)) {
                this.stop(
                  detailResult.reason,
                  `页面已停止扫描：${detailResult.reason}`,
                );
                await this.diagnose({
                  level: 'warning',
                  event: 'scan_stopped',
                  outcome: detailResult.reason,
                  message: `页面已停止扫描：${detailResult.reason}`,
                });
                return this.currentState;
              }
              this.appendDetailError(
                card.job.jobId,
                `页面阻断：${detailResult.reason}`,
              );
            } else if (detailResult.outcome === 'timeout') {
              this.appendDetailError(card.job.jobId, '职位详情读取超时。');
            } else if (detailResult.outcome === 'identity_failure') {
              this.appendDetailError(card.job.jobId, '职位详情身份校验失败。');
            } else if (detailResult.outcome === 'failed') {
              this.appendDetailError(card.job.jobId, detailResult.message);
            } else {
              this.updateResult(card.job.jobId, { detail: detailResult.job });

              let savedJob: JobResponse | undefined;
              try {
                savedJob = await this.bridge.saveJob(
                  detailResult.job,
                  controller.signal,
                );
                this.updateResult(card.job.jobId, { savedJob });
                await this.diagnose({
                  level: 'info',
                  event: 'job_saved',
                  jobId: savedJob.id,
                  expectedJobId: card.job.jobId,
                  actualJobId: detailResult.job.jobId,
                  expectedTitle: card.job.title,
                  actualTitle: detailResult.job.title,
                  outcome: 'saved',
                });
              } catch (error) {
                if (controller.signal.aborted || isAbortError(error)) {
                  throw error;
                }
                this.appendDetailError(
                  card.job.jobId,
                  `保存职位失败：${errorMessage(error)}`,
                );
                await this.diagnose({
                  level: 'error',
                  event: 'job_save_failed',
                  expectedJobId: card.job.jobId,
                  expectedTitle: card.job.title,
                  outcome: 'failed',
                  message: errorMessage(error),
                });
              }

              try {
                const [fullScreening] = await this.bridge.screenJobs(
                  [detailResult.job],
                  undefined,
                  controller.signal,
                  'detail',
                );
                if (fullScreening === undefined) {
                  this.appendDetailError(
                    card.job.jobId,
                    '完整筛选未返回该职位结果。',
                  );
                } else {
                  this.updateResult(card.job.jobId, {
                    screening: fullScreening,
                  });
                }
              } catch (error) {
                if (controller.signal.aborted || isAbortError(error)) {
                  throw error;
                }
                this.appendDetailError(
                  card.job.jobId,
                  `完整筛选失败：${errorMessage(error)}`,
                );
              }
            }

            const failureKind = parserFailureKind(detailResult);
            if (failureKind === null) {
              consecutiveParserFailureKind = null;
              consecutiveParserFailures = 0;
            } else if (failureKind === consecutiveParserFailureKind) {
              consecutiveParserFailures += 1;
            } else {
              consecutiveParserFailureKind = failureKind;
              consecutiveParserFailures = 1;
            }
            if (
              consecutiveParserFailures >= CONSECUTIVE_PARSER_FAILURE_LIMIT
            ) {
              this.stop(
                'parser_failure_limit',
                `连续 ${CONSECUTIVE_PARSER_FAILURE_LIMIT} 个职位出现同类 Parser 错误：${failureKind}。`,
              );
              await this.diagnose({
                level: 'error',
                event: 'scan_stopped',
                outcome: 'parser_failure_limit',
                message: `连续出现同类 Parser 错误：${failureKind}。`,
              });
              return this.currentState;
            }
          }
        }

        if (this.currentState.progress.newJobs >= maxNewJobs) {
          discoveryStopReason = 'new_job_limit';
          break discovery;
        }
        if (consecutiveNoNewPages >= 2) {
          discoveryStopReason = 'no_new_jobs';
          break discovery;
        }
        if (nextPagesVisited >= maxPages) {
          discoveryStopReason = 'page_limit';
          break discovery;
        }

        await this.beforeBossRequest(controller.signal);
        const advance = await this.content.advanceSearchPage(
          this.config.detailTimeoutMs,
          controller.signal,
        );
        if (advance.outcome === 'cancelled') {
          throw abortError();
        }
        if (advance.outcome === 'blocked') {
          this.stop(advance.reason, `页面已停止扫描：${advance.reason}`);
          await this.diagnose({
            level: 'warning',
            event: 'scan_stopped',
            outcome: advance.reason,
            message: `页面已停止扫描：${advance.reason}`,
          });
          return this.currentState;
        }
        if (advance.outcome === 'end') {
          discoveryStopReason = 'end_of_results';
          break discovery;
        }
        if (advance.outcome === 'failed') {
          this.stop('page_navigation_failed', advance.message);
          return this.currentState;
        }
      }

      const evaluationTargets = this.currentState.results
        .filter(
          (
            result,
          ): result is ScannedJob & {
            savedJob: JobResponse;
            screening: ScreeningResult;
          } => result.savedJob !== undefined && result.screening?.matched === true,
        )
        .slice(0, Math.max(0, maxAiJobs));
      this.update({ status: 'evaluating' });
      this.updateProgress({ aiTarget: evaluationTargets.length });

      for (const result of evaluationTargets) {
        try {
          const evaluation = await this.bridge.evaluateJob(
            result.savedJob.id,
            controller.signal,
          );
          this.updateResult(result.card.job.jobId, { evaluation });
          await this.diagnose({
            level: 'info',
            event: 'evaluation_received',
            jobId: result.savedJob.id,
            expectedJobId: result.card.job.jobId,
            expectedTitle: result.card.job.title,
            ...(result.detail === undefined
              ? {}
              : {
                  actualJobId: result.detail.jobId,
                  actualTitle: result.detail.title,
                }),
            outcome: evaluation.recommendation,
            details: {
              score: evaluation.score,
              rawReportLength: evaluation.rawReport.length,
            },
          });
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error)) {
            throw error;
          }
          this.updateResult(result.card.job.jobId, {
            evaluationError: errorMessage(error),
          });
          await this.diagnose({
            level: 'error',
            event: 'evaluation_failed',
            jobId: result.savedJob.id,
            expectedJobId: result.card.job.jobId,
            expectedTitle: result.card.job.title,
            outcome: 'failed',
            message: errorMessage(error),
          });
        }
        this.updateProgress({
          aiCompleted: this.currentState.progress.aiCompleted + 1,
        });
      }

      this.complete(discoveryStopReason);
      await this.diagnose({
        level: 'info',
        event: 'scan_completed',
        outcome: discoveryStopReason,
        details: {
          pagesVisited: this.currentState.progress.pagesVisited,
          newJobs: this.currentState.progress.newJobs,
          mappedJobs: this.currentState.results.filter(
            (result) => result.detail !== undefined,
          ).length,
          evaluatedJobs: this.currentState.results.filter(
            (result) => result.evaluation !== undefined,
          ).length,
        },
      });
      return this.currentState;
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        if (deadlineReached) {
          this.complete('round_time_limit');
          await this.diagnose({
            level: 'warning',
            event: 'scan_stopped',
            outcome: 'round_time_limit',
            message: '本轮扫描达到最长运行时间。',
          });
        } else {
          if (this.currentState.status !== 'cancelled') {
            this.update({ status: 'cancelled', error: null, stopReason: null });
          }
          await this.diagnose({
            level: 'warning',
            event: 'scan_cancelled',
            outcome: 'cancelled',
            details: {
              mappedJobs: this.currentState.results.filter(
                (result) => result.detail !== undefined,
              ).length,
            },
          });
        }
      } else {
        this.update({ status: 'failed', error: errorMessage(error) });
        await this.diagnose({
          level: 'error',
          event: 'scan_failed',
          outcome: 'failed',
          message: errorMessage(error),
        });
      }
      return this.currentState;
    } finally {
      clearTimeout(deadlineTimer);
      if (this.abortController === controller) {
        this.abortController = null;
      }
      this.currentScanId = null;
    }
  }

  async cancel(): Promise<void> {
    if (!ACTIVE_STATUSES.has(this.currentState.status)) {
      return;
    }
    const diagnostic = this.diagnose({
      level: 'warning',
      event: 'cancel_requested',
      outcome: 'requested',
    });
    this.abortController?.abort(abortError());
    this.update({ status: 'cancelled', error: null, stopReason: null });
    await Promise.all([
      diagnostic,
      this.content.cancelDetailScan().catch(() => undefined),
    ]);
  }

  recordDecision(decision: DecisionResponse): void {
    const result = this.currentState.results.find(
      (candidate) => candidate.savedJob?.id === decision.jobId,
    );
    if (result !== undefined) {
      this.updateResult(result.card.job.jobId, { decision });
    }
  }
}
