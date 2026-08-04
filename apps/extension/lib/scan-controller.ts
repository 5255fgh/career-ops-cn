import {
  BossAccountFatalReasonSchema,
  JobResponseSchema,
  ScanConfigSchema,
  canonicalizeZhipinUrl,
  type BossAccountFatalReason,
  type BossPageBlockReason,
  type CandidateRecord,
  type DiagnosticEventRequest,
  type EvaluationResult,
  type JobCard,
  type JobDetail,
  type JobHistoryEntry,
  type JobResponse,
  type ScanConfig,
  type ScanRunPhase,
  type ScanRunSnapshot,
  type ScanRunStatus,
  type ScreeningResult,
  type StartDetailScanResponse,
  type VisibleJobCard,
} from '@career-ops-cn/shared';

import {
  BridgeUnavailableError,
  isAbortError,
  type BridgeClient,
} from './bridge-client';
import {
  BossFatalBlockError,
  ContentClientError,
  ContentContextChangedError,
  type ContentClient,
} from './content-client';

export const DEFAULT_SCAN_CONFIG: ScanConfig = Object.freeze({
  maxPages: 1,
  maxNewJobs: 60,
  maxAiJobs: 30,
  detailTimeoutMs: 8_000,
  requestIntervalMs: 1_800,
  maxRoundMs: 10 * 60_000,
});

const PARSER_FAILURE_MIN_ATTEMPTS = 8;
const PARSER_FAILURE_RATIO = 0.75;
const DIAGNOSTIC_TIMEOUT_MS = 2_000;
const CONTROL_TIMEOUT_MS = 2_000;

export type ScanStatus =
  | 'idle'
  | 'reading-list'
  | 'screening'
  | 'reading-details'
  | 'evaluating'
  | 'completed'
  | 'cancelled'
  | 'interrupted'
  | 'failed';

export type ScanStopReason =
  | BossPageBlockReason
  | 'parser_failure_limit'
  | 'current_page_complete'
  | 'new_job_limit'
  | 'end_of_results'
  | 'round_time_limit';

export interface ScanProgress {
  pagesVisited: number;
  listJobs: number;
  newJobs: number;
  screenedJobs: number;
  detailCompleted: number;
  detailTarget: number;
  detailSuccess: number;
  detailFailure: number;
  aiCompleted: number;
  aiTarget: number;
  aiSuccess: number;
  aiFailure: number;
  cacheHits: number;
}

export interface ScannedJob {
  card: VisibleJobCard;
  preScreening?: ScreeningResult;
  screening?: ScreeningResult;
  detail?: JobDetail;
  savedJob?: JobResponse;
  evaluation?: EvaluationResult;
  candidate?: CandidateRecord;
  detailError?: string;
  evaluationError?: string;
}

export interface ScanState {
  runId: string | null;
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

function isAccountFatalBlock(
  reason: BossPageBlockReason,
): reason is BossAccountFatalReason {
  return BossAccountFatalReasonSchema.safeParse(reason).success;
}

function emptyProgress(): ScanProgress {
  return {
    pagesVisited: 0,
    listJobs: 0,
    newJobs: 0,
    screenedJobs: 0,
    detailCompleted: 0,
    detailTarget: 0,
    detailSuccess: 0,
    detailFailure: 0,
    aiCompleted: 0,
    aiTarget: 0,
    aiSuccess: 0,
    aiFailure: 0,
    cacheHits: 0,
  };
}

function abortError(): DOMException {
  return new DOMException('扫描已取消。', 'AbortError');
}

function roundTimeoutError(): DOMException {
  return new DOMException('本轮扫描已达到最长运行时间。', 'TimeoutError');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '扫描流程发生未知错误。';
}

async function withControlTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('控制请求超时。', 'TimeoutError'));
  }, CONTROL_TIMEOUT_MS);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
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

function jobKeys(job: Pick<JobCard, 'jobId' | 'detailUrl'>): string[] {
  return [
    `id:${job.jobId}`,
    `url:${canonicalizeZhipinUrl(job.detailUrl)}`,
  ];
}

function jobDetailFromHistory(job: JobHistoryEntry): JobDetail | undefined {
  if (job.description === undefined || job.url === undefined) {
    return undefined;
  }
  return {
    jobId: job.sourceJobId ?? job.id,
    title: job.title,
    companyName: job.company,
    ...(job.salary === undefined ? {} : { salaryText: job.salary }),
    ...(job.location === undefined ? {} : { location: job.location }),
    ...(job.experience === undefined
      ? {}
      : { experienceText: job.experience }),
    ...(job.education === undefined
      ? {}
      : { educationText: job.education }),
    detailUrl: job.url,
    description: job.description,
    identityVerified: job.identityVerified,
  };
}

