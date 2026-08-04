export interface BossLocatorSessionRef {
  sessionId: string;
  generation: string;
}

type SessionIdFactory = () => string;

function defaultSessionIdFactory(): string {
  return crypto.randomUUID();
}

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
  private activeSession: BossLocatorSessionRef | null = null;
  private readonly locators = new Map<string, string>();

  constructor(
    private readonly generation: string = crypto.randomUUID(),
    private readonly createSessionId: SessionIdFactory = defaultSessionIdFactory,
  ) {}

  beginCapture(): BossLocatorSessionRef {
    this.clear();
    const session = {
      sessionId: this.createSessionId(),
      generation: this.generation,
    };
    this.activeSession = session;
    return { ...session };
  }

  register(
    session: BossLocatorSessionRef,
    sourceJobId: string,
    rawDetailUrl: string,
  ): boolean {
    if (!this.matchesActiveSession(session) || !isBossDetailLocator(rawDetailUrl)) {
      return false;
    }
    this.locators.set(this.key(session.sessionId, sourceJobId), rawDetailUrl);
    return true;
  }

  resolve(
    session: BossLocatorSessionRef,
    sourceJobId: string,
  ): string | null {
    if (!this.matchesActiveSession(session)) {
      return null;
    }
    return this.locators.get(this.key(session.sessionId, sourceJobId)) ?? null;
  }

  clear(): void {
    this.locators.clear();
    this.activeSession = null;
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
}
