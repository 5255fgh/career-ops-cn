import { z } from "zod";

const NonEmptyTextSchema = z.string().trim().min(1);

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const SourceQuerySchema = NonEmptyTextSchema.max(2_048);

const ZhipinUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase();
      return (
        url.protocol === "https:" &&
        (hostname === "zhipin.com" || hostname.endsWith(".zhipin.com"))
      );
    } catch {
      return false;
    }
  }, "必须是 zhipin.com 域名下的 HTTPS URL");

export const JobCardSchema = z.strictObject({
  jobId: NonEmptyTextSchema,
  title: NonEmptyTextSchema,
  companyName: NonEmptyTextSchema,
  salaryText: NonEmptyTextSchema.optional(),
  location: NonEmptyTextSchema.optional(),
  experienceText: NonEmptyTextSchema.optional(),
  educationText: NonEmptyTextSchema.optional(),
  detailUrl: ZhipinUrlSchema,
});

export type JobCard = z.infer<typeof JobCardSchema>;

export const JobDetailSchema = JobCardSchema.extend({
  description: NonEmptyTextSchema,
  identityVerified: z.boolean(),
}).strict();

export type JobDetail = z.infer<typeof JobDetailSchema>;

export const CreateJobRequestSchema = z.strictObject({
  source: z.literal("boss"),
  sourceJobId: NonEmptyTextSchema.optional(),
  title: NonEmptyTextSchema,
  company: NonEmptyTextSchema,
  salary: NonEmptyTextSchema.optional(),
  location: NonEmptyTextSchema.optional(),
  experience: NonEmptyTextSchema.optional(),
  education: NonEmptyTextSchema.optional(),
  description: NonEmptyTextSchema.optional(),
  url: ZhipinUrlSchema.optional(),
  identityVerified: z.boolean().default(false),
});

export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

export const SaveJobRequestSchema = CreateJobRequestSchema.extend({
  scanRunId: NonEmptyTextSchema.optional(),
  sourceQuery: SourceQuerySchema.optional(),
}).strict();

export type SaveJobRequest = z.infer<typeof SaveJobRequestSchema>;

export const PossibleDuplicateSchema = z.strictObject({
  jobId: NonEmptyTextSchema,
  reason: z.literal("same_company_and_title"),
});

export type PossibleDuplicate = z.infer<typeof PossibleDuplicateSchema>;

export const JobResponseSchema = CreateJobRequestSchema.extend({
  id: NonEmptyTextSchema,
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  jdHash: Sha256Schema.optional(),
  lastScanRunId: NonEmptyTextSchema.optional(),
  sourceQuery: SourceQuerySchema.optional(),
  possibleDuplicate: PossibleDuplicateSchema.optional(),
}).strict();

export type JobResponse = z.infer<typeof JobResponseSchema>;

export const JobIdParamsSchema = z.strictObject({
  id: NonEmptyTextSchema,
});

export type JobIdParams = z.infer<typeof JobIdParamsSchema>;

export const PreferencesSchema = z.strictObject({
  location: z
    .strictObject({
      allowed: z.array(NonEmptyTextSchema).optional(),
    })
    .optional(),
  salary: z
    .strictObject({
      minimum: z.number().nonnegative().optional(),
      period: z.enum(["month", "day", "year"]).optional(),
    })
    .optional(),
  company: z
    .strictObject({
      blocklist: z.array(NonEmptyTextSchema).optional(),
    })
    .optional(),
  keyword: z
    .strictObject({
      blocklist: z.array(NonEmptyTextSchema).optional(),
      warning: z.array(NonEmptyTextSchema).optional(),
    })
    .optional(),
  skill: z
    .strictObject({
      requiredAny: z.array(NonEmptyTextSchema).optional(),
    })
    .optional(),
  jd: z
    .strictObject({
      minimumLength: z.number().int().positive().optional(),
    })
    .optional(),
});

export type Preferences = z.infer<typeof PreferencesSchema>;

export const ScreeningResultSchema = z.strictObject({
  jobId: NonEmptyTextSchema,
  matched: z.boolean(),
  reasons: z.array(NonEmptyTextSchema),
});

export type ScreeningResult = z.infer<typeof ScreeningResultSchema>;

export const ScreeningPhaseSchema = z.enum(["list", "detail"]);

export type ScreeningPhase = z.infer<typeof ScreeningPhaseSchema>;

export const ScreenableJobSchema = z.union([JobDetailSchema, JobCardSchema]);

