import { JobCardSchema, JobDetailSchema, type VisibleJobCard } from '@career-ops-cn/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  BossFatalBlockError,
  ContentClientError,
  ContentContextChangedError,
  createContentClient,
  type RuntimeClient,
  type RuntimeMessageListener,
  type TabsClient,
} from './content-client';

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

function runtimeHarness(): {
  runtime: RuntimeClient;
  emit(message: unknown): void;
} {
  const listeners = new Set<RuntimeMessageListener>();
  return {
    runtime: {
      addMessageListener(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit(message) {
      for (const listener of listeners) {
        listener(message);
      }
    },
  };
}

const noopRuntime: RuntimeClient = {
  addMessageListener: () => () => undefined,
};

describe('Content client', () => {
  it('只通过 tabs 消息访问 Content Script，并校验全部响应', async () => {
    const sendMessage = vi.fn<TabsClient['sendMessage']>(async (_tabId, message) => {
      const type = (message as { type?: string }).type;
      switch (type) {
        case 'boss/begin-session/request':
          return {
            type: 'boss/begin-session/response',
            sessionId: 'session-1',
            generation: 'generation-1',
            queryScope: 'boss:/web/geek/job?query=TypeScript',
          };
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
        case 'boss/end-session/request':
          return { type: 'boss/end-session/response', ended: true };
        default:
          return undefined;
      }
    });
    const tabs: TabsClient = {
      query: vi.fn(async () => [{ id: 42 }]),
      sendMessage,
    };
    const client = createContentClient(tabs, noopRuntime, () => 'session-1');

    await expect(client.beginSession()).resolves.toEqual({
      sessionId: 'session-1',
      tabId: 42,
      generation: 'generation-1',
      queryScope: 'boss:/web/geek/job?query=TypeScript',
    });
    await expect(client.detectPage()).resolves.toMatchObject({
      pageType: 'search-detail-panel',
    });
    await expect(client.extractCurrentDetail()).resolves.toEqual(detail);
    await expect(client.extractVisibleCards()).resolves.toMatchObject({
      cards: [visibleCard],
    });
    await expect(
      client.startDetailScan(visibleCard, 8_000, undefined, {
        deadlineAt: 1_800_000_000_000,
        requestIntervalMs: 1_800,
      }),
    ).resolves.toMatchObject({
      outcome: 'success',
      diagnostics: [
        expect.objectContaining({
          source: 'fetch',
        }),
      ],
    });
    await expect(client.cancelDetailScan()).resolves.toBe(true);
    await expect(client.endSession()).resolves.toBe(true);

    expect(sendMessage.mock.calls.map(([, message]) => (message as { type: string }).type)).toEqual([
      'boss/begin-session/request',
      'boss/detect-page/request',
      'boss/extract-current-detail/request',
      'boss/extract-visible-cards/request',
      'boss/start-detail-scan/request',
      'boss/cancel-detail-scan/request',
      'boss/end-session/request',
    ]);
    expect(tabs.query).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls.every(([tabId]) => tabId === 42)).toBe(true);
    expect(sendMessage.mock.calls.slice(1).every(([, message]) => {
      const value = message as { sessionId?: string; generation?: string };
      return value.sessionId === 'session-1' && value.generation === 'generation-1';
    })).toBe(true);
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
      deadlineAt: 1_800_000_000_000,
      requestIntervalMs: 1_800,
    });
    expect(startMessage).not.toHaveProperty('card');
    expect(JSON.stringify(startMessage)).not.toContain('securityId');
  });

  it('AbortSignal 会立即结束悬挂消息，并通知 Content Script 停止当前详情请求', async () => {
    const sendMessage = vi.fn<TabsClient['sendMessage']>(async (_tabId, message) => {
      const type = (message as { type?: string }).type;
      if (type === 'boss/begin-session/request') {
        return {
          type: 'boss/begin-session/response',
          sessionId: 'session-7',
          generation: 'generation-7',
          queryScope: 'boss:/web/geek/jobs',
        };
      }
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
    const client = createContentClient(
      {
        query: async () => [{ id: 7 }],
        sendMessage,
      },
      noopRuntime,
      () => 'session-7',
    );
    const controller = new AbortController();
    await client.beginSession();
    await client.extractVisibleCards();
    const scan = client.startDetailScan(visibleCard, 8_000, controller.signal);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(3));
    controller.abort();

    await expect(scan).rejects.toMatchObject({ name: 'AbortError' });
    expect(sendMessage).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ type: 'boss/cancel-detail-scan/request' }),
    );
  });

  it('没有 locator session 时拒绝详情请求，不猜测 canonical URL', async () => {
    const sendMessage = vi.fn<TabsClient['sendMessage']>();
    const client = createContentClient(
      {
        query: async () => [{ id: 9 }],
        sendMessage,
      },
      noopRuntime,
    );

    await expect(client.startDetailScan(visibleCard, 8_000)).rejects.toThrow(
      'session 尚未开始',
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('页面检测消息悬挂时也会遵守外部轮次截止信号', async () => {
    const client = createContentClient(
      {
        query: async () => [{ id: 8 }],
        sendMessage: async (_tabId, message) =>
          (message as { type?: string }).type === 'boss/begin-session/request'
            ? {
                type: 'boss/begin-session/response',
                sessionId: 'session-8',
                generation: 'generation-8',
                queryScope: 'boss:/web/geek/jobs',
              }
            : await new Promise<unknown>(() => undefined),
      },
      noopRuntime,
      () => 'session-8',
    );
    await client.beginSession();
    const controller = new AbortController();
    const detection = client.detectPage(controller.signal);
    controller.abort(new DOMException('轮次超时。', 'TimeoutError'));

    await expect(detection).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('没有活动标签页时返回明确错误', async () => {
    const client = createContentClient(
      {
        query: async () => [],
        sendMessage: async () => undefined,
      },
      noopRuntime,
    );
    await expect(client.beginSession()).rejects.toBeInstanceOf(ContentClientError);
  });

  it('固定 tab 后 active tab 改变也不会重定向后续请求', async () => {
    const query = vi
      .fn<TabsClient['query']>()
      .mockResolvedValueOnce([{ id: 41 }])
      .mockResolvedValueOnce([{ id: 99 }]);
    const sendMessage = vi.fn<TabsClient['sendMessage']>(async (_tabId, message) => {
      switch ((message as { type?: string }).type) {
        case 'boss/begin-session/request':
          return {
            type: 'boss/begin-session/response',
            sessionId: 'session-fixed',
            generation: 'generation-fixed',
            queryScope: 'boss:/web/geek/jobs',
          };
        case 'boss/detect-page/request':
          return {
            type: 'boss/detect-page/response',
            pageType: 'search-list',
            block: null,
          };
        default:
          return undefined;
      }
    });
    const client = createContentClient(
      { query, sendMessage },
      noopRuntime,
      () => 'session-fixed',
    );

    await client.beginSession();
    await client.detectPage();
    await client.detectPage();

    expect(query).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls.every(([tabId]) => tabId === 41)).toBe(true);
  });

  it('content 返回 context_changed 时使用明确中断错误并形成 sticky latch', async () => {
    const sendMessage = vi.fn<TabsClient['sendMessage']>(async (_tabId, message) => {
      if ((message as { type?: string }).type === 'boss/begin-session/request') {
        return {
          type: 'boss/begin-session/response',
          sessionId: 'session-context',
          generation: 'generation-context',
          queryScope: 'boss:/web/geek/jobs',
        };
      }
      return {
        type: 'boss/session-error/response',
        sessionId: 'session-context',
        generation: 'generation-context',
        reason: 'context_changed',
      };
    });
    const client = createContentClient(
      { query: async () => [{ id: 5 }], sendMessage },
      noopRuntime,
      () => 'session-context',
    );
    await client.beginSession();

    await expect(client.detectPage()).rejects.toBeInstanceOf(
      ContentContextChangedError,
    );
    await expect(client.detectPage()).rejects.toBeInstanceOf(
      ContentContextChangedError,
    );
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('固定 tab reload 或断开时形成主动中断并禁止后续消息', async () => {
    const runtime = runtimeHarness();
    const sendMessage = vi.fn<TabsClient['sendMessage']>(async (_tabId, message) => {
      if ((message as { type?: string }).type === 'boss/begin-session/request') {
        return {
          type: 'boss/begin-session/response',
          sessionId: 'session-disconnected',
          generation: 'generation-disconnected',
          queryScope: 'boss:/web/geek/jobs',
        };
      }
      throw new Error('Receiving end does not exist');
    });
    const client = createContentClient(
      { query: async () => [{ id: 14 }], sendMessage },
      runtime.runtime,
      () => 'session-disconnected',
    );
    const invalidatedListener = vi.fn();
    client.onSessionInvalidated(invalidatedListener);
    await client.beginSession();

    await expect(client.detectPage()).rejects.toBeInstanceOf(
      ContentContextChangedError,
    );
    await expect(client.detectPage()).rejects.toBeInstanceOf(
      ContentContextChangedError,
    );
    expect(invalidatedListener).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('匹配 session 的主动 fatal event 形成 client sticky latch', async () => {
    const runtime = runtimeHarness();
    const sendMessage = vi.fn<TabsClient['sendMessage']>(async (_tabId, message) => {
      if ((message as { type?: string }).type === 'boss/begin-session/request') {
        return {
          type: 'boss/begin-session/response',
          sessionId: 'session-fatal',
          generation: 'generation-fatal',
          queryScope: 'boss:/web/geek/jobs',
        };
      }
      return undefined;
    });
    const client = createContentClient(
      { query: async () => [{ id: 6 }], sendMessage },
      runtime.runtime,
      () => 'session-fatal',
    );
    const fatalListener = vi.fn();
    client.onFatalBlock(fatalListener);
    await client.beginSession();

    runtime.emit({
      type: 'boss/fatal-block/event',
      sessionId: 'session-fatal',
      generation: 'generation-fatal',
      reason: 'challenge',
    });

    expect(fatalListener).toHaveBeenCalledOnce();
    await expect(client.detectPage()).rejects.toMatchObject({
      name: 'BossFatalBlockError',
      reason: 'challenge',
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(new BossFatalBlockError('challenge')).toBeInstanceOf(ContentClientError);
  });

  it('匹配 session 的主动 invalidated event 会通知 listener 并形成 sticky latch', async () => {
    const runtime = runtimeHarness();
    const sendMessage = vi.fn<TabsClient['sendMessage']>(async (_tabId, message) => {
      if ((message as { type?: string }).type === 'boss/begin-session/request') {
        return {
          type: 'boss/begin-session/response',
          sessionId: 'session-invalidated',
          generation: 'generation-invalidated',
          queryScope: 'boss:/web/geek/jobs',
        };
      }
      return undefined;
    });
    const client = createContentClient(
      { query: async () => [{ id: 12 }], sendMessage },
      runtime.runtime,
      () => 'session-invalidated',
    );
    const invalidatedListener = vi.fn();
    client.onSessionInvalidated(invalidatedListener);
    await client.beginSession();

    runtime.emit({
      type: 'boss/session-invalidated/event',
      sessionId: 'session-invalidated',
      generation: 'generation-invalidated',
      reason: 'context_changed',
    });

    expect(invalidatedListener).toHaveBeenCalledOnce();
    await expect(client.detectPage()).rejects.toBeInstanceOf(
      ContentContextChangedError,
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('begin response 返回前收到的匹配 invalidated event 会在 generation 核对后生效', async () => {
    const runtime = runtimeHarness();
    let finishBegin: ((response: unknown) => void) | undefined;
    const sendMessage = vi.fn<TabsClient['sendMessage']>(
      async () =>
        await new Promise<unknown>((resolve) => {
          finishBegin = resolve;
        }),
    );
    const client = createContentClient(
      { query: async () => [{ id: 13 }], sendMessage },
      runtime.runtime,
      () => 'session-pending',
    );
    const beginning = client.beginSession();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());

    runtime.emit({
      type: 'boss/session-invalidated/event',
      sessionId: 'session-pending',
      generation: 'generation-pending',
      reason: 'context_changed',
    });
    finishBegin?.({
      type: 'boss/begin-session/response',
      sessionId: 'session-pending',
      generation: 'generation-pending',
      queryScope: 'boss:/web/geek/jobs',
    });

    await expect(beginning).rejects.toBeInstanceOf(ContentContextChangedError);
  });
});
