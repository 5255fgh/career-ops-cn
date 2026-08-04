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

function currentSourceQuery(): string {
  const url = new URL(window.location.href);
  for (const key of ['ka', 'lid', 'securityId', 'sessionId']) {
    url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return `boss:${url.pathname}${url.search}`.slice(0, 2_048);
}

function extractVisibleCards(): {
  cards: VisibleJobCard[];
  totalVisible: number;
  invalidCount: number;
  invalidFieldCounts: Partial<Record<JobCardField, number>>;
} {
  const parsedCards = parseVisibleBossCards(document, window.location.href);
  const cards: VisibleJobCard[] = [];
  const invalidFieldCounts: Partial<Record<JobCardField, number>> = {};

  parsedCards.forEach((card, index) => {
    const { job, invalidFields } = toJobCard(card);
    if (job !== null) {
      cards.push({ index, job });
      return;
    }
    for (const field of invalidFields) {
      invalidFieldCounts[field] = (invalidFieldCounts[field] ?? 0) + 1;
    }
  });

  return {
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
          ...extractVisibleCards(),
        });
      }

      const startRequest = StartDetailScanRequestSchema.safeParse(message);
      if (startRequest.success) {
        activeOperationController?.abort();
        const controller = new AbortController();
        activeOperationController = controller;

        try {
          return await fetchBossDetail({
            card: startRequest.data.card,
            timeoutMs: startRequest.data.timeoutMs,
            signal: controller.signal,
          });
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
        return CancelDetailScanResponseSchema.parse({
          type: 'boss/cancel-detail-scan/response',
          cancelled,
        });
      }

      return undefined;
    });
  },
});
