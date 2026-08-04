import {
  JobDetailSchema,
  JobResponseSchema,
  type BossAccountFatalReason,
  type BossFatalBlockEvent,
  type BossSessionInvalidatedEvent,
  type JobCard,
  type JobDetail,
  type ScanRunSnapshot,
  type ScreeningPhase,
  type VisibleJobCard,
} from '@career-ops-cn/shared';
import { describe, expect, it, vi } from 'vitest';

import type { BridgeClient } from './bridge-client';
import {
  BossFatalBlockError,
  ContentContextChangedError,
  createContentClient,
  type ContentClient,
  type TabsClient,
} from './content-client';
import {
  DEFAULT_SCAN_CONFIG,
  ScanController,
  scanStateFromSnapshot,
} from './scan-controller';

const contentFatalEmitters = new WeakMap<
  ContentClient,
  (reason: BossAccountFatalReason) => void
>();
const contentInvalidationEmitters = new WeakMap<ContentClient, () => void>();

function emitContentFatal(
  content: ContentClient,
  reason: BossAccountFatalReason,
): void {
  contentFatalEmitters.get(content)?.(reason);
}

function emitContentInvalidation(content: ContentClient): void {
  contentInvalidationEmitters.get(content)?.();
}

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
  const fatalListeners = new Set<(event: BossFatalBlockEvent) => void>();
  const invalidationListeners = new Set<
    (event: BossSessionInvalidatedEvent) => void
  >();
  const content: ContentClient = {
    beginSession: vi.fn(async () => ({
      sessionId: 'session-1',
      tabId: 42,
      generation: 'generation-1',
      queryScope: 'boss:/web/geek/job?query=TypeScript',
    })),
    endSession: vi.fn(async () => true),
    onFatalBlock(listener) {
      fatalListeners.add(listener);
      return () => fatalListeners.delete(listener);
    },
    onSessionInvalidated(listener) {
      invalidationListeners.add(listener);
      return () => invalidationListeners.delete(listener);
    },
    detectPage: vi.fn(async () => ({
      type: 'boss/detect-page/response' as const,
      pageType: 'search-detail-panel' as const,
      block: null,
    })),
    extractCurrentDetail: vi.fn(async () => null),
    extractVisibleCards: vi.fn(async () => {
      const cards = pages[0] ?? [];
      return {
        type: 'boss/extract-visible-cards/response' as const,
        sessionId: 'session-1',
        generation: 'generation-1',
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
    cancelDetailScan: vi.fn(async () => true),
  };
  contentFatalEmitters.set(content, (reason) => {
    const event: BossFatalBlockEvent = {
      type: 'boss/fatal-block/event',
      sessionId: 'session-1',
      generation: 'generation-1',
      reason,
    };
    for (const listener of fatalListeners) {
      listener(event);
    }
  });
  contentInvalidationEmitters.set(content, () => {
    const event: BossSessionInvalidatedEvent = {
      type: 'boss/session-invalidated/event',
      sessionId: 'session-1',
      generation: 'generation-1',
      reason: 'context_changed',
    };
    for (const listener of invalidationListeners) {
      listener(event);
    }
  });
  return content;
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

  it('默认只处理当前页，同时保留其他预算', () => {
    expect(DEFAULT_SCAN_CONFIG).toMatchObject({
      maxPages: 1,
      maxNewJobs: 60,
      maxAiJobs: 30,
      requestIntervalMs: 1_800,
      maxRoundMs: 600_000,
    });
  });

  it('当前页存在后续页面时也只处理一次并正常完成', async () => {
    const pages = [0, 1].map((page) =>
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
    expect(state.stopReason).toBe('current_page_complete');
    expect(state.progress.pagesVisited).toBe(1);
    expect(state.progress.newJobs).toBe(25);
    expect(state.results).toHaveLength(25);
    expect(content.extractVisibleCards).toHaveBeenCalledOnce();
    expect(content.startDetailScan).not.toHaveBeenCalled();
    expect(content.beginSession).toHaveBeenCalledOnce();
    expect(content.endSession).toHaveBeenCalledOnce();
  });

  it('maxNewJobs 恰好覆盖当前页全部新职位时仍是 current_page_complete', async () => {
    const cards = [visibleCard(0), visibleCard(1)];
    const content = contentMock([cards]);
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run({ maxNewJobs: 2 });

    expect(state.status).toBe('completed');
    expect(state.stopReason).toBe('current_page_complete');
    expect(content.startDetailScan).toHaveBeenCalledTimes(2);
  });

  it('当前页有新职位因 maxNewJobs 被跳过时才使用 new_job_limit', async () => {
    const cards = [visibleCard(0), visibleCard(1), visibleCard(2)];
    const content = contentMock([cards]);
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run({ maxNewJobs: 2 });

    expect(state.status).toBe('completed');
    expect(state.stopReason).toBe('new_job_limit');
    expect(content.startDetailScan).toHaveBeenCalledTimes(2);
  });

  it('queryScope 或 content generation 改变时整轮进入 interrupted', async () => {
    const content = contentMock([[visibleCard(0)]]);
    vi.mocked(content.detectPage).mockRejectedValue(
      new ContentContextChangedError(),
    );
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run();

    expect(state.status).toBe('interrupted');
    expect(state.stopReason).toBeNull();
    expect(bridge.saveJob).not.toHaveBeenCalled();
    expect(bridge.evaluateJob).not.toHaveBeenCalled();
    expect(content.endSession).toHaveBeenCalledOnce();
  });

  it('Bridge 阶段收到主动 session invalidation 时立即 interrupted 且不保存或调用 AI', async () => {
    const content = contentMock([[visibleCard(0)]]);
    const bridge = bridgeMock();
    vi.mocked(bridge.observeJobs).mockImplementation(async () => {
      emitContentInvalidation(content);
      return [
        {
          sourceJobId: 'boss-0',
          action: 'read-detail',
          reason: 'new',
        },
      ];
    });

    const state = await controller(content, bridge).run();

    expect(state.status).toBe('interrupted');
    expect(state.stopReason).toBeNull();
    expect(content.startDetailScan).not.toHaveBeenCalled();
    expect(bridge.saveJob).not.toHaveBeenCalled();
    expect(bridge.evaluateJob).not.toHaveBeenCalled();
  });

  it('正常处理结束但固定 tab 在 endSession 前断开时最终仍返回 interrupted', async () => {
    const content = contentMock([[visibleCard(0)]]);
    vi.mocked(content.endSession).mockResolvedValue(false);
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run();

    expect(state.status).toBe('interrupted');
    expect(state.stopReason).toBeNull();
    expect(state.error).toContain('页面 generation');
    expect(bridge.updateScanRun).toHaveBeenLastCalledWith(
      'scan-1',
      expect.objectContaining({ status: 'interrupted', phase: 'finished' }),
      expect.any(AbortSignal),
    );
  });

  it('beginSession pending 期间主动 invalidation 保持 interrupted', async () => {
    const content = contentMock([[visibleCard(0)]]);
    vi.mocked(content.beginSession).mockImplementation(async () => {
      emitContentInvalidation(content);
      return {
        sessionId: 'session-1',
        tabId: 42,
        generation: 'generation-1',
        queryScope: 'boss:/web/geek/job?query=TypeScript',
      };
    });
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run();

    expect(state.status).toBe('interrupted');
    expect(bridge.createScanRun).not.toHaveBeenCalled();
  });

  it('beginSession 超过 round deadline 时归类为 completed/round_time_limit', async () => {
    vi.useFakeTimers();
    try {
      const content = contentMock([[visibleCard(0)]]);
      vi.mocked(content.beginSession).mockImplementation(
        async (signal) =>
          await new Promise((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(signal.reason),
              { once: true },
            );
          }),
      );
      const bridge = bridgeMock();

      const running = controller(content, bridge).run({ maxRoundMs: 20 });
      await vi.advanceTimersByTimeAsync(20);
      const state = await running;

      expect(state.status).toBe('completed');
      expect(state.stopReason).toBe('round_time_limit');
      expect(bridge.createScanRun).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('createScanRun 期间 fatal 不会被普通 Bridge 错误覆盖', async () => {
    const content = contentMock([[visibleCard(0)]]);
    const bridge = bridgeMock();
    vi.mocked(bridge.createScanRun).mockImplementation(async () => {
      emitContentFatal(content, 'challenge');
      throw new Error('create response lost');
    });

    const state = await controller(content, bridge).run();

    expect(state.status).toBe('failed');
    expect(state.stopReason).toBe('challenge');
    expect(state.error).toContain('challenge');
  });

  it('maxPages 不为 1 时在创建 run 前明确拒绝', async () => {
    const content = contentMock([[visibleCard(0)]]);
    const bridge = bridgeMock();
    const scan = controller(content, bridge);

    await expect(scan.run({ maxPages: 2 })).rejects.toThrow();
    expect(bridge.createScanRun).not.toHaveBeenCalled();
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

  it('请求 gate 判定会越过绝对 deadline 时立即按轮次预算完成', async () => {
    const cards = [visibleCard(0), visibleCard(1)];
    const content = contentMock([cards]);
    vi.mocked(content.startDetailScan).mockResolvedValue({
      type: 'boss/start-detail-scan/response',
      outcome: 'deadline_exceeded',
    });
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run();

    expect(state.status).toBe('completed');
    expect(state.stopReason).toBe('round_time_limit');
    expect(content.startDetailScan).toHaveBeenCalledOnce();
    expect(bridge.saveJob).not.toHaveBeenCalled();
    expect(bridge.evaluateJob).not.toHaveBeenCalled();
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
    [
      'content locator 缺失',
      {
        type: 'boss/start-detail-scan/response' as const,
        outcome: 'failed' as const,
        message: '当前 content session 缺少该职位的请求定位信息。',
        failureKind: 'locator' as const,
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
    const scan = new ScanController({
      content,
      bridge,
      config: {
        maxPages: 1,
        requestIntervalMs: 1_800,
        maxRoundMs: 30_000,
      },
    });

    const state = await scan.run();

    expect(state.status).toBe('completed');
    expect(content.startDetailScan).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    expect(content.startDetailScan).toHaveBeenNthCalledWith(
      2,
      card,
      8_000,
      expect.any(AbortSignal),
      expect.objectContaining({ requestIntervalMs: 1_800 }),
    );
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
    expect(state.stopReason).toBe('current_page_complete');
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

  it.each(['login_required', 'challenge', 'account_risk'] as const)(
    '主动 %s event 在详情请求悬挂中立即终止且不发起 retry',
    async (reason) => {
      const card = visibleCard(0);
      const content = contentMock([[card]]);
      let markRequestStarted: (() => void) | undefined;
      const requestStarted = new Promise<void>((resolve) => {
        markRequestStarted = resolve;
      });
      vi.mocked(content.startDetailScan).mockImplementation(
        async (_card, _timeout, signal) =>
          await new Promise((resolve) => {
            markRequestStarted?.();
            signal?.addEventListener(
              'abort',
              () =>
                resolve({
                  type: 'boss/start-detail-scan/response',
                  outcome: 'cancelled',
                }),
              { once: true },
            );
          }),
      );
      const bridge = bridgeMock();
      const scan = new ScanController({
        content,
        bridge,
        config: { requestIntervalMs: 1_800, maxRoundMs: 30_000 },
      });

      const running = scan.run();
      await requestStarted;
      emitContentFatal(content, reason);
      const state = await running;

      expect(state.status).toBe('failed');
      expect(state.stopReason).toBe(reason);
      expect(content.startDetailScan).toHaveBeenCalledOnce();
      expect(bridge.saveJob).not.toHaveBeenCalled();
      expect(bridge.evaluateJob).not.toHaveBeenCalled();
    },
  );

  it('主动 fatal 在列表筛选前置位后禁止筛选、保存和 AI', async () => {
    const content = contentMock([[visibleCard(0)]]);
    const bridge = bridgeMock();
    vi.mocked(bridge.observeJobs).mockImplementation(async () => {
      emitContentFatal(content, 'challenge');
      return [
        {
          sourceJobId: 'boss-0',
          action: 'read-detail',
          reason: 'new',
        },
      ];
    });

    const state = await controller(content, bridge).run();

    expect(state.stopReason).toBe('challenge');
    expect(bridge.screenJobs).not.toHaveBeenCalled();
    expect(bridge.saveJob).not.toHaveBeenCalled();
    expect(bridge.evaluateJob).not.toHaveBeenCalled();
  });

  it('主动 fatal 在职位保存前置位后禁止保存和 AI', async () => {
    const card = visibleCard(0);
    const content = contentMock([[card]]);
    vi.mocked(content.startDetailScan).mockImplementation(async () => {
      emitContentFatal(content, 'account_risk');
      return {
        type: 'boss/start-detail-scan/response',
        outcome: 'success',
        job: detailFor(card),
      };
    });
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run();

    expect(state.stopReason).toBe('account_risk');
    expect(bridge.saveJob).not.toHaveBeenCalled();
    expect(bridge.evaluateJob).not.toHaveBeenCalled();
  });

  it('主动 fatal 在 AI 前置位后不再调用 AI', async () => {
    const card = visibleCard(0);
    const content = contentMock([[card]]);
    const bridge = bridgeMock();
    vi.mocked(bridge.screenJobs).mockImplementation(
      async (jobs, _preferences, _signal, phase: ScreeningPhase = 'list') => {
        if (phase === 'detail') {
          emitContentFatal(content, 'login_required');
        }
        return jobs.map((job) => ({
          jobId: job.jobId,
          matched: true,
          reasons: [],
        }));
      },
    );

    const state = await controller(content, bridge).run();

    expect(state.stopReason).toBe('login_required');
    expect(bridge.saveJob).toHaveBeenCalledOnce();
    expect(bridge.evaluateJob).not.toHaveBeenCalled();
  });

  it('最后一次 evaluating 状态写入期间发生 fatal 时不能覆盖为 completed', async () => {
    const card = visibleCard(0);
    const content = contentMock([[card]]);
    const bridge = bridgeMock();
    let evaluatingWrites = 0;
    vi.mocked(bridge.updateScanRun).mockImplementation(async (_runId, update) => {
      if (update.phase === 'evaluating') {
        evaluatingWrites += 1;
        if (evaluatingWrites === 2) {
          emitContentFatal(content, 'account_risk');
        }
      }
      return scanRun();
    });

    const state = await controller(content, bridge).run();

    expect(bridge.evaluateJob).toHaveBeenCalledOnce();
    expect(state.status).toBe('failed');
    expect(state.stopReason).toBe('account_risk');
  });

  it('endSession 最终返回 fatal 时覆盖普通完成终态', async () => {
    const content = contentMock([[]]);
    vi.mocked(content.endSession).mockRejectedValueOnce(
      new BossFatalBlockError('login_required'),
    );
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run();

    expect(state.status).toBe('failed');
    expect(state.stopReason).toBe('login_required');
  });

  it('fatal 终态写回 Bridge 失败时只追加警告，不降级为 interrupted', async () => {
    const content = contentMock([[]]);
    vi.mocked(content.detectPage).mockResolvedValue({
      type: 'boss/detect-page/response',
      pageType: 'challenge',
      block: { reason: 'challenge', pageType: 'challenge' },
    });
    const bridge = bridgeMock();
    vi.mocked(bridge.updateScanRun).mockImplementation(
      async (_runId, update) => {
        if (update.status === 'failed') {
          throw new Error('Bridge write failed');
        }
        return scanRun();
      },
    );

    const state = await controller(content, bridge).run();

    expect(state.status).toBe('failed');
    expect(state.stopReason).toBe('challenge');
    expect(state.warnings).toContain(
      'scan run 最终状态写入失败：Bridge write failed',
    );
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
          case 'boss/begin-session/request':
            return {
              type: 'boss/begin-session/response',
              sessionId: 'session-11',
              generation: 'generation-11',
              queryScope: 'boss:/web/geek/jobs',
            };
          case 'boss/detect-page/request':
            return {
              type: 'boss/detect-page/response',
              pageType: 'search-detail-panel',
              block: null,
            };
          case 'boss/extract-visible-cards/request':
            return {
              type: 'boss/extract-visible-cards/response',
              sessionId: 'session-11',
              generation: 'generation-11',
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
          case 'boss/end-session/request':
            return {
              type: 'boss/end-session/response',
              ended: true,
            };
          default:
            return undefined;
        }
      },
    );
    const content = createContentClient(
      {
        query: async () => [{ id: 11 }],
        sendMessage,
      },
      { addMessageListener: () => () => undefined },
      () => 'session-11',
    );
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

  it('用户取消先中止本地详情，再等待 Bridge 的 best-effort 标志', async () => {
    const card = visibleCard(0);
    const content = contentMock([[card]]);
    let detailAborted = false;
    vi.mocked(content.startDetailScan).mockImplementation(
      async (_card, _timeout, signal) =>
        await new Promise((resolve) => {
          signal?.addEventListener(
            'abort',
            () => {
              detailAborted = true;
              resolve({
                type: 'boss/start-detail-scan/response',
                outcome: 'cancelled',
              });
            },
            { once: true },
          );
        }),
    );
    const bridge = bridgeMock();
    let finishBridgeCancellation: (() => void) | undefined;
    vi.mocked(bridge.requestScanRunCancel).mockImplementation(
      async () =>
        await new Promise((resolve) => {
          finishBridgeCancellation = () =>
            resolve({ ...scanRun(), cancelRequested: true });
        }),
    );
    const scan = controller(content, bridge);
    const running = scan.run();
    await vi.waitFor(() =>
      expect(content.startDetailScan).toHaveBeenCalledOnce(),
    );

    const cancelling = scan.cancel();

    expect(detailAborted).toBe(true);
    expect(scan.state.status).toBe('cancelled');
    await expect(running).resolves.toMatchObject({ status: 'cancelled' });
    await expect(scan.run()).rejects.toThrow('上一轮扫描仍在清理中');
    finishBridgeCancellation?.();
    await cancelling;
  });

  it('旧轮次 endSession 完成前拒绝启动新轮次', async () => {
    const content = contentMock([[]]);
    let finishEndSession: (() => void) | undefined;
    vi.mocked(content.endSession)
      .mockImplementationOnce(
        async () =>
          await new Promise<boolean>((resolve) => {
            finishEndSession = () => resolve(true);
          }),
      )
      .mockResolvedValue(true);
    const scan = controller(content, bridgeMock());
    const running = scan.run();
    await vi.waitFor(() => expect(content.endSession).toHaveBeenCalledOnce());

    await expect(scan.run()).rejects.toThrow('上一轮扫描仍在清理中');
    finishEndSession?.();
    await running;

    await expect(scan.run()).resolves.toMatchObject({ status: 'completed' });
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

    expect(bridge.interruptScanRun).toHaveBeenCalledWith(
      'scan-1',
      {
        reason: 'side-panel-closed',
        errorSummary: '扫描上下文已关闭，可重新开始并复用已完成结果。',
      },
      expect.any(AbortSignal),
    );
    finishContentCancellation?.();
    await interrupted;
    expect(scan.state.status).toBe('interrupted');
  });
});
