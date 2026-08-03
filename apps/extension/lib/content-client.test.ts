import { JobCardSchema, JobDetailSchema, type VisibleJobCard } from '@career-ops-cn/shared';
import { describe, expect, it, vi } from 'vitest';

import { ContentClientError, createContentClient, type TabsClient } from './content-client';

const job = JobCardSchema.parse({
  jobId: 'boss-1',
  title: '前端开发工程师',
  companyName: '示例科技',
  salaryText: '20-30K·14薪',
  location: '上海·浦东新区',
  experienceText: '3-5年',
  educationText: '本科',
  detailUrl: 'https://www.zhipin.com/job_detail/boss-1.html',
});

const visibleCard: VisibleJobCard = { index: 0, job };
const detail = JobDetailSchema.parse({
  ...job,
  description: '负责 TypeScript 与 React 产品开发。',
  identityVerified: true,
});

describe('Content client', () => {
  it('只通过 tabs 消息访问 Content Script，并校验全部响应', async () => {
    const sendMessage = vi.fn<TabsClient['sendMessage']>(async (_tabId, message) => {
      const type = (message as { type?: string }).type;
      switch (type) {
        case 'boss/detect-page/request':
          return {
            type: 'boss/detect-page/response',
            pageType: 'search-detail-panel',
            block: null,
          };
        case 'boss/extract-current-detail/request':
          return { type: 'boss/extract-current-detail/response', job: detail };
        case 'boss/extract-visible-cards/request':
          return {
            type: 'boss/extract-visible-cards/response',
            cards: [visibleCard],
            totalVisible: 1,
            invalidCount: 0,
          };
        case 'boss/start-detail-scan/request':
          return {
            type: 'boss/start-detail-scan/response',
            outcome: 'success',
            job: detail,
            diagnostics: [
              {
                source: 'live-panel',
                sourceJobId: job.jobId,
                detailUrl: job.detailUrl,
                responseUrl: 'https://www.zhipin.com/web/geek/jobs',
                httpStatus: null,
                detectedPageType: 'search-detail-panel',
                hasDetailContainer: true,
                missingFields: [],
                outcome: 'success',
                matchedBy: 'source_job_id',
              },
            ],
          };
        case 'boss/advance-search-page/request':
          return {
            type: 'boss/advance-search-page/response',
            outcome: 'advanced',
          };
        case 'boss/cancel-detail-scan/request':
          return { type: 'boss/cancel-detail-scan/response', cancelled: true };
        default:
          return undefined;
      }
    });
    const tabs: TabsClient = {
      query: vi.fn(async () => [{ id: 42 }]),
      sendMessage,
    };
    const client = createContentClient(tabs);

    await expect(client.detectPage()).resolves.toMatchObject({
      pageType: 'search-detail-panel',
    });
    await expect(client.extractCurrentDetail()).resolves.toEqual(detail);
    await expect(client.extractVisibleCards()).resolves.toMatchObject({
      cards: [visibleCard],
    });
    await expect(client.startDetailScan(visibleCard, 8_000)).resolves.toMatchObject({
      outcome: 'success',
      diagnostics: [
        expect.objectContaining({
          source: 'live-panel',
          matchedBy: 'source_job_id',
        }),
      ],
    });
    await expect(client.advanceSearchPage(8_000)).resolves.toMatchObject({
      outcome: 'advanced',
    });
    await expect(client.cancelDetailScan()).resolves.toBe(true);

    expect(sendMessage.mock.calls.map(([, message]) => (message as { type: string }).type)).toEqual([
      'boss/detect-page/request',
      'boss/extract-current-detail/request',
      'boss/extract-visible-cards/request',
      'boss/start-detail-scan/request',
      'boss/advance-search-page/request',
      'boss/cancel-detail-scan/request',
    ]);
  });

  it('AbortSignal 会立即结束悬挂消息，并通知 Content Script 停止当前 MutationObserver', async () => {
    const sendMessage = vi.fn<TabsClient['sendMessage']>(async (_tabId, message) => {
      const type = (message as { type?: string }).type;
      if (type === 'boss/start-detail-scan/request') {
        return await new Promise<unknown>(() => undefined);
      }
      if (type === 'boss/cancel-detail-scan/request') {
        return { type: 'boss/cancel-detail-scan/response', cancelled: true };
      }
      return undefined;
    });
    const client = createContentClient({
      query: async () => [{ id: 7 }],
      sendMessage,
    });
    const controller = new AbortController();
    const scan = client.startDetailScan(visibleCard, 8_000, controller.signal);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    controller.abort();

    await expect(scan).rejects.toMatchObject({ name: 'AbortError' });
    expect(sendMessage).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ type: 'boss/cancel-detail-scan/request' }),
    );
  });

  it('页面检测消息悬挂时也会遵守外部轮次截止信号', async () => {
    const client = createContentClient({
      query: async () => [{ id: 8 }],
      sendMessage: async () => await new Promise<unknown>(() => undefined),
    });
    const controller = new AbortController();
    const detection = client.detectPage(controller.signal);
    controller.abort(new DOMException('轮次超时。', 'TimeoutError'));

    await expect(detection).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('传统整页翻页导致消息端口断开时，会等待新 Content Script 后继续', async () => {
    const sendMessage = vi
      .fn<TabsClient['sendMessage']>()
      .mockRejectedValueOnce(new Error('The message port closed'))
      .mockResolvedValueOnce({
        type: 'boss/detect-page/response',
        pageType: 'search-list',
        block: null,
      });
    const client = createContentClient({
      query: async () => [{ id: 9 }],
      sendMessage,
    });

    await expect(client.advanceSearchPage(500)).resolves.toEqual({
      type: 'boss/advance-search-page/response',
      outcome: 'advanced',
    });
    expect(sendMessage.mock.calls.map(([, message]) => (message as { type: string }).type)).toEqual([
      'boss/advance-search-page/request',
      'boss/detect-page/request',
    ]);
  });

  it('详情消息端口因页面跳转断开时显示明确的中断说明', async () => {
    const client = createContentClient({
      query: async () => [{ id: 10 }],
      sendMessage: async () => {
        throw new Error('The message port closed');
      },
    });

    await expect(client.startDetailScan(visibleCard, 1_000)).rejects.toMatchObject({
      name: 'ContentClientError',
      message: 'BOSS 页面发生跳转，当前扫描已中断；已完成结果已保存。',
    });
  });

  it('详情响应不符合契约时保留响应无效提示', async () => {
    const client = createContentClient({
      query: async () => [{ id: 11 }],
      sendMessage: async () => ({ unexpected: true }),
    });

    await expect(client.startDetailScan(visibleCard, 1_000)).rejects.toMatchObject({
      name: 'ContentClientError',
      message: '职位详情扫描响应无效。',
    });
  });

  it('没有活动标签页时返回明确错误', async () => {
    const client = createContentClient({
      query: async () => [],
      sendMessage: async () => undefined,
    });
    await expect(client.detectPage()).rejects.toBeInstanceOf(ContentClientError);
  });
});
