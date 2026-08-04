import { describe, expect, it, vi } from 'vitest';

import type { ContentClient } from './content-client';
import { readBossPagePreview } from './page-preview';

function contentMock(): ContentClient {
  return {
    beginSession: vi.fn(async () => ({
      sessionId: 'preview-session',
      tabId: 42,
      generation: 'preview-generation',
      queryScope: 'boss:/web/geek/jobs',
    })),
    endSession: vi.fn(async () => true),
    onFatalBlock: () => () => undefined,
    onSessionInvalidated: () => () => undefined,
    detectPage: vi.fn(async () => ({
      type: 'boss/detect-page/response' as const,
      pageType: 'search-list' as const,
      block: null,
    })),
    extractCurrentDetail: vi.fn(async () => null),
    extractVisibleCards: vi.fn(async () => ({
      type: 'boss/extract-visible-cards/response' as const,
      sessionId: 'preview-session',
      generation: 'preview-generation',
      cards: [],
      totalVisible: 12,
      invalidCount: 2,
    })),
    startDetailScan: vi.fn(),
    cancelDetailScan: vi.fn(async () => false),
  };
}

describe('readBossPagePreview', () => {
  it('使用独占短 session 读取页面，并在成功后结束 session', async () => {
    const content = contentMock();

    await expect(readBossPagePreview(content)).resolves.toEqual({
      pageType: 'search-list',
      block: null,
      jobCount: 12,
      invalidCount: 2,
    });
    expect(content.beginSession).toHaveBeenCalledOnce();
    expect(content.endSession).toHaveBeenCalledOnce();
  });

  it('页面读取失败时仍结束短 session', async () => {
    const content = contentMock();
    vi.mocked(content.detectPage).mockRejectedValue(new Error('页面断开'));

    await expect(readBossPagePreview(content)).rejects.toThrow('页面断开');
    expect(content.endSession).toHaveBeenCalledOnce();
  });
});