export const ScreenRequestSchema = z.strictObject({
  jobs: z.array(ScreenableJobSchema),
  preferences: PreferencesSchema.optional(),
  phase: ScreeningPhaseSchema.default("list"),
});

export type ScreenRequest = z.infer<typeof ScreenRequestSchema>;

export const ScreenResponseSchema = z.array(ScreeningResultSchema);

export type ScreenResponse = z.infer<typeof ScreenResponseSchema>;

export const EvaluationResultSchema = z.strictObject({
  score: z.number().int().min(0).max(100),
  recommendation: NonEmptyTextSchema,
  rawReport: NonEmptyTextSchema,
  company: NonEmptyTextSchema.nullable().optional(),
  role: NonEmptyTextSchema.nullable().optional(),
  archetype: NonEmptyTextSchema.nullable().optional(),
  legitimacy: NonEmptyTextSchema.nullable().optional(),
});

export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;

export const EvaluateJobRequestSchema = z.strictObject({
  scanRunId: NonEmptyTextSchema.optional(),
});

export type EvaluateJobRequest = z.infer<typeof EvaluateJobRequestSchema>;

export const EvaluationResponseSchema = z.strictObject({
  evaluation: EvaluationResultSchema,
  cacheHit: z.boolean(),
});

export type EvaluationResponse = z.infer<typeof EvaluationResponseSchema>;

export const CandidateDecisionSchema = z.enum(["apply", "review", "skip"]);

export type CandidateDecision = z.infer<typeof CandidateDecisionSchema>;

export const ApplicationStatusSchema = z.enum([
  "not_applied",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
]);

export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

const CandidateNoteSchema = NonEmptyTextSchema.max(4_000);

export const CandidateUpdateRequestSchema = z
  .strictObject({
    decision: CandidateDecisionSchema.nullable().optional(),
    note: CandidateNoteSchema.nullable().optional(),
    applicationStatus: ApplicationStatusSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "至少需要更新一个候选池字段。",
  });

export type CandidateUpdateRequest = z.infer<
  typeof CandidateUpdateRequestSchema
>;

export const CandidateRecordSchema = z.strictObject({
  jobId: NonEmptyTextSchema,
  decision: CandidateDecisionSchema.nullable(),
  note: CandidateNoteSchema.nullable(),
  applicationStatus: ApplicationStatusSchema,
  updatedAt: z.string().datetime(),
});

export type CandidateRecord = z.infer<typeof CandidateRecordSchema>;

export const JobHistoryEntrySchema = JobResponseSchema.extend({
  latestScreening: ScreeningResultSchema.optional(),
  latestEvaluation: EvaluationResultSchema.optional(),
  candidate: CandidateRecordSchema.optional(),
}).strict();

export type JobHistoryEntry = z.infer<typeof JobHistoryEntrySchema>;

export const JobListResponseSchema = z.array(JobHistoryEntrySchema);

export type JobListResponse = z.infer<typeof JobListResponseSchema>;

export const HealthRequestSchema = z.strictObject({});

export type HealthRequest = z.infer<typeof HealthRequestSchema>;

