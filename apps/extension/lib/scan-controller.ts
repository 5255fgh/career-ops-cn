import {
  ScanConfigSchema,
  type BossPageBlockReason,
  type DecisionResponse,
  type DiagnosticEventRequest,
  type EvaluationResult,
  type JobDetail,
  type JobResponse,
  type ScanConfig,
  type ScreeningResult,
  type VisibleJobCard,
} from '@career-ops-cn/shared';

import { isAbortError, type BridgeClient } from './bridge-client';
import type { ContentClient } from './content-client';

export const DEFAULT_SCAN_CONFIG: ScanConfig = Object.freeze({
  maxListJobs: 30,
  maxDetailJobs: 8,
  maxAiJobs: 5,
  detailTimeoutMs: 8_000,
  detailCooldownMs: 1_500,
});

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
  | Exclude<BossPageBlockReason, 'empty_page'>
  | 'detail_timeout_limit'
  | 'identity_failure_limit';

export interface ScanProgress {
  listJobs: number;
  screenedJobs: number;
  detailCompleted: number;
  detailTarget: number;
  aiCompleted: number;
  aiTarget: number;
}

export interface ScannedJob {
  card: VisibleJobCard;
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
}

export interface ScanControllerOptions {
  content: ContentClient;
  bridge: BridgeClient;
  config?: Partial<ScanConfig>;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
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
]);

