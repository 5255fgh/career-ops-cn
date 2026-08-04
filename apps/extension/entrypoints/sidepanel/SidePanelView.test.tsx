import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ScanState } from '../../lib/scan-controller';
import { SidePanelView, type SidePanelViewProps } from './SidePanelView';

const completedState: ScanState = {
  runId: 'scan-1',
  status: 'completed',
  progress: {
    pagesVisited: 1,
    listJobs: 12,
    newJobs: 8,
    screenedJobs: 12,
    detailCompleted: 2,
    detailTarget: 2,
    detailSuccess: 2,
    detailFailure: 0,
    aiCompleted: 1,
    aiTarget: 1,
    aiSuccess: 1,
    aiFailure: 0,
    cacheHits: 0,
  },
  stopReason: 'current_page_complete',
  error: null,
  warnings: [],
  results: [
    {
      card: {
        index: 0,
        job: {
          jobId: 'boss-1',
          title: '高级前端开发工程师',
          companyName: '示例科技',
          salaryText: '30-40K·14薪',
          location: '上海·浦东新区',
          experienceText: '5-10年',
          educationText: '本科',
          detailUrl: 'https://www.zhipin.com/job_detail/boss-1.html',
        },
      },
      screening: {
        jobId: 'boss-1',
        matched: true,
        reasons: ['地点符合', '未命中公司黑名单'],
      },
      detail: {
        jobId: 'boss-1',
        title: '高级前端开发工程师',
        companyName: '示例科技',
        salaryText: '30-40K·14薪',
        location: '上海·浦东新区',
        experienceText: '5-10年',
        educationText: '本科',
        detailUrl: 'https://www.zhipin.com/job_detail/boss-1.html',
        description: '负责 TypeScript、React 与复杂产品工程。',
        identityVerified: true,
      },
      savedJob: {
        id: 'saved-1',
        source: 'boss',
        sourceJobId: 'boss-1',
        title: '高级前端开发工程师',
        company: '示例科技',
        identityVerified: true,
        firstSeenAt: '2026-08-01T10:00:00.000Z',
        lastSeenAt: '2026-08-01T10:00:00.000Z',
      },
      evaluation: {
        score: 91,
        recommendation: 'apply',
        archetype: 'Builder',
        legitimacy: 'high',
        rawReport: '这是未经改写的 career-ops rawReport。',
      },
      candidate: {
        jobId: 'saved-1',
        decision: 'apply',
        note: '优先跟进',
        applicationStatus: 'interviewing',
        updatedAt: '2026-08-01T10:00:00.000Z',
      },
    },
  ],
};

function props(overrides: Partial<SidePanelViewProps> = {}): SidePanelViewProps {
  return {
    tokenDraft: 'secret-token',
    connectionState: 'online',
    connectionMessage: 'Token 已保存，Bridge 连接正常。',
    pageSnapshot: {
      pageType: 'search-detail-panel',
      block: null,
      jobCount: 12,
      invalidCount: 1,
    },
    pageError: '',
    scanState: completedState,
    selectedJobId: 'boss-1',
    candidates: [
      {
        id: 'saved-1',
        source: 'boss',
        sourceJobId: 'boss-1',
        title: '高级前端开发工程师',
        company: '示例科技',
        identityVerified: true,
        firstSeenAt: '2026-08-01T10:00:00.000Z',
        lastSeenAt: '2026-08-01T10:00:00.000Z',
        latestScreening: completedState.results[0]!.screening,
        latestEvaluation: completedState.results[0]!.evaluation,
        candidate: completedState.results[0]!.candidate,
      },
    ],
    candidateTotal: 1,
    candidateDecisionFilter: 'all',
    applicationStatusFilter: 'all',
    candidateSort: 'last-seen-desc',
    selectedCandidateId: 'saved-1',
    candidateDecision: 'apply',
    candidateNote: '优先跟进',
    applicationStatus: 'interviewing',
    historyError: '',
    candidateMessage: '候选池记录已保存。',
    exportMessage: '',
    diagnostics: [
      {
        id: 'diag-1',
        createdAt: '2026-08-01T10:00:00.000Z',
        source: 'extension',
        level: 'info',
        event: 'detail_mapping',
        scanId: 'scan-1',
        expectedJobId: 'boss-1',
        actualJobId: 'boss-1',
        outcome: 'success',
      },
    ],
    diagnosticsError: '',
    onTokenChange: () => undefined,
    onSaveConnection: () => undefined,
    onRefreshPage: () => undefined,
    onStartScan: () => undefined,
    onCancelScan: () => undefined,
    onSelectJob: () => undefined,
    onCandidateDecisionFilterChange: () => undefined,
    onApplicationStatusFilterChange: () => undefined,
    onCandidateSortChange: () => undefined,
    onSelectCandidate: () => undefined,
    onCandidateDecisionChange: () => undefined,
    onCandidateNoteChange: () => undefined,
    onApplicationStatusChange: () => undefined,
    onRefreshHistory: () => undefined,
    onSaveCandidate: () => undefined,
    onExport: () => undefined,
    onRefreshDiagnostics: () => undefined,
    ...overrides,
  };
}

