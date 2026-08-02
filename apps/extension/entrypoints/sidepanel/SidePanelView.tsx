import type {
  ApplicationStatus,
  BossPageBlock,
  BossPageType,
  CandidateDecision,
  DiagnosticEvent,
  JobHistoryEntry,
} from '@career-ops-cn/shared';
import type { FormEventHandler } from 'react';

import type {
  ApplicationStatusFilter,
  CandidateDecisionFilter,
  CandidateSort,
} from '../../lib/candidate-pool';
import type { ScanState, ScannedJob } from '../../lib/scan-controller';

export interface PageSnapshot {
  pageType: BossPageType;
  block: BossPageBlock | null;
  jobCount: number;
  invalidCount: number;
}

export type ConnectionState = 'unknown' | 'checking' | 'online' | 'offline';

export interface SidePanelViewProps {
  tokenDraft: string;
  connectionState: ConnectionState;
  connectionMessage: string;
  pageSnapshot: PageSnapshot | null;
  pageError: string;
  scanState: ScanState;
  selectedJobId: string | null;
  candidates: JobHistoryEntry[];
  candidateTotal: number;
  candidateDecisionFilter: CandidateDecisionFilter;
  applicationStatusFilter: ApplicationStatusFilter;
  candidateSort: CandidateSort;
  selectedCandidateId: string | null;
  candidateDecision: CandidateDecision;
  candidateNote: string;
  applicationStatus: ApplicationStatus;
  historyError: string;
  candidateMessage: string;
  exportMessage: string;
  diagnostics: DiagnosticEvent[];
  diagnosticsError: string;
  onTokenChange(value: string): void;
  onSaveConnection: FormEventHandler<HTMLFormElement>;
  onRefreshPage(): void;
  onStartScan(): void;
  onCancelScan(): void;
  onSelectJob(jobId: string): void;
  onCandidateDecisionFilterChange(filter: CandidateDecisionFilter): void;
  onApplicationStatusFilterChange(filter: ApplicationStatusFilter): void;
  onCandidateSortChange(sort: CandidateSort): void;
  onSelectCandidate(jobId: string): void;
  onCandidateDecisionChange(decision: CandidateDecision): void;
  onCandidateNoteChange(note: string): void;
  onApplicationStatusChange(status: ApplicationStatus): void;
  onRefreshHistory(): void;
  onSaveCandidate(): void;
  onExport(format: 'csv' | 'json'): void;
  onRefreshDiagnostics(): void;
}

const ACTIVE_SCAN_STATUSES = new Set<ScanState['status']>([
  'reading-list',
  'screening',
  'reading-details',
  'evaluating',
]);

const STATUS_LABELS: Record<ScanState['status'], string> = {
  idle: '待命',
  'reading-list': '读取列表',
  screening: '硬规则筛选',
  'reading-details': '读取详情',
  evaluating: 'AI 评估',
  completed: '已完成',
  cancelled: '已取消',
  interrupted: '已中断',
  failed: '已停止',
};

function recommendationLabel(value: string | undefined): string {
  switch (value?.toLowerCase()) {
    case 'apply':
      return 'Apply';
    case 'review':
      return 'Review';
    case 'skip':
      return 'Skip';
    default:
      return value ?? '待评估';
  }
}

function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case 'online':
      return 'Bridge 在线';
    case 'offline':
      return 'Bridge 离线';
    case 'checking':
      return '正在检查';
    default:
      return '尚未连接';
  }
}

function applicationStatusLabel(value: ApplicationStatus): string {
  switch (value) {
    case 'applied':
      return '已投递';
    case 'interviewing':
      return '面试中';
    case 'offer':
      return '已获 Offer';
    case 'rejected':
      return '未通过';
    case 'withdrawn':
      return '已放弃';
    default:
      return '未投递';
  }
}

function screeningLabel(job: JobHistoryEntry): string {
  if (job.latestScreening === undefined) {
    return '待筛选';
  }
  return job.latestScreening.matched ? '通过' : '阻断';
}

function resultError(result: ScannedJob): string | null {
  return result.detailError ?? result.evaluationError ?? null;
}

