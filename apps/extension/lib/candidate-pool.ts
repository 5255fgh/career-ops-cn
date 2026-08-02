import type {
  ApplicationStatus,
  CandidateDecision,
  JobHistoryEntry,
} from '@career-ops-cn/shared';

export type CandidateDecisionFilter =
  | 'all'
  | 'unreviewed'
  | CandidateDecision;
export type ApplicationStatusFilter = 'all' | ApplicationStatus;
export type CandidateSort =
  | 'last-seen-desc'
  | 'score-desc'
  | 'title-asc';

export interface CandidatePoolView {
  decision: CandidateDecisionFilter;
  applicationStatus: ApplicationStatusFilter;
  sort: CandidateSort;
}

function compareLastSeen(left: JobHistoryEntry, right: JobHistoryEntry): number {
  return right.lastSeenAt.localeCompare(left.lastSeenAt);
}

export function filterAndSortCandidates(
  jobs: readonly JobHistoryEntry[],
  view: CandidatePoolView,
): JobHistoryEntry[] {
  return jobs
    .filter((job) => {
      const decision = job.candidate?.decision ?? null;
      const applicationStatus =
        job.candidate?.applicationStatus ?? 'not_applied';
      return (
        (view.decision === 'all' ||
          (view.decision === 'unreviewed'
            ? decision === null
            : decision === view.decision)) &&
        (view.applicationStatus === 'all' ||
          applicationStatus === view.applicationStatus)
      );
    })
    .sort((left, right) => {
      if (view.sort === 'score-desc') {
        const scoreDifference =
          (right.latestEvaluation?.score ?? -1) -
          (left.latestEvaluation?.score ?? -1);
        return scoreDifference === 0
          ? compareLastSeen(left, right)
          : scoreDifference;
      }
      if (view.sort === 'title-asc') {
        const titleDifference = left.title.localeCompare(right.title, 'zh-CN');
        return titleDifference === 0
          ? left.company.localeCompare(right.company, 'zh-CN')
          : titleDifference;
      }
      return compareLastSeen(left, right);
    });
}
