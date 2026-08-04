import type { BossPageBlock, BossPageType } from '@career-ops-cn/shared';

import type { ContentClient } from './content-client';

export interface BossPagePreview {
  pageType: BossPageType;
  block: BossPageBlock | null;
  jobCount: number;
  invalidCount: number;
}

export async function readBossPagePreview(
  content: ContentClient,
): Promise<BossPagePreview> {
  try {
    await content.beginSession();
    const [page, visible] = await Promise.all([
      content.detectPage(),
      content.extractVisibleCards(),
    ]);
    return {
      pageType: page.pageType,
      block: page.block,
      jobCount: visible.totalVisible,
      invalidCount: visible.invalidCount,
    };
  } finally {
    await content.endSession();
  }
}
