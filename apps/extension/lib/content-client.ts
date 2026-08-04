import {
  BeginBossSessionRequestSchema,
  BeginBossSessionResponseSchema,
  BossFatalBlockEventSchema,
  BossSessionInvalidatedEventSchema,
  BossSessionErrorResponseSchema,
  CancelDetailScanRequestSchema,
  CancelDetailScanResponseSchema,
  DetectPageRequestSchema,
  DetectPageResponseSchema,
  EndBossSessionRequestSchema,
  EndBossSessionResponseSchema,
  ExtractCurrentDetailRequestSchema,
  ExtractCurrentDetailResponseSchema,
  ExtractVisibleCardsRequestSchema,
  ExtractVisibleCardsResponseSchema,
  StartDetailScanRequestSchema,
  StartDetailScanResponseSchema,
  type BossAccountFatalReason,
  type BossFatalBlockEvent,
  type BossSessionInvalidatedEvent,
  type DetectPageResponse,
  type ExtractVisibleCardsResponse,
  type JobDetail,
  type StartDetailScanResponse,
  type VisibleJobCard,
} from '@career-ops-cn/shared';
import { browser } from 'wxt/browser';

export interface TabsClient {
  query(queryInfo: {
    active: boolean;
    currentWindow: boolean;
  }): Promise<Array<{ id?: number | undefined }>>;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

export type RuntimeMessageListener = (message: unknown) => void;

export interface RuntimeClient {
  addMessageListener(listener: RuntimeMessageListener): () => void;
}

export interface BossScanSession {
  sessionId: string;
  tabId: number;
  generation: string;
  queryScope: string;
}

export interface DetailScanGovernance {
  deadlineAt: number;
  requestIntervalMs: number;
}

export interface ContentClient {
  beginSession(signal?: AbortSignal): Promise<BossScanSession>;
  endSession(signal?: AbortSignal): Promise<boolean>;
  onFatalBlock(listener: (event: BossFatalBlockEvent) => void): () => void;
  onSessionInvalidated(
    listener: (event: BossSessionInvalidatedEvent) => void,
  ): () => void;
  detectPage(signal?: AbortSignal): Promise<DetectPageResponse>;
  extractCurrentDetail(signal?: AbortSignal): Promise<JobDetail | null>;
  extractVisibleCards(
    signal?: AbortSignal,
  ): Promise<ExtractVisibleCardsResponse>;
  startDetailScan(
    card: VisibleJobCard,
    timeoutMs: number,
    signal?: AbortSignal,
    governance?: DetailScanGovernance,
  ): Promise<StartDetailScanResponse>;
  cancelDetailScan(signal?: AbortSignal): Promise<boolean>;
}

export class ContentClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContentClientError';
  }
}

export class ContentContextChangedError extends ContentClientError {
  constructor(message = 'BOSS 页面查询条件或 content 上下文已改变。', options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContentContextChangedError';
  }
}

export class BossFatalBlockError extends ContentClientError {
  readonly reason: BossAccountFatalReason;

