import {
  JobDetailSchema,
  JobResponseSchema,
  type JobCard,
  type JobDetail,
  type ScanRunSnapshot,
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
import {
  DEFAULT_SCAN_CONFIG,
  ScanController,
  scanStateFromSnapshot,
} from './scan-controller';

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
    firstSeenAt: '2026-08-01T10:00:00.000Z',
    lastSeenAt: '2026-08-01T10:00:00.000Z',
  });
}

function scanRun(status: 'running' | 'cancelled' | 'interrupted' = 'running') {
  return {
    id: 'scan-1',
    status,
    phase: status === 'running' ? ('starting' as const) : ('finished' as const),
    startedAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    finishedAt: status === 'running' ? null : '2026-08-01T10:00:01.000Z',
    pageCount: 0,
    discoveredCount: 0,
    newJobCount: 0,
    detailSuccessCount: 0,
    detailFailureCount: 0,
    aiSuccessCount: 0,
    aiFailureCount: 0,
    cacheHitCount: 0,
    stopReason: null,
    errorSummary: null,
    cancelRequested: false,
  };
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
    createScanRun: vi.fn(async () => scanRun()),
    updateScanRun: vi.fn(async () => scanRun()),
    latestScanRun: vi.fn(async () => null),
    requestScanRunCancel: vi.fn(async () => ({
      ...scanRun(),
      cancelRequested: true,
    })),
    interruptScanRun: vi.fn(async () => scanRun('interrupted')),
    observeJobs: vi.fn(async (
      _runId: string,
      _sourceQuery: string,
      jobs: readonly JobCard[],
    ) =>
      jobs.map((job) => ({
        sourceJobId: job.jobId,
        action: 'read-detail' as const,
        reason: 'new' as const,
      })),
    ),
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
      evaluation: {
        score: 88,
        recommendation: 'apply',
        archetype: 'Builder',
        legitimacy: 'high',
        rawReport: '完整 career-ops 原始报告。',
      },
      cacheHit: false,
    })),
    listJobs: vi.fn(async () => []),
    saveCandidate: vi.fn(async (jobId, update) => ({
      jobId,
      decision: update.decision ?? null,
      note: update.note ?? null,
      applicationStatus: update.applicationStatus ?? 'not_applied',
      updatedAt: '2026-08-01T10:00:00.000Z',
    })),
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
  it('Side Panel 重建后从 Bridge 快照恢复 interrupted 进度和结果', () => {
    const card = visibleCard(0);
    const saved = savedFor(detailFor(card));
    const snapshot: ScanRunSnapshot = {
      run: {
        ...scanRun('interrupted'),
        pageCount: 2,
        discoveredCount: 12,
        newJobCount: 4,
        detailSuccessCount: 3,
        detailFailureCount: 1,
        aiSuccessCount: 2,
        aiFailureCount: 1,
        cacheHitCount: 1,
        stopReason: 'bridge-restarted',
        errorSummary: '1 个详情失败；1 个评估失败。',
      },
      jobs: [
        {
          ...saved,
          latestEvaluation: {
            score: 90,
            recommendation: 'apply',
            rawReport: '已持久化评估。',
          },
        },
      ],
    };

    const restored = scanStateFromSnapshot(snapshot);

    expect(restored).toMatchObject({
      runId: 'scan-1',
      status: 'interrupted',
      progress: {
        pagesVisited: 2,
        listJobs: 12,
        detailCompleted: 4,
        aiCompleted: 3,
        cacheHits: 1,
      },
      error: '1 个详情失败；1 个评估失败。',
    });
    expect(restored.results).toHaveLength(1);
    expect(restored.results[0]?.evaluation?.score).toBe(90);
    expect(restored.warnings[0]).toContain('可重新开始');
  });

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

  it('详情诊断会记录响应证据和读取来源，不包含整页 HTML', async () => {
    const card = visibleCard(0);
    const content = contentMock([[card]]);
    vi.mocked(content.startDetailScan).mockResolvedValue({
      type: 'boss/start-detail-scan/response',
      outcome: 'success',
      job: detailFor(card),
      diagnostics: [
        {
          source: 'fetch',
          sourceJobId: card.job.jobId,
          detailUrl: card.job.detailUrl,
          responseUrl: card.job.detailUrl,
          httpStatus: 200,
          detectedPageType: 'job-detail',
          hasDetailContainer: true,
          missingFields: [],
          outcome: 'success',
        },
      ],
    });
    const bridge = bridgeMock();

    await controller(content, bridge).run({ maxPages: 1 });

    expect(bridge.recordDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'detail_read',
        expectedJobId: card.job.jobId,
        details: expect.objectContaining({
          sourceJobId: card.job.jobId,
          originalDetailUrl: card.job.detailUrl,
          finalResponseUrl: card.job.detailUrl,
          httpStatus: 200,
          detectedPageType: 'job-detail',
          hasDetailContainer: true,
          missingFields: null,
          readSource: 'fetch',
        }),
      }),
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(vi.mocked(bridge.recordDiagnostic).mock.calls)).not.toContain(
      '<html',
    );
  });

  it('单次 AI 失败不终止整轮，后一个职位继续评估', async () => {
    const cards = [visibleCard(0), visibleCard(1)];
    const content = contentMock([cards]);
    const bridge = bridgeMock();
    vi.mocked(bridge.evaluateJob)
      .mockRejectedValueOnce(new Error('AI provider unavailable'))
      .mockResolvedValueOnce({
        evaluation: {
          score: 92,
          recommendation: 'apply',
          rawReport: '第二个职位评估成功。',
        },
        cacheHit: false,
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

  it('5 个详情成功、3 个 layout 失败时继续完成并评估所有成功职位', async () => {
    const cards = Array.from({ length: 8 }, (_, index) => visibleCard(index));
    const content = contentMock([cards]);
    vi.mocked(content.startDetailScan).mockImplementation(async (card) => {
      if (card.index < 5) {
        return {
          type: 'boss/start-detail-scan/response',
          outcome: 'success',
          job: detailFor(card),
        };
      }
      return {
        type: 'boss/start-detail-scan/response',
        outcome: 'failed',
        message: '单个职位详情布局无法识别。',
        failureKind: 'layout',
        retryable: false,
      };
    });
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run({ maxPages: 1 });

    expect(state.status).toBe('completed');
    expect(state.stopReason).toBe('page_limit');
    expect(state.progress).toMatchObject({
      detailCompleted: 8,
      detailSuccess: 5,
      detailFailure: 3,
      aiCompleted: 5,
      aiSuccess: 5,
    });
    expect(content.startDetailScan).toHaveBeenCalledTimes(8);
    expect(bridge.evaluateJob).toHaveBeenCalledTimes(5);
  });

  it('至少 8 个样本且同类 Parser 错误达到 75% 才停止，并先评估成功详情', async () => {
    const cards = Array.from({ length: 10 }, (_, index) => visibleCard(index));
    const content = contentMock([cards]);
    vi.mocked(content.startDetailScan).mockImplementation(async (card) => {
      if (card.index < 2) {
        return {
          type: 'boss/start-detail-scan/response',
          outcome: 'success',
          job: detailFor(card),
        };
      }
      return {
        type: 'boss/start-detail-scan/response',
        outcome: 'identity_failure',
      };
    });
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run({ maxPages: 1 });

    expect(state.status).toBe('failed');
    expect(state.stopReason).toBe('parser_failure_limit');
    expect(state.progress).toMatchObject({
      detailCompleted: 8,
      detailSuccess: 2,
      detailFailure: 6,
      aiCompleted: 2,
      aiSuccess: 2,
    });
    expect(content.startDetailScan).toHaveBeenCalledTimes(8);
    expect(bridge.evaluateJob).toHaveBeenCalledTimes(2);
  });

  it.each(['login_required', 'challenge', 'account_risk'] as const)(
    '详情读取出现 %s 时立即停止整轮',
    async (reason) => {
      const cards = [visibleCard(0), visibleCard(1)];
      const content = contentMock([cards]);
      vi.mocked(content.startDetailScan).mockResolvedValue({
        type: 'boss/start-detail-scan/response',
        outcome: 'blocked',
        reason,
      });
      const bridge = bridgeMock();

      const state = await controller(content, bridge).run({ maxPages: 1 });

      expect(state.status).toBe('failed');
      expect(state.stopReason).toBe(reason);
      expect(content.startDetailScan).toHaveBeenCalledOnce();
      expect(bridge.saveJob).not.toHaveBeenCalled();
      expect(bridge.evaluateJob).not.toHaveBeenCalled();
    },
  );

  it('连续两页没有新职位时正常完成', async () => {
    const duplicate = visibleCard(0);
    const content = contentMock([[duplicate], [duplicate], [visibleCard(1, 2)]]);
    const bridge = bridgeMock();
    const existing = savedFor(detailFor(duplicate));
    vi.mocked(bridge.observeJobs).mockImplementation(
      async (_runId, _sourceQuery, jobs) =>
        jobs.map((job) => ({
          sourceJobId: job.jobId,
          action: 'reuse' as const,
          job: existing,
          evaluation: {
            score: 88,
            recommendation: 'apply',
            rawReport: '缓存评估。',
          },
          cacheHit: true,
        })),
    );

    const state = await controller(content, bridge).run();

    expect(state.status).toBe('completed');
    expect(state.stopReason).toBe('no_new_jobs');
    expect(state.progress.pagesVisited).toBe(2);
    expect(content.advanceSearchPage).toHaveBeenCalledOnce();
    expect(state.results).toHaveLength(1);
    expect(state.progress.cacheHits).toBe(1);
    expect(content.startDetailScan).not.toHaveBeenCalled();
    expect(bridge.evaluateJob).not.toHaveBeenCalled();
  });

  it('旧职位 cache miss 时重建完整硬规则，阻断后不调用 AI', async () => {
    const card = visibleCard(0);
    const content = contentMock([[card]]);
    const bridge = bridgeMock();
    const existing = savedFor(detailFor(card));
    vi.mocked(bridge.observeJobs).mockResolvedValue([
      {
        sourceJobId: card.job.jobId,
        action: 'reuse',
        job: existing,
        evaluation: null,
        cacheHit: false,
      },
    ]);
    vi.mocked(bridge.screenJobs).mockResolvedValue([
      {
        jobId: card.job.jobId,
        matched: false,
        reasons: ['命中完整硬规则'],
      },
    ]);

    const state = await controller(content, bridge).run({ maxPages: 1 });

    expect(state.status).toBe('completed');
    expect(state.results[0]?.screening).toMatchObject({
      matched: false,
      reasons: ['命中完整硬规则'],
    });
    expect(bridge.screenJobs).toHaveBeenCalledWith(
      [expect.objectContaining({ description: expect.any(String) })],
      undefined,
      expect.any(AbortSignal),
      'detail',
    );
    expect(bridge.evaluateJob).not.toHaveBeenCalled();
    expect(content.startDetailScan).not.toHaveBeenCalled();
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

  it('Side Panel 关闭时不等待 Content Script 即发出 keepalive 中断写入', async () => {
    const content = contentMock([[]]);
    let finishContentCancellation: (() => void) | undefined;
    vi.mocked(content.cancelDetailScan).mockImplementation(
      async () =>
        await new Promise<boolean>((resolve) => {
          finishContentCancellation = () => resolve(true);
        }),
    );
    const bridge = bridgeMock();
    const scan = controller(content, bridge);
    scan.restore({ run: scanRun(), jobs: [] });

    const interrupted = scan.interrupt('side-panel-closed');

    expect(bridge.interruptScanRun).toHaveBeenCalledWith('scan-1', {
      reason: 'side-panel-closed',
      errorSummary: '扫描上下文已关闭，可重新开始并复用已完成结果。',
    });
    finishContentCancellation?.();
    await interrupted;
    expect(scan.state.status).toBe('interrupted');
  });
});
