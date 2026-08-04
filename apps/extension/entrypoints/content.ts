import {
  detectBossPage,
  detectBossPageBlock,
  parseBossDetail,
  parseVisibleBossCards,
  sourceJobIdFromUrl,
  verifyDetailIdentity,
} from '@career-ops-cn/boss-adapter';
import {
  BeginBossSessionRequestSchema,
  BeginBossSessionResponseSchema,
  BossAccountFatalReasonSchema,
  BossFatalBlockEventSchema,
  BossSessionInvalidatedEventSchema,
  BossSessionErrorResponseSchema,
  CancelDetailScanRequestSchema,
  CancelDetailScanResponseSchema,
  DetectPageRequestSchema,
  DetectPageResponseSchema,
  EndBossSessionRequestSchema,
  EndBossSessionResponseSchema,
  ExtractCurrentDetailRequestSchema,
  ExtractCurrentDetailResponseSchema,
  ExtractVisibleCardsRequestSchema,
  ExtractVisibleCardsResponseSchema,
  JobCardSchema,
  StartDetailScanRequestSchema,
  StartDetailScanResponseSchema,
  type BossFatalBlockEvent,
  type BossSessionInvalidatedEvent,
  type VisibleJobCard,
} from '@career-ops-cn/shared';
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';

import {
  fetchBossDetail,
  toJobCard,
  toJobDetail,
  type JobCardField,
} from '../lib/boss-detail-fetch';
import {
  BossContentLocatorStore,
  type BossContentSession,
  type BossLocatorSessionRef,
} from '../lib/boss-content-session';
import { BossRequestGate } from '../lib/boss-request-gate';

