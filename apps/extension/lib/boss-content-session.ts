import { sourceJobIdFromUrl } from '@career-ops-cn/boss-adapter';
import {
  canonicalizeZhipinUrl,
  type BossAccountFatalReason,
  type BossFatalBlockEvent,
} from '@career-ops-cn/shared';

const BOSS_DETAIL_PATH_PATTERN = /^\/job_detail\/[^/.?#]+\.html$/u;

function isBossDetailLocator(
  rawDetailUrl: string,
  canonicalDetailUrl: string,
  expectedOrigin: string,
  sourceJobId: string,
): boolean {
  try {
    const url = new URL(rawDetailUrl);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      (hostname === 'zhipin.com' || hostname.endsWith('.zhipin.com')) &&
      url.origin === expectedOrigin &&
      BOSS_DETAIL_PATH_PATTERN.test(url.pathname) &&
      sourceJobIdFromUrl(rawDetailUrl) === sourceJobId &&
      canonicalizeZhipinUrl(rawDetailUrl) === canonicalDetailUrl
    );
  } catch {
    return false;
  }
}

/*
 * raw locator 只能存在于当前 content session；canonicalDetailUrl 则是允许跨
 * context 的公开身份。两者在注册和解析时都必须保持一一对应。
 */
export interface BossLocatorSessionRef {
  sessionId: string;
  generation: string;
}

export interface BossContentSession extends BossLocatorSessionRef {
  queryScope: string;
}

export type BossContentSessionValidation =
  | { status: 'ok'; session: BossContentSession }
  | { status: 'context_changed' }
  | { status: 'fatal'; event: BossFatalBlockEvent };

export type BossContentSessionTermination =
  | { status: 'ended' }
  | { status: 'stale' }
  | { status: 'context_changed' }
  | { status: 'fatal'; event: BossFatalBlockEvent };

/*
 * 不要把该结构扩展成通用 URL 注册中心；这里只接受仓库 fixture 已证明的
 * BOSS 详情 URL 形态。
 */
export class BossContentLocatorStore {
  private activeSession:
    | (BossContentSession & {
        invalidated: boolean;
        fatalReason: BossAccountFatalReason | null;
      })
    | null = null;
  private readonly locators = new Map<string, string>();

  private readonly expectedOrigin: string;

  constructor(
    expectedOrigin: string,
    private readonly generation: string = crypto.randomUUID(),
  ) {
    const parsedOrigin = new URL(expectedOrigin);
    const hostname = parsedOrigin.hostname.toLowerCase();
    if (
      parsedOrigin.protocol !== 'https:' ||
      parsedOrigin.username !== '' ||
      parsedOrigin.password !== '' ||
      (hostname !== 'zhipin.com' && !hostname.endsWith('.zhipin.com'))
    ) {
      throw new TypeError('BOSS locator store 需要可信的 zhipin.com HTTPS origin。');
    }
    this.expectedOrigin = parsedOrigin.origin;
  }

  beginSession(sessionId: string, queryScope: string): BossContentSession {
    this.clear();
    const session = {
      sessionId,
      generation: this.generation,
      queryScope,
      invalidated: false,
      fatalReason: null,
    };
    this.activeSession = session;
    return this.publicSession(session);
  }

  validate(
    session: BossLocatorSessionRef,
    currentQueryScope: string,
  ): BossContentSessionValidation {
    const active = this.activeSession;
    if (!this.matchesActiveSession(session) || active === null) {
      return { status: 'context_changed' };
    }
    if (active.invalidated || active.queryScope !== currentQueryScope) {
      active.invalidated = true;
      this.locators.clear();
      return { status: 'context_changed' };
    }
    if (active.fatalReason !== null) {
      return {
        status: 'fatal',
        event: this.fatalEvent(active, active.fatalReason),
      };
    }
    return { status: 'ok', session: this.publicSession(active) };
  }

  latchFatal(reason: BossAccountFatalReason): BossFatalBlockEvent | null {
    const active = this.activeSession;
    if (active === null || active.invalidated || active.fatalReason !== null) {
      return null;
    }
    active.fatalReason = reason;
    this.locators.clear();
    return this.fatalEvent(active, reason);
  }

  invalidate(session: BossLocatorSessionRef): boolean {
    const active = this.activeSession;
    if (!this.matchesActiveSession(session) || active === null) {
      return false;
    }
    active.invalidated = true;
    this.locators.clear();
    return true;
  }

  register(
    session: BossLocatorSessionRef,
    sourceJobId: string,
    canonicalDetailUrl: string,
    rawDetailUrl: string,
  ): boolean {
    if (
      !this.isUsableSession(session) ||
      !isBossDetailLocator(
        rawDetailUrl,
        canonicalDetailUrl,
        this.expectedOrigin,
        sourceJobId,
      )
    ) {
      return false;
    }
    this.locators.set(this.key(session.sessionId, sourceJobId), rawDetailUrl);
    return true;
  }

  resolve(
    session: BossLocatorSessionRef,
    sourceJobId: string,
    canonicalDetailUrl: string,
  ): string | null {
    if (!this.isUsableSession(session)) {
      return null;
    }
    const rawDetailUrl =
      this.locators.get(this.key(session.sessionId, sourceJobId)) ?? null;
    return rawDetailUrl !== null &&
      isBossDetailLocator(
        rawDetailUrl,
        canonicalDetailUrl,
        this.expectedOrigin,
        sourceJobId,
      )
      ? rawDetailUrl
      : null;
  }

  clearLocators(): void {
    this.locators.clear();
  }

  endSession(
    session: BossLocatorSessionRef,
    currentQueryScope: string,
  ): BossContentSessionTermination {
    const active = this.activeSession;
    if (!this.matchesActiveSession(session) || active === null) {
      return { status: 'stale' };
    }

    const result: BossContentSessionTermination =
      active.invalidated || active.queryScope !== currentQueryScope
        ? { status: 'context_changed' }
        : active.fatalReason === null
          ? { status: 'ended' }
          : {
              status: 'fatal',
              event: this.fatalEvent(active, active.fatalReason),
            };
    this.clear();
    return result;
  }

  clear(): void {
    this.locators.clear();
    this.activeSession = null;
  }

  private isUsableSession(session: BossLocatorSessionRef): boolean {
    return (
      this.matchesActiveSession(session) &&
      this.activeSession?.invalidated === false &&
      this.activeSession.fatalReason === null
    );
  }

  private matchesActiveSession(session: BossLocatorSessionRef): boolean {
    return (
      this.activeSession?.sessionId === session.sessionId &&
      this.activeSession.generation === session.generation
    );
  }

  private key(sessionId: string, sourceJobId: string): string {
    return `${sessionId}\u0000${sourceJobId}`;
  }

  private publicSession(session: BossContentSession): BossContentSession {
    return {
      sessionId: session.sessionId,
      generation: session.generation,
      queryScope: session.queryScope,
    };
  }

  private fatalEvent(
    session: BossContentSession,
    reason: BossAccountFatalReason,
  ): BossFatalBlockEvent {
    return {
      type: 'boss/fatal-block/event',
      sessionId: session.sessionId,
      generation: session.generation,
      reason,
    };
  }
}
