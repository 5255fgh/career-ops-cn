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
}).strict();

export type JobDetail = z.infer<typeof JobDetailSchema>;

export const PreferencesSchema = z.strictObject({
  targetTitles: z.array(NonEmptyTextSchema),
  locations: z.array(NonEmptyTextSchema),
  requiredKeywords: z.array(NonEmptyTextSchema),
  excludedKeywords: z.array(NonEmptyTextSchema),
});

export type Preferences = z.infer<typeof PreferencesSchema>;

export const ScreeningResultSchema = z.strictObject({
  jobId: NonEmptyTextSchema,
  matched: z.boolean(),
  reasons: z.array(NonEmptyTextSchema),
});

export type ScreeningResult = z.infer<typeof ScreeningResultSchema>;

export const EvaluationResultSchema = z.strictObject({
  jobId: NonEmptyTextSchema,
  score: z.number().int().min(0).max(100),
  summary: NonEmptyTextSchema,
  strengths: z.array(NonEmptyTextSchema),
  risks: z.array(NonEmptyTextSchema),
});

export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;

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
  error: z.literal("invalid_request"),
});

export type HealthBadRequestResponse = z.infer<
  typeof HealthBadRequestResponseSchema
>;

export const PageContextRequestSchema = z.strictObject({
  type: z.literal("page-context/request"),
});

export type PageContextRequest = z.infer<typeof PageContextRequestSchema>;

export const PageContextResponseSchema = z.strictObject({
  type: z.literal("page-context/response"),
  isZhipin: z.boolean(),
});

export type PageContextResponse = z.infer<typeof PageContextResponseSchema>;

export const ExtensionMessageSchema = z.discriminatedUnion("type", [
  PageContextRequestSchema,
  PageContextResponseSchema,
]);

export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>;
