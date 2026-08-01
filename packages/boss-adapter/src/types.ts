export type BossPageType =
  | "search-list"
  | "search-detail-panel"
  | "job-detail"
  | "company-job-list"
  | "login"
  | "challenge"
  | "unsupported";

export type BossPageBlockReason =
  | "login_required"
  | "challenge"
  | "account_risk"
  | "unsupported_layout"
  | "empty_page";

export interface BossPageBlock {
  reason: BossPageBlockReason;
  pageType: BossPageType;
}

export interface BossJobIdentity {
  sourceJobId: string | null;
  url: string | null;
  title: string | null;
}

export interface BossJobCard extends BossJobIdentity {
  company: string | null;
  salaryRaw: string | null;
  city: string | null;
  experience: string | null;
  education: string | null;
  tags: string[];
}

export interface BossJobDetail extends BossJobCard {
  description: string | null;
  capturedAt: string;
  warnings: string[];
}

export type BossIdentitySignal =
  | "job_identity"
  | "title"
  | "active_card"
  | "content_changed";

export interface BossIdentitySignals {
  jobIdentity: boolean | null;
  title: boolean | null;
  activeCard: boolean | null;
  contentChanged: boolean | null;
}

export interface VerifyDetailIdentityInput {
  expected: BossJobIdentity;
  detail: BossJobDetail;
  activeCard?: BossJobCard | null;
  previousDetail?: BossJobDetail | null;
  previousDetailHash?: string | null;
}

export interface BossIdentityVerification {
  verified: boolean;
  signals: BossIdentitySignals;
  matchedSignals: BossIdentitySignal[];
  detailHash: string;
}

export interface BossDetailPredicateContext {
  detail: BossJobDetail;
  identity: BossIdentityVerification;
}

export type BossDetailPredicate = (
  context: BossDetailPredicateContext,
) => boolean;

export interface WaitForBossDetailOptions {
  document: Document;
  url: string;
  expected: BossJobIdentity;
  previousDetail?: BossJobDetail | null;
  previousDetailHash?: string | null;
  predicate?: BossDetailPredicate;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type WaitForBossDetailResult =
  | {
      status: "verified";
      detail: BossJobDetail;
      identity: BossIdentityVerification;
    }
  | {
      status: "blocked";
      block: BossPageBlock;
    }
  | {
      status: "aborted";
    }
  | {
      status: "timeout";
      lastIdentity: BossIdentityVerification | null;
    };

export interface BossDetailSelection {
  element: Element;
  expected?: BossJobIdentity;
}

export interface ScanSelectedBossDetailsOptions {
  document: Document;
  url: string;
  selections: readonly BossDetailSelection[];
  activate?: (
    selection: BossDetailSelection,
    index: number,
  ) => void | Promise<void>;
  predicate?: BossDetailPredicate;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BossDetailScanEntry {
  index: number;
  expected: BossJobIdentity;
  result: WaitForBossDetailResult;
}

export interface BossDetailScanResult {
  entries: BossDetailScanEntry[];
  details: BossJobDetail[];
  block: BossPageBlock | null;
}
