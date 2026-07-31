import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import {
  EvaluationResultSchema,
  HealthBadRequestResponseSchema,
  HealthRequestSchema,
  HealthResponseSchema,
  JobCardSchema,
  JobDetailSchema,
  PageContextRequestSchema,
  PageContextResponseSchema,
  PreferencesSchema,
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
      targetTitles: ["前端开发工程师"],
      locations: ["上海"],
      requiredKeywords: ["TypeScript"],
      excludedKeywords: ["外包"],
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
    value: { error: "invalid_request" },
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
];

describe("其余边界对象", () => {
  for (const { name, schema, value } of otherStrictContracts) {
    it(`${name} 接受最小对象并拒绝未知字段`, () => {
      expect(() => schema.parse(value)).not.toThrow();
      expect(() => schema.parse({ ...value, unexpected: true })).toThrow();
    });
  }

  it("JobCard 拒绝非 zhipin.com URL", () => {
    const fixture = readFixture("job-card.json");
    expect(() =>
      JobCardSchema.parse({
        ...fixture,
        detailUrl: "https://example.com/job/123456789",
      }),
    ).toThrow();
  });
});