function scannedJobFromHistory(
  card: VisibleJobCard,
  job: JobHistoryEntry,
  evaluation: EvaluationResult | null,
): ScannedJob {
  const {
    latestScreening,
    latestEvaluation: _latestEvaluation,
    candidate,
    ...jobResponse
  } = job;
  const detail = jobDetailFromHistory(job);
  return {
    card,
    ...(detail === undefined ? {} : { detail }),
    savedJob: JobResponseSchema.parse(jobResponse),
    ...(latestScreening === undefined ? {} : { screening: latestScreening }),
    ...(evaluation === null ? {} : { evaluation }),
    ...(candidate === undefined ? {} : { candidate }),
  };
}

function scanStatusFromRun(
  status: ScanRunStatus,
  phase: ScanRunPhase,
): ScanStatus {
  if (status !== 'running') {
    return status;
  }
  switch (phase) {
    case 'screening':
      return 'screening';
    case 'reading-details':
      return 'reading-details';
    case 'evaluating':
      return 'evaluating';
    default:
      return 'reading-list';
  }
}

export function scanStateFromSnapshot(snapshot: ScanRunSnapshot): ScanState {
  const { run } = snapshot;
  const detailCompleted =
    run.detailSuccessCount + run.detailFailureCount;
  const aiCompleted = run.aiSuccessCount + run.aiFailureCount;
  return {
    runId: run.id,
    status: scanStatusFromRun(run.status, run.phase),
    progress: {
      pagesVisited: run.pageCount,
      listJobs: run.discoveredCount,
      newJobs: run.newJobCount,
      screenedJobs: detailCompleted,
      detailCompleted,
      detailTarget: detailCompleted,
      detailSuccess: run.detailSuccessCount,
      detailFailure: run.detailFailureCount,
      aiCompleted,
      aiTarget: aiCompleted,
      aiSuccess: run.aiSuccessCount,
      aiFailure: run.aiFailureCount,
      cacheHits: run.cacheHitCount,
    },
    results: snapshot.jobs.map((job, index) =>
      scannedJobFromHistory(
        {
          index,
          job: {
            jobId: job.sourceJobId ?? job.id,
            title: job.title,
            companyName: job.company,
            ...(job.salary === undefined ? {} : { salaryText: job.salary }),
            ...(job.location === undefined ? {} : { location: job.location }),
            ...(job.experience === undefined
              ? {}
              : { experienceText: job.experience }),
            ...(job.education === undefined
              ? {}
              : { educationText: job.education }),
            detailUrl: job.url ?? 'https://www.zhipin.com/',
          },
        },
        job,
        job.latestEvaluation ?? null,
      ),
    ),
    stopReason: run.stopReason as ScanStopReason | null,
    error: run.errorSummary,
    warnings:
      run.status === 'interrupted'
        ? ['上次扫描被中断，可重新开始；增量缓存会复用已完成结果。']
        : [],
  };
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
  private readonly listeners = new Set<ScanStateListener>();
  private activeRunToken: symbol | null = null;
  private abortController: AbortController | null = null;
  private pendingContentCancellation: Promise<void> | null = null;
  private pendingControlOperation: Promise<void> | null = null;
  private currentScanId: string | null = null;
  private sourceQuery = 'boss:unknown';
  private diagnosticError: string | null = null;
  private interruptionRequested = false;
  private fatalReason: BossAccountFatalReason | null = null;
  private currentState: ScanState = {
    runId: null,
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

  restore(snapshot: ScanRunSnapshot): void {
    if (
      this.activeRunToken !== null ||
      this.pendingControlOperation !== null ||
      ACTIVE_STATUSES.has(this.currentState.status)
    ) {
      return;
    }
    this.currentScanId = snapshot.run.status === 'running' ? snapshot.run.id : null;
    this.update(scanStateFromSnapshot(snapshot));
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

  private runErrorSummary(): string | null {
    const errors = this.currentState.results
      .flatMap((result) => [result.detailError, result.evaluationError])
      .filter((value): value is string => value !== undefined);
    if (this.currentState.error !== null) {
      errors.unshift(this.currentState.error);
    }
    return errors.length === 0 ? null : errors.slice(0, 10).join('；').slice(0, 2_000);
  }

  private async persistRun(
    phase: ScanRunPhase,
    status: ScanRunStatus = 'running',
    runId: string | null = this.currentScanId,
    signal?: AbortSignal,
  ): Promise<void> {
    if (runId === null) {
      return;
    }
    const progress = this.currentState.progress;
    const run = await this.bridge.updateScanRun(
      runId,
      {
        status,
        phase: status === 'running' ? phase : 'finished',
        pageCount: progress.pagesVisited,
        discoveredCount: progress.listJobs,
        newJobCount: progress.newJobs,
        detailSuccessCount: progress.detailSuccess,
        detailFailureCount: progress.detailFailure,
        aiSuccessCount: progress.aiSuccess,
        aiFailureCount: progress.aiFailure,
        cacheHitCount: progress.cacheHits,
        ...(this.currentState.stopReason === null
          ? { stopReason: null }
          : { stopReason: this.currentState.stopReason }),
        ...(this.runErrorSummary() === null
          ? { errorSummary: null }
          : { errorSummary: this.runErrorSummary() }),
      },
      signal ?? (status === 'running' ? this.abortController?.signal : undefined),
    );
    if (
      status === 'running' &&
      this.currentScanId === runId &&
      this.abortController !== null &&
      !this.abortController.signal.aborted &&
      (run.cancelRequested || run.status !== 'running')
    ) {
      if (run.status === 'interrupted') {
        this.interruptionRequested = true;
      }
      this.abortController.abort(abortError());
    }
  }

  private async finalizeRun(runId: string): Promise<void> {
    const status: ScanRunStatus =
      this.currentState.status === 'completed'
        ? 'completed'
        : this.currentState.status === 'cancelled'
          ? 'cancelled'
          : this.currentState.status === 'interrupted'
            ? 'interrupted'
            : 'failed';
    try {
      await withControlTimeout((signal) =>
        this.persistRun('finished', status, runId, signal),
      );
    } catch (error) {
      this.addWarning(`scan run 最终状态写入失败：${errorMessage(error)}`);
    }
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

  private latchFatal(reason: BossAccountFatalReason): void {
    if (this.fatalReason !== null) {
      return;
    }
    this.fatalReason = reason;
    this.abortController?.abort(new BossFatalBlockError(reason));
  }

  private assertRoundSafe(signal: AbortSignal): void {
    if (this.fatalReason !== null) {
      throw new BossFatalBlockError(this.fatalReason);
    }
    if (signal.aborted) {
      throw signal.reason ?? abortError();
    }
  }

  private complete(reason: ScanStopReason): void {
    this.update({ status: 'completed', stopReason: reason, error: null });
  }

  private async diagnose(
    event: Omit<DiagnosticEventRequest, 'source' | 'scanId'>,
  ): Promise<void> {
    const scanId = this.currentScanId;
    if (scanId === null || this.diagnosticError !== null) {
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
            scanId,
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

  private async endContentSession(): Promise<boolean> {
    try {
      return await withControlTimeout((signal) =>
        this.content.endSession(signal),
      );
    } catch (error) {
      if (error instanceof BossFatalBlockError) {
        this.latchFatal(error.reason);
      } else if (error instanceof ContentContextChangedError) {
        this.interruptionRequested = true;
      } else {
        this.addWarning(`Content session 清理失败：${errorMessage(error)}`);
      }
      return false;
    }
  }

  private async cancelContentDetail(): Promise<void> {
    try {
      await withControlTimeout((signal) =>
        this.content.cancelDetailScan(signal),
      );
    } catch (error) {
      if (error instanceof BossFatalBlockError) {
        this.latchFatal(error.reason);
      } else if (error instanceof ContentContextChangedError) {
        this.interruptionRequested = true;
      } else {
        this.addWarning(`Content 取消请求失败：${errorMessage(error)}`);
      }
    }
  }

  private requestContentCancellation(): Promise<void> {
    if (this.pendingContentCancellation !== null) {
      return this.pendingContentCancellation;
    }
    this.pendingContentCancellation = this.cancelContentDetail();
    return this.pendingContentCancellation;
  }

  private async readDetailWithRetry(
    card: VisibleJobCard,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<StartDetailScanResponse> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      this.assertRoundSafe(signal);
      const result = await this.content.startDetailScan(
        card,
        this.config.detailTimeoutMs,
        signal,
        {
          deadlineAt,
          requestIntervalMs: this.config.requestIntervalMs,
        },
      );
      this.assertRoundSafe(signal);
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
    for (const diagnostic of result.diagnostics ?? []) {
      await this.diagnose({
        level: diagnostic.outcome === 'success' ? 'info' : 'warning',
        event: 'detail_read',
        expectedJobId: card.job.jobId,
        expectedTitle: card.job.title,
        outcome: diagnostic.outcome,
        details: {
          sourceJobId: diagnostic.sourceJobId,
          originalDetailUrl: diagnostic.detailUrl,
          finalResponseUrl: diagnostic.responseUrl,
          httpStatus: diagnostic.httpStatus,
          detectedPageType: diagnostic.detectedPageType,
          hasDetailContainer: diagnostic.hasDetailContainer,
          missingFields:
            diagnostic.missingFields.length === 0
              ? null
              : diagnostic.missingFields.join(','),
          readSource: diagnostic.source,
        },
      });
    }
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
    await this.persistRun('reading-details');
    const detail = await this.content.extractCurrentDetail(controller.signal);
    this.assertRoundSafe(controller.signal);
    this.updateProgress({
      listJobs: detail === null ? 0 : 1,
      detailCompleted: 1,
      detailSuccess: detail === null ? 0 : 1,
      detailFailure: detail === null ? 1 : 0,
    });

    if (detail === null) {
      this.addWarning('当前职位详情缺少必要字段。');
      await this.diagnose({
        level: 'error',
        event: 'detail_mapping',
        outcome: 'missing_fields',
        message: '当前职位详情缺少必要字段。',
      });
      this.assertRoundSafe(controller.signal);
      this.complete('end_of_results');
      return this.currentState;
    }

    const card = visibleCardFromDetail(detail);
    if (this.currentScanId === null) {
      throw new Error('scan run 尚未创建。');
    }
    this.assertRoundSafe(controller.signal);
    const [observation] = await this.bridge.observeJobs(
      this.currentScanId,
      this.sourceQuery,
      [card.job],
      controller.signal,
    );
    this.assertRoundSafe(controller.signal);
    this.updateProgress({
      newJobs: observation?.action === 'read-detail' && observation.reason === 'new' ? 1 : 0,
    });
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
      this.assertRoundSafe(controller.signal);
      this.complete('end_of_results');
      return this.currentState;
    }

    let savedJob: JobResponse | undefined;
    try {
      this.assertRoundSafe(controller.signal);
      savedJob = await this.bridge.saveJob(detail, controller.signal, {
        scanRunId: this.currentScanId,
        sourceQuery: this.sourceQuery,
      });
      this.assertRoundSafe(controller.signal);
      this.updateResult(detail.jobId, { savedJob });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw error;
      }
      this.appendDetailError(detail.jobId, `保存职位失败：${errorMessage(error)}`);
    }

    let screening: ScreeningResult | undefined;
    try {
      this.assertRoundSafe(controller.signal);
      [screening] = await this.bridge.screenJobs(
        [detail],
        undefined,
        controller.signal,
        'detail',
      );
      this.assertRoundSafe(controller.signal);
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

    if (screening?.matched === true && savedJob !== undefined && maxAiJobs > 0) {
      this.update({ status: 'evaluating' });
      this.updateProgress({ aiTarget: 1 });
      await this.persistRun('evaluating');
      try {
        this.assertRoundSafe(controller.signal);
        const response = await this.bridge.evaluateJob(
          savedJob.id,
          controller.signal,
          this.currentScanId,
        );
        this.assertRoundSafe(controller.signal);
        this.updateResult(detail.jobId, { evaluation: response.evaluation });
        this.updateProgress({
          aiSuccess: 1,
          cacheHits: response.cacheHit ? 1 : 0,
        });
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          throw error;
        }
        this.updateResult(detail.jobId, { evaluationError: errorMessage(error) });
        this.updateProgress({ aiFailure: 1 });
      }
      this.updateProgress({ aiCompleted: 1 });
      await this.persistRun('evaluating');
      this.assertRoundSafe(controller.signal);
    }

    this.assertRoundSafe(controller.signal);
    this.complete('end_of_results');
    return this.currentState;
  }

  async run(options: ScanRunOptions = {}): Promise<ScanState> {
    if (
      this.activeRunToken !== null ||
      this.pendingControlOperation !== null
    ) {
      throw new Error('上一轮扫描仍在清理中。');
    }
    const token = Symbol('scan-run');
    this.activeRunToken = token;
    try {
      return await this.executeRun(options);
    } finally {
      if (this.activeRunToken === token) {
        this.activeRunToken = null;
      }
    }
  }

  private async executeRun(options: ScanRunOptions): Promise<ScanState> {
    if (ACTIVE_STATUSES.has(this.currentState.status)) {
      throw new Error('扫描已在进行中。');
    }

    const maxPages = options.maxPages ?? this.config.maxPages;
    if (maxPages !== 1) {
      throw new RangeError('BOSS 搜索扫描只允许处理当前页，maxPages 必须为 1。');
    }

    const controller = new AbortController();
    this.abortController = controller;
    this.pendingContentCancellation = null;
    this.currentScanId = null;
    this.sourceQuery = 'boss:unknown';
    this.diagnosticError = null;
    this.interruptionRequested = false;
    this.fatalReason = null;
    const maxNewJobs = options.maxNewJobs ?? this.config.maxNewJobs;
    const maxAiJobs = options.maxAiJobs ?? this.config.maxAiJobs;
    const maxRoundMs = options.maxRoundMs ?? this.config.maxRoundMs;
    const deadlineAt = Date.now() + maxRoundMs;
    let deadlineReached = false;
    const deadlineTimer = setTimeout(() => {
      deadlineReached = true;
      controller.abort(roundTimeoutError());
    }, maxRoundMs);

    this.update({
      runId: null,
      status: 'reading-list',
      progress: emptyProgress(),
      results: [],
      stopReason: null,
      error: null,
      warnings: [],
    });

    const removeFatalListener = this.content.onFatalBlock((event) => {
      this.latchFatal(event.reason);
    });
    const removeSessionInvalidatedListener =
      this.content.onSessionInvalidated(() => {
        this.interruptionRequested = true;
        controller.abort(new ContentContextChangedError());
      });

    try {
      const session = await this.content.beginSession(controller.signal);
      this.sourceQuery = session.queryScope;
      this.assertRoundSafe(controller.signal);
    } catch (error) {
      clearTimeout(deadlineTimer);
      await this.endContentSession();
      removeFatalListener();
      removeSessionInvalidatedListener();
      if (
        this.fatalReason !== null ||
        error instanceof BossFatalBlockError
      ) {
        const reason =
          this.fatalReason ?? (error as BossFatalBlockError).reason;
        this.stop(reason, `页面已停止扫描：${reason}`);
      } else if (deadlineReached) {
        this.complete('round_time_limit');
      } else if (
        this.interruptionRequested ||
        error instanceof ContentContextChangedError
      ) {
        this.update({
          status: 'interrupted',
          error: errorMessage(error),
          stopReason: null,
        });
      } else if (controller.signal.aborted || isAbortError(error)) {
        this.update({ status: 'cancelled', error: null, stopReason: null });
      } else if (error instanceof ContentClientError) {
        this.update({
          status: 'interrupted',
          error: errorMessage(error),
          stopReason: null,
        });
      } else {
        this.update({ status: 'failed', error: errorMessage(error) });
      }
      if (this.abortController === controller) {
        this.abortController = null;
      }
      this.pendingContentCancellation = null;
      return this.currentState;
    }

    let runId: string | null = null;
    try {
      const createdRun = await this.bridge.createScanRun(controller.signal);
      runId = createdRun.id;
      this.currentScanId = runId;
      this.update({ runId });
    } catch (error) {
      clearTimeout(deadlineTimer);
      await this.endContentSession();
      removeFatalListener();
      removeSessionInvalidatedListener();
      if (
        this.fatalReason !== null ||
        error instanceof BossFatalBlockError
      ) {
        const reason =
          this.fatalReason ?? (error as BossFatalBlockError).reason;
        this.stop(reason, `页面已停止扫描：${reason}`);
      } else if (deadlineReached) {
        this.complete('round_time_limit');
      } else if (
        this.interruptionRequested ||
        error instanceof ContentContextChangedError ||
        error instanceof ContentClientError ||
        error instanceof BridgeUnavailableError
      ) {
        this.update({
          status: 'interrupted',
          error: errorMessage(error),
          stopReason: null,
        });
      } else if (controller.signal.aborted || isAbortError(error)) {
        this.update({ status: 'cancelled', error: null, stopReason: null });
      } else {
        this.update({
          status: 'failed',
          error: `无法创建 Bridge scan run：${errorMessage(error)}`,
        });
      }
      this.abortController = null;
      this.pendingContentCancellation = null;
      return this.currentState;
    }

    const executeRound = async (): Promise<void> => {
      this.assertRoundSafe(controller.signal);
      const firstPage = await this.content.detectPage(controller.signal);
      this.sourceQuery =
        firstPage.sourceQuery ?? `boss:${firstPage.pageType}`;
      await this.persistRun('reading-list');
      if (firstPage.block !== null) {
        if (isAccountFatalBlock(firstPage.block.reason)) {
          this.fatalReason = firstPage.block.reason;
        }
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
        return;
      }

      await this.diagnose({
        level: 'info',
        event: 'scan_started',
        details: { maxPages, maxNewJobs, maxAiJobs, maxRoundMs },
      });
      await this.diagnose({
        level: 'info',
        event: 'page_detected',
        outcome: firstPage.pageType,
        details: { block: null },
      });
      if (firstPage.pageType === 'job-detail') {
        await this.processStandaloneDetail(controller, maxAiJobs);
        return;
      }

      const seenKeys = new Set<string>();

      let detailAttempts = 0;
      const parserFailuresByKind = new Map<string, number>();
      let parserFailureMessage: string | null = null;
      let discoveryStopReason: ScanStopReason = 'current_page_complete';
      let newJobBudgetTruncated = false;

      if (controller.signal.aborted) {
        throw controller.signal.reason ?? abortError();
      }

      const page = firstPage;
      this.sourceQuery = page.sourceQuery ?? this.sourceQuery;
      if (
        page.pageType !== 'search-list' &&
        page.pageType !== 'search-detail-panel' &&
        page.pageType !== 'company-job-list'
      ) {
        this.stop('unsupported_layout', '搜索页面整体无法识别。');
        return;
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
      await this.persistRun('reading-list');
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
        return;
      }

      const uniqueCards: VisibleJobCard[] = [];
      for (const card of visible.cards) {
        const keys = jobKeys(card.job);
        if (keys.some((key) => seenKeys.has(key))) {
          continue;
        }
        for (const key of keys) {
          seenKeys.add(key);
        }
        uniqueCards.push(card);
      }

      if (this.currentScanId === null) {
        throw new Error('scan run 尚未创建。');
      }
      const observations =
        uniqueCards.length === 0
          ? []
          : await (async () => {
              this.assertRoundSafe(controller.signal);
              const value = await this.bridge.observeJobs(
                this.currentScanId!,
                this.sourceQuery,
                uniqueCards.map(({ job }) => job),
                controller.signal,
              );
              this.assertRoundSafe(controller.signal);
              return value;
            })();
      const cardById = new Map(
        uniqueCards.map((card) => [card.job.jobId, card]),
      );
      const remainingBudget = maxNewJobs - this.currentState.progress.newJobs;
      const pageCards: VisibleJobCard[] = [];
      const reusedResults: ScannedJob[] = [];
      let pageNewJobs = 0;
      let pageCacheHits = 0;
      for (const observation of observations) {
        const card = cardById.get(observation.sourceJobId);
        if (card === undefined) {
          continue;
        }
        if (observation.action === 'reuse') {
          reusedResults.push(
            scannedJobFromHistory(card, observation.job, observation.evaluation),
          );
          if (observation.cacheHit) {
            pageCacheHits += 1;
          }
          continue;
        }
        if (observation.reason === 'new') {
          if (pageNewJobs >= remainingBudget) {
            newJobBudgetTruncated = true;
            continue;
          }
          pageNewJobs += 1;
        }
        pageCards.push(card);
      }

      let reusedScreenedJobs = 0;
      for (const result of reusedResults) {
        if (result.screening !== undefined || result.detail === undefined) {
          continue;
        }
        try {
          this.assertRoundSafe(controller.signal);
          const [screening] = await this.bridge.screenJobs(
            [result.detail],
            undefined,
            controller.signal,
            'detail',
          );
          this.assertRoundSafe(controller.signal);
          if (screening === undefined) {
            result.detailError = '完整筛选未返回该职位结果。';
          } else {
            result.screening = screening;
            reusedScreenedJobs += 1;
          }
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error)) {
            throw error;
          }
          result.detailError = `完整筛选失败：${errorMessage(error)}`;
        }
      }

      if (reusedResults.length > 0) {
        this.update({
          results: [...this.currentState.results, ...reusedResults],
        });
      }
      this.updateProgress({
        newJobs: this.currentState.progress.newJobs + pageNewJobs,
        screenedJobs:
          this.currentState.progress.screenedJobs + reusedScreenedJobs,
        aiCompleted: this.currentState.progress.aiCompleted + pageCacheHits,
        aiTarget: this.currentState.progress.aiTarget + pageCacheHits,
        aiSuccess: this.currentState.progress.aiSuccess + pageCacheHits,
        cacheHits: this.currentState.progress.cacheHits + pageCacheHits,
      });
      await this.persistRun('reading-list');

      if (pageCards.length > 0) {
        this.update({
          results: [
            ...this.currentState.results,
            ...pageCards.map((card) => ({ card })),
          ],
        });
        this.update({ status: 'screening' });
        await this.persistRun('screening');
        this.assertRoundSafe(controller.signal);
        const screenings = await this.bridge.screenJobs(
          pageCards.map(({ job }) => job),
          undefined,
          controller.signal,
          'list',
        );
        this.assertRoundSafe(controller.signal);
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
        await this.persistRun('reading-details');

        for (const card of detailTargets) {
          const detailResult = await this.readDetailWithRetry(
            card,
            controller.signal,
            deadlineAt,
          );
          if (detailResult.outcome === 'deadline_exceeded') {
            deadlineReached = true;
            controller.abort(roundTimeoutError());
            throw controller.signal.reason ?? roundTimeoutError();
          }
          this.updateProgress({
            detailCompleted: this.currentState.progress.detailCompleted + 1,
            detailSuccess:
              this.currentState.progress.detailSuccess +
              (detailResult.outcome === 'success' ? 1 : 0),
            detailFailure:
              this.currentState.progress.detailFailure +
              (detailResult.outcome === 'success' ||
              detailResult.outcome === 'cancelled'
                ? 0
                : 1),
          });
          await this.recordDetailDiagnostic(card, detailResult);
          detailAttempts += 1;

          if (detailResult.outcome === 'cancelled') {
            throw abortError();
          }
          if (detailResult.outcome === 'blocked') {
            if (isAccountFatalBlock(detailResult.reason)) {
              this.fatalReason = detailResult.reason;
            }
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
            return;
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
              this.assertRoundSafe(controller.signal);
              savedJob = await this.bridge.saveJob(
                detailResult.job,
                controller.signal,
                {
                  scanRunId: this.currentScanId!,
                  sourceQuery: this.sourceQuery,
                },
              );
              this.assertRoundSafe(controller.signal);
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
              this.assertRoundSafe(controller.signal);
              const [fullScreening] = await this.bridge.screenJobs(
                [detailResult.job],
                undefined,
                controller.signal,
                'detail',
              );
              this.assertRoundSafe(controller.signal);
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
          if (failureKind !== null) {
            const failures =
              (parserFailuresByKind.get(failureKind) ?? 0) + 1;
            parserFailuresByKind.set(failureKind, failures);
            const failureRatio = failures / detailAttempts;
            if (
              detailAttempts >= PARSER_FAILURE_MIN_ATTEMPTS &&
              failureRatio >= PARSER_FAILURE_RATIO
            ) {
              parserFailureMessage =
                `已尝试 ${detailAttempts} 个职位，其中 ${failures} 个出现同类 ` +
                `Parser 错误：${failureKind}（${Math.round(failureRatio * 100)}%）。`;
              discoveryStopReason = 'parser_failure_limit';
              await this.diagnose({
                level: 'error',
                event: 'parser_failure_threshold',
                outcome: failureKind,
                message: parserFailureMessage,
                details: {
                  detailAttempts,
                  sameKindFailures: failures,
                  failureRatio,
                  minimumAttempts: PARSER_FAILURE_MIN_ATTEMPTS,
                  thresholdRatio: PARSER_FAILURE_RATIO,
                },
              });
              await this.persistRun('reading-details');
              break;
            }
          }
          await this.persistRun('reading-details');
        }
      }

      if (
        discoveryStopReason !== 'parser_failure_limit' &&
        newJobBudgetTruncated
      ) {
        discoveryStopReason = 'new_job_limit';
      }

      const evaluationTargets = this.currentState.results
        .filter(
          (
            result,
          ): result is ScannedJob & {
            savedJob: JobResponse;
          } =>
            result.savedJob !== undefined &&
            result.evaluation === undefined &&
            result.screening?.matched === true,
        )
        .slice(0, Math.max(0, maxAiJobs));
      this.update({ status: 'evaluating' });
      this.updateProgress({
        aiTarget: this.currentState.progress.aiTarget + evaluationTargets.length,
      });
      await this.persistRun('evaluating');
      this.assertRoundSafe(controller.signal);

      for (const result of evaluationTargets) {
        try {
          this.assertRoundSafe(controller.signal);
          const response = await this.bridge.evaluateJob(
            result.savedJob.id,
            controller.signal,
            this.currentScanId!,
          );
          this.assertRoundSafe(controller.signal);
          this.updateResult(result.card.job.jobId, {
            evaluation: response.evaluation,
          });
          this.updateProgress({
            aiSuccess: this.currentState.progress.aiSuccess + 1,
            cacheHits:
              this.currentState.progress.cacheHits +
              (response.cacheHit ? 1 : 0),
          });
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
            outcome: response.evaluation.recommendation,
            details: {
              score: response.evaluation.score,
              rawReportLength: response.evaluation.rawReport.length,
              cacheHit: response.cacheHit,
            },
          });
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error)) {
            throw error;
          }
          this.updateResult(result.card.job.jobId, {
            evaluationError: errorMessage(error),
          });
          this.updateProgress({
            aiFailure: this.currentState.progress.aiFailure + 1,
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
        await this.persistRun('evaluating');
        this.assertRoundSafe(controller.signal);
      }

      if (parserFailureMessage !== null) {
        this.stop('parser_failure_limit', parserFailureMessage);
        await this.diagnose({
          level: 'error',
          event: 'scan_stopped',
          outcome: 'parser_failure_limit',
          message: parserFailureMessage,
        });
        return;
      }

      this.assertRoundSafe(controller.signal);
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
      this.assertRoundSafe(controller.signal);
      return;
    };

    try {
      await executeRound();
    } catch (error) {
      if (
        this.fatalReason !== null ||
        error instanceof BossFatalBlockError
      ) {
        const reason =
          this.fatalReason ?? (error as BossFatalBlockError).reason;
        this.fatalReason = reason;
        this.stop(reason, `页面已停止扫描：${reason}`);
        await this.diagnose({
          level: 'warning',
          event: 'scan_stopped',
          outcome: reason,
          message: `页面已停止扫描：${reason}`,
        });
      } else if (controller.signal.aborted || isAbortError(error)) {
        if (deadlineReached) {
          this.complete('round_time_limit');
          await this.diagnose({
            level: 'warning',
            event: 'scan_stopped',
            outcome: 'round_time_limit',
            message: '本轮扫描达到最长运行时间。',
          });
        } else if (this.interruptionRequested) {
          this.update({
            status: 'interrupted',
            error: '扫描因 Side Panel、标签页或扩展上下文断开而中断。',
            stopReason: null,
          });
          await this.diagnose({
            level: 'warning',
            event: 'scan_interrupted',
            outcome: 'interrupted',
            message: '浏览器侧扫描上下文已断开。',
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
      } else if (
        error instanceof ContentClientError ||
        error instanceof BridgeUnavailableError
      ) {
        this.update({
          status: 'interrupted',
          error: errorMessage(error),
          stopReason: null,
        });
        await this.diagnose({
          level: 'warning',
          event: 'scan_interrupted',
          outcome: 'interrupted',
          message: errorMessage(error),
        });
      } else {
        this.update({ status: 'failed', error: errorMessage(error) });
        await this.diagnose({
          level: 'error',
          event: 'scan_failed',
          outcome: 'failed',
          message: errorMessage(error),
        });
      }
    } finally {
      clearTimeout(deadlineTimer);
      if (
        this.currentState.status === 'cancelled' ||
        this.currentState.status === 'interrupted'
      ) {
        await this.requestContentCancellation();
      } else {
        await this.pendingContentCancellation;
      }
      const sessionEnded = await this.endContentSession();
      if (this.fatalReason !== null) {
        this.stop(
          this.fatalReason,
          `页面已停止扫描：${this.fatalReason}`,
        );
      } else if (deadlineReached) {
        this.complete('round_time_limit');
      } else if (this.interruptionRequested || !sessionEnded) {
        this.update({
          status: 'interrupted',
          error: '扫描因 BOSS 查询条件、页面 generation、标签页或扩展上下文改变而中断。',
          stopReason: null,
        });
      }
      if (runId !== null) {
        await this.finalizeRun(runId);
      }
      removeFatalListener();
      removeSessionInvalidatedListener();
      if (this.abortController === controller) {
        this.abortController = null;
      }
      if (this.currentScanId === runId) {
        this.currentScanId = null;
      }
    }
    return this.currentState;
  }

  async cancel(): Promise<void> {
    if (!ACTIVE_STATUSES.has(this.currentState.status)) {
      return;
    }
    const runId = this.currentScanId ?? this.currentState.runId;
    const hadActiveController = this.abortController !== null;
    this.abortController?.abort(abortError());
    if (this.fatalReason === null) {
      this.update({ status: 'cancelled', error: null, stopReason: null });
    }

    const diagnostic = this.diagnose({
      level: 'warning',
      event: 'cancel_requested',
      outcome: 'requested',
    });
    const persistCancellation =
      runId === null
        ? Promise.resolve()
        : withControlTimeout((signal) =>
            this.bridge.requestScanRunCancel(runId, signal),
          )
            .then(() => undefined)
            .catch((error: unknown) => {
              this.addWarning(`取消标志写入失败：${errorMessage(error)}`);
            });
    const controlOperation = Promise.all([
      diagnostic,
      persistCancellation,
      this.requestContentCancellation(),
    ]).then(() => undefined);
    this.pendingControlOperation = controlOperation;
    try {
      await controlOperation;
    } finally {
      if (this.pendingControlOperation === controlOperation) {
        this.pendingControlOperation = null;
      }
    }
    if (this.fatalReason !== null) {
      this.stop(
        this.fatalReason,
        `页面已停止扫描：${this.fatalReason}`,
      );
    } else if (this.interruptionRequested) {
      this.update({
        status: 'interrupted',
        error: '扫描上下文已改变。',
        stopReason: null,
      });
    }
    if (!hadActiveController && runId !== null) {
      await this.finalizeRun(runId);
      if (this.currentScanId === runId) {
        this.currentScanId = null;
      }
      this.pendingContentCancellation = null;
    }
  }

  async interrupt(reason = 'side-panel-closed'): Promise<void> {
    if (!ACTIVE_STATUSES.has(this.currentState.status)) {
      return;
    }
    this.interruptionRequested = true;
    const runId = this.currentScanId ?? this.currentState.runId;
    this.update({
      status: 'interrupted',
      error: '扫描上下文已关闭，可重新开始并复用已完成结果。',
      stopReason: null,
    });
    this.abortController?.abort(abortError());
    const persistInterruption =
      runId === null
        ? Promise.resolve()
        : withControlTimeout((signal) =>
            this.bridge.interruptScanRun(
              runId,
              {
                reason,
                errorSummary:
                  this.runErrorSummary() ?? '浏览器侧扫描上下文已关闭。',
              },
              signal,
            ),
          )
            .then(() => undefined)
            .catch((error: unknown) => {
              this.addWarning(`interrupted 状态写入失败：${errorMessage(error)}`);
            });
    const controlOperation = Promise.all([
      persistInterruption,
      this.requestContentCancellation(),
    ]).then(() => undefined);
    this.pendingControlOperation = controlOperation;
    try {
      await controlOperation;
    } finally {
      if (this.pendingControlOperation === controlOperation) {
        this.pendingControlOperation = null;
      }
    }
    if (this.fatalReason !== null) {
      this.stop(
        this.fatalReason,
        `页面已停止扫描：${this.fatalReason}`,
      );
    }
  }

  recordCandidate(candidate: CandidateRecord): void {
    const result = this.currentState.results.find(
      (entry) => entry.savedJob?.id === candidate.jobId,
    );
    if (result !== undefined) {
      this.updateResult(result.card.job.jobId, { candidate });
    }
  }
}
