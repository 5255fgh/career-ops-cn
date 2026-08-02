import type { JobHistoryEntry } from '@career-ops-cn/shared';
import { describe, expect, it } from 'vitest';

import { filterAndSortCandidates } from './candidate-pool';

const jobs: JobHistoryEntry[] = [
  {
    id: 'job-b',
    source: 'boss',
    sourceJobId: 'boss-b',
    title: '后端工程师',
    company: '乙公司',
    identityVerified: true,
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-02T00:00:00.000Z',
    latestEvaluation: {
      score: 90,
      recommendation: 'apply',
      rawReport: '适合。',
    },
    candidate: {
      jobId: 'job-b',
      decision: 'apply',
      note: '优先处理',
      applicationStatus: 'applied',
      updatedAt: '2026-08-02T01:00:00.000Z',
    },
  },
  {
    id: 'job-a',
    source: 'boss',
    sourceJobId: 'boss-a',
    title: '前端工程师',
    company: '甲公司',
    identityVerified: true,
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-03T00:00:00.000Z',
    latestEvaluation: {
      score: 70,
      recommendation: 'review',
      rawReport: '需要复核。',
    },
  },
];

describe('filterAndSortCandidates', () => {
  it('按用户判断和投递状态筛选', () => {
    expect(
      filterAndSortCandidates(jobs, {
        decision: 'apply',
        applicationStatus: 'applied',
        sort: 'last-seen-desc',
      }).map(({ id }) => id),
    ).toEqual(['job-b']);
  });

  it('支持未判断筛选和 AI 分数排序', () => {
    expect(
      filterAndSortCandidates(jobs, {
        decision: 'unreviewed',
        applicationStatus: 'not_applied',
        sort: 'score-desc',
      }).map(({ id }) => id),
    ).toEqual(['job-a']);
    expect(
      filterAndSortCandidates(jobs, {
        decision: 'all',
        applicationStatus: 'all',
        sort: 'score-desc',
      }).map(({ id }) => id),
    ).toEqual(['job-b', 'job-a']);
  });
});
