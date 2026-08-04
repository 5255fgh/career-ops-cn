import { describe, expect, it, vi } from 'vitest';

import {
  BossRequestDeadlineError,
  BossRequestGate,
} from './boss-request-gate';

describe('BossRequestGate', () => {
  it('首次 fetch 与唯一 retry 都取得许可，并使用不超过 ±20% 的间隔', async () => {
    let now = 1_000;
    const delay = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const random = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1);
    const gate = new BossRequestGate({
      intervalMs: 1_800,
      now: () => now,
      random,
      delay,
    });
    const signal = new AbortController().signal;
    const first = vi.fn(async () => 'first');
    const retry = vi.fn(async () => 'retry');

    await expect(
      gate.run({ signal, deadlineAt: 10_000 }, first),
    ).resolves.toBe('first');
    await expect(
      gate.run({ signal, deadlineAt: 10_000 }, retry),
    ).resolves.toBe('retry');

    expect(first).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    expect(delay).toHaveBeenCalledWith(1_440, signal);
    expect(random).toHaveBeenCalledTimes(2);
  });

  it('详情并发固定为 1', async () => {
    let finishFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    const gate = new BossRequestGate({ intervalMs: 0 });
    const signal = new AbortController().signal;
    const first = gate.run({ signal, deadlineAt: Date.now() + 5_000 }, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await firstPending;
      active -= 1;
    });
    const secondOperation = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      active -= 1;
    });
    const second = gate.run(
      { signal, deadlineAt: Date.now() + 5_000 },
      secondOperation,
    );

    await vi.waitFor(() => expect(active).toBe(1));
    expect(secondOperation).not.toHaveBeenCalled();
    finishFirst?.();
    await Promise.all([first, second]);
    expect(maximumActive).toBe(1);
  });

  it('队列中的已取消请求不会让后续请求绕过在途 fetch', async () => {
    let finishFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const gate = new BossRequestGate({ intervalMs: 0 });
    const firstSignal = new AbortController().signal;
    const cancelled = new AbortController();
    const thirdOperation = vi.fn(async () => undefined);
    const first = gate.run(
      { signal: firstSignal, deadlineAt: Date.now() + 5_000 },
      async () => await firstPending,
    );
    const second = gate.run(
      { signal: cancelled.signal, deadlineAt: Date.now() + 5_000 },
      async () => undefined,
    );
    const third = gate.run(
      { signal: firstSignal, deadlineAt: Date.now() + 5_000 },
      thirdOperation,
    );
    cancelled.abort(new DOMException('cancelled', 'AbortError'));

    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    expect(thirdOperation).not.toHaveBeenCalled();
    finishFirst?.();
    await Promise.all([first, third]);
    expect(thirdOperation).toHaveBeenCalledOnce();
  });

  it('fatal 或用户取消会中断限速等待', async () => {
    let now = 1_000;
    const controller = new AbortController();
    const delay = vi.fn(
      async (_milliseconds: number, signal: AbortSignal) =>
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const gate = new BossRequestGate({
      intervalMs: 1_800,
      now: () => now,
      random: () => 0.5,
      delay,
    });
    await gate.run(
      { signal: controller.signal, deadlineAt: 10_000 },
      async () => undefined,
    );
    const waiting = gate.run(
      { signal: controller.signal, deadlineAt: 10_000 },
      async () => undefined,
    );
    await vi.waitFor(() => expect(delay).toHaveBeenCalledOnce());

    const fatal = new Error('challenge');
    controller.abort(fatal);

    await expect(waiting).rejects.toBe(fatal);
    expect(now).toBe(1_000);
  });

  it('已知限速等待会越过绝对 deadline 时不调用 fetch', async () => {
    let now = 1_000;
    const operation = vi.fn(async () => undefined);
    const delay = vi.fn(async () => undefined);
    const gate = new BossRequestGate({
      intervalMs: 1_800,
      now: () => now,
      random: () => 0.5,
      delay,
    });
    const signal = new AbortController().signal;
    await gate.run({ signal, deadlineAt: 10_000 }, async () => undefined);

    await expect(
      gate.run({ signal, deadlineAt: 2_000 }, operation),
    ).rejects.toBeInstanceOf(BossRequestDeadlineError);
    expect(operation).not.toHaveBeenCalled();
    expect(delay).not.toHaveBeenCalled();
    expect(now).toBe(1_000);
  });
});
