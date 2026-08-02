import { JobCardSchema, type VisibleJobCard } from '@career-ops-cn/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchBossDetail, toJobCard } from './boss-detail-fetch';

const card: VisibleJobCard = {
  index: 0,
  job: JobCardSchema.parse({
    jobId: 'boss-timeout',
    title: '前端工程师',
    companyName: '示例科技',
    detailUrl: 'https://www.zhipin.com/job_detail/boss-timeout.html',
  }),
};

function pendingFetch(): typeof fetch {
  return vi.fn((_, init) => {
    const requestSignal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener(
        'abort',
        () =>
          reject(
            requestSignal.reason ??
              new DOMException('请求已中止。', 'AbortError'),
          ),
        { once: true },
      );
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchBossDetail', () => {
  it('列表非关键字段缺失时仍生成可处理 JobCard', () => {
    expect(
      toJobCard({
        sourceJobId: 'boss-minimal',
        title: '前端工程师',
        company: '示例科技',
        url: 'https://www.zhipin.com/job_detail/boss-minimal.html',
        salaryRaw: null,
        city: null,
        experience: null,
        education: null,
        tags: [],
      }),
    ).toEqual({
      job: {
        jobId: 'boss-minimal',
        title: '前端工程师',
        companyName: '示例科技',
        detailUrl: 'https://www.zhipin.com/job_detail/boss-minimal.html',
      },
      invalidFields: [],
    });
  });

  it('detailTimeoutMs 会真实中止 fetch，并清理 timer 与外部监听器', async () => {
    vi.useFakeTimers();
    const userController = new AbortController();
    const removeListener = vi.spyOn(
      userController.signal,
      'removeEventListener',
    );
    const fetchImpl = pendingFetch();
    const resultPromise = fetchBossDetail({
      card,
      timeoutMs: 250,
      signal: userController.signal,
      fetchImpl,
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(fetchImpl).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    await expect(resultPromise).resolves.toEqual({
      type: 'boss/start-detail-scan/response',
      outcome: 'timeout',
    });
    const requestSignal = vi.mocked(fetchImpl).mock.calls[0]?.[1]
      ?.signal as AbortSignal;
    expect(requestSignal.aborted).toBe(true);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('用户取消与请求超时保持不同结果', async () => {
    const userController = new AbortController();
    const resultPromise = fetchBossDetail({
      card,
      timeoutMs: 10_000,
      signal: userController.signal,
      fetchImpl: pendingFetch(),
    });

    userController.abort();

    await expect(resultPromise).resolves.toEqual({
      type: 'boss/start-detail-scan/response',
      outcome: 'cancelled',
    });
  });

  it('普通网络错误可重试，但不会伪装成超时或页面阻断', async () => {
    const result = await fetchBossDetail({
      card,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      fetchImpl: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      failureKind: 'network',
      retryable: true,
    });
  });
});
