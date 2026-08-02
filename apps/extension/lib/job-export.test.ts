import type { JobHistoryEntry } from '@career-ops-cn/shared';
import { describe, expect, it } from 'vitest';

import { serializeJobsAsCsv, serializeJobsAsJson } from './job-export';

const job: JobHistoryEntry = {
  id: 'job-export',
  source: 'boss',
  sourceJobId: 'boss-export',
  title: '高级前端工程师',
  company: '示例，科技',
  description: '负责 TypeScript、React。\n包含换行和“中文”。',
  url: 'https://www.zhipin.com/job_detail/boss-export.html',
  identityVerified: true,
  firstSeenAt: '2026-08-01T00:00:00.000Z',
  lastSeenAt: '2026-08-02T00:00:00.000Z',
  latestScreening: {
    jobId: 'boss-export',
    matched: true,
    reasons: ['需要人工复核'],
  },
  latestEvaluation: {
    score: 88,
    recommendation: 'apply',
    rawReport: '岗位匹配，建议申请。',
    role: '前端工程师',
  },
  candidate: {
    jobId: 'job-export',
    decision: 'apply',
    note: '联系后跟进',
    applicationStatus: 'interviewing',
    updatedAt: '2026-08-02T01:00:00.000Z',
  },
};

describe('职位导出', () => {
  it('CSV 带 UTF-8 BOM、完整中文字段并正确转义换行', () => {
    const csv = serializeJobsAsCsv([job]);

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"职位描述"');
    expect(csv).toContain('"AI原始报告"');
    expect(csv).toContain('"投递状态"');
    expect(csv).toContain('高级前端工程师');
    expect(csv).toContain('负责 TypeScript、React。\n包含换行和“中文”。');
  });

  it('JSON 保留硬规则、AI 原文、备注和投递状态', () => {
    expect(JSON.parse(serializeJobsAsJson([job]))).toEqual([
      expect.objectContaining({
        title: '高级前端工程师',
        hardRuleMatched: true,
        hardRuleReasons: ['需要人工复核'],
        aiRawReport: '岗位匹配，建议申请。',
        note: '联系后跟进',
        applicationStatus: 'interviewing',
      }),
    ]);
  });
});
