export class BossRequestDeadlineError extends Error {
  constructor() {
    super('本轮扫描截止时间不足以开始下一次 BOSS 请求。');
    this.name = 'BossRequestDeadlineError';
  }
}

export interface BossRequestGateOptions {
  intervalMs: number;
  jitterRatio?: number;
  now?: () => number;
  random?: () => number;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface BossRequestPermit {
  signal: AbortSignal;
  deadlineAt: number;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('BOSS 请求已取消。', 'AbortError');
}

async function defaultDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw abortReason(signal);
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class BossRequestGate {
  private readonly intervalMs: number;
  private readonly jitterRatio: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly delay: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private nextAllowedAt = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: BossRequestGateOptions) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0) {
      throw new RangeError('BOSS 请求间隔必须是非负有限数值。');
    }
    const jitterRatio = options.jitterRatio ?? 0.2;
    if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 0.2) {
      throw new RangeError('BOSS 请求抖动比例必须位于 0 到 0.2。');
    }
    this.intervalMs = options.intervalMs;
    this.jitterRatio = jitterRatio;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.delay = options.delay ?? defaultDelay;
  }

  async run<T>(permit: BossRequestPermit, operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    let hasTurn = false;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await this.waitForTurn(previous, permit);
      hasTurn = true;
      this.assertPermit(permit);

      const waitMs = Math.max(0, this.nextAllowedAt - this.now());
      if (waitMs > 0) {
        if (this.now() + waitMs >= permit.deadlineAt) {
          throw new BossRequestDeadlineError();
        }
        await this.delay(waitMs, permit.signal);
        this.assertPermit(permit);
      }

      const sample = Math.min(1, Math.max(0, this.random()));
      const factor = 1 - this.jitterRatio + sample * this.jitterRatio * 2;
      this.nextAllowedAt = this.now() + Math.round(this.intervalMs * factor);
      return await operation();
    } finally {
      if (hasTurn) {
        release?.();
      } else {
        void previous.finally(() => release?.());
      }
    }
  }

  private assertPermit(permit: BossRequestPermit): void {
    if (permit.signal.aborted) {
      throw abortReason(permit.signal);
    }
    if (this.now() >= permit.deadlineAt) {
      throw new BossRequestDeadlineError();
    }
  }

  private async waitForTurn(
    previous: Promise<void>,
    permit: BossRequestPermit,
  ): Promise<void> {
    this.assertPermit(permit);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const milliseconds = Math.max(0, permit.deadlineAt - this.now());
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(deadlineTimer);
        permit.signal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = (): void => {
        finish(() => reject(abortReason(permit.signal)));
      };
      const deadlineTimer = setTimeout(() => {
        finish(() => reject(new BossRequestDeadlineError()));
      }, milliseconds);
      permit.signal.addEventListener('abort', onAbort, { once: true });
      void previous.then(
        () => finish(resolve),
        (error: unknown) => finish(() => reject(error)),
      );
    });
    this.assertPermit(permit);
  }
}
