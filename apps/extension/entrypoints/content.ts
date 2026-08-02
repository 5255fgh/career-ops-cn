import {
  bossSelectors,
  detectBossPage,
  detectBossPageBlock,
  parseBossDetail,
  parseVisibleBossCards,
  sourceJobIdFromUrl,
  verifyDetailIdentity,
} from '@career-ops-cn/boss-adapter';
import {
  AdvanceSearchPageRequestSchema,
  AdvanceSearchPageResponseSchema,
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
  type AdvanceSearchPageResponse,
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

function queryFirstByPriority(
  root: Document | Element,
  selectors: readonly string[],
): Element | null {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (element !== null) {
      return element;
    }
  }
  return null;
}

function visibleCardSignature(): string {
  return parseVisibleBossCards(document, window.location.href)
    .map((card) =>
      [card.sourceJobId, card.url, card.title, card.company]
        .map((value) => value ?? '')
        .join('\u001f'),
    )
    .join('\u001e');
}

function isDisabled(element: Element): boolean {
  return (
    element.matches(bossSelectors.pagination.disabled) ||
    element.closest(bossSelectors.pagination.disabled) !== null
  );
}

async function advanceSearchPage(
  timeoutMs: number,
  signal: AbortSignal,
): Promise<AdvanceSearchPageResponse> {
  if (signal.aborted) {
    return AdvanceSearchPageResponseSchema.parse({
      type: 'boss/advance-search-page/response',
      outcome: 'cancelled',
    });
  }

  const initialBlock = detectBossPageBlock(document, window.location.href);
  if (initialBlock !== null) {
    return AdvanceSearchPageResponseSchema.parse({
      type: 'boss/advance-search-page/response',
      outcome: 'blocked',
      reason: initialBlock.reason,
    });
  }

  const previousSignature = visibleCardSignature();
  const next = queryFirstByPriority(document, bossSelectors.pagination.next);
  if (next === null || isDisabled(next)) {
    return AdvanceSearchPageResponseSchema.parse({
      type: 'boss/advance-search-page/response',
      outcome: 'end',
    });
  }

  return await new Promise<AdvanceSearchPageResponse>((resolve) => {
    let settled = false;
    const observer = new MutationObserver(evaluate);
    const finish = (response: AdvanceSearchPageResponse): void => {
      if (settled) {
        return;
      }
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(AdvanceSearchPageResponseSchema.parse(response));
    };
    const onAbort = (): void => {
      finish({
        type: 'boss/advance-search-page/response',
        outcome: 'cancelled',
      });
    };
    function evaluate(): void {
      const block = detectBossPageBlock(document, window.location.href);
      if (
        block !== null &&
        (block.reason === 'login_required' ||
          block.reason === 'challenge' ||
          block.reason === 'account_risk')
      ) {
        finish({
          type: 'boss/advance-search-page/response',
          outcome: 'blocked',
          reason: block.reason,
        });
        return;
      }
      const signature = visibleCardSignature();
      if (signature !== '' && signature !== previousSignature) {
        finish({
          type: 'boss/advance-search-page/response',
          outcome: 'advanced',
        });
      }
    }
    const timer = setTimeout(() => {
      finish({
        type: 'boss/advance-search-page/response',
        outcome: 'failed',
        message: '翻页后职位列表未在超时前更新。',
      });
    }, timeoutMs);

    signal.addEventListener('abort', onAbort, { once: true });
    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    next.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    evaluate();
  });
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

      const advanceRequest = AdvanceSearchPageRequestSchema.safeParse(message);
      if (advanceRequest.success) {
        activeOperationController?.abort();
        const controller = new AbortController();
        activeOperationController = controller;
        try {
          return await advanceSearchPage(
            advanceRequest.data.timeoutMs,
            controller.signal,
          );
        } catch (error) {
          return AdvanceSearchPageResponseSchema.parse({
            type: 'boss/advance-search-page/response',
            outcome: controller.signal.aborted ? 'cancelled' : 'failed',
            ...(controller.signal.aborted
              ? {}
              : {
                  message:
                    error instanceof Error ? error.message : '搜索页翻页失败。',
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