export const HealthResponseSchema = z.strictObject({
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const HealthBadRequestResponseSchema = z.strictObject({
  error: z.literal("INVALID_REQUEST"),
});

export type HealthBadRequestResponse = z.infer<
  typeof HealthBadRequestResponseSchema
>;

export const BridgeErrorResponseSchema = z.strictObject({
  error: z.enum([
    "UNAUTHORIZED",
    "INVALID_REQUEST",
    "JOB_NOT_FOUND",
    "INVALID_JOB_DETAIL",
    "DETAIL_IDENTITY_UNVERIFIED",
    "HARD_RULE_BLOCKED",
    "EVALUATION_FAILED",
    "EVALUATION_TIMEOUT",
    "CANCELLED",
    "CAREER_OPS_NOT_FOUND",
    "DATABASE_ERROR",
  ]),
  message: NonEmptyTextSchema.optional(),
  diagnosticId: NonEmptyTextSchema.optional(),
});

export type BridgeErrorResponse = z.infer<typeof BridgeErrorResponseSchema>;

const DiagnosticDetailValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const DiagnosticEventRequestSchema = z.strictObject({
  source: z.enum(["extension", "bridge"]),
  level: z.enum(["info", "warning", "error"]),
  event: NonEmptyTextSchema,
  scanId: NonEmptyTextSchema.optional(),
  jobId: NonEmptyTextSchema.optional(),
  expectedJobId: NonEmptyTextSchema.optional(),
  actualJobId: NonEmptyTextSchema.optional(),
  expectedTitle: NonEmptyTextSchema.optional(),
  actualTitle: NonEmptyTextSchema.optional(),
  outcome: NonEmptyTextSchema.optional(),
  message: NonEmptyTextSchema.optional(),
  details: z.record(z.string(), DiagnosticDetailValueSchema).optional(),
});

export type DiagnosticEventRequest = z.infer<
  typeof DiagnosticEventRequestSchema
>;

export const DiagnosticEventSchema = DiagnosticEventRequestSchema.extend({
  id: NonEmptyTextSchema,
  createdAt: z.string().datetime(),
}).strict();

export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>;

export const DiagnosticListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const DiagnosticListResponseSchema = z.array(DiagnosticEventSchema);

export const BridgeSettingsSchema = z.strictObject({
  bridgeToken: NonEmptyTextSchema,
});

export type BridgeSettings = z.infer<typeof BridgeSettingsSchema>;

export const ScanConfigSchema = z.strictObject({
  maxPages: z.number().int().positive(),
  maxNewJobs: z.number().int().positive(),
  maxAiJobs: z.number().int().positive(),
  detailTimeoutMs: z.number().int().positive(),
  requestIntervalMs: z.number().int().nonnegative(),
  maxRoundMs: z.number().int().positive(),
});

export type ScanConfig = z.infer<typeof ScanConfigSchema>;

export const ScanRunStatusSchema = z.enum([
  "running",
  "completed",
  "cancelled",
  "interrupted",
  "failed",
]);

export type ScanRunStatus = z.infer<typeof ScanRunStatusSchema>;

export const ScanRunPhaseSchema = z.enum([
  "starting",
  "reading-list",
  "screening",
  "reading-details",
  "evaluating",
  "finished",
]);

export type ScanRunPhase = z.infer<typeof ScanRunPhaseSchema>;

export const ScanRunSchema = z.strictObject({
  id: NonEmptyTextSchema,
  status: ScanRunStatusSchema,
  phase: ScanRunPhaseSchema,
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  pageCount: z.number().int().nonnegative(),
  discoveredCount: z.number().int().nonnegative(),
  newJobCount: z.number().int().nonnegative(),
  detailSuccessCount: z.number().int().nonnegative(),
  detailFailureCount: z.number().int().nonnegative(),
  aiSuccessCount: z.number().int().nonnegative(),
  aiFailureCount: z.number().int().nonnegative(),
  cacheHitCount: z.number().int().nonnegative(),
  stopReason: NonEmptyTextSchema.nullable(),
  errorSummary: NonEmptyTextSchema.nullable(),
  cancelRequested: z.boolean(),
});

export type ScanRun = z.infer<typeof ScanRunSchema>;

export const CreateScanRunRequestSchema = z.strictObject({});

export const ScanRunIdParamsSchema = z.strictObject({
  id: NonEmptyTextSchema,
});

export const UpdateScanRunRequestSchema = z
  .strictObject({
    status: ScanRunStatusSchema.optional(),
    phase: ScanRunPhaseSchema.optional(),
    pageCount: z.number().int().nonnegative().optional(),
    discoveredCount: z.number().int().nonnegative().optional(),
    newJobCount: z.number().int().nonnegative().optional(),
    detailSuccessCount: z.number().int().nonnegative().optional(),
    detailFailureCount: z.number().int().nonnegative().optional(),
    aiSuccessCount: z.number().int().nonnegative().optional(),
    aiFailureCount: z.number().int().nonnegative().optional(),
    cacheHitCount: z.number().int().nonnegative().optional(),
    stopReason: NonEmptyTextSchema.max(256).nullable().optional(),
    errorSummary: NonEmptyTextSchema.max(2_000).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "至少需要更新一个 scan run 字段。",
  });

export type UpdateScanRunRequest = z.infer<
  typeof UpdateScanRunRequestSchema
>;

export const RequestScanRunCancelSchema = z.strictObject({});

export const InterruptScanRunRequestSchema = z.strictObject({
  reason: NonEmptyTextSchema.max(256).optional(),
  errorSummary: NonEmptyTextSchema.max(2_000).optional(),
});

export type InterruptScanRunRequest = z.infer<
  typeof InterruptScanRunRequestSchema
>;

const ReadDetailObservationSchema = z.strictObject({
  sourceJobId: NonEmptyTextSchema,
  action: z.literal("read-detail"),
  reason: z.enum(["new", "card-changed", "missing-detail"]),
});

const ReuseObservationSchema = z.strictObject({
  sourceJobId: NonEmptyTextSchema,
  action: z.literal("reuse"),
  job: JobHistoryEntrySchema,
  evaluation: EvaluationResultSchema.nullable(),
  cacheHit: z.boolean(),
});

export const JobObservationSchema = z.discriminatedUnion("action", [
  ReadDetailObservationSchema,
  ReuseObservationSchema,
]);

export type JobObservation = z.infer<typeof JobObservationSchema>;

export const ObserveJobsRequestSchema = z.strictObject({
  scanRunId: NonEmptyTextSchema,
  sourceQuery: SourceQuerySchema,
  jobs: z.array(JobCardSchema).min(1).max(200),
});

export type ObserveJobsRequest = z.infer<typeof ObserveJobsRequestSchema>;

export const ObserveJobsResponseSchema = z.array(JobObservationSchema);

export const ScanRunSnapshotSchema = z.strictObject({
  run: ScanRunSchema,
  jobs: JobListResponseSchema,
});

export type ScanRunSnapshot = z.infer<typeof ScanRunSnapshotSchema>;

export const LatestScanRunResponseSchema = ScanRunSnapshotSchema.nullable();

export const BossPageTypeSchema = z.enum([
  "search-list",
  "search-detail-panel",
  "job-detail",
  "company-job-list",
  "login",
  "challenge",
  "unsupported",
]);

export type BossPageType = z.infer<typeof BossPageTypeSchema>;

export const BossPageBlockReasonSchema = z.enum([
  "login_required",
  "challenge",
  "account_risk",
  "unsupported_layout",
  "empty_page",
]);

export type BossPageBlockReason = z.infer<
  typeof BossPageBlockReasonSchema
>;

export const BossPageBlockSchema = z.strictObject({
  reason: BossPageBlockReasonSchema,
  pageType: BossPageTypeSchema,
});

export type BossPageBlock = z.infer<typeof BossPageBlockSchema>;

export const VisibleJobCardSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  job: JobCardSchema,
});

