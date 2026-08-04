import type {
  BossAccountFatalReason,
  BossFatalBlockEvent,
} from '@career-ops-cn/shared';

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

function isBossDetailLocator(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      (hostname === 'zhipin.com' || hostname.endsWith('.zhipin.com'))
    );
  } catch {
    return false;
  }
}

export class BossContentLocatorStore {
  private activeSession:
    | (BossContentSession & {
        invalidated: boolean;
        fatalReason: BossAccountFatalReason | null;
      })
    | null = null;
  private readonly locators = new Map<string, string>();

  constructor(private readonly generation: string = crypto.randomUUID()) {}

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

  register(
    session: BossLocatorSessionRef,
    sourceJobId: string,
    rawDetailUrl: string,
  ): boolean {
    if (
      !this.isUsableSession(session) ||
      !isBossDetailLocator(rawDetailUrl)
    ) {
      return false;
    }
    this.locators.set(this.key(session.sessionId, sourceJobId), rawDetailUrl);
    return true;
  }

  resolve(
    session: BossLocatorSessionRef,
    sourceJobId: string,
  ): string | null {
    if (!this.isUsableSession(session)) {
      return null;
    }
    return this.locators.get(this.key(session.sessionId, sourceJobId)) ?? null;
  }

  clearLocators(): void {
    this.locators.clear();
  }

  endSession(session: BossLocatorSessionRef): boolean {
    if (!this.matchesActiveSession(session)) {
      return false;
    }
    this.clear();
    return true;
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
