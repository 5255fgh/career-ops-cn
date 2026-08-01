import { z } from "zod";

const NonEmptyTextSchema = z.string().trim().min(1);

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
  salaryText: NonEmptyTextSchema,
  location: NonEmptyTextSchema,
  experienceText: NonEmptyTextSchema,
  educationText: NonEmptyTextSchema,
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

export const PossibleDuplicateSchema = z.strictObject({
  jobId: NonEmptyTextSchema,
  reason: z.literal("same_company_and_title"),
});

export type PossibleDuplicate = z.infer<typeof PossibleDuplicateSchema>;

export const JobResponseSchema = CreateJobRequestSchema.extend({
  id: NonEmptyTextSchema,
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

export const ScreenRequestSchema = z.strictObject({
  jobs: z.array(JobCardSchema),
  preferences: PreferencesSchema.optional(),
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

export const JobListResponseSchema = z.array(JobResponseSchema);

export type JobListResponse = z.infer<typeof JobListResponseSchema>;

export const DecisionRequestSchema = z.strictObject({
  decision: z.enum(["apply", "review", "skip"]),
  reason: NonEmptyTextSchema.optional(),
  outcome: NonEmptyTextSchema.optional(),
});

export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

export const DecisionResponseSchema = DecisionRequestSchema.extend({
  jobId: NonEmptyTextSchema,
}).strict();

export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

export const UserDecisionSchema = z.strictObject({
  jobId: NonEmptyTextSchema,
  decision: z.enum(["interested", "not_interested"]),
  note: NonEmptyTextSchema.optional(),
});

export type UserDecision = z.infer<typeof UserDecisionSchema>;

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
    "EVALUATION_FAILED",
    "EVALUATION_TIMEOUT",
    "CANCELLED",
    "CAREER_OPS_NOT_FOUND",
    "DATABASE_ERROR",
  ]),
});

export type BridgeErrorResponse = z.infer<typeof BridgeErrorResponseSchema>;

export const BridgeSettingsSchema = z.strictObject({
  bridgeToken: NonEmptyTextSchema,
});

export type BridgeSettings = z.infer<typeof BridgeSettingsSchema>;

export const PageContextRequestSchema = z.strictObject({
  type: z.literal("page-context/request"),
});

export type PageContextRequest = z.infer<typeof PageContextRequestSchema>;

export const PageContextResponseSchema = z.strictObject({
  type: z.literal("page-context/response"),
  isZhipin: z.boolean(),
});

export type PageContextResponse = z.infer<typeof PageContextResponseSchema>;

export const MockJobDetailRequestSchema = z.strictObject({
  type: z.literal("mock-job-detail/request"),
});

export type MockJobDetailRequest = z.infer<typeof MockJobDetailRequestSchema>;

export const MockJobDetailResponseSchema = z.strictObject({
  type: z.literal("mock-job-detail/response"),
  job: JobDetailSchema,
});

export type MockJobDetailResponse = z.infer<typeof MockJobDetailResponseSchema>;

export const ExtensionMessageSchema = z.discriminatedUnion("type", [
  PageContextRequestSchema,
  PageContextResponseSchema,
  MockJobDetailRequestSchema,
  MockJobDetailResponseSchema,
]);

export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>;