describe('SidePanelView', () => {
  it('渲染扫描诊断区块，并显示关键结果字段', () => {
    const html = renderToStaticMarkup(<SidePanelView {...props()} />);

    for (const heading of [
      '连接设置',
      '当前页面状态',
      '扫描控制',
      '进度',
      '结果列表',
      '单个职位详情',
      '候选池',
      '备注与投递状态',
      '扫描诊断',
    ]) {
      expect(html).toContain(heading);
    }
    expect(html.match(/<section/g)).toHaveLength(9);
    expect(html).toContain('12');
    expect(html).toContain('2/2');
    expect(html).toContain('1/1');
    expect(html).toContain('Apply');
    expect(html).toContain('Review');
    expect(html).toContain('Skip');
    expect(html).toContain('Builder');
    expect(html).toContain('high');
    expect(html).toContain('这是未经改写的 career-ops rawReport。');
    expect(html).toContain('硬规则结果');
    expect(html).toContain('优先跟进');
    expect(html).toContain('面试中');
    expect(html).toContain('导出 CSV');
    expect(html).toContain('导出 JSON');
    expect(html).toContain('detail_mapping');
    expect(html).toContain('boss-1');
    expect(html).toContain('每轮只读取当前页，不点击职位或分页');
    expect(html).toContain('完成原因：当前页处理完成');
    expect(html).toContain('本轮读取页数');
    expect(html).not.toContain('strengths');
    expect(html).not.toContain('gaps');
  });

  it('challenge 停止状态会显示真实阻断原因', () => {
    const html = renderToStaticMarkup(
      <SidePanelView
        {...props({
          pageSnapshot: {
            pageType: 'challenge',
            block: { reason: 'challenge', pageType: 'challenge' },
            jobCount: 0,
            invalidCount: 0,
          },
          scanState: {
            ...completedState,
            status: 'failed',
            stopReason: 'challenge',
            error: '页面已停止扫描：challenge',
          },
        })}
      />,
    );

    expect(html).toContain('停止原因：challenge');
    expect(html).toContain('页面已停止扫描：challenge');
  });

  it('interrupted 状态显示持久化进度、失败摘要和重新开始入口', () => {
    const html = renderToStaticMarkup(
      <SidePanelView
        {...props({
          scanState: {
            ...completedState,
            status: 'interrupted',
            error: '1 个详情失败；已完成结果仍可复用。',
          },
        })}
      />,
    );

    expect(html).toContain('已中断');
    expect(html).toContain('重新开始');
    expect(html).toContain('1 个详情失败；已完成结果仍可复用。');
    expect(html).toContain('评估缓存命中');
  });
});
