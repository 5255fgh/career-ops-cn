import {
  JobDetailSchema,
  JobResponseSchema,
  type JobCard,
  type JobDetail,
  type VisibleJobCard,
} from '@career-ops-cn/shared';
import { describe, expect, it, vi } from 'vitest';

import type { BridgeClient } from './bridge-client';
import type { ContentClient } from './content-client';
import { ScanController, type ScanStatus } from './scan-controller';

function visibleCard(index: number): VisibleJobCard {
  const job: JobCard = {
    jobId: `boss-${index}`,
    title: `前端开发工程师 ${index}`,
    companyName: `示例科技 ${index}`,
    salaryText: '20-30K·14薪',
    location: '上海·浦东新区',
    experienceText: '3-5年',
    educationText: '本科',
    detailUrl: `https://www.zhipin.com/job_detail/boss-${index}.html`,
  };
  return { index, job };
}

function detailFor(card: VisibleJobCard): JobDetail {
  return JobDetailSchema.parse({
    ...card.job,
    description: `职位 ${card.index} 的完整 TypeScript 与 React 描述。`,
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

function contentMock(cards: VisibleJobCard[]): ContentClient {
  return {
    detectPage: vi.fn(async () => ({
      type: 'boss/detect-page/response' as const,
      pageType: 'search-detail-panel' as const,
      block: null,
    })),
    extractCurrentDetail: vi.fn(async () => null),
    extractVisibleCards: vi.fn(async () => ({
      type: 'boss/extract-visible-cards/response' as const,
      cards,
      totalVisible: cards.length,
      invalidCount: 0,
    })),
    startDetailScan: vi.fn(async (card) => ({
      type: 'boss/start-detail-scan/response' as const,
      outcome: 'success' as const,
      job: detailFor(card),
    })),
    cancelDetailScan: vi.fn(async () => true),
  };
}

function bridgeMock(): BridgeClient {
  return {
    health: vi.fn(async () => true),
    screenJobs: vi.fn(async (jobs: readonly JobCard[]) =>
      jobs.map((job) => ({
        jobId: job.jobId,
        matched: true,
        reasons: ['通过全部硬规则'],
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
  };
}

function controller(content: ContentClient, bridge: BridgeClient): ScanController {
  return new ScanController({
    content,
    bridge,
    config: { detailCooldownMs: 0 },
    delay: async () => undefined,
  });
}

describe('ScanController', () => {
  it('直接职位详情页完成身份校验、保存和 AI 评估闭环', async () => {
    const detail = detailFor(visibleCard(0));
    const content = contentMock([]);
    vi.mocked(content.detectPage).mockResolvedValue({
      type: 'boss/detect-page/response',
      pageType: 'job-detail',
      block: null,
    });
    vi.mocked(content.extractCurrentDetail).mockResolvedValue(detail);
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run();

    expect(state.status).toBe('completed');
    expect(state.progress).toEqual({
      listJobs: 1,
      screenedJobs: 0,
      detailCompleted: 1,
      detailTarget: 1,
      aiCompleted: 1,
      aiTarget: 1,
    });
    expect(state.results[0]).toMatchObject({
      detail,
      savedJob: { id: `saved-${detail.jobId}` },
      evaluation: { score: 88, rawReport: '完整 career-ops 原始报告。' },
    });
    expect(content.extractVisibleCards).not.toHaveBeenCalled();
    expect(bridge.screenJobs).not.toHaveBeenCalled();
    expect(bridge.saveJob).toHaveBeenCalledWith(detail, expect.any(AbortSignal));
    expect(bridge.evaluateJob).toHaveBeenCalledOnce();
  });

  it('直接职位详情身份未验证时不会保存或分析', async () => {
    const detail = { ...detailFor(visibleCard(0)), identityVerified: false };
    const content = contentMock([]);
    vi.mocked(content.detectPage).mockResolvedValue({
      type: 'boss/detect-page/response',
      pageType: 'job-detail',
      block: null,
    });
    vi.mocked(content.extractCurrentDetail).mockResolvedValue(detail);
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run();

    expect(state.status).toBe('failed');
    expect(state.error).toBe('职位详情身份校验失败。');
    expect(state.results[0]?.detail).toEqual(detail);
    expect(bridge.saveJob).not.toHaveBeenCalled();
    expect(bridge.evaluateJob).not.toHaveBeenCalled();
  });

  it('完整成功流程按状态转换，并逐条保存与显示 AI 结果', async () => {
    const cards = [visibleCard(0), visibleCard(1)];
    const content = contentMock(cards);
    const bridge = bridgeMock();
    const scan = controller(content, bridge);
    const statuses: ScanStatus[] = [];
    let sawImmediateEvaluation = false;
    scan.subscribe((state) => {
      statuses.push(state.status);
      if (
        state.status === 'evaluating' &&
        state.results.some((result) => result.evaluation !== undefined)
      ) {
        sawImmediateEvaluation = true;
      }
    });

    const finalState = await scan.run();

    expect([...new Set(statuses)]).toEqual([
      'idle',
      'reading-list',
      'screening',
      'reading-details',
      'evaluating',
      'completed',
    ]);
    expect(finalState.status).toBe('completed');
    expect(finalState.progress).toEqual({
      listJobs: 2,
      screenedJobs: 2,
      detailCompleted: 2,
      detailTarget: 2,
      aiCompleted: 2,
      aiTarget: 2,
    });
    expect(finalState.results.every((result) => result.savedJob !== undefined)).toBe(true);
    expect(finalState.results.every((result) => result.evaluation?.score === 88)).toBe(true);
    expect(bridge.saveJob).toHaveBeenCalledTimes(2);
    expect(bridge.evaluateJob).toHaveBeenCalledTimes(2);
    expect(sawImmediateEvaluation).toBe(true);
  });

  it('单个详情普通失败会记录并继续下一个职位', async () => {
    const cards = [visibleCard(0), visibleCard(1)];
    const content = contentMock(cards);
    vi.mocked(content.startDetailScan)
      .mockResolvedValueOnce({
        type: 'boss/start-detail-scan/response',
        outcome: 'failed',
        message: '卡片已失效',
      })
      .mockResolvedValueOnce({
        type: 'boss/start-detail-scan/response',
        outcome: 'success',
        job: detailFor(cards[1]!),
      });
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run();

    expect(state.status).toBe('completed');
    expect(state.results[0]?.detailError).toBe('卡片已失效');
    expect(state.results[1]?.savedJob).toBeDefined();
    expect(bridge.saveJob).toHaveBeenCalledOnce();
  });

  it.each([
    ['timeout', 'detail_timeout_limit'],
    ['identity_failure', 'identity_failure_limit'],
  ] as const)('连续 3 个 %s 会立即停止', async (outcome, stopReason) => {
    const cards = [0, 1, 2, 3].map(visibleCard);
    const content = contentMock(cards);
    vi.mocked(content.startDetailScan).mockResolvedValue({
      type: 'boss/start-detail-scan/response',
      outcome,
    });
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run();

    expect(state.status).toBe('failed');
    expect(state.stopReason).toBe(stopReason);
    expect(content.startDetailScan).toHaveBeenCalledTimes(3);
    expect(bridge.saveJob).not.toHaveBeenCalled();
    expect(bridge.evaluateJob).not.toHaveBeenCalled();
  });

  it('challenge 在读取列表前立即停止', async () => {
    const content = contentMock([visibleCard(0)]);
    vi.mocked(content.detectPage).mockResolvedValue({
      type: 'boss/detect-page/response',
      pageType: 'challenge',
      block: { reason: 'challenge', pageType: 'challenge' },
    });
    const bridge = bridgeMock();

    const state = await controller(content, bridge).run();

    expect(state.status).toBe('failed');
    expect(state.stopReason).toBe('challenge');
    expect(content.extractVisibleCards).not.toHaveBeenCalled();
    expect(bridge.screenJobs).not.toHaveBeenCalled();
  });

  it('用户取消会通知 Content Script，并保留此前已完成的职位', async () => {
    const cards = [visibleCard(0), visibleCard(1)];
    const content = contentMock(cards);
    vi.mocked(content.startDetailScan).mockImplementation(async (card, _timeout, signal) => {
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
    });
    const bridge = bridgeMock();
    const scan = controller(content, bridge);
    const running = scan.run();
    await vi.waitFor(() => expect(content.startDetailScan).toHaveBeenCalledTimes(2));

    await scan.cancel();
    const state = await running;

    expect(state.status).toBe('cancelled');
    expect(content.cancelDetailScan).toHaveBeenCalledOnce();
    expect(state.results[0]?.savedJob).toBeDefined();
    expect(state.results[1]?.savedJob).toBeUndefined();
  });
});