function emptyProgress(): ScanProgress {
  return {
    listJobs: 0,
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

async function defaultDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds === 0) {
    return;
  }
  if (signal.aborted) {
    throw abortError();
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '扫描流程发生未知错误。';
}

export interface ScanRunOptions {
  acceptance?: boolean;
  maxDetailJobs?: number;
  maxAiJobs?: number;
}

function visibleCardFromDetail(detail: JobDetail): VisibleJobCard {
  return {
    index: 0,
    job: {
      jobId: detail.jobId,
      title: detail.title,
      companyName: detail.companyName,
      salaryText: detail.salaryText,
      location: detail.location,
      experienceText: detail.experienceText,
      educationText: detail.educationText,
      detailUrl: detail.detailUrl,
    },
  };
}

export class ScanController {
  readonly config: ScanConfig;
  private readonly content: ContentClient;
  private readonly bridge: BridgeClient;
  private readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly listeners = new Set<ScanStateListener>();
  private abortController: AbortController | null = null;
  private currentScanId: string | null = null;
  private diagnosticError: string | null = null;
  private currentState: ScanState = {
    status: 'idle',
    progress: emptyProgress(),
    results: [],
    stopReason: null,
    error: null,
  };

  constructor(options: ScanControllerOptions) {
    this.content = options.content;
    this.bridge = options.bridge;
    this.config = ScanConfigSchema.parse({
      ...DEFAULT_SCAN_CONFIG,
      ...options.config,
    });
    this.delay = options.delay ?? defaultDelay;
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

  private stop(reason: ScanStopReason, message: string): void {
    this.update({ status: 'failed', stopReason: reason, error: message });
  }

  private async diagnose(
    event: Omit<DiagnosticEventRequest, 'source' | 'scanId'>,
  ): Promise<void> {
    if (this.currentScanId === null) {
      return;
    }
    try {
      await this.bridge.recordDiagnostic({
        source: 'extension',
        scanId: this.currentScanId,
        ...event,
      });
    } catch (error) {
      this.diagnosticError ??= errorMessage(error);
    }
  }

  async run(options: ScanRunOptions = {}): Promise<ScanState> {
    if (ACTIVE_STATUSES.has(this.currentState.status)) {
      throw new Error('扫描已在进行中。');
    }

    const controller = new AbortController();
    this.abortController = controller;
    this.currentScanId =
      options.acceptance === true ? globalThis.crypto.randomUUID() : null;
    this.diagnosticError = null;
    const maxDetailJobs = options.maxDetailJobs ?? this.config.maxDetailJobs;
    const maxAiJobs = options.maxAiJobs ?? this.config.maxAiJobs;
    this.update({
      status: 'reading-list',
      progress: emptyProgress(),
      results: [],
      stopReason: null,
      error: null,
    });

    try {
      await this.diagnose({
        level: 'info',
        event: 'acceptance_smoke_started',
        details: { maxDetailJobs, maxAiJobs },
      });
      const page = await this.content.detectPage();
      await this.diagnose({
        level: page.block === null ? 'info' : 'warning',
        event: 'page_detected',
        outcome: page.pageType,
        details: { block: page.block?.reason ?? null },
      });
      if (page.block !== null && FATAL_PAGE_BLOCKS.has(page.block.reason)) {
        await this.diagnose({
          level: 'warning',
          event: 'scan_stopped',
          outcome: page.block.reason,
          message: `页面已停止扫描：${page.block.reason}`,
        });
        this.stop(page.block.reason as ScanStopReason, `页面已停止扫描：${page.block.reason}`);
        return this.currentState;
      }

      if (page.pageType === 'job-detail') {
        this.update({ status: 'reading-details' });
        this.updateProgress({ detailTarget: 1 });
        const detail = await this.content.extractCurrentDetail();
        this.updateProgress({
          listJobs: detail === null ? 0 : 1,
          detailCompleted: 1,
        });

        if (detail === null) {
          await this.diagnose({
            level: 'error',
            event: 'detail_mapping',
            outcome: 'missing_detail',
            message: '当前职位详情缺少必要字段。',
          });
          this.update({
            status: 'failed',
            error: '当前职位详情缺少必要字段。',
          });
          return this.currentState;
        }

        const card = visibleCardFromDetail(detail);
        this.update({ results: [{ card, detail }] });
        await this.diagnose({
          level: detail.identityVerified ? 'info' : 'error',
          event: 'detail_mapping',
          jobId: detail.jobId,
          expectedJobId: detail.jobId,
          actualJobId: detail.jobId,
          expectedTitle: detail.title,
          actualTitle: detail.title,
          outcome: detail.identityVerified ? 'verified' : 'identity_failure',
        });
        if (!detail.identityVerified) {
          this.update({
            status: 'failed',
            error: '职位详情身份校验失败。',
          });
          return this.currentState;
        }

        const savedJob = await this.bridge.saveJob(detail, controller.signal);
        this.updateResult(detail.jobId, { savedJob });
        await this.diagnose({
          level: 'info',
          event: 'job_saved',
          jobId: savedJob.id,
          actualJobId: detail.jobId,
          actualTitle: detail.title,
          outcome: 'saved',
        });
        this.update({ status: 'evaluating' });
        this.updateProgress({ aiTarget: 1 });
        const evaluation = await this.bridge.evaluateJob(
          savedJob.id,
          controller.signal,
        );
        this.updateResult(detail.jobId, { evaluation });
        await this.diagnose({
          level: 'info',
          event: 'evaluation_received',
          jobId: savedJob.id,
          actualJobId: detail.jobId,
          actualTitle: detail.title,
          outcome: evaluation.recommendation,
          details: {
            score: evaluation.score,
            rawReportLength: evaluation.rawReport.length,
          },
        });
        this.updateProgress({ aiCompleted: 1 });
        this.update({ status: 'completed' });
        await this.diagnose({
          level: 'info',
          event: 'acceptance_smoke_completed',
          outcome: 'completed',
          details: { mappedJobs: 1, evaluatedJobs: 1 },
        });
        if (this.diagnosticError !== null) {
          this.update({
            status: 'failed',
            error: `验收诊断写入失败：${this.diagnosticError}`,
          });
        }
        return this.currentState;
      }

      const visible = await this.content.extractVisibleCards();
      const cards = visible.cards.slice(0, this.config.maxListJobs);
      this.updateProgress({ listJobs: visible.totalVisible });
      await this.diagnose({
        level: cards.length === 0 ? 'warning' : 'info',
        event: 'visible_cards_extracted',
        outcome: cards.length === 0 ? 'empty' : 'success',
        details: {
          totalVisible: visible.totalVisible,
          validCards: cards.length,
          invalidCards: visible.invalidCount,
          ...Object.fromEntries(
            Object.entries(visible.invalidFieldCounts ?? {}).map(
              ([field, count]) => [`invalid_${field}`, count],
            ),
          ),
        },
      });
      if (cards.length === 0) {
        this.update({
          status: 'failed',
          error:
            visible.invalidCount > 0
              ? '当前可见职位均缺少必要字段。'
              : '当前页面没有可扫描的可见职位。',
        });
        return this.currentState;
      }

      this.update({ status: 'screening' });
      const screenings = await this.bridge.screenJobs(
        cards.map(({ job }) => job),
        undefined,
        controller.signal,
      );
      const screeningById = new Map(screenings.map((result) => [result.jobId, result]));
      this.update({
        results: cards.map((card) => {
          const screening = screeningById.get(card.job.jobId);
          return {
            card,
            ...(screening === undefined ? {} : { screening }),
          };
        }),
      });
      this.updateProgress({ screenedJobs: screenings.length });
      await this.diagnose({
        level: 'info',
        event: 'screening_completed',
        outcome: 'success',
        details: {
          screenedJobs: screenings.length,
          matchedJobs: screenings.filter((result) => result.matched).length,
        },
      });

      const detailTargets = cards
        .filter((card) => screeningById.get(card.job.jobId)?.matched === true)
        .slice(0, maxDetailJobs);
      this.update({ status: 'reading-details' });
      this.updateProgress({ detailTarget: detailTargets.length });

      let consecutiveTimeouts = 0;
      let consecutiveIdentityFailures = 0;

      for (const [index, card] of detailTargets.entries()) {
        const detailResult = await this.content.startDetailScan(
          card,
          this.config.detailTimeoutMs,
          controller.signal,
        );
        this.updateProgress({
          detailCompleted: this.currentState.progress.detailCompleted + 1,
        });

        await this.diagnose({
          level:
            detailResult.outcome === 'success'
              ? 'info'
              : detailResult.outcome === 'cancelled'
                ? 'warning'
                : 'error',
          event: 'detail_mapping',
          expectedJobId: card.job.jobId,
          expectedTitle: card.job.title,
          ...(detailResult.outcome === 'success'
            ? {
                actualJobId: detailResult.job.jobId,
                actualTitle: detailResult.job.title,
              }
            : detailResult.outcome === 'timeout' ||
                detailResult.outcome === 'identity_failure'
              ? {
                  ...(detailResult.evidence?.actualJobId === undefined
                    ? {}
                    : { actualJobId: detailResult.evidence.actualJobId }),
                  ...(detailResult.evidence?.actualTitle === undefined
                    ? {}
                    : { actualTitle: detailResult.evidence.actualTitle }),
                }
            : {}),
          outcome: detailResult.outcome,
          ...(detailResult.outcome === 'failed'
            ? { message: detailResult.message }
            : {}),
          ...(detailResult.outcome === 'blocked'
            ? {
                message: `页面已停止扫描：${detailResult.reason}`,
                details: { blockReason: detailResult.reason },
              }
            : {}),
          ...(detailResult.outcome === 'timeout' ||
          detailResult.outcome === 'identity_failure'
            ? {
                details: {
                  detailFound: detailResult.evidence?.detailFound ?? false,
                  signalJobIdentity:
                    detailResult.evidence?.signals?.jobIdentity ?? null,
                  signalTitle: detailResult.evidence?.signals?.title ?? null,
                  signalActiveCard:
                    detailResult.evidence?.signals?.activeCard ?? null,
                  signalContentChanged:
                    detailResult.evidence?.signals?.contentChanged ?? null,
                },
              }
            : {}),
        });

        if (detailResult.outcome === 'cancelled') {
          throw abortError();
        }

        if (detailResult.outcome === 'blocked') {
          if (FATAL_PAGE_BLOCKS.has(detailResult.reason)) {
            this.stop(
              detailResult.reason as ScanStopReason,
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
          consecutiveTimeouts = 0;
          consecutiveIdentityFailures = 0;
          this.updateResult(card.job.jobId, {
            detailError: `页面阻断：${detailResult.reason}`,
          });
        } else if (detailResult.outcome === 'timeout') {
          consecutiveTimeouts += 1;
          consecutiveIdentityFailures = 0;
          this.updateResult(card.job.jobId, { detailError: '职位详情读取超时。' });
          if (consecutiveTimeouts >= 3) {
            this.stop('detail_timeout_limit', '连续 3 个职位详情读取超时。');
            await this.diagnose({
              level: 'error',
              event: 'scan_stopped',
              outcome: 'detail_timeout_limit',
              message: '连续 3 个职位详情读取超时。',
            });
            return this.currentState;
          }
        } else if (detailResult.outcome === 'identity_failure') {
          consecutiveIdentityFailures += 1;
          consecutiveTimeouts = 0;
          this.updateResult(card.job.jobId, { detailError: '职位详情身份校验失败。' });
          if (consecutiveIdentityFailures >= 3) {
            this.stop('identity_failure_limit', '连续 3 个职位详情身份校验失败。');
            await this.diagnose({
              level: 'error',
              event: 'scan_stopped',
              outcome: 'identity_failure_limit',
              message: '连续 3 个职位详情身份校验失败。',
            });
            return this.currentState;
          }
        } else if (detailResult.outcome === 'failed') {
          consecutiveTimeouts = 0;
          consecutiveIdentityFailures = 0;
          this.updateResult(card.job.jobId, { detailError: detailResult.message });
        } else {
          consecutiveTimeouts = 0;
          consecutiveIdentityFailures = 0;
          this.updateResult(card.job.jobId, { detail: detailResult.job });
          try {
            const savedJob = await this.bridge.saveJob(detailResult.job, controller.signal);
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
            this.updateResult(card.job.jobId, {
              detailError: `保存职位失败：${errorMessage(error)}`,
            });
            await this.diagnose({
              level: 'error',
              event: 'job_save_failed',
              expectedJobId: card.job.jobId,
              expectedTitle: card.job.title,
              outcome: 'failed',
              message: errorMessage(error),
            });
          }
        }

        if (index < detailTargets.length - 1) {
          await this.delay(this.config.detailCooldownMs, controller.signal);
        }
      }

      const evaluationTargets = this.currentState.results
        .filter((result): result is ScannedJob & { savedJob: JobResponse } =>
          result.savedJob !== undefined,
        )
        .slice(0, maxAiJobs);
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

      this.update({ status: 'completed' });
      await this.diagnose({
        level: 'info',
        event: 'acceptance_smoke_completed',
        outcome: 'completed',
        details: {
          mappedJobs: this.currentState.results.filter(
            (result) => result.detail !== undefined,
          ).length,
          evaluatedJobs: this.currentState.results.filter(
            (result) => result.evaluation !== undefined,
          ).length,
        },
      });
      if (this.diagnosticError !== null) {
        this.update({
          status: 'failed',
          error: `验收诊断写入失败：${this.diagnosticError}`,
        });
      }
      return this.currentState;
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
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
      } else {
        this.update({ status: 'failed', error: errorMessage(error) });
        await this.diagnose({
          level: 'error',
          event: 'acceptance_smoke_failed',
          outcome: 'failed',
          message: errorMessage(error),
        });
      }
      return this.currentState;
    } finally {
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
    this.abortController?.abort();
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