export type VisibleJobCard = z.infer<typeof VisibleJobCardSchema>;

export const DetectPageRequestSchema = z.strictObject({
  type: z.literal("boss/detect-page/request"),
});

export const DetectPageResponseSchema = z.strictObject({
  type: z.literal("boss/detect-page/response"),
  pageType: BossPageTypeSchema,
  block: BossPageBlockSchema.nullable(),
  sourceQuery: SourceQuerySchema.optional(),
});

export type DetectPageResponse = z.infer<typeof DetectPageResponseSchema>;

export const ExtractCurrentDetailRequestSchema = z.strictObject({
  type: z.literal("boss/extract-current-detail/request"),
});

export const ExtractCurrentDetailResponseSchema = z.strictObject({
  type: z.literal("boss/extract-current-detail/response"),
  job: JobDetailSchema.nullable(),
});

export const ExtractVisibleCardsRequestSchema = z.strictObject({
  type: z.literal("boss/extract-visible-cards/request"),
});

export const ExtractVisibleCardsResponseSchema = z.strictObject({
  type: z.literal("boss/extract-visible-cards/response"),
  cards: z.array(VisibleJobCardSchema),
  totalVisible: z.number().int().nonnegative(),
  invalidCount: z.number().int().nonnegative(),
  invalidFieldCounts: z
    .strictObject({
      jobId: z.number().int().nonnegative().optional(),
      title: z.number().int().nonnegative().optional(),
      companyName: z.number().int().nonnegative().optional(),
      salaryText: z.number().int().nonnegative().optional(),
      location: z.number().int().nonnegative().optional(),
      experienceText: z.number().int().nonnegative().optional(),
      educationText: z.number().int().nonnegative().optional(),
      detailUrl: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export type ExtractVisibleCardsResponse = z.infer<
  typeof ExtractVisibleCardsResponseSchema
>;

export const StartDetailScanRequestSchema = z.strictObject({
  type: z.literal("boss/start-detail-scan/request"),
  card: VisibleJobCardSchema,
  timeoutMs: z.number().int().positive(),
});

export const DetailReadDiagnosticSchema = z.strictObject({
  source: z.enum(["fetch", "live-panel"]),
  sourceJobId: NonEmptyTextSchema,
  detailUrl: ZhipinUrlSchema,
  responseUrl: z.string().url().nullable(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  detectedPageType: BossPageTypeSchema.nullable(),
  hasDetailContainer: z.boolean(),
  missingFields: z.array(NonEmptyTextSchema).max(20),
  outcome: NonEmptyTextSchema,
  matchedBy: z
    .enum(["source_job_id", "detail_url", "title_company"])
    .optional(),
});

export type DetailReadDiagnostic = z.infer<
  typeof DetailReadDiagnosticSchema
>;

const DetailReadDiagnosticsSchema = z
  .array(DetailReadDiagnosticSchema)
  .min(1)
  .max(4)
  .optional();

const DetailIdentityEvidenceSchema = z.strictObject({
  detailFound: z.boolean(),
  actualJobId: NonEmptyTextSchema.optional(),
  actualTitle: NonEmptyTextSchema.optional(),
  signals: z
    .strictObject({
      jobIdentity: z.boolean().nullable(),
      title: z.boolean().nullable(),
      company: z.boolean().nullable(),
      activeCard: z.boolean().nullable(),
      contentChanged: z.boolean().nullable(),
    })
    .optional(),
});

export const StartDetailScanResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    type: z.literal("boss/start-detail-scan/response"),
    outcome: z.literal("success"),
    job: JobDetailSchema,
    diagnostics: DetailReadDiagnosticsSchema,
  }),
  z.strictObject({
    type: z.literal("boss/start-detail-scan/response"),
    outcome: z.literal("timeout"),
    evidence: DetailIdentityEvidenceSchema.optional(),
    diagnostics: DetailReadDiagnosticsSchema,
  }),
  z.strictObject({
    type: z.literal("boss/start-detail-scan/response"),
    outcome: z.literal("identity_failure"),
    evidence: DetailIdentityEvidenceSchema.optional(),
    diagnostics: DetailReadDiagnosticsSchema,
  }),
  z.strictObject({
    type: z.literal("boss/start-detail-scan/response"),
    outcome: z.literal("blocked"),
    reason: BossPageBlockReasonSchema,
    diagnostics: DetailReadDiagnosticsSchema,
  }),
  z.strictObject({
    type: z.literal("boss/start-detail-scan/response"),
    outcome: z.literal("cancelled"),
    diagnostics: DetailReadDiagnosticsSchema,
  }),
  z.strictObject({
    type: z.literal("boss/start-detail-scan/response"),
    outcome: z.literal("failed"),
    message: NonEmptyTextSchema,
    failureKind: z.enum([
      "network",
      "http",
      "missing_fields",
      "layout",
      "navigation_changed",
      "unknown",
    ]),
    retryable: z.boolean(),
    diagnostics: DetailReadDiagnosticsSchema,
  }),
]);

export type StartDetailScanResponse = z.infer<
  typeof StartDetailScanResponseSchema
>;

export const AdvanceSearchPageRequestSchema = z.strictObject({
  type: z.literal("boss/advance-search-page/request"),
  timeoutMs: z.number().int().positive(),
});

export const AdvanceSearchPageResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    type: z.literal("boss/advance-search-page/response"),
    outcome: z.literal("advanced"),
  }),
  z.strictObject({
    type: z.literal("boss/advance-search-page/response"),
    outcome: z.literal("end"),
  }),
  z.strictObject({
    type: z.literal("boss/advance-search-page/response"),
    outcome: z.literal("blocked"),
    reason: BossPageBlockReasonSchema,
  }),
  z.strictObject({
    type: z.literal("boss/advance-search-page/response"),
    outcome: z.literal("cancelled"),
  }),
  z.strictObject({
    type: z.literal("boss/advance-search-page/response"),
    outcome: z.literal("failed"),
    message: NonEmptyTextSchema,
  }),
]);

export type AdvanceSearchPageResponse = z.infer<
  typeof AdvanceSearchPageResponseSchema
>;

export const CancelDetailScanRequestSchema = z.strictObject({
  type: z.literal("boss/cancel-detail-scan/request"),
});

export const CancelDetailScanResponseSchema = z.strictObject({
  type: z.literal("boss/cancel-detail-scan/response"),
  cancelled: z.boolean(),
});

export const ExtensionMessageSchema = z.union([
  DetectPageRequestSchema,
  DetectPageResponseSchema,
  ExtractCurrentDetailRequestSchema,
  ExtractCurrentDetailResponseSchema,
  ExtractVisibleCardsRequestSchema,
  ExtractVisibleCardsResponseSchema,
  StartDetailScanRequestSchema,
  StartDetailScanResponseSchema,
  AdvanceSearchPageRequestSchema,
  AdvanceSearchPageResponseSchema,
  CancelDetailScanRequestSchema,
  CancelDetailScanResponseSchema,
]);

export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>;
