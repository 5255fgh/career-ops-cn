import { describe, expect, it } from 'vitest';

import { BossContentLocatorStore } from './boss-content-session';

describe('BossContentLocatorStore', () => {
  it('raw locator 只允许相同 session、generation 和 sourceJobId 解析', () => {
    let sessionSequence = 0;
    const store = new BossContentLocatorStore(
      'generation-1',
      () => `session-${++sessionSequence}`,
    );
    const first = store.beginCapture();
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

  it('新 capture 与显式 clear 都会清除旧 locator', () => {
    let sessionSequence = 0;
    const store = new BossContentLocatorStore(
      'generation-1',
      () => `session-${++sessionSequence}`,
    );
    const first = store.beginCapture();
    store.register(
      first,
      'boss-1',
      'https://www.zhipin.com/job_detail/boss-1.html?securityId=first',
    );

    const second = store.beginCapture();
    expect(store.resolve(first, 'boss-1')).toBeNull();
    store.register(
      second,
      'boss-2',
      'https://www.zhipin.com/job_detail/boss-2.html?securityId=second',
    );
    store.clear();
    expect(store.resolve(second, 'boss-2')).toBeNull();
  });
});
