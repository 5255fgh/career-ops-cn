import type { JobHistoryEntry } from '@career-ops-cn/shared';

export interface JobExportRow {
  source: string;
  sourceJobId: string | null;
  title: string;
  company: string;
  salary: string | null;
  location: string | null;
  experience: string | null;
  education: string | null;
  description: string | null;
  url: string | null;
  identityVerified: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  jdHash: string | null;
  sourceQuery: string | null;
  hardRuleMatched: boolean | null;
  hardRuleReasons: string[];
  aiScore: number | null;
  aiRecommendation: string | null;
  aiCompany: string | null;
  aiRole: string | null;
  aiArchetype: string | null;
  aiLegitimacy: string | null;
  aiRawReport: string | null;
  userDecision: string | null;
  note: string | null;
  applicationStatus: string;
}

const CSV_COLUMNS: ReadonlyArray<
  readonly [keyof JobExportRow, string]
> = [
  ['source', '来源'],
  ['sourceJobId', '来源职位ID'],
  ['title', '职位'],
  ['company', '公司'],
  ['salary', '薪资'],
  ['location', '地点'],
  ['experience', '经验要求'],
  ['education', '学历要求'],
  ['description', '职位描述'],
  ['url', '职位链接'],
  ['identityVerified', '身份已校验'],
  ['firstSeenAt', '首次发现时间'],
  ['lastSeenAt', '最近发现时间'],
  ['jdHash', 'JD哈希'],
  ['sourceQuery', '搜索来源'],
  ['hardRuleMatched', '硬规则通过'],
  ['hardRuleReasons', '硬规则原因'],
  ['aiScore', 'AI分数'],
  ['aiRecommendation', 'AI建议'],
  ['aiCompany', 'AI公司判断'],
  ['aiRole', 'AI岗位判断'],
  ['aiArchetype', 'AI岗位类型'],
  ['aiLegitimacy', 'AI可信度判断'],
  ['aiRawReport', 'AI原始报告'],
  ['userDecision', '用户判断'],
  ['note', '备注'],
  ['applicationStatus', '投递状态'],
];

export function buildJobExportRows(
  jobs: readonly JobHistoryEntry[],
): JobExportRow[] {
  return jobs.map((job) => ({
    source: job.source,
    sourceJobId: job.sourceJobId ?? null,
    title: job.title,
    company: job.company,
    salary: job.salary ?? null,
    location: job.location ?? null,
    experience: job.experience ?? null,
    education: job.education ?? null,
    description: job.description ?? null,
    url: job.url ?? null,
    identityVerified: job.identityVerified,
    firstSeenAt: job.firstSeenAt,
    lastSeenAt: job.lastSeenAt,
    jdHash: job.jdHash ?? null,
    sourceQuery: job.sourceQuery ?? null,
    hardRuleMatched: job.latestScreening?.matched ?? null,
    hardRuleReasons: job.latestScreening?.reasons ?? [],
    aiScore: job.latestEvaluation?.score ?? null,
    aiRecommendation: job.latestEvaluation?.recommendation ?? null,
    aiCompany: job.latestEvaluation?.company ?? null,
    aiRole: job.latestEvaluation?.role ?? null,
    aiArchetype: job.latestEvaluation?.archetype ?? null,
    aiLegitimacy: job.latestEvaluation?.legitimacy ?? null,
    aiRawReport: job.latestEvaluation?.rawReport ?? null,
    userDecision: job.candidate?.decision ?? null,
    note: job.candidate?.note ?? null,
    applicationStatus:
      job.candidate?.applicationStatus ?? 'not_applied',
  }));
}

function csvCell(value: JobExportRow[keyof JobExportRow]): string {
  const text = Array.isArray(value)
    ? value.join('；')
    : value === null
      ? ''
      : typeof value === 'boolean'
        ? value
          ? '是'
          : '否'
        : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function serializeJobsAsCsv(
  jobs: readonly JobHistoryEntry[],
): string {
  const rows = buildJobExportRows(jobs);
  const header = CSV_COLUMNS.map(([, label]) => csvCell(label)).join(',');
  const body = rows.map((row) =>
    CSV_COLUMNS.map(([key]) => csvCell(row[key])).join(','),
  );
  return `\uFEFF${[header, ...body].join('\r\n')}\r\n`;
}

export function serializeJobsAsJson(
  jobs: readonly JobHistoryEntry[],
): string {
  return `${JSON.stringify(buildJobExportRows(jobs), null, 2)}\n`;
}
