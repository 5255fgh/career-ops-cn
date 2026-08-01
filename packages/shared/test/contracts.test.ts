import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import {
  BridgeErrorResponseSchema,
  BridgeSettingsSchema,
  CreateJobRequestSchema,
  DecisionRequestSchema,
  DecisionResponseSchema,
  EvaluationResultSchema,
  HealthBadRequestResponseSchema,
  HealthRequestSchema,
  HealthResponseSchema,
  JobCardSchema,
  JobDetailSchema,
  JobIdParamsSchema,
  JobListResponseSchema,
  JobResponseSchema,
  MockJobDetailRequestSchema,
  MockJobDetailResponseSchema,
  PageContextRequestSchema,
  PageContextResponseSchema,
  PreferencesSchema,
  PossibleDuplicateSchema,
  ScreenRequestSchema,
  ScreenResponseSchema,
  ScreeningResultSchema,
  UserDecisionSchema,
} from "../src/index.js";

const readFixture = (filename: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      new URL(`../../../fixtures/contracts/${filename}`, import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;

const fixtureContracts: Array<{
  filename: string;
  schema: ZodType;
}> = [
  { filename: "job-card.json", schema: JobCardSchema },
  { filename: "job-detail.json", schema: JobDetailSchema },
  { filename: "screening-result.json", schema: ScreeningResultSchema },
  { filename: "evaluation-result.json", schema: EvaluationResultSchema },
];

describe("契约 fixtures", () => {
  for (const { filename, schema } of fixtureContracts) {
    it(`${filename} 通过对应 schema`, () => {
      expect(() => schema.parse(readFixture(filename))).not.toThrow();
    });

    it(`${filename} 拒绝未知字段`, () => {
      const fixture = readFixture(filename);
      expect(() => schema.parse({ ...fixture, unexpected: true })).toThrow();
    });
  }
});

const otherStrictContracts: Array<{
  name: string;
  schema: ZodType;
  value: Record<string, unknown>;
}> = [
  {
    name: "Preferences",
    schema: PreferencesSchema,
    value: {
      location: { allowed: ["上海"] },
      salary: { minimum: 20_000, period: "month" },
      company: { blocklist: ["风险公司"] },
      keyword: { blocklist: ["外包"], warning: ["大小周"] },
      skill: { requiredAny: ["TypeScript"] },
      jd: { minimumLength: 20 },
    },
  },
  {
    name: "UserDecision",
    schema: UserDecisionSchema,
    value: { jobId: "123456789", decision: "interested" },
  },
  { name: "HealthRequest", schema: HealthRequestSchema, value: {} },
  {
    name: "HealthResponse",
    schema: HealthResponseSchema,
    value: { status: "ok" },
  },
  {
    name: "HealthBadRequestResponse",
    schema: HealthBadRequestResponseSchema,
    value: { error: "INVALID_REQUEST" },
  },
  {
    name: "PageContextRequest",
    schema: PageContextRequestSchema,
    value: { type: "page-context/request" },
  },
  {
    name: "PageContextResponse",
    schema: PageContextResponseSchema,
    value: { type: "page-context/response", isZhipin: true },
  },
  {
    name: "BridgeSettings",
    schema: BridgeSettingsSchema,
    value: { bridgeToken: "test-token" },
  },
  {
    name: "BridgeErrorResponse",
    schema: BridgeErrorResponseSchema,
    value: { error: "JOB_NOT_FOUND" },
  },
  {
    name: "MockJobDetailRequest",
    schema: MockJobDetailRequestSchema,
    value: { type: "mock-job-detail/request" },
  },
  {
    name: "MockJobDetailResponse",
    schema: MockJobDetailResponseSchema,
    value: {
      type: "mock-job-detail/response",
      job: readFixture("job-detail.json"),
    },
  },
  {
    name: "CreateJobRequest",
    schema: CreateJobRequestSchema,
    value: {
      source: "boss",
      sourceJobId: "123456789",
      title: "前端开发工程师",
      company: "示例科技",
      salary: "20-30K·14薪",
      location: "上海·浦东新区",
      description: "负责招聘产品的前端功能开发与维护。",
      url: "https://www.zhipin.com/job_detail/123456789.html",
    },
  },
  {
    name: "JobResponse",
    schema: JobResponseSchema,
    value: {
      id: "1",
      source: "boss",
      sourceJobId: "123456789",
      title: "前端开发工程师",
      company: "示例科技",
      salary: "20-30K·14薪",
      location: "上海·浦东新区",
      description: "负责招聘产品的前端功能开发与维护。",
      url: "https://www.zhipin.com/job_detail/123456789.html",
      identityVerified: true,
    },
  },
  {
    name: "PossibleDuplicate",
    schema: PossibleDuplicateSchema,
    value: { jobId: "2", reason: "same_company_and_title" },
  },
  {
    name: "ScreenRequest",
    schema: ScreenRequestSchema,
    value: {
      jobs: [readFixture("job-card.json")],
      preferences: {
        location: { allowed: ["上海"] },
        keyword: { blocklist: ["外包"] },
        skill: { requiredAny: ["TypeScript"] },
      },
    },
  },
  {
    name: "DecisionRequest",
    schema: DecisionRequestSchema,
    value: { decision: "review", reason: "需要人工复核" },
  },
  {
    name: "DecisionResponse",
    schema: DecisionResponseSchema,
    value: {
      jobId: "1",
      decision: "apply",
      outcome: "已确认",
    },
  },
  {
    name: "JobIdParams",
    schema: JobIdParamsSchema,
    value: { id: "1" },
  },
];

describe("其余边界对象", () => {
  for (const { name, schema, value } of otherStrictContracts) {
    it(`${name} 接受最小对象并拒绝未知字段`, () => {
      expect(() => schema.parse(value)).not.toThrow();
      expect(() => schema.parse({ ...value, unexpected: true })).toThrow();
    });
  }

  it("列表响应只接受对应契约数组", () => {
    expect(() =>
      ScreenResponseSchema.parse([readFixture("screening-result.json")]),
    ).not.toThrow();
    expect(() =>
      JobListResponseSchema.parse([
        {
          id: "1",
          source: "boss",
          title: "前端开发工程师",
          company: "示例科技",
          identityVerified: false,
        },
      ]),
    ).not.toThrow();
    expect(() => ScreenResponseSchema.parse({})).toThrow();
    expect(() => JobListResponseSchema.parse({})).toThrow();
  });

  it("JobCard 拒绝非 zhipin.com URL", () => {
    const fixture = readFixture("job-card.json");
    expect(() =>
      JobCardSchema.parse({
        ...fixture,
        detailUrl: "https://example.com/job/123456789",
      }),
    ).toThrow();
  });

  it("CreateJobRequest 拒绝非 zhipin.com URL", () => {
    expect(() =>
      CreateJobRequestSchema.parse({
        source: "boss",
        title: "前端开发工程师",
        company: "示例科技",
        url: "https://example.com/job/123456789",
      }),
    ).toThrow();
  });

  it("EvaluationResult 接受 career-ops summary 元数据", () => {
    expect(() =>
      EvaluationResultSchema.parse({
        score: 84,
        recommendation: "apply",
        rawReport: "完整评估报告",
        company: "示例科技",
        role: "前端开发工程师",
        archetype: null,
        legitimacy: "high",
      }),
    ).not.toThrow();
  });
});
