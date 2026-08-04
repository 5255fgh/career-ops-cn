import {
  detectBossPage,
  detectBossPageBlock,
  parseBossDetail,
  parseVisibleBossCards,
  sourceJobIdFromUrl,
  verifyDetailIdentity,
} from '@career-ops-cn/boss-adapter';
import {
  CancelDetailScanRequestSchema,
  CancelDetailScanResponseSchema,
  DetectPageRequestSchema,
  DetectPageResponseSchema,
  ExtractCurrentDetailRequestSchema,
  ExtractCurrentDetailResponseSchema,
  ExtractVisibleCardsRequestSchema,
  ExtractVisibleCardsResponseSchema,
  JobCardSchema,
  StartDetailScanRequestSchema,
  StartDetailScanResponseSchema,
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
import { BossContentLocatorStore } from '../lib/boss-content-session';

function currentSourceQuery(): string {
  const url = new URL(window.location.href);
  for (const key of ['ka', 'lid', 'securityId', 'sessionId']) {
    url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return `boss:${url.pathname}${url.search}`.slice(0, 2_048);
}

function extractVisibleCards(locatorStore: BossContentLocatorStore): {
  sessionId: string;
  generation: string;
  cards: VisibleJobCard[];
  totalVisible: number;
  invalidCount: number;
  invalidFieldCounts: Partial<Record<JobCardField, number>>;
} {
  const locatorSession = locatorStore.beginCapture();
  const parsedCards = parseVisibleBossCards(document, window.location.href);
  const cards: VisibleJobCard[] = [];
  const invalidFieldCounts: Partial<Record<JobCardField, number>> = {};

  parsedCards.forEach((card, index) => {
    const { job, invalidFields } = toJobCard(card);
    if (job !== null) {
      if (
        card.url !== null &&
        locatorStore.register(locatorSession, job.jobId, card.url)
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
    ...locatorSession,
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
    const locatorStore = new BossContentLocatorStore();

    browser.runtime.onMessage.addListener(async (message: unknown) => {
      if (DetectPageRequestSchema.safeParse(message).success) {
        return DetectPageResponseSchema.parse({
          type: 'boss/detect-page/response',
          pageType: detectBossPage(document, window.location.href),
          block: detectBossPageBlock(document, window.location.href),
          sourceQuery: currentSourceQuery(),
        });
      }

      if (ExtractCurrentDetailRequestSchema.safeParse(message).success) {
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

      if (ExtractVisibleCardsRequestSchema.safeParse(message).success) {
        return ExtractVisibleCardsResponseSchema.parse({
          type: 'boss/extract-visible-cards/response',
          ...extractVisibleCards(locatorStore),
        });
      }

      const startRequest = StartDetailScanRequestSchema.safeParse(message);
      if (startRequest.success) {
        const rawDetailUrl = locatorStore.resolve(
          startRequest.data,
          startRequest.data.sourceJobId,
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
            signal: controller.signal,
          });
          if (
            result.outcome === 'blocked' &&
            ['login_required', 'challenge', 'account_risk'].includes(
              result.reason,
            )
          ) {
            locatorStore.clear();
          }
          return result;
        } catch (error) {
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

      if (CancelDetailScanRequestSchema.safeParse(message).success) {
        const cancelled = activeOperationController !== null;
        activeOperationController?.abort();
        activeOperationController = null;
        locatorStore.clear();
        return CancelDetailScanResponseSchema.parse({
          type: 'boss/cancel-detail-scan/response',
          cancelled,
        });
      }

      return undefined;
    });
  },
});