export function SidePanelView(props: SidePanelViewProps) {
  const isScanning = ACTIVE_SCAN_STATUSES.has(props.scanState.status);
  const selectedResult = props.scanState.results.find(
    (result) => result.card.job.jobId === props.selectedJobId,
  );
  const selectedCandidate = props.candidates.find(
    ({ id }) => id === props.selectedCandidateId,
  );

  return (
    <main className="panel-shell">
      <header className="panel-header">
        <p className="eyebrow">Career Ops CN</p>
        <h1>BOSS 只读职位扫描</h1>
        <p>一次点击最多连续处理 3 页；不投递、不联系招聘方。</p>
      </header>

      <section className="panel-section" aria-labelledby="connection-heading">
        <div className="section-heading">
          <div>
            <span className="section-index">01</span>
            <h2 id="connection-heading">连接设置</h2>
          </div>
          <span className={`status-dot status-${props.connectionState}`}>
            {connectionLabel(props.connectionState)}
          </span>
        </div>
        <form className="token-form" onSubmit={props.onSaveConnection}>
          <label htmlFor="bridge-token">Bridge token</label>
          <div className="input-row">
            <input
              id="bridge-token"
              type="password"
              value={props.tokenDraft}
              autoComplete="off"
              placeholder="输入本机 Bridge token"
              onChange={(event) => props.onTokenChange(event.target.value)}
            />
            <button className="button button-secondary" type="submit">
              保存并检查
            </button>
          </div>
        </form>
        {props.connectionMessage === '' ? null : (
          <p className="inline-message" role="status">
            {props.connectionMessage}
          </p>
        )}
      </section>

      <section className="panel-section" aria-labelledby="page-heading">
        <div className="section-heading">
          <div>
            <span className="section-index">02</span>
            <h2 id="page-heading">当前页面状态</h2>
          </div>
          <button className="text-button" type="button" onClick={props.onRefreshPage}>
            刷新
          </button>
        </div>
        {props.pageSnapshot === null ? (
          <p className="empty-copy">尚未读取当前页面。</p>
        ) : (
          <dl className="metric-grid compact-grid">
            <div>
              <dt>页面类型</dt>
              <dd>{props.pageSnapshot.pageType}</dd>
            </div>
            <div>
              <dt>当前页职位数</dt>
              <dd>{props.pageSnapshot.jobCount}</dd>
            </div>
            <div>
              <dt>字段不完整</dt>
              <dd>{props.pageSnapshot.invalidCount}</dd>
            </div>
            <div>
              <dt>阻断</dt>
              <dd>{props.pageSnapshot.block?.reason ?? '无'}</dd>
            </div>
          </dl>
        )}
        {props.pageError === '' ? null : (
          <p className="error-message" role="alert">{props.pageError}</p>
        )}
      </section>

      <section className="panel-section" aria-labelledby="control-heading">
        <div className="section-heading">
          <div>
            <span className="section-index">03</span>
            <h2 id="control-heading">扫描控制</h2>
          </div>
          <span className="scan-status">{STATUS_LABELS[props.scanState.status]}</span>
        </div>
        <div className="control-row">
          <button
            className="button button-primary"
            type="button"
            disabled={isScanning || props.connectionState !== 'online'}
            onClick={props.onStartScan}
          >
            {props.scanState.status === 'interrupted' ? '重新开始' : '开始扫描'}
          </button>
          <button
            className="button button-danger"
            type="button"
            disabled={!isScanning}
            onClick={props.onCancelScan}
          >
            取消
          </button>
        </div>
        {props.scanState.error === null ? null : (
          <p className="error-message" role="alert">{props.scanState.error}</p>
        )}
        {props.scanState.stopReason === null ? null : (
          <p className="stop-reason">停止原因：{props.scanState.stopReason}</p>
        )}
        {props.scanState.warnings.map((warning) => (
          <p className="inline-message" role="status" key={warning}>
            警告：{warning}
          </p>
        ))}
      </section>

      <section className="panel-section" aria-labelledby="progress-heading">
        <div className="section-heading">
          <div>
            <span className="section-index">04</span>
            <h2 id="progress-heading">进度</h2>
          </div>
        </div>
        <dl className="metric-grid progress-grid">
          <div>
            <dt>已处理页数</dt>
            <dd>{props.scanState.progress.pagesVisited}</dd>
          </div>
          <div>
            <dt>累计可见职位</dt>
            <dd>{props.scanState.progress.listJobs}</dd>
          </div>
          <div>
            <dt>本轮新职位</dt>
            <dd>{props.scanState.progress.newJobs}</dd>
          </div>
          <div>
            <dt>已筛选数量</dt>
            <dd>{props.scanState.progress.screenedJobs}</dd>
          </div>
          <div>
            <dt>详情进度</dt>
            <dd>{props.scanState.progress.detailCompleted}/{props.scanState.progress.detailTarget}</dd>
          </div>
          <div>
            <dt>详情成功 / 失败</dt>
            <dd>{props.scanState.progress.detailSuccess} / {props.scanState.progress.detailFailure}</dd>
          </div>
          <div>
            <dt>AI 进度</dt>
            <dd>{props.scanState.progress.aiCompleted}/{props.scanState.progress.aiTarget}</dd>
          </div>
          <div>
            <dt>AI 成功 / 失败</dt>
            <dd>{props.scanState.progress.aiSuccess} / {props.scanState.progress.aiFailure}</dd>
          </div>
          <div>
            <dt>评估缓存命中</dt>
            <dd>{props.scanState.progress.cacheHits}</dd>
          </div>
        </dl>
      </section>

      <section className="panel-section" aria-labelledby="results-heading">
        <div className="section-heading">
          <div>
            <span className="section-index">05</span>
            <h2 id="results-heading">结果列表</h2>
          </div>
          <span className="count-pill">{props.scanState.results.length}</span>
        </div>
        {props.scanState.results.length === 0 ? (
          <p className="empty-copy">扫描结果会在这里逐条出现。</p>
        ) : (
          <ul className="result-list">
            {props.scanState.results.map((result) => {
              const error = resultError(result);
              return (
                <li key={result.card.job.jobId}>
                  <button
                    type="button"
                    className={
                      result.card.job.jobId === props.selectedJobId
                        ? 'result-row result-row-selected'
                        : 'result-row'
                    }
                    onClick={() => props.onSelectJob(result.card.job.jobId)}
                  >
                    <span className="result-main">
                      <strong>{result.card.job.title}</strong>
                      <span>{result.card.job.companyName}</span>
                    </span>
                    <span className="result-side">
                      <span className={`recommendation recommendation-${result.evaluation?.recommendation?.toLowerCase() ?? 'pending'}`}>
                        {recommendationLabel(result.evaluation?.recommendation)}
                      </span>
                      {result.evaluation === undefined ? null : (
                        <span>{result.evaluation.score} 分</span>
                      )}
                    </span>
                  </button>
                  {(result.screening ?? result.preScreening) === undefined ? null : (
                    <p className="rule-copy">
                      {(result.screening ?? result.preScreening)?.reasons.length === 0
                        ? '硬规则：未发现阻断或警告'
                        : `硬规则原因：${(result.screening ?? result.preScreening)?.reasons.join('；')}`}
                    </p>
                  )}
                  {error === null ? null : <p className="row-error">{error}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="panel-section" aria-labelledby="detail-heading">
        <div className="section-heading">
          <div>
            <span className="section-index">06</span>
            <h2 id="detail-heading">单个职位详情</h2>
          </div>
        </div>
        {selectedResult === undefined ? (
          <p className="empty-copy">从结果列表选择一个职位。</p>
        ) : (
          <article className="job-detail">
            <h3>{selectedResult.card.job.title}</h3>
            <p className="job-company">{selectedResult.card.job.companyName}</p>
            <dl className="detail-grid">
              <div><dt>薪资</dt><dd>{selectedResult.detail?.salaryText ?? selectedResult.card.job.salaryText ?? '—'}</dd></div>
              <div><dt>地点</dt><dd>{selectedResult.detail?.location ?? selectedResult.card.job.location ?? '—'}</dd></div>
              <div><dt>career-ops score</dt><dd>{selectedResult.evaluation?.score ?? '—'}</dd></div>
              <div><dt>archetype</dt><dd>{selectedResult.evaluation?.archetype ?? '—'}</dd></div>
              <div><dt>legitimacy</dt><dd>{selectedResult.evaluation?.legitimacy ?? '—'}</dd></div>
              <div><dt>用户判断</dt><dd>{selectedResult.candidate?.decision ?? '未判断'}</dd></div>
            </dl>
            <div className="detail-copy">
              <h4>职位描述</h4>
              <p>{selectedResult.detail?.description ?? '详情尚未读取成功。'}</p>
            </div>
            <div className="detail-copy">
              <h4>硬规则结果</h4>
              <p>
                {selectedResult.screening === undefined
                  ? '尚无完整硬规则结果。'
                  : selectedResult.screening.reasons.length === 0
                    ? selectedResult.screening.matched
                      ? '通过；未发现阻断或警告。'
                      : '未通过。'
                    : `${selectedResult.screening.matched ? '通过' : '阻断'}：${selectedResult.screening.reasons.join('；')}`}
              </p>
            </div>
            <div className="detail-copy">
              <h4>rawReport</h4>
              <pre>{selectedResult.evaluation?.rawReport ?? '尚无 AI 评估。'}</pre>
            </div>
          </article>
        )}
      </section>

      <section className="panel-section" aria-labelledby="candidate-heading">
        <div className="section-heading">
          <div>
            <span className="section-index">07</span>
            <h2 id="candidate-heading">候选池</h2>
          </div>
          <div className="header-actions">
            <button className="text-button" type="button" onClick={() => props.onExport('csv')}>
              导出 CSV
            </button>
            <button className="text-button" type="button" onClick={() => props.onExport('json')}>
              导出 JSON
            </button>
            <button className="text-button" type="button" onClick={props.onRefreshHistory}>
              刷新
            </button>
          </div>
        </div>
        <p className="candidate-count">
          当前显示 {props.candidates.length} / {props.candidateTotal}
        </p>
        <div className="filter-grid">
          <label>
            用户判断
            <select
              value={props.candidateDecisionFilter}
              onChange={(event) =>
                props.onCandidateDecisionFilterChange(
                  event.target.value as CandidateDecisionFilter,
                )
              }
            >
              <option value="all">全部</option>
              <option value="unreviewed">未判断</option>
              <option value="apply">Apply</option>
              <option value="review">Review</option>
              <option value="skip">Skip</option>
            </select>
          </label>
          <label>
            投递状态
            <select
              value={props.applicationStatusFilter}
              onChange={(event) =>
                props.onApplicationStatusFilterChange(
                  event.target.value as ApplicationStatusFilter,
                )
              }
            >
              <option value="all">全部</option>
              <option value="not_applied">未投递</option>
              <option value="applied">已投递</option>
              <option value="interviewing">面试中</option>
              <option value="offer">已获 Offer</option>
              <option value="rejected">未通过</option>
              <option value="withdrawn">已放弃</option>
            </select>
          </label>
          <label>
            排序
            <select
              value={props.candidateSort}
              onChange={(event) =>
                props.onCandidateSortChange(event.target.value as CandidateSort)
              }
            >
              <option value="last-seen-desc">最近发现优先</option>
              <option value="score-desc">AI 分数优先</option>
              <option value="title-asc">职位名称</option>
            </select>
          </label>
        </div>
        {props.historyError === '' ? null : (
          <p className="error-message" role="alert">{props.historyError}</p>
        )}
        {props.exportMessage === '' ? null : (
          <p className="inline-message" role="status">{props.exportMessage}</p>
        )}
        {props.candidates.length === 0 ? (
          <p className="empty-copy">没有符合筛选条件的候选职位。</p>
        ) : (
          <ul className="history-list">
            {props.candidates.map((job) => (
              <li key={job.id}>
                <button
                  type="button"
                  className={
                    job.id === props.selectedCandidateId
                      ? 'candidate-row candidate-row-selected'
                      : 'candidate-row'
                  }
                  onClick={() => props.onSelectCandidate(job.id)}
                >
                  <span>
                    <strong>{job.title}</strong>
                    <span>{job.company}</span>
                  </span>
                  <span>{job.latestEvaluation?.score ?? '—'} 分</span>
                </button>
                <div className="history-meta">
                  <span>硬规则：{screeningLabel(job)}</span>
                  <span>AI：{recommendationLabel(job.latestEvaluation?.recommendation)}</span>
                  <span>判断：{job.candidate?.decision ?? '未判断'}</span>
                  <span>
                    状态：{applicationStatusLabel(job.candidate?.applicationStatus ?? 'not_applied')}
                  </span>
                </div>
                {job.latestScreening?.reasons.length ? (
                  <p className="rule-copy">
                    硬规则原因：{job.latestScreening.reasons.join('；')}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel-section" aria-labelledby="candidate-edit-heading">
        <div className="section-heading">
          <div>
            <span className="section-index">08</span>
            <h2 id="candidate-edit-heading">备注与投递状态</h2>
          </div>
        </div>
        <p className="decision-context">
          {selectedCandidate === undefined
            ? '从候选池选择一个职位后编辑。'
            : `${selectedCandidate.title} · ${selectedCandidate.company}`}
        </p>
        <div className="candidate-editor">
          <label>
            用户判断
            <select
              disabled={selectedCandidate === undefined}
              value={props.candidateDecision}
              onChange={(event) =>
                props.onCandidateDecisionChange(
                  event.target.value as CandidateDecision,
                )
              }
            >
              <option value="apply">Apply</option>
              <option value="review">Review</option>
              <option value="skip">Skip</option>
            </select>
          </label>
          <label>
            投递状态
            <select
              disabled={selectedCandidate === undefined}
              value={props.applicationStatus}
              onChange={(event) =>
                props.onApplicationStatusChange(
                  event.target.value as ApplicationStatus,
                )
              }
            >
              <option value="not_applied">未投递</option>
              <option value="applied">已投递</option>
              <option value="interviewing">面试中</option>
              <option value="offer">已获 Offer</option>
              <option value="rejected">未通过</option>
              <option value="withdrawn">已放弃</option>
            </select>
          </label>
          <label>
            备注
            <textarea
              disabled={selectedCandidate === undefined}
              maxLength={4000}
              value={props.candidateNote}
              placeholder="记录人工判断、跟进信息或下一步"
              onChange={(event) => props.onCandidateNoteChange(event.target.value)}
            />
          </label>
          <button
            className="button button-primary"
            type="button"
            disabled={selectedCandidate === undefined}
            onClick={props.onSaveCandidate}
          >
            保存候选池记录
          </button>
        </div>
        {props.candidateMessage === '' ? null : (
          <p className="inline-message" role="status">{props.candidateMessage}</p>
        )}
      </section>

      <section className="panel-section" aria-labelledby="diagnostics-heading">
        <div className="section-heading">
          <div>
            <span className="section-index">09</span>
            <h2 id="diagnostics-heading">扫描诊断</h2>
          </div>
          <button className="text-button" type="button" onClick={props.onRefreshDiagnostics}>
            刷新
          </button>
        </div>
        {props.diagnosticsError === '' ? null : (
          <p className="error-message" role="alert">{props.diagnosticsError}</p>
        )}
        {props.diagnostics.length === 0 ? (
          <p className="empty-copy">尚无扫描诊断记录。</p>
        ) : (
          <ul className="history-list diagnostic-list">
            {props.diagnostics.slice(0, 30).map((event) => (
              <li key={event.id}>
                <div>
                  <strong>{event.event}</strong>
                  <span>{new Date(event.createdAt).toLocaleString()}</span>
                </div>
                <div className="history-meta">
                  <span>{event.level}</span>
                  <span>{event.outcome ?? '—'}</span>
                  <span>{event.expectedJobId ?? '—'} → {event.actualJobId ?? '—'}</span>
                </div>
                {event.message === undefined ? null : (
                  <p className="row-error">{event.message}</p>
                )}
                {event.details === undefined ? null : (
                  <pre>{JSON.stringify(event.details, null, 2)}</pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
