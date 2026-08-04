import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import {
  ApplicationStatusSchema,
  BeginBossSessionRequestSchema,
  BeginBossSessionResponseSchema,
  BossFatalBlockEventSchema,
  BossSessionErrorResponseSchema,
  BridgeErrorResponseSchema,
  BridgeSettingsSchema,
  CandidateRecordSchema,
  CandidateUpdateRequestSchema,
  CreateJobRequestSchema,
  DetectPageRequestSchema,
  DetailReadDiagnosticSchema,
  EvaluationResponseSchema,
  EvaluationResultSchema,
  EndBossSessionRequestSchema,
  EndBossSessionResponseSchema,
  ExtractVisibleCardsResponseSchema,
  HealthBadRequestResponseSchema,
  HealthRequestSchema,
  HealthResponseSchema,
  JobCardSchema,
  JobDetailSchema,
  JobIdParamsSchema,
  JobListResponseSchema,
  JobResponseSchema,
  ObserveJobsRequestSchema,
  ScanRunSchema,
  UpdateScanRunRequestSchema,
  PreferencesSchema,
  PossibleDuplicateSchema,
  ScreenRequestSchema,
  ScreenResponseSchema,
  ScreeningResultSchema,
  StartDetailScanRequestSchema,
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
      firstSeenAt: "2026-08-01T10:00:00.000Z",
      lastSeenAt: "2026-08-01T10:00:00.000Z",
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
    name: "CandidateUpdateRequest",
    schema: CandidateUpdateRequestSchema,
    value: {
      decision: "review",
      note: "需要人工复核",
      applicationStatus: "not_applied",
    },
  },
  {
    name: "CandidateRecord",
    schema: CandidateRecordSchema,
    value: {
      jobId: "1",
      decision: "apply",
      note: "已完成首次沟通",
      applicationStatus: "interviewing",
      updatedAt: "2026-08-01T11:00:00.000Z",
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
          firstSeenAt: "2026-08-01T10:00:00.000Z",
          lastSeenAt: "2026-08-01T10:00:00.000Z",
        },
      ]),
    ).not.toThrow();
    expect(() => ScreenResponseSchema.parse({})).toThrow();
    expect(() => JobListResponseSchema.parse({})).toThrow();
  });

  it("scan run、进度更新、观察和评估响应使用严格契约", () => {
    const run = {
      id: "scan-1",
      status: "running",
      phase: "reading-list",
      startedAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:01.000Z",
      finishedAt: null,
      pageCount: 1,
      discoveredCount: 10,
      newJobCount: 3,
      detailSuccessCount: 1,
      detailFailureCount: 0,
      aiSuccessCount: 1,
      aiFailureCount: 0,
      cacheHitCount: 1,
      stopReason: null,
      errorSummary: null,
      cancelRequested: false,
    };
    expect(() => ScanRunSchema.parse(run)).not.toThrow();
    expect(() => ScanRunSchema.parse({ ...run, status: "queued" })).toThrow();
    expect(() =>
      UpdateScanRunRequestSchema.parse({ phase: "evaluating", aiSuccessCount: 2 }),
    ).not.toThrow();
    expect(() => UpdateScanRunRequestSchema.parse({})).toThrow();
    expect(() =>
      ObserveJobsRequestSchema.parse({
        scanRunId: "scan-1",
        sourceQuery: "boss:/web/geek/job?query=TypeScript",
        jobs: [readFixture("job-card.json")],
      }),
    ).not.toThrow();
    expect(() =>
      EvaluationResponseSchema.parse({
        evaluation: readFixture("evaluation-result.json"),
        cacheHit: true,
      }),
    ).not.toThrow();
  });

  it("候选池更新至少包含一个字段，并限制投递状态", () => {
    expect(() => CandidateUpdateRequestSchema.parse({})).toThrow();
    expect(() => ApplicationStatusSchema.parse("interviewing")).not.toThrow();
    expect(() => ApplicationStatusSchema.parse("自动投递中")).toThrow();
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

  it("JobCard 和 JobDetail 对外统一移除 URL query 与 hash", () => {
    const cardFixture = readFixture("job-card.json");
    const detailFixture = readFixture("job-detail.json");
    const volatileUrl =
      "https://www.zhipin.com/job_detail/123456789.html?securityId=volatile#detail";

    expect(
      JobCardSchema.parse({ ...cardFixture, detailUrl: volatileUrl }).detailUrl,
    ).toBe("https://www.zhipin.com/job_detail/123456789.html");
    expect(
      JobDetailSchema.parse({ ...detailFixture, detailUrl: volatileUrl })
        .detailUrl,
    ).toBe("https://www.zhipin.com/job_detail/123456789.html");
  });

  it("detail-scan 请求只携带稳定身份和 content locator session", () => {
    const request = StartDetailScanRequestSchema.parse({
      type: "boss/start-detail-scan/request",
      sessionId: "session-1",
      generation: "generation-1",
      sourceJobId: "123456789",
      detailUrl:
        "https://www.zhipin.com/job_detail/123456789.html?securityId=volatile#detail",
      expectedTitle: "前端开发工程师",
      expectedCompany: "示例科技",
      timeoutMs: 8_000,
      deadlineAt: 1_800_000_000_000,
      requestIntervalMs: 1_800,
    });

    expect(request).toEqual({
      type: "boss/start-detail-scan/request",
      sessionId: "session-1",
      generation: "generation-1",
      sourceJobId: "123456789",
      detailUrl: "https://www.zhipin.com/job_detail/123456789.html",
      expectedTitle: "前端开发工程师",
      expectedCompany: "示例科技",
      timeoutMs: 8_000,
      deadlineAt: 1_800_000_000_000,
      requestIntervalMs: 1_800,
    });
    expect(JSON.stringify(request)).not.toContain("securityId");
    expect(() =>
      StartDetailScanRequestSchema.parse({
        ...request,
        card: { index: 0, job: readFixture("job-card.json") },
      }),
    ).toThrow();
  });

  it("可见卡片响应绑定 locator session 与 content generation", () => {
    const card = JobCardSchema.parse(readFixture("job-card.json"));
    expect(
      ExtractVisibleCardsResponseSchema.parse({
        type: "boss/extract-visible-cards/response",
        sessionId: "session-1",
        generation: "generation-1",
        cards: [{ index: 0, job: card }],
        totalVisible: 1,
        invalidCount: 0,
      }),
    ).toMatchObject({ sessionId: "session-1", generation: "generation-1" });
  });

  it("detail diagnostic 的请求与响应 URL 都不能携带 query/hash", () => {
    expect(
      DetailReadDiagnosticSchema.parse({
        source: "fetch",
        sourceJobId: "123456789",
        detailUrl:
          "https://www.zhipin.com/job_detail/123456789.html?securityId=request",
        responseUrl:
          "https://www.zhipin.com/job_detail/123456789.html?securityId=response#detail",
        httpStatus: 200,
        detectedPageType: "job-detail",
        hasDetailContainer: true,
        missingFields: [],
        outcome: "success",
      }),
    ).toMatchObject({
      detailUrl: "https://www.zhipin.com/job_detail/123456789.html",
      responseUrl: "https://www.zhipin.com/job_detail/123456789.html",
    });
  });

  it("begin/end session 与会话内请求使用严格 session 契约", () => {
    const begin = BeginBossSessionRequestSchema.parse({
      type: "boss/begin-session/request",
      sessionId: "session-1",
    });
    expect(
      BeginBossSessionResponseSchema.parse({
        type: "boss/begin-session/response",
        sessionId: begin.sessionId,
        generation: "generation-1",
        queryScope: "boss:/web/geek/job?query=TypeScript",
      }),
    ).toMatchObject({ sessionId: "session-1", generation: "generation-1" });
    expect(
      DetectPageRequestSchema.parse({
        type: "boss/detect-page/request",
        sessionId: "session-1",
        generation: "generation-1",
      }),
    ).toMatchObject({ sessionId: "session-1" });
    expect(
      EndBossSessionRequestSchema.parse({
        type: "boss/end-session/request",
        sessionId: "session-1",
        generation: "generation-1",
      }),
    ).toMatchObject({ sessionId: "session-1" });
    expect(
      EndBossSessionResponseSchema.parse({
        type: "boss/end-session/response",
        ended: true,
      }),
    ).toEqual({ type: "boss/end-session/response", ended: true });
  });

  it("context_changed 与 account fatal 使用不同的最小消息", () => {
    expect(
      BossSessionErrorResponseSchema.parse({
        type: "boss/session-error/response",
        sessionId: "session-1",
        generation: "generation-1",
        reason: "context_changed",
      }),
    ).toMatchObject({ reason: "context_changed" });
    expect(
      BossFatalBlockEventSchema.parse({
        type: "boss/fatal-block/event",
        sessionId: "session-1",
        generation: "generation-1",
        reason: "challenge",
      }),
    ).toEqual({
      type: "boss/fatal-block/event",
      sessionId: "session-1",
      generation: "generation-1",
      reason: "challenge",
    });
    expect(() =>
      BossFatalBlockEventSchema.parse({
        type: "boss/fatal-block/event",
        sessionId: "session-1",
        generation: "generation-1",
        reason: "unsupported_layout",
      }),
    ).toThrow();
  });

  it("JobCard 只要求身份与详情入口字段", () => {
    expect(
      JobCardSchema.parse({
        jobId: "minimal-1",
        title: "前端工程师",
        companyName: "示例科技",
        detailUrl: "https://www.zhipin.com/job_detail/minimal-1.html",
      }),
    ).toEqual({
      jobId: "minimal-1",
      title: "前端工程师",
      companyName: "示例科技",
      detailUrl: "https://www.zhipin.com/job_detail/minimal-1.html",
    });
  });

  it("ScreenRequest 可明确区分列表预筛和详情完整筛选", () => {
    expect(
      ScreenRequestSchema.parse({
        jobs: [readFixture("job-detail.json")],
        phase: "detail",
      }),
    ).toMatchObject({ phase: "detail" });
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
