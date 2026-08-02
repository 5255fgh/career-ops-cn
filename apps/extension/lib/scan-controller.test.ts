import {
  JobDetailSchema,
  JobResponseSchema,
  type JobCard,
  type JobDetail,
  type ScreeningPhase,
  type VisibleJobCard,
} from '@career-ops-cn/shared';
import { describe, expect, it, vi } from 'vitest';

import type { BridgeClient } from './bridge-client';
import {
  createContentClient,
  type ContentClient,
  type TabsClient,
} from './content-client';
import { DEFAULT_SCAN_CONFIG, ScanController } from './scan-controller';

function visibleCard(index: number, page = 0): VisibleJobCard {
  const suffix = page * 100 + index;
  const job: JobCard = {
    jobId: `boss-${suffix}`,
    title: `前端开发工程师 ${suffix}`,
    companyName: `示例科技 ${suffix}`,
    salaryText: '20-30K·14薪',
    location: '上海·浦东新区',
    experienceText: '3-5年',
    educationText: '本科',
    detailUrl: `https://www.zhipin.com/job_detail/boss-${suffix}.html`,
  };
  return { index, job };
}

function detailFor(card: VisibleJobCard): JobDetail {
  return JobDetailSchema.parse({
    ...card.job,
    description: `职位 ${card.job.jobId} 的完整 TypeScript 与 React 描述。`,
    identityVerified: true,
  });
}

function savedFor(detail: JobDetail) {
  return JobResponseSchema.parse({
    id: `saved-${detail.jobId}`,
    source: 'boss',
    sourceJobId: detail.jobId,
    title: detail.title,
    company: detail.companyName,
    salary: detail.salaryText,
    location: detail.location,
    experience: detail.experienceText,
    education: detail.educationText,
    description: detail.description,
    url: detail.detailUrl,
    identityVerified: true,
  });
}

function contentMock(pages: VisibleJobCard[][]): ContentClient {
  let pageIndex = 0;
  return {
    detectPage: vi.fn(async () => ({
      type: 'boss/detect-page/response' as const,
      pageType: 'search-detail-panel' as const,
      block: null,
    })),
    extractCurrentDetail: vi.fn(async () => null),
    extractVisibleCards: vi.fn(async () => {
      const cards = pages[pageIndex] ?? [];
      return {
        type: 'boss/extract-visible-cards/response' as const,
        cards,
        totalVisible: cards.length,
        invalidCount: 0,
      };
    }),
    startDetailScan: vi.fn(async (card) => ({
      type: 'boss/start-detail-scan/response' as const,
      outcome: 'success' as const,
      job: detailFor(card),
    })),
    advanceSearchPage: vi.fn(async () => {
      if (pageIndex + 1 >= pages.length) {
        return {
          type: 'boss/advance-search-page/response' as const,
          outcome: 'end' as const,
        };
      }
      pageIndex += 1;
      return {
        type: 'boss/advance-search-page/response' as const,
        outcome: 'advanced' as const,
      };
    }),
    cancelDetailScan: vi.fn(async () => true),
  };
}

function bridgeMock(): BridgeClient {
  return {
    health: vi.fn(async () => true),
    screenJobs: vi.fn(
      async (jobs: readonly (JobCard | JobDetail)[]) =>
        jobs.map((job) => ({
          jobId: job.jobId,
          matched: true,
          reasons: [],
        })),
    ),
    saveJob: vi.fn(async (detail) => savedFor(detail)),
    evaluateJob: vi.fn(async () => ({
      score: 88,
      recommendation: 'apply',
      archetype: 'Builder',
      legitimacy: 'high',
      rawReport: '完整 career-ops 原始报告。',
    })),
    listJobs: vi.fn(async () => []),
    saveDecision: vi.fn(async (jobId, decision) => ({ jobId, ...decision })),
    recordDiagnostic: vi.fn(async (event) => ({
      ...event,
      id: `diag-${Math.random()}`,
      createdAt: '2026-08-01T10:00:00.000Z',
    })),
    listDiagnostics: vi.fn(async () => []),
  };
}

function controller(
  content: ContentClient,
  bridge: BridgeClient,
): ScanController {
  return new ScanController({
    content,
    bridge,
    config: { requestIntervalMs: 0, maxRoundMs: 30_000 },
    delay: async () => undefined,
    random: () => 0.5,
  });
}