  constructor(reason: BossAccountFatalReason) {
    super(`页面已停止扫描：${reason}`);
    this.name = 'BossFatalBlockError';
    this.reason = reason;
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

const browserTabs: TabsClient = {
  async query(queryInfo) {
    return browser.tabs.query(queryInfo);
  },
  async sendMessage(tabId, message) {
    return browser.tabs.sendMessage(tabId, message);
  },
};

const browserRuntime: RuntimeClient = {
  addMessageListener(listener) {
    const wrapped = (message: unknown): undefined => {
      listener(message);
      return undefined;
    };
    browser.runtime.onMessage.addListener(wrapped);
    return () => {
      browser.runtime.onMessage.removeListener(wrapped);
    };
  },
};

function defaultSessionIdFactory(): string {
  return crypto.randomUUID();
}

export function createContentClient(
  tabs: TabsClient = browserTabs,
  runtime: RuntimeClient = browserRuntime,
  createSessionId: () => string = defaultSessionIdFactory,
): ContentClient {
  let activeSession: BossScanSession | null = null;
  let pendingSessionId: string | null = null;
  let stickyFatal: BossFatalBlockEvent | null = null;
  let pendingFatal: BossFatalBlockEvent | null = null;
  let stickyInvalidation: BossSessionInvalidatedEvent | null = null;
  let pendingInvalidation: BossSessionInvalidatedEvent | null = null;
  let removeRuntimeListener: (() => void) | null = null;
  const fatalListeners = new Set<(event: BossFatalBlockEvent) => void>();
  const invalidationListeners = new Set<
    (event: BossSessionInvalidatedEvent) => void
  >();

  function matchesActiveSession(event: {
    sessionId: string;
    generation: string;
  }): boolean {
    return (
      activeSession?.sessionId === event.sessionId &&
      activeSession.generation === event.generation
    );
  }

  function acceptFatalEvent(event: BossFatalBlockEvent): void {
    if (!matchesActiveSession(event) && pendingSessionId !== event.sessionId) {
      return;
    }
    if (activeSession === null) {
      pendingFatal = event;
    } else {
      stickyFatal ??= event;
    }
    for (const listener of fatalListeners) {
      listener(event);
    }
  }

  function acceptSessionInvalidatedEvent(
    event: BossSessionInvalidatedEvent,
  ): void {
    if (!matchesActiveSession(event) && pendingSessionId !== event.sessionId) {
      return;
    }
    if (activeSession === null) {
      pendingInvalidation = event;
    } else {
      stickyInvalidation ??= event;
    }
    for (const listener of invalidationListeners) {
      listener(event);
    }
  }

  function ensureRuntimeListener(): void {
    if (removeRuntimeListener !== null) {
      return;
    }
    removeRuntimeListener = runtime.addMessageListener((message) => {
      const parsed = BossFatalBlockEventSchema.safeParse(message);
      if (parsed.success) {
        acceptFatalEvent(parsed.data);
      }
      const invalidated = BossSessionInvalidatedEventSchema.safeParse(message);
      if (invalidated.success) {
        acceptSessionInvalidatedEvent(invalidated.data);
      }
    });
  }

  function removeRuntimeListenerIfUnused(): void {
    if (
      fatalListeners.size === 0 &&
      invalidationListeners.size === 0 &&
      removeRuntimeListener !== null
    ) {
      removeRuntimeListener();
      removeRuntimeListener = null;
    }
  }

  function sessionOrThrow(): BossScanSession {
    if (activeSession === null) {
      throw new ContentClientError('BOSS 扫描 session 尚未开始。');
    }
    return activeSession;
  }

  function throwIfFatal(): void {
    if (stickyFatal !== null) {
      throw new BossFatalBlockError(stickyFatal.reason);
    }
  }

  function throwIfSessionInvalidated(): void {
    if (stickyInvalidation !== null) {
      throw new ContentContextChangedError();
    }
  }

  function parseSessionControlResponse(response: unknown): void {
    const fatal = BossFatalBlockEventSchema.safeParse(response);
    if (fatal.success) {
      acceptFatalEvent(fatal.data);
      throw new BossFatalBlockError(fatal.data.reason);
    }
    const sessionError = BossSessionErrorResponseSchema.safeParse(response);
    if (sessionError.success) {
      acceptSessionInvalidatedEvent(
        BossSessionInvalidatedEventSchema.parse({
          type: 'boss/session-invalidated/event',
          sessionId: sessionError.data.sessionId,
          generation: sessionError.data.generation,
          reason: sessionError.data.reason,
        }),
      );
      throw new ContentContextChangedError();
    }
  }

  async function sendToSession(
    message: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const session = sessionOrThrow();
    throwIfFatal();
    throwIfSessionInvalidated();
    try {
      const response = await withAbort(
        tabs.sendMessage(session.tabId, message),
        signal,
      );
      parseSessionControlResponse(response);
      throwIfFatal();
      throwIfSessionInvalidated();
      return response;
    } catch (error) {
      if (
        isSignalAborted(signal) ||
        error instanceof ContentContextChangedError ||
        error instanceof BossFatalBlockError
      ) {
        throw isSignalAborted(signal) ? abortReason(signal) : error;
      }
      acceptSessionInvalidatedEvent(
        BossSessionInvalidatedEventSchema.parse({
          type: 'boss/session-invalidated/event',
          sessionId: session.sessionId,
          generation: session.generation,
          reason: 'context_changed',
        }),
      );
      throw new ContentContextChangedError(
        '固定的 BOSS 标签页已 reload、关闭或无法连接。',
        { cause: error },
      );
    }
  }

  const client: ContentClient = {
    async beginSession(signal) {
      if (activeSession !== null || pendingSessionId !== null) {
        throw new ContentClientError('BOSS 扫描 session 已经开始。');
      }
      const [tab] = await withAbort(
        tabs.query({ active: true, currentWindow: true }),
        signal,
      );
      if (tab?.id === undefined) {
        throw new ContentClientError('找不到当前浏览器标签页。');
      }

      const sessionId = createSessionId();
      pendingSessionId = sessionId;
      pendingFatal = null;
      pendingInvalidation = null;
      ensureRuntimeListener();
      try {
        const response = await withAbort(
          tabs.sendMessage(
            tab.id,
            BeginBossSessionRequestSchema.parse({
              type: 'boss/begin-session/request',
              sessionId,
            }),
          ),
          signal,
        );
        const parsed = BeginBossSessionResponseSchema.parse(response);
        if (parsed.sessionId !== sessionId) {
          throw new ContentContextChangedError('Content Script 返回了错误的 sessionId。');
        }
        activeSession = {
          sessionId,
          tabId: tab.id,
          generation: parsed.generation,
          queryScope: parsed.queryScope,
        };
        const fatalDuringBegin = pendingFatal as BossFatalBlockEvent | null;
        if (
          fatalDuringBegin !== null &&
          fatalDuringBegin.generation === activeSession.generation
        ) {
          stickyFatal = fatalDuringBegin;
        }
        const invalidationDuringBegin =
          pendingInvalidation as BossSessionInvalidatedEvent | null;
        if (
          invalidationDuringBegin !== null &&
          invalidationDuringBegin.generation === activeSession.generation
        ) {
          stickyInvalidation = invalidationDuringBegin;
        }
        throwIfFatal();
        throwIfSessionInvalidated();
        return { ...activeSession };
      } catch (error) {
        if (isSignalAborted(signal)) {
          throw abortReason(signal);
        }
        if (
          error instanceof ContentClientError ||
          error instanceof BossFatalBlockError
        ) {
          throw error;
        }
        throw new ContentClientError(
          '无法在当前 BOSS 标签页开始扫描 session。',
          { cause: error },
        );
      } finally {
        pendingSessionId = null;
        pendingFatal = null;
        pendingInvalidation = null;
        if (activeSession === null) {
          removeRuntimeListenerIfUnused();
        }
      }
    },

    async endSession(signal) {
      const session = activeSession;
      if (session === null) {
        return false;
      }
      try {
        const response = await withAbort(
          tabs.sendMessage(
            session.tabId,
            EndBossSessionRequestSchema.parse({
              type: 'boss/end-session/request',
              sessionId: session.sessionId,
              generation: session.generation,
            }),
          ),
          signal,
        );
        parseSessionControlResponse(response);
        return EndBossSessionResponseSchema.parse(response).ended;
      } catch (error) {
        if (
          isSignalAborted(signal) ||
          error instanceof BossFatalBlockError ||
          error instanceof ContentContextChangedError
        ) {
          throw isSignalAborted(signal) ? abortReason(signal) : error;
        }
        return false;
      } finally {
        if (matchesActiveSession(session)) {
          activeSession = null;
          stickyFatal = null;
          pendingFatal = null;
          stickyInvalidation = null;
          pendingInvalidation = null;
        }
        removeRuntimeListenerIfUnused();
      }
    },

    onFatalBlock(listener) {
      fatalListeners.add(listener);
      ensureRuntimeListener();
      return () => {
        fatalListeners.delete(listener);
        removeRuntimeListenerIfUnused();
      };
    },

    onSessionInvalidated(listener) {
      invalidationListeners.add(listener);
      ensureRuntimeListener();
      return () => {
        invalidationListeners.delete(listener);
        removeRuntimeListenerIfUnused();
      };
    },

    async detectPage(signal) {
      const session = sessionOrThrow();
      const response = await sendToSession(
        DetectPageRequestSchema.parse({
          type: 'boss/detect-page/request',
          sessionId: session.sessionId,
          generation: session.generation,
        }),
        signal,
      );
      return DetectPageResponseSchema.parse(response);
    },

    async extractCurrentDetail(signal) {
      const session = sessionOrThrow();
      const response = await sendToSession(
        ExtractCurrentDetailRequestSchema.parse({
          type: 'boss/extract-current-detail/request',
          sessionId: session.sessionId,
          generation: session.generation,
        }),
        signal,
      );
      return ExtractCurrentDetailResponseSchema.parse(response).job;
    },

    async extractVisibleCards(signal) {
      const session = sessionOrThrow();
      const response = await sendToSession(
        ExtractVisibleCardsRequestSchema.parse({
          type: 'boss/extract-visible-cards/request',
          sessionId: session.sessionId,
          generation: session.generation,
        }),
        signal,
      );
      const parsed = ExtractVisibleCardsResponseSchema.parse(response);
      if (
        parsed.sessionId !== session.sessionId ||
        parsed.generation !== session.generation
      ) {
        throw new ContentContextChangedError(
          '职位卡片响应不属于当前 BOSS 扫描 session。',
        );
      }
      return parsed;
    },

    async startDetailScan(card, timeoutMs, signal, governance) {
      if (isSignalAborted(signal)) {
        throw abortReason(signal);
      }
      const session = sessionOrThrow();
      const message = StartDetailScanRequestSchema.parse({
        type: 'boss/start-detail-scan/request',
        sessionId: session.sessionId,
        generation: session.generation,
        sourceJobId: card.job.jobId,
        detailUrl: card.job.detailUrl,
        expectedTitle: card.job.title,
        expectedCompany: card.job.companyName,
        timeoutMs,
        deadlineAt: governance?.deadlineAt ?? Date.now() + timeoutMs,
        requestIntervalMs: governance?.requestIntervalMs ?? 1_800,
      });
      const onAbort = (): void => {
        const cancelMessage = CancelDetailScanRequestSchema.parse({
          type: 'boss/cancel-detail-scan/request',
          sessionId: session.sessionId,
          generation: session.generation,
        });
        void tabs
          .sendMessage(session.tabId, cancelMessage)
          .catch(() => undefined);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const response = await sendToSession(message, signal);
        return StartDetailScanResponseSchema.parse(response);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },

    async cancelDetailScan(signal) {
      const session = activeSession;
      if (session === null) {
        return false;
      }
      try {
        const response = await withAbort(
          tabs.sendMessage(
            session.tabId,
            CancelDetailScanRequestSchema.parse({
              type: 'boss/cancel-detail-scan/request',
              sessionId: session.sessionId,
              generation: session.generation,
            }),
          ),
          signal,
        );
        parseSessionControlResponse(response);
        return CancelDetailScanResponseSchema.parse(response).cancelled;
      } catch (error) {
        if (
          isSignalAborted(signal) ||
          error instanceof BossFatalBlockError ||
          error instanceof ContentContextChangedError
        ) {
          throw isSignalAborted(signal) ? abortReason(signal) : error;
        }
        return false;
      }
    },
  };

  return client;
}
