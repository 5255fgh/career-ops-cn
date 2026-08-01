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
  detectPage(): Promise<DetectPageResponse>;
  extractCurrentDetail(): Promise<JobDetail | null>;
  extractVisibleCards(): Promise<ExtractVisibleCardsResponse>;
  startDetailScan(card: VisibleJobCard, timeoutMs: number, signal?: AbortSignal): Promise<StartDetailScanResponse>;
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

const browserTabs: TabsClient = {
  async query(queryInfo) {
    return browser.tabs.query(queryInfo);
  },
  async sendMessage(tabId, message) {
    return browser.tabs.sendMessage(tabId, message);
  },
};

export function createContentClient(tabs: TabsClient = browserTabs): ContentClient {
  async function activeTabId(): Promise<number> {
    const [tab] = await tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) {
      throw new ContentClientError('找不到当前浏览器标签页。');
    }
    return tab.id;
  }

  async function request(message: unknown): Promise<unknown> {
    const tabId = await activeTabId();
    try {
      return await tabs.sendMessage(tabId, message);
    } catch (error) {
      throw new ContentClientError(
        '无法连接当前 BOSS 页面，请确认页面已刷新且扩展已启用。',
        { cause: error },
      );
    }
  }

  const client: ContentClient = {
    async detectPage() {
      const response = await request(
        DetectPageRequestSchema.parse({ type: 'boss/detect-page/request' }),
      );
      return DetectPageResponseSchema.parse(response);
    },

    async extractCurrentDetail() {
      const response = await request(
        ExtractCurrentDetailRequestSchema.parse({
          type: 'boss/extract-current-detail/request',
        }),
      );
      return ExtractCurrentDetailResponseSchema.parse(response).job;
    },

    async extractVisibleCards() {
      const response = await request(
        ExtractVisibleCardsRequestSchema.parse({
          type: 'boss/extract-visible-cards/request',
        }),
      );
      return ExtractVisibleCardsResponseSchema.parse(response);
    },

    async startDetailScan(card, timeoutMs, signal) {
      if (isSignalAborted(signal)) {
        throw abortError();
      }

      const tabId = await activeTabId();
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
        const response = await tabs.sendMessage(tabId, message);
        return StartDetailScanResponseSchema.parse(response);
      } catch (error) {
        if (isSignalAborted(signal)) {
          throw abortError();
        }
        throw new ContentClientError('职位详情扫描消息失败。', { cause: error });
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
