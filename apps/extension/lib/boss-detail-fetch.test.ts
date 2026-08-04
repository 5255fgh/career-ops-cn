import { readFileSync } from 'node:fs';

import { JobCardSchema, type VisibleJobCard } from '@career-ops-cn/shared';
import { Window } from 'happy-dom';
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

const fixtureUrl = (filename: string): URL =>
  new URL(`../../../fixtures/boss/${filename}`, import.meta.url);

const readFixture = (filename: string): string =>
  readFileSync(fixtureUrl(filename), 'utf8');

function createDocument(
  filename: string,
  url: string,
): { window: Window; document: Document; html: string } {
  const html = readFixture(filename);
  const window = new Window({ url });
  window.document.write(html);
  window.document.close();
  return { window, document: window.document as unknown as Document, html };
}

function htmlResponse(html: string, url: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    text: async () => html,
  } as Response;
}

const directCard: VisibleJobCard = {
  index: 9,
  job: JobCardSchema.parse({
    jobId: 'boss-2001',
    title: '高级前端工程师',
    companyName: '示例丙软件',
    detailUrl:
      'https://www.zhipin.com/job_detail/boss-2001.html?securityId=do-not-log',
  }),
};

const panelCard: VisibleJobCard = {
  index: 99,
  job: JobCardSchema.parse({
    jobId: 'boss-3002',
    title: '全栈工程师',
    companyName: '示例戊科技',
    detailUrl: 'https://www.zhipin.com/job_detail/boss-3002.html',
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

    await expect(resultPromise).resolves.toMatchObject({
      type: 'boss/start-detail-scan/response',
      outcome: 'timeout',
      diagnostics: [
        expect.objectContaining({
          source: 'fetch',
          sourceJobId: 'boss-timeout',
          httpStatus: null,
          detectedPageType: null,
          outcome: 'timeout',
        }),
      ],
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

    await expect(resultPromise).resolves.toMatchObject({
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

  it('直接 fetch 成功时解析详情并记录有限响应诊断', async () => {
    const url = directCard.job.detailUrl;
    const fixture = createDocument('job-detail.html', url);
    const responseUrl =
      'https://www.zhipin.com/job_detail/boss-2001.html?securityId=secret';

    const result = await fetchBossDetail({
      card: directCard,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      fetchImpl: vi.fn(async () =>
        htmlResponse(fixture.html, responseUrl),
      ) as unknown as typeof fetch,
      parseDocument: () => fixture.document,
    });

    expect(result).toMatchObject({
      outcome: 'success',
      job: {
        jobId: 'boss-2001',
        title: '高级前端工程师',
        description: '负责复杂业务前端架构与核心功能开发。',
      },
      diagnostics: [
        {
          source: 'fetch',
          sourceJobId: 'boss-2001',
          detailUrl: 'https://www.zhipin.com/job_detail/boss-2001.html',
          responseUrl: 'https://www.zhipin.com/job_detail/boss-2001.html',
          httpStatus: 200,
          detectedPageType: 'job-detail',
          hasDetailContainer: true,
          missingFields: [],
          outcome: 'success',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    fixture.window.close();
  });

  it('fetch 缺少详情容器时按单职位布局失败处理', async () => {
    const shell = createDocument(
      'fetch-detail-shell.html',
      panelCard.job.detailUrl,
    );
    const responseUrl =
      'https://www.zhipin.com/web/passport/zp/security.html?seed=do-not-log';
    const fetched = await fetchBossDetail({
      card: panelCard,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      fetchImpl: vi.fn(async () =>
        htmlResponse(shell.html, responseUrl),
      ) as unknown as typeof fetch,
      parseDocument: () => shell.document,
    });
    expect(fetched).toMatchObject({
      outcome: 'failed',
      failureKind: 'layout',
      diagnostics: [
        {
          source: 'fetch',
          sourceJobId: 'boss-3002',
          detailUrl: 'https://www.zhipin.com/job_detail/boss-3002.html',
          responseUrl:
            'https://www.zhipin.com/web/passport/zp/security.html',
          httpStatus: 200,
          detectedPageType: 'unsupported',
          hasDetailContainer: false,
          missingFields: ['detail_container'],
          outcome: 'unsupported_layout',
        },
      ],
    });
    expect(JSON.stringify(fetched)).not.toContain('do-not-log');
    shell.window.close();
  });
});
