import { describe, expect, it } from 'vitest';

import { BossContentLocatorStore } from './boss-content-session';

describe('BossContentLocatorStore', () => {
  it('raw locator 只允许相同 session、generation 和 sourceJobId 解析', () => {
    const store = new BossContentLocatorStore(
      'https://www.zhipin.com',
      'generation-1',
    );
    const first = store.beginSession('session-1', 'boss:/web/geek/jobs');
    const rawUrl =
      'https://www.zhipin.com/job_detail/boss-1.html?securityId=volatile';

    expect(store.register(first, 'boss-1', rawUrl)).toBe(true);
    expect(store.resolve(first, 'boss-1')).toBe(rawUrl);
    expect(
      store.resolve({ ...first, sessionId: 'session-other' }, 'boss-1'),
    ).toBeNull();
    expect(
      store.resolve({ ...first, generation: 'generation-other' }, 'boss-1'),
    ).toBeNull();
    expect(store.resolve(first, 'boss-other')).toBeNull();
  });

  it('新 session 与显式 clear 都会清除旧 locator', () => {
    const store = new BossContentLocatorStore(
      'https://www.zhipin.com',
      'generation-1',
    );
    const first = store.beginSession('session-1', 'boss:/web/geek/jobs');
    store.register(
      first,
      'boss-1',
      'https://www.zhipin.com/job_detail/boss-1.html?securityId=first',
    );

    const second = store.beginSession('session-2', 'boss:/web/geek/jobs');
    expect(store.resolve(first, 'boss-1')).toBeNull();
    store.register(
      second,
      'boss-2',
      'https://www.zhipin.com/job_detail/boss-2.html?securityId=second',
    );
    store.clear();
    expect(store.resolve(second, 'boss-2')).toBeNull();
  });

  it('queryScope 改变后 sticky context_changed 并清空 locator', () => {
    const store = new BossContentLocatorStore(
      'https://www.zhipin.com',
      'generation-1',
    );
    const session = store.beginSession(
      'session-1',
      'boss:/web/geek/job?query=TypeScript',
    );
    store.register(
      session,
      'boss-1',
      'https://www.zhipin.com/job_detail/boss-1.html?securityId=volatile',
    );

    expect(
      store.validate(session, 'boss:/web/geek/job?query=Java'),
    ).toEqual({ status: 'context_changed' });
    expect(
      store.validate(session, 'boss:/web/geek/job?query=TypeScript'),
    ).toEqual({ status: 'context_changed' });
    expect(store.resolve(session, 'boss-1')).toBeNull();
  });

  it('account fatal 在 endSession 前保持 sticky 并禁止 locator 继续使用', () => {
    const store = new BossContentLocatorStore(
      'https://www.zhipin.com',
      'generation-1',
    );
    const session = store.beginSession('session-1', 'boss:/web/geek/jobs');
    store.register(
      session,
      'boss-1',
      'https://www.zhipin.com/job_detail/boss-1.html?securityId=volatile',
    );

    expect(store.latchFatal('challenge')).toEqual({
      type: 'boss/fatal-block/event',
      sessionId: 'session-1',
      generation: 'generation-1',
      reason: 'challenge',
    });
    expect(store.latchFatal('account_risk')).toBeNull();
    expect(store.validate(session, 'boss:/web/geek/jobs')).toMatchObject({
      status: 'fatal',
      event: { reason: 'challenge' },
    });
    expect(store.resolve(session, 'boss-1')).toBeNull();
    expect(
      store.register(
        session,
        'boss-2',
        'https://www.zhipin.com/job_detail/boss-2.html?securityId=other',
      ),
    ).toBe(false);

    expect(store.endSession(session)).toBe(true);
    const next = store.beginSession('session-2', 'boss:/web/geek/jobs');
    expect(store.validate(next, 'boss:/web/geek/jobs')).toMatchObject({
      status: 'ok',
    });
  });

  it.each([
    [
      '同域非详情路径',
      'https://www.zhipin.com/web/geek/job?query=TypeScript',
    ],
    [
      '详情 Job ID 冲突',
      'https://www.zhipin.com/job_detail/boss-other.html?securityId=volatile',
    ],
    [
      '非 BOSS host',
      'https://example.com/job_detail/boss-1.html?securityId=volatile',
    ],
  ])('%s 不能注册为 raw locator', (_label, rawUrl) => {
    const store = new BossContentLocatorStore(
      'https://www.zhipin.com',
      'generation-1',
    );
    const session = store.beginSession('session-1', 'boss:/web/geek/jobs');

    expect(store.register(session, 'boss-1', rawUrl)).toBe(false);
    expect(store.resolve(session, 'boss-1')).toBeNull();
  });

  it('不同 zhipin 子域也不能越过当前页面同源边界', () => {
    const store = new BossContentLocatorStore(
      'https://www.zhipin.com',
      'generation-1',
    );
    const session = store.beginSession('session-1', 'boss:/web/geek/jobs');

    expect(
      store.register(
        session,
        'boss-1',
        'https://m.zhipin.com/job_detail/boss-1.html?securityId=volatile',
      ),
    ).toBe(false);
  });
});
