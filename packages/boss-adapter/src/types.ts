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
  company?: string | null;
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
  | "company"
  | "active_card"
  | "content_changed";

export interface BossIdentitySignals {
  jobIdentity: boolean | null;
  title: boolean | null;
  company: boolean | null;
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

export type BossCardMatchMethod =
  | "source_job_id"
  | "detail_url"
  | "title_company";

export interface BossCardElementMatch {
  element: Element;
  card: BossJobCard;
  matchedBy: BossCardMatchMethod;
}
