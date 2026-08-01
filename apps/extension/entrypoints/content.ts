import {
  bossSelectors,
  detectBossPage,
  detectBossPageBlock,
  parseBossDetail,
  parseVisibleBossCards,
  scanSelectedBossDetails,
  sourceJobIdFromUrl,
  verifyDetailIdentity,
  type BossJobCard,
  type BossJobDetail,
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
  JobDetailSchema,
  StartDetailScanRequestSchema,
  StartDetailScanResponseSchema,
  type JobCard,
  type JobDetail,
  type VisibleJobCard,
} from '@career-ops-cn/shared';
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';

function toJobCard(card: BossJobCard): JobCard | null {
  const parsed = JobCardSchema.safeParse({
    jobId: card.sourceJobId,
    title: card.title,
    companyName: card.company,
    salaryText: card.salaryRaw,
    location: card.city,
    experienceText: card.experience,
    educationText: card.education,
    detailUrl: card.url,
  });
  return parsed.success ? parsed.data : null;
}

function toJobDetail(detail: BossJobDetail, identityVerified: boolean): JobDetail | null {
  const parsed = JobDetailSchema.safeParse({
    jobId: detail.sourceJobId,
    title: detail.title,
    companyName: detail.company,
    salaryText: detail.salaryRaw,
    location: detail.city,
    experienceText: detail.experience,
    educationText: detail.education,
    detailUrl: detail.url,
    description: detail.description,
    identityVerified,
  });
  return parsed.success ? parsed.data : null;
}

function queryByPriority(root: Document | Element, selectors: readonly string[]): Element[] {
  for (const selector of selectors) {
    const elements = [...root.querySelectorAll(selector)];
    if (elements.length > 0) {
      return elements;
    }
  }
  return [];
}

function visibleCardElements(document: Document): Element[] {
  const containers = [
    ...queryByPriority(document, bossSelectors.page.searchListContainers),
    ...queryByPriority(document, bossSelectors.page.companyJobListContainers),
  ];
  const cards: Element[] = [];
  const seen = new Set<Element>();

  for (const container of containers) {
    for (const card of queryByPriority(container, bossSelectors.list.cards)) {
      if (
        !seen.has(card) &&
        card.closest(bossSelectors.visibility.hiddenAncestor) === null
      ) {
        seen.add(card);
        cards.push(card);
      }
    }
  }

  return cards;
}

function extractVisibleCards(): {
  cards: VisibleJobCard[];
  totalVisible: number;
  invalidCount: number;
} {
  const parsedCards = parseVisibleBossCards(document, window.location.href);
  const cards: VisibleJobCard[] = [];

  parsedCards.forEach((card, index) => {
    const job = toJobCard(card);
    if (job !== null) {
      cards.push({ index, job });
    }
  });

  return {
    cards,
    totalVisible: parsedCards.length,
    invalidCount: parsedCards.length - cards.length,
  };
}

export default defineContentScript({
  matches: ['*://*.zhipin.com/*', '*://zhipin.com/*'],
  main() {
    let detailScanController: AbortController | null = null;

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
        detailScanController?.abort();
        const controller = new AbortController();
        detailScanController = controller;

        try {
          const element = visibleCardElements(document)[startRequest.data.card.index];
          if (element === undefined) {
            return StartDetailScanResponseSchema.parse({
              type: 'boss/start-detail-scan/response',
              outcome: 'failed',
              message: '目标职位卡片已离开当前可见列表。',
            });
          }

          const result = await scanSelectedBossDetails({
            document,
            url: window.location.href,
            selections: [
              {
                element,
                expected: {
                  sourceJobId: startRequest.data.card.job.jobId,
                  url: startRequest.data.card.job.detailUrl,
                  title: startRequest.data.card.job.title,
                },
              },
            ],
            timeoutMs: startRequest.data.timeoutMs,
            signal: controller.signal,
          });
          const entry = result.entries[0];

          if (result.block !== null) {
            return StartDetailScanResponseSchema.parse({
              type: 'boss/start-detail-scan/response',
              outcome: 'blocked',
              reason: result.block.reason,
            });
          }
          if (entry?.result.status === 'verified') {
            const job = toJobDetail(entry.result.detail, true);
            return StartDetailScanResponseSchema.parse(
              job === null
                ? {
                    type: 'boss/start-detail-scan/response',
                    outcome: 'failed',
                    message: '职位详情缺少 shared 契约要求的字段。',
                  }
                : {
                    type: 'boss/start-detail-scan/response',
                    outcome: 'success',
                    job,
                  },
            );
          }
          if (entry?.result.status === 'timeout') {
            return StartDetailScanResponseSchema.parse({
              type: 'boss/start-detail-scan/response',
              outcome:
                entry.result.lastIdentity?.verified === false
                  ? 'identity_failure'
                  : 'timeout',
            });
          }
          if (entry?.result.status === 'aborted' || controller.signal.aborted) {
            return StartDetailScanResponseSchema.parse({
              type: 'boss/start-detail-scan/response',
              outcome: 'cancelled',
            });
          }

          return StartDetailScanResponseSchema.parse({
            type: 'boss/start-detail-scan/response',
            outcome: 'failed',
            message: '职位详情读取未返回有效结果。',
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
                }),
          });
        } finally {
          if (detailScanController === controller) {
            detailScanController = null;
          }
        }
      }

      if (CancelDetailScanRequestSchema.safeParse(message).success) {
        const cancelled = detailScanController !== null;
        detailScanController?.abort();
        detailScanController = null;
        return CancelDetailScanResponseSchema.parse({
          type: 'boss/cancel-detail-scan/response',
          cancelled,
        });
      }

      return undefined;
    });
  },
});