function currentSourceQuery(): string {
  const url = new URL(window.location.href);
  for (const key of ['ka', 'lid', 'securityId', 'sessionId']) {
    url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return `boss:${url.pathname}${url.search}`.slice(0, 2_048);
}

function extractVisibleCards(
  locatorStore: BossContentLocatorStore,
  session: BossLocatorSessionRef,
): {
  sessionId: string;
  generation: string;
  cards: VisibleJobCard[];
  totalVisible: number;
  invalidCount: number;
  invalidFieldCounts: Partial<Record<JobCardField, number>>;
} {
  locatorStore.clearLocators();
  const parsedCards = parseVisibleBossCards(document, window.location.href);
  const cards: VisibleJobCard[] = [];
  const invalidFieldCounts: Partial<Record<JobCardField, number>> = {};

  parsedCards.forEach((card, index) => {
    const { job, invalidFields } = toJobCard(card);
    if (job !== null) {
      if (
        card.url !== null &&
        locatorStore.register(session, job.jobId, job.detailUrl, card.url)
      ) {
        cards.push({ index, job });
      } else {
        invalidFieldCounts.detailUrl =
          (invalidFieldCounts.detailUrl ?? 0) + 1;
      }
      return;
    }
    for (const field of invalidFields) {
      invalidFieldCounts[field] = (invalidFieldCounts[field] ?? 0) + 1;
    }
  });

  return {
    sessionId: session.sessionId,
    generation: session.generation,
    cards,
    totalVisible: parsedCards.length,
    invalidCount: parsedCards.length - cards.length,
    invalidFieldCounts,
  };
}

export default defineContentScript({
  matches: ['*://*.zhipin.com/*', '*://zhipin.com/*'],
  main() {
    let activeOperationController: AbortController | null = null;
    let monitoredSession: BossContentSession | null = null;
    let fatalObserver: MutationObserver | null = null;
    let pageHideListener: (() => void) | null = null;
    let requestGate: { intervalMs: number; gate: BossRequestGate } | null = null;
    const locatorStore = new BossContentLocatorStore(window.location.origin);

    const stopFatalMonitoring = (): void => {
      fatalObserver?.disconnect();
      fatalObserver = null;
      if (pageHideListener !== null) {
        window.removeEventListener('pagehide', pageHideListener);
        pageHideListener = null;
      }
      monitoredSession = null;
    };

    const broadcastFatal = (event: BossFatalBlockEvent): void => {
      stopFatalMonitoring();
      requestGate = null;
      activeOperationController?.abort(
        new DOMException(`页面已停止扫描：${event.reason}`, 'AbortError'),
      );
      void browser.runtime
        .sendMessage(BossFatalBlockEventSchema.parse(event))
        .catch(() => undefined);
    };

    const broadcastSessionInvalidated = (
      session: BossLocatorSessionRef,
    ): void => {
      if (
        monitoredSession?.sessionId !== session.sessionId ||
        monitoredSession.generation !== session.generation
      ) {
        return;
      }
      locatorStore.invalidate(session);
      const event: BossSessionInvalidatedEvent =
        BossSessionInvalidatedEventSchema.parse({
          type: 'boss/session-invalidated/event',
          sessionId: session.sessionId,
          generation: session.generation,
          reason: 'context_changed',
        });
      stopFatalMonitoring();
      requestGate = null;
      activeOperationController?.abort(
        new DOMException('BOSS 查询上下文已改变。', 'AbortError'),
      );
      void browser.runtime.sendMessage(event).catch(() => undefined);
    };

    const latchVisibleFatal = (): BossFatalBlockEvent | null => {
      const block = detectBossPageBlock(document, window.location.href);
      const reason = BossAccountFatalReasonSchema.safeParse(block?.reason);
      if (!reason.success) {
        return null;
      }
      const event = locatorStore.latchFatal(reason.data);
      if (event !== null) {
        broadcastFatal(event);
      }
      return event;
    };

    const sessionControlResponse = (
      session: BossLocatorSessionRef,
    ): BossFatalBlockEvent | ReturnType<typeof BossSessionErrorResponseSchema.parse> | null => {
      const visibleFatal = latchVisibleFatal();
      if (visibleFatal !== null) {
        return visibleFatal;
      }
      const validation = locatorStore.validate(session, currentSourceQuery());
      if (validation.status === 'context_changed') {
        broadcastSessionInvalidated(session);
        return BossSessionErrorResponseSchema.parse({
          type: 'boss/session-error/response',
          sessionId: session.sessionId,
          generation: session.generation,
          reason: 'context_changed',
        });
      }
      if (validation.status === 'fatal') {
        return validation.event;
      }
      return null;
    };

    const monitorSession = (session: BossContentSession): void => {
      stopFatalMonitoring();
      monitoredSession = session;
      const check = (): void => {
        if (monitoredSession === null) {
          return;
        }
        if (latchVisibleFatal() !== null) {
          return;
        }
        const validation = locatorStore.validate(
          monitoredSession,
          currentSourceQuery(),
        );
        if (validation.status === 'context_changed') {
          broadcastSessionInvalidated(monitoredSession);
          return;
        }
        if (validation.status === 'fatal') {
          broadcastFatal(validation.event);
        }
      };
      fatalObserver = new MutationObserver(check);
      fatalObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
      });
      pageHideListener = () => {
        broadcastSessionInvalidated(session);
      };
      window.addEventListener('pagehide', pageHideListener, { once: true });
      queueMicrotask(check);
    };

    browser.runtime.onMessage.addListener(async (message: unknown) => {
      const beginRequest = BeginBossSessionRequestSchema.safeParse(message);
      if (beginRequest.success) {
        activeOperationController?.abort();
        activeOperationController = null;
        requestGate = null;
        const session = locatorStore.beginSession(
          beginRequest.data.sessionId,
          currentSourceQuery(),
        );
        monitorSession(session);
        return BeginBossSessionResponseSchema.parse({
          type: 'boss/begin-session/response',
          sessionId: session.sessionId,
          generation: session.generation,
          queryScope: session.queryScope,
        });
      }

      const endRequest = EndBossSessionRequestSchema.safeParse(message);
      if (endRequest.success) {
        const ended = locatorStore.endSession(endRequest.data);
        if (!ended) {
          return BossSessionErrorResponseSchema.parse({
            type: 'boss/session-error/response',
            sessionId: endRequest.data.sessionId,
            generation: endRequest.data.generation,
            reason: 'context_changed',
          });
        }
        stopFatalMonitoring();
        requestGate = null;
        activeOperationController?.abort();
        activeOperationController = null;
        return EndBossSessionResponseSchema.parse({
          type: 'boss/end-session/response',
          ended: true,
        });
      }

      const detectRequest = DetectPageRequestSchema.safeParse(message);
      if (detectRequest.success) {
        const control = sessionControlResponse(detectRequest.data);
        if (control !== null) {
          return control;
        }
        return DetectPageResponseSchema.parse({
          type: 'boss/detect-page/response',
          pageType: detectBossPage(document, window.location.href),
          block: detectBossPageBlock(document, window.location.href),
          sourceQuery: currentSourceQuery(),
        });
      }

      const currentDetailRequest =
        ExtractCurrentDetailRequestSchema.safeParse(message);
      if (currentDetailRequest.success) {
        const control = sessionControlResponse(currentDetailRequest.data);
        if (control !== null) {
          return control;
        }
        const detail = parseBossDetail(document, window.location.href);
        const identity =
          detail === null
            ? null
            : verifyDetailIdentity({
                expected: {
                  sourceJobId: sourceJobIdFromUrl(window.location.href),
                  url: window.location.href,
                  title: detail.title,
                  company: detail.company,
                },
                detail,
              });
        return ExtractCurrentDetailResponseSchema.parse({
          type: 'boss/extract-current-detail/response',
          job:
            detail === null
              ? null
              : toJobDetail(detail, identity?.verified === true),
        });
      }

      const visibleCardsRequest =
        ExtractVisibleCardsRequestSchema.safeParse(message);
      if (visibleCardsRequest.success) {
        const control = sessionControlResponse(visibleCardsRequest.data);
        if (control !== null) {
          return control;
        }
        return ExtractVisibleCardsResponseSchema.parse({
          type: 'boss/extract-visible-cards/response',
          ...extractVisibleCards(locatorStore, visibleCardsRequest.data),
        });
      }

      const startRequest = StartDetailScanRequestSchema.safeParse(message);
      if (startRequest.success) {
        const control = sessionControlResponse(startRequest.data);
        if (control !== null) {
          return control;
        }
        const rawDetailUrl = locatorStore.resolve(
          startRequest.data,
          startRequest.data.sourceJobId,
          startRequest.data.detailUrl,
        );
        if (rawDetailUrl === null) {
          return StartDetailScanResponseSchema.parse({
            type: 'boss/start-detail-scan/response',
            outcome: 'failed',
            message: '当前 content session 缺少该职位的请求定位信息。',
            failureKind: 'locator',
            retryable: false,
          });
        }
        if (requestGate === null) {
          requestGate = {
            intervalMs: startRequest.data.requestIntervalMs,
            gate: new BossRequestGate({
              intervalMs: startRequest.data.requestIntervalMs,
            }),
          };
        } else if (
          requestGate.intervalMs !== startRequest.data.requestIntervalMs
        ) {
          return StartDetailScanResponseSchema.parse({
            type: 'boss/start-detail-scan/response',
            outcome: 'failed',
            message: '同一 content session 的 BOSS 请求间隔配置发生变化。',
            failureKind: 'unknown',
            retryable: false,
          });
        }
        activeOperationController?.abort();
        const controller = new AbortController();
        activeOperationController = controller;

        try {
          const result = await fetchBossDetail({
            card: {
              index: 0,
              job: JobCardSchema.parse({
                jobId: startRequest.data.sourceJobId,
                title: startRequest.data.expectedTitle,
                companyName: startRequest.data.expectedCompany,
                detailUrl: startRequest.data.detailUrl,
              }),
            },
            rawDetailUrl,
            timeoutMs: startRequest.data.timeoutMs,
            deadlineAt: startRequest.data.deadlineAt,
            signal: controller.signal,
            requestGate: requestGate.gate,
          });
          if (
            result.outcome === 'blocked' &&
            BossAccountFatalReasonSchema.safeParse(result.reason).success
          ) {
            const reason = BossAccountFatalReasonSchema.parse(result.reason);
            const event = locatorStore.latchFatal(reason);
            if (event !== null) {
              broadcastFatal(event);
            }
          }
          const afterRequest = sessionControlResponse(startRequest.data);
          if (afterRequest !== null) {
            return afterRequest;
          }
          return result;
        } catch (error) {
          const afterRequest = sessionControlResponse(startRequest.data);
          if (afterRequest !== null) {
            return afterRequest;
          }
          return StartDetailScanResponseSchema.parse({
            type: 'boss/start-detail-scan/response',
            outcome: controller.signal.aborted ? 'cancelled' : 'failed',
            ...(controller.signal.aborted
              ? {}
              : {
                  message:
                    error instanceof Error ? error.message : '职位详情读取失败。',
                  failureKind: 'unknown',
                  retryable: false,
                }),
          });
        } finally {
          if (activeOperationController === controller) {
            activeOperationController = null;
          }
        }
      }

      const cancelRequest = CancelDetailScanRequestSchema.safeParse(message);
      if (cancelRequest.success) {
        const validation = locatorStore.validate(
          cancelRequest.data,
          currentSourceQuery(),
        );
        if (validation.status === 'context_changed') {
          return BossSessionErrorResponseSchema.parse({
            type: 'boss/session-error/response',
            sessionId: cancelRequest.data.sessionId,
            generation: cancelRequest.data.generation,
            reason: 'context_changed',
          });
        }
        const cancelled = activeOperationController !== null;
        activeOperationController?.abort();
        activeOperationController = null;
        return CancelDetailScanResponseSchema.parse({
          type: 'boss/cancel-detail-scan/response',
          cancelled,
        });
      }

      return undefined;
    });
  },
});