describe('ScanController', () => {
  it('固定默认预算支持 3 页、60 个新职位和至少 30 次 AI', () => {
    expect(DEFAULT_SCAN_CONFIG).toMatchObject({
      maxPages: 3,
      maxNewJobs: 60,
      maxAiJobs: 30,
      requestIntervalMs: 1_800,
      maxRoundMs: 600_000,
    });
  });

  it('一次点击自动处理多页，并在 60 个新职位预算处正常完成', async () => {
    const pages = [0, 1, 2].map((page) =>
      Array.from({ length: 25 }, (_, index) => visibleCard(index, page)),
    );
    const content = contentMock(pages);
    const bridge = bridgeMock();
    vi.mocked(bridge.screenJobs).mockImplementation(
      async (jobs, _preferences, _signal, phase: ScreeningPhase = 'list') =>
        jobs.map((job) => ({
          jobId: job.jobId,
          matched: phase !== 'list',
          reasons: phase === 'list' ? ['列表规则阻断'] : [],
        })),
    );

    const state = await controller(content, bridge).run();

    expect(state.error).toBeNull();
    expect(state.status).toBe('completed');
    expect(state.stopReason).toBe('new_job_limit');
    expect(state.progress.pagesVisited).toBe(3);
    expect(state.progress.newJobs).toBe(60);
    expect(state.results).toHaveLength(60);
    expect(content.advanceSearchPage).toHaveBeenCalledTimes(2);
    expect(content.startDetailScan).not.toHaveBeenCalled();
  });

  it('单个职位超时只记录失败，下一个职位仍保存并评估', async () => {
    const cards = [visibleCard(0), visibleCard(1)];
    const content = contentMock([cards]);
    vi.mocked(content.startDetailScan)
      .mockResolvedValueOnce({
        type: 'boss/start-detail-scan/response',
        outcome: 'timeout',
      })
      .mockResolvedValueOnce({
        type: 'boss/start-detail-scan/response',
        outcome: 'success',
        job: detailFor(cards[1]!),
      });
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run({ maxPages: 1 });

    expect(state.status).toBe('completed');
    expect(state.results[0]?.detailError).toBe('职位详情读取超时。');
    expect(state.results[1]?.savedJob).toBeDefined();
    expect(state.results[1]?.evaluation).toBeDefined();
    expect(content.startDetailScan).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      '身份校验失败',
      {
        type: 'boss/start-detail-scan/response' as const,
        outcome: 'identity_failure' as const,
      },
    ],
    [
      '字段缺失',
      {
        type: 'boss/start-detail-scan/response' as const,
        outcome: 'failed' as const,
        message: '职位详情缺少必要字段。',
        failureKind: 'missing_fields' as const,
        retryable: false,
      },
    ],
    [
      '单职位布局异常',
      {
        type: 'boss/start-detail-scan/response' as const,
        outcome: 'failed' as const,
        message: '单个职位详情布局无法识别。',
        failureKind: 'layout' as const,
        retryable: false,
      },
    ],
  ])('%s 只影响当前职位', async (_label, firstFailure) => {
    const cards = [visibleCard(0), visibleCard(1)];
    const content = contentMock([cards]);
    vi.mocked(content.startDetailScan)
      .mockResolvedValueOnce(firstFailure)
      .mockResolvedValueOnce({
        type: 'boss/start-detail-scan/response',
        outcome: 'success',
        job: detailFor(cards[1]!),
      });
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run({ maxPages: 1 });

    expect(state.status).toBe('completed');
    expect(state.results[0]?.detailError).toBeDefined();
    expect(state.results[1]?.evaluation).toBeDefined();
  });

  it('单职位保存失败后仍处理和评估下一个职位', async () => {
    const cards = [visibleCard(0), visibleCard(1)];
    const content = contentMock([cards]);
    const bridge = bridgeMock();
    vi.mocked(bridge.saveJob)
      .mockRejectedValueOnce(new Error('SQLite busy'))
      .mockResolvedValueOnce(savedFor(detailFor(cards[1]!)));

    const state = await controller(content, bridge).run({ maxPages: 1 });

    expect(state.status).toBe('completed');
    expect(state.results[0]?.detailError).toContain('保存职位失败');
    expect(state.results[1]?.evaluation).toBeDefined();
    expect(bridge.saveJob).toHaveBeenCalledTimes(2);
  });

  it('临时网络失败只重试 1 次，并保持详情并发为 1', async () => {
    const card = visibleCard(0);
    const content = contentMock([[card]]);
    let active = 0;
    let maxActive = 0;
    vi.mocked(content.startDetailScan)
      .mockImplementationOnce(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
        return {
          type: 'boss/start-detail-scan/response',
          outcome: 'failed',
          message: '临时断网',
          failureKind: 'network',
          retryable: true,
        };
      })
      .mockImplementationOnce(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
        return {
          type: 'boss/start-detail-scan/response',
          outcome: 'success',
          job: detailFor(card),
        };
      });
    const bridge = bridgeMock();
    const delay = vi.fn(async () => undefined);
    const scan = new ScanController({
      content,
      bridge,
      config: {
        maxPages: 1,
        requestIntervalMs: 1_800,
        maxRoundMs: 30_000,
      },
      delay,
      random: () => 0,
    });

    const state = await scan.run();

    expect(state.status).toBe('completed');
    expect(content.startDetailScan).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    expect(delay).toHaveBeenCalledWith(1_440, expect.any(AbortSignal));
    expect(state.progress.detailCompleted).toBe(1);
  });

  it('详情完成后执行完整筛选，阻断职位不会调用 AI', async () => {
    const card = visibleCard(0);
    const content = contentMock([[card]]);
    const bridge = bridgeMock();
    vi.mocked(bridge.screenJobs).mockImplementation(
      async (jobs, _preferences, _signal, phase: ScreeningPhase = 'list') =>
        jobs.map((job) => ({
          jobId: job.jobId,
          matched: phase === 'list',
          reasons:
            phase === 'detail' ? ['职位未命中任何必备技能'] : [],
        })),
    );

    const state = await controller(content, bridge).run({ maxPages: 1 });

    expect(state.status).toBe('completed');
    expect(state.results[0]?.preScreening?.matched).toBe(true);
    expect(state.results[0]?.screening).toMatchObject({
      matched: false,
      reasons: ['职位未命中任何必备技能'],
    });
    expect(bridge.saveJob).toHaveBeenCalledOnce();
    expect(bridge.evaluateJob).not.toHaveBeenCalled();
    expect(
      vi.mocked(bridge.screenJobs).mock.calls.map((call) => call[3]),
    ).toEqual(['list', 'detail']);
  });

  it('diagnostics 写入失败只产生警告，不改变业务成功状态', async () => {
    const content = contentMock([[visibleCard(0)]]);
    const bridge = bridgeMock();
    vi.mocked(bridge.recordDiagnostic).mockRejectedValue(
      new Error('diagnostics database unavailable'),
    );

    const state = await controller(content, bridge).run({ maxPages: 1 });

    expect(state.status).toBe('completed');
    expect(state.error).toBeNull();
    expect(state.warnings).toEqual([
      'diagnostics 写入失败：diagnostics database unavailable',
    ]);
    expect(state.results[0]?.evaluation).toBeDefined();
  });

  it('单次 AI 失败不终止整轮，后一个职位继续评估', async () => {
    const cards = [visibleCard(0), visibleCard(1)];
    const content = contentMock([cards]);
    const bridge = bridgeMock();
    vi.mocked(bridge.evaluateJob)
      .mockRejectedValueOnce(new Error('AI provider unavailable'))
      .mockResolvedValueOnce({
        score: 92,
        recommendation: 'apply',
        rawReport: '第二个职位评估成功。',
      });

    const state = await controller(content, bridge).run({ maxPages: 1 });

    expect(state.status).toBe('completed');
    expect(state.results[0]?.evaluationError).toBe('AI provider unavailable');
    expect(state.results[1]?.evaluation?.score).toBe(92);
    expect(bridge.evaluateJob).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['login', 'login_required'],
    ['challenge', 'challenge'],
    ['unsupported', 'account_risk'],
  ] as const)('%s 或风控在列表读取前立即停止', async (pageType, reason) => {
    const content = contentMock([[visibleCard(0)]]);
    vi.mocked(content.detectPage).mockResolvedValue({
      type: 'boss/detect-page/response',
      pageType,
      block: { reason, pageType },
    });
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run();

    expect(state.status).toBe('failed');
    expect(state.stopReason).toBe(reason);
    expect(content.extractVisibleCards).not.toHaveBeenCalled();
    expect(bridge.listJobs).not.toHaveBeenCalled();
    expect(bridge.evaluateJob).not.toHaveBeenCalled();
  });

  it('翻页时出现 challenge 会立即停止，不再读取下一页', async () => {
    const content = contentMock([[visibleCard(0)], [visibleCard(0, 1)]]);
    vi.mocked(content.advanceSearchPage).mockResolvedValue({
      type: 'boss/advance-search-page/response',
      outcome: 'blocked',
      reason: 'challenge',
    });
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run();

    expect(state.status).toBe('failed');
    expect(state.stopReason).toBe('challenge');
    expect(content.extractVisibleCards).toHaveBeenCalledOnce();
  });

  it('连续 3 个同类身份 Parser 错误才停止整轮', async () => {
    const cards = [0, 1, 2, 3].map((index) => visibleCard(index));
    const content = contentMock([cards]);
    vi.mocked(content.startDetailScan).mockResolvedValue({
      type: 'boss/start-detail-scan/response',
      outcome: 'identity_failure',
    });
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run({ maxPages: 1 });

    expect(state.status).toBe('failed');
    expect(state.stopReason).toBe('parser_failure_limit');
    expect(content.startDetailScan).toHaveBeenCalledTimes(3);
    expect(bridge.evaluateJob).not.toHaveBeenCalled();
  });

  it('连续两页没有新职位时正常完成', async () => {
    const duplicate = visibleCard(0);
    const content = contentMock([[duplicate], [duplicate], [visibleCard(1, 2)]]);
    const bridge = bridgeMock();
    vi.mocked(bridge.listJobs).mockResolvedValue([
      JobResponseSchema.parse({
        id: 'saved-existing',
        source: 'boss',
        sourceJobId: duplicate.job.jobId,
        title: duplicate.job.title,
        company: duplicate.job.companyName,
        url: duplicate.job.detailUrl,
        identityVerified: true,
      }),
    ]);

    const state = await controller(content, bridge).run();

    expect(state.status).toBe('completed');
    expect(state.stopReason).toBe('no_new_jobs');
    expect(state.progress.pagesVisited).toBe(2);
    expect(content.advanceSearchPage).toHaveBeenCalledOnce();
    expect(state.results).toHaveLength(0);
  });

  it('单轮达到最长时间后以正常预算停止，不进入失控循环', async () => {
    const card = visibleCard(0);
    const sendMessage = vi.fn<TabsClient['sendMessage']>(
      async (_tabId, message) => {
        switch ((message as { type?: string }).type) {
          case 'boss/detect-page/request':
            return {
              type: 'boss/detect-page/response',
              pageType: 'search-detail-panel',
              block: null,
            };
          case 'boss/extract-visible-cards/request':
            return {
              type: 'boss/extract-visible-cards/response',
              cards: [card],
              totalVisible: 1,
              invalidCount: 0,
            };
          case 'boss/start-detail-scan/request':
            return await new Promise<unknown>(() => undefined);
          case 'boss/cancel-detail-scan/request':
            return {
              type: 'boss/cancel-detail-scan/response',
              cancelled: true,
            };
          default:
            return undefined;
        }
      },
    );
    const content = createContentClient({
      query: async () => [{ id: 11 }],
      sendMessage,
    });
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run({ maxRoundMs: 20 });

    expect(state.status).toBe('completed');
    expect(state.stopReason).toBe('round_time_limit');
    expect(
      sendMessage.mock.calls.map(
        ([, message]) => (message as { type: string }).type,
      ),
    ).toContain('boss/cancel-detail-scan/request');
  });

  it('用户取消会中断当前详情并保留已完成职位', async () => {
    const cards = [visibleCard(0), visibleCard(1)];
    const content = contentMock([cards]);
    vi.mocked(content.startDetailScan).mockImplementation(
      async (card, _timeout, signal) => {
        if (card.index === 0) {
          return {
            type: 'boss/start-detail-scan/response',
            outcome: 'success',
            job: detailFor(card),
          };
        }
        return await new Promise((resolve) => {
          signal?.addEventListener(
            'abort',
            () =>
              resolve({
                type: 'boss/start-detail-scan/response',
                outcome: 'cancelled',
              }),
            { once: true },
          );
        });
      },
    );
    const bridge = bridgeMock();
    const scan = controller(content, bridge);
    const running = scan.run({ maxPages: 1 });
    await vi.waitFor(() =>
      expect(content.startDetailScan).toHaveBeenCalledTimes(2),
    );

    await scan.cancel();
    const state = await running;

    expect(state.status).toBe('cancelled');
    expect(content.cancelDetailScan).toHaveBeenCalledOnce();
    expect(state.results[0]?.savedJob).toBeDefined();
    expect(state.results[1]?.savedJob).toBeUndefined();
  });
});
