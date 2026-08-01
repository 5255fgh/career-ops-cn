import {
  bossSelectors,
  detectBossPage,
  detectBossPageBlock,
  parseBossDetail,
  parseVisibleBossCards,
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
  type StartDetailScanResponse,
  type VisibleJobCard,
} from '@career-ops-cn/shared';
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';

const JOB_CARD_FIELDS = [
  'jobId',
  'title',
  'companyName',
  'salaryText',
  'location',
  'experienceText',
  'educationText',
  'detailUrl',
] as const;

type JobCardField = (typeof JOB_CARD_FIELDS)[number];

function toJobCard(card: BossJobCard): {
  job: JobCard | null;
  invalidFields: JobCardField[];
} {
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

function toJobDetail(
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
  identity: ReturnType<typeof verifyDetailIdentity> | null,
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

async function readDetailUrl(
  card: VisibleJobCard,
  signal: AbortSignal,
): Promise<StartDetailScanResponse> {
  const response = await fetch(card.job.detailUrl, {
    method: 'GET',
    credentials: 'include',
    redirect: 'follow',
    signal,
  });
  const responseUrl = response.url === '' ? card.job.detailUrl : response.url;
  const html = await response.text();
  const detailDocument = new DOMParser().parseFromString(html, 'text/html');
  const block = detectBossPageBlock(detailDocument, responseUrl);
  if (block !== null) {
    return StartDetailScanResponseSchema.parse({
      type: 'boss/start-detail-scan/response',
      outcome: 'blocked',
      reason: block.reason,
    });
  }
  if (!response.ok) {
    return StartDetailScanResponseSchema.parse({
      type: 'boss/start-detail-scan/response',
      outcome: 'failed',
      message: `职位详情请求失败（HTTP ${response.status}）。`,
    });
  }

  const detail = parseBossDetail(detailDocument, responseUrl);
  if (detail === null) {
    return StartDetailScanResponseSchema.parse({
      type: 'boss/start-detail-scan/response',
      outcome: 'blocked',
      reason: 'unsupported_layout',
    });
  }
  const identity = verifyDetailIdentity({
    expected: {
      sourceJobId: card.job.jobId,
      url: card.job.detailUrl,
      title: card.job.title,
    },
    detail,
  });
  if (!identity.verified) {
    return StartDetailScanResponseSchema.parse({
      type: 'boss/start-detail-scan/response',
      outcome: 'identity_failure',
      evidence: detailEvidence(detail, identity),
    });
  }

  const job = toJobDetail(detail, true, card.job);
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

          return await readDetailUrl(startRequest.data.card, controller.signal);
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
