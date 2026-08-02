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
  type DetectPageResponse,
  type ExtractVisibleCardsResponse,
  type JobDetail,
  type StartDetailScanResponse,
  type VisibleJobCard,
} from '@career-ops-cn/shared';
import { browser } from 'wxt/browser';

export interface TabsClient {
  query(queryInfo: { active: boolean; currentWindow: boolean }): Promise<Array<{ id?: number | undefined }>>;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

export interface ContentClient {
  detectPage(signal?: AbortSignal): Promise<DetectPageResponse>;
  extractCurrentDetail(signal?: AbortSignal): Promise<JobDetail | null>;
  extractVisibleCards(signal?: AbortSignal): Promise<ExtractVisibleCardsResponse>;
  startDetailScan(card: VisibleJobCard, timeoutMs: number, signal?: AbortSignal): Promise<StartDetailScanResponse>;
  advanceSearchPage(timeoutMs: number, signal?: AbortSignal): Promise<AdvanceSearchPageResponse>;
  cancelDetailScan(): Promise<boolean>;
}

export class ContentClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContentClientError';
  }
}

function abortError(): DOMException {
  return new DOMException('扫描已取消。', 'AbortError');
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? abortError();
}

async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) {
    return await promise;
  }
  if (signal.aborted) {
    throw abortReason(signal);
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => reject(abortReason(signal)));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function waitForRetry(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (isSignalAborted(signal)) {
    throw abortError();
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const browserTabs: TabsClient = {
  async query(queryInfo) {
    return browser.tabs.query(queryInfo);
  },
  async sendMessage(tabId, message) {
    return browser.tabs.sendMessage(tabId, message);
  },
};

export function createContentClient(tabs: TabsClient = browserTabs): ContentClient {
  async function activeTabId(signal?: AbortSignal): Promise<number> {
    const [tab] = await withAbort(
      tabs.query({ active: true, currentWindow: true }),
      signal,
    );
    if (tab?.id === undefined) {
      throw new ContentClientError('找不到当前浏览器标签页。');
    }
    return tab.id;
  }

  async function request(
    message: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const tabId = await activeTabId(signal);
    try {
      return await withAbort(tabs.sendMessage(tabId, message), signal);
    } catch (error) {
      if (isSignalAborted(signal)) {
        throw abortReason(signal);
      }
      throw new ContentClientError(
        '无法连接当前 BOSS 页面，请确认页面已刷新且扩展已启用。',
        { cause: error },
      );
    }
  }

  const client: ContentClient = {
    async detectPage(signal) {
      const response = await request(
        DetectPageRequestSchema.parse({ type: 'boss/detect-page/request' }),
        signal,
      );
      return DetectPageResponseSchema.parse(response);
    },

    async extractCurrentDetail(signal) {
      const response = await request(
        ExtractCurrentDetailRequestSchema.parse({
          type: 'boss/extract-current-detail/request',
        }),
        signal,
      );
      return ExtractCurrentDetailResponseSchema.parse(response).job;
    },

    async extractVisibleCards(signal) {
      const response = await request(
        ExtractVisibleCardsRequestSchema.parse({
          type: 'boss/extract-visible-cards/request',
        }),
        signal,
      );
      return ExtractVisibleCardsResponseSchema.parse(response);
    },

    async startDetailScan(card, timeoutMs, signal) {
      if (isSignalAborted(signal)) {
        throw abortReason(signal);
      }

      const tabId = await activeTabId(signal);
      const message = StartDetailScanRequestSchema.parse({
        type: 'boss/start-detail-scan/request',
        card,
        timeoutMs,
      });
      const onAbort = (): void => {
        const cancelMessage = CancelDetailScanRequestSchema.parse({
          type: 'boss/cancel-detail-scan/request',
        });
        void tabs.sendMessage(tabId, cancelMessage).catch(() => undefined);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const response = await withAbort(tabs.sendMessage(tabId, message), signal);
        return StartDetailScanResponseSchema.parse(response);
      } catch (error) {
        if (isSignalAborted(signal)) {
          throw abortReason(signal);
        }
        throw new ContentClientError('职位详情扫描消息失败。', { cause: error });
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },

    async advanceSearchPage(timeoutMs, signal) {
      if (isSignalAborted(signal)) {
        throw abortReason(signal);
      }

      const tabId = await activeTabId(signal);
      const message = AdvanceSearchPageRequestSchema.parse({
        type: 'boss/advance-search-page/request',
        timeoutMs,
      });
      const onAbort = (): void => {
        const cancelMessage = CancelDetailScanRequestSchema.parse({
          type: 'boss/cancel-detail-scan/request',
        });
        void tabs.sendMessage(tabId, cancelMessage).catch(() => undefined);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const response = await withAbort(tabs.sendMessage(tabId, message), signal);
        return AdvanceSearchPageResponseSchema.parse(response);
      } catch (error) {
        if (isSignalAborted(signal)) {
          throw abortReason(signal);
        }
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          await waitForRetry(
            Math.min(100, Math.max(1, deadline - Date.now())),
            signal,
          );
          try {
            const page = DetectPageResponseSchema.parse(
              await withAbort(
                tabs.sendMessage(
                  tabId,
                  DetectPageRequestSchema.parse({
                    type: 'boss/detect-page/request',
                  }),
                ),
                signal,
              ),
            );
            return AdvanceSearchPageResponseSchema.parse(
              page.block === null
                ? {
                    type: 'boss/advance-search-page/response',
                    outcome: 'advanced',
                  }
                : {
                    type: 'boss/advance-search-page/response',
                    outcome: 'blocked',
                    reason: page.block.reason,
                  },
            );
          } catch {
            // 完整页面跳转时 Content Script 会短暂不可达，继续等待其重新注入。
          }
        }
        throw new ContentClientError('搜索页翻页消息失败。', { cause: error });
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },

    async cancelDetailScan() {
      const response = await request(
        CancelDetailScanRequestSchema.parse({
          type: 'boss/cancel-detail-scan/request',
        }),
      );
      return CancelDetailScanResponseSchema.parse(response).cancelled;
    },
  };

  return client;
}
