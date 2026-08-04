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
            sessionId: 'session-1',
            generation: 'generation-1',
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
                source: 'fetch',
                sourceJobId: job.jobId,
                detailUrl: job.detailUrl,
                responseUrl: 'https://www.zhipin.com/web/geek/jobs',
                httpStatus: null,
                detectedPageType: 'search-detail-panel',
                hasDetailContainer: true,
                missingFields: [],
                outcome: 'success',
              },
            ],
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
          source: 'fetch',
        }),
      ],
    });
    await expect(client.cancelDetailScan()).resolves.toBe(true);

    expect(sendMessage.mock.calls.map(([, message]) => (message as { type: string }).type)).toEqual([
      'boss/detect-page/request',
      'boss/extract-current-detail/request',
      'boss/extract-visible-cards/request',
      'boss/start-detail-scan/request',
      'boss/cancel-detail-scan/request',
    ]);
    const startMessage = sendMessage.mock.calls.find(
      ([, message]) =>
        (message as { type?: string }).type === 'boss/start-detail-scan/request',
    )?.[1];
    expect(startMessage).toEqual({
      type: 'boss/start-detail-scan/request',
      sessionId: 'session-1',
      generation: 'generation-1',
      sourceJobId: job.jobId,
      detailUrl: job.detailUrl,
      expectedTitle: job.title,
      expectedCompany: job.companyName,
      timeoutMs: 8_000,
    });
    expect(startMessage).not.toHaveProperty('card');
    expect(JSON.stringify(startMessage)).not.toContain('securityId');
  });

  it('AbortSignal 会立即结束悬挂消息，并通知 Content Script 停止当前 MutationObserver', async () => {
    const sendMessage = vi.fn<TabsClient['sendMessage']>(async (_tabId, message) => {
      const type = (message as { type?: string }).type;
      if (type === 'boss/start-detail-scan/request') {
        return await new Promise<unknown>(() => undefined);
      }
      if (type === 'boss/extract-visible-cards/request') {
        return {
          type: 'boss/extract-visible-cards/response',
          sessionId: 'session-7',
          generation: 'generation-7',
          cards: [visibleCard],
          totalVisible: 1,
          invalidCount: 0,
        };
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
    await client.extractVisibleCards();
    const scan = client.startDetailScan(visibleCard, 8_000, controller.signal);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(scan).rejects.toMatchObject({ name: 'AbortError' });
    expect(sendMessage).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ type: 'boss/cancel-detail-scan/request' }),
    );
  });

  it('没有 locator session 时拒绝详情请求，不猜测 canonical URL', async () => {
    const sendMessage = vi.fn<TabsClient['sendMessage']>();
    const client = createContentClient({
      query: async () => [{ id: 9 }],
      sendMessage,
    });

    await expect(client.startDetailScan(visibleCard, 8_000)).rejects.toThrow(
      'locator session',
    );
    expect(sendMessage).not.toHaveBeenCalled();
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

  it('没有活动标签页时返回明确错误', async () => {
    const client = createContentClient({
      query: async () => [],
      sendMessage: async () => undefined,
    });
    await expect(client.detectPage()).rejects.toBeInstanceOf(ContentClientError);
  });
});
