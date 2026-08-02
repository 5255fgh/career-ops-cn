import { describe, expect, it } from "vitest";

import {
  normalizeUnicodeKey,
  parseCnSalary,
  screenJob,
  type RuleResult,
  type ScreenableJob,
  type ScreeningPreferences,
} from "../src/index.js";

const baseJob: ScreenableJob = {
  title: "高级前端开发工程师",
  companyName: "示例科技有限公司",
  salaryText: "20-30K·14薪",
  location: "上海·浦东新区",
  description:
    "负责 TypeScript、React 和前端工程化开发，持续维护核心业务系统并参与代码评审。",
};

const basePreferences: ScreeningPreferences = {
  location: { allowed: ["上海", "杭州"] },
  salary: { minimum: 20_000, period: "month" },
  company: { blocklist: ["风险公司"] },
  keyword: {
    blocklist: ["外包"],
    warning: ["大小周"],
  },
  skill: { requiredAny: ["TypeScript", "Go"] },
  jd: { minimumLength: 20 },
};

function ruleById(
  result: ReturnType<typeof screenJob>,
  ruleId: RuleResult["ruleId"],
): RuleResult {
  const rule = result.rules.find((candidate) => candidate.ruleId === ruleId);
  if (rule === undefined) {
    throw new Error(`缺少规则结果: ${ruleId}`);
  }
  return rule;
}

describe("normalizeUnicodeKey", () => {
  it("使用 NFKC、大小写和空白归一化且保留中文", () => {
    expect(normalizeUnicodeKey("  ＡＢＣ　科技（中国）有限公司 ")).toBe(
      "abc科技(中国)有限公司",
    );
  });
});

describe("parseCnSalary", () => {
  it.each([
    {
      raw: "15-25K",
      expected: {
        period: "month",
        min: 15_000,
        max: 25_000,
        monthsPerYear: 12,
        estimatedAnnualMin: 180_000,
        estimatedAnnualMax: 300_000,
        negotiable: false,
        confidence: "high",
      },
    },
    {
      raw: "15-25K·13薪",
      expected: {
        period: "month",
        min: 15_000,
        max: 25_000,
        monthsPerYear: 13,
        estimatedAnnualMin: 195_000,
        estimatedAnnualMax: 325_000,
        negotiable: false,
        confidence: "high",
      },
    },
    {
      raw: "20-30K·14薪",
      expected: {
        period: "month",
        min: 20_000,
        max: 30_000,
        monthsPerYear: 14,
        estimatedAnnualMin: 280_000,
        estimatedAnnualMax: 420_000,
        negotiable: false,
        confidence: "high",
      },
    },
    {
      raw: "300-500元/天",
      expected: {
        period: "day",
        min: 300,
        max: 500,
        monthsPerYear: null,
        estimatedAnnualMin: 75_000,
        estimatedAnnualMax: 125_000,
        negotiable: false,
        confidence: "medium",
      },
    },
    {
      raw: "30-45万/年",
      expected: {
        period: "year",
        min: 300_000,
        max: 450_000,
        monthsPerYear: null,
        estimatedAnnualMin: 300_000,
        estimatedAnnualMax: 450_000,
        negotiable: false,
        confidence: "high",
      },
    },
    {
      raw: "薪资面议",
      expected: {
        period: "unknown",
        min: null,
        max: null,
        monthsPerYear: null,
        estimatedAnnualMin: null,
        estimatedAnnualMax: null,
        negotiable: true,
        confidence: "high",
      },
    },
    {
      raw: "15K以上",
      expected: {
        period: "month",
        min: 15_000,
        max: null,
        monthsPerYear: 12,
        estimatedAnnualMin: 180_000,
        estimatedAnnualMax: null,
        negotiable: false,
        confidence: "high",
      },
    },
    {
      raw: "根据能力综合评估",
      expected: {
        period: "unknown",
        min: null,
        max: null,
        monthsPerYear: null,
        estimatedAnnualMin: null,
        estimatedAnnualMax: null,
        negotiable: false,
        confidence: "low",
      },
    },
  ])("解析 $raw", ({ raw, expected }) => {
    expect(parseCnSalary(raw)).toEqual({ raw, ...expected });
  });

  it("开放上界保持为空，不猜测薪资上限", () => {
    expect(parseCnSalary("15K以上").max).toBeNull();
    expect(parseCnSalary("15K以上").estimatedAnnualMax).toBeNull();
  });
});

describe("screenJob", () => {
  it("列表预筛不因 JD 为空或未命中详情技能而阻断", () => {
    const result = screenJob(
      { ...baseJob, title: "普通前端工程师", description: "" },
      { ...basePreferences, skill: { requiredAny: ["Rust"] } },
      "list",
    );

    expect(result.decision).not.toBe("block");
    expect(result.rules.some(({ ruleId }) => ruleId.startsWith("jd."))).toBe(
      false,
    );
    expect(
      result.rules.some(({ ruleId }) => ruleId === "skill.required_any"),
    ).toBe(false);
  });

  it("城市前缀匹配允许地点，并输出全部规则字段", () => {
    const result = screenJob(baseJob, basePreferences);

    expect(result.decision).toBe("pass");
    expect(result.score).toBe(100);
    expect(result.rules).toHaveLength(8);
    expect(ruleById(result, "location.allowed")).toMatchObject({
      decision: "pass",
      reason: expect.any(String),
      evidence: expect.arrayContaining(["上海·浦东新区", "上海"]),
    });
    for (const rule of result.rules) {
      expect(rule).toEqual({
        ruleId: expect.any(String),
        decision: expect.any(String),
        reason: expect.any(String),
        evidence: expect.any(Array),
      });
    }
  });

  it("薪资下限不足时阻断", () => {
    const result = screenJob(baseJob, {
      ...basePreferences,
      salary: { minimum: 25_000, period: "month" },
    });

    expect(ruleById(result, "salary.minimum").decision).toBe("block");
    expect(result.decision).toBe("block");
  });

  it("使用中文安全归一化匹配公司黑名单", () => {
    const result = screenJob(
      {
        ...baseJob,
        companyName: "ＡＢＣ　科技（中国）有限公司",
      },
      {
        ...basePreferences,
        company: { blocklist: ["abc科技(中国)有限公司"] },
      },
    );

    expect(ruleById(result, "company.blocklist")).toMatchObject({
      decision: "block",
      evidence: expect.arrayContaining([
        "ＡＢＣ　科技（中国）有限公司",
        "abc科技(中国)有限公司",
      ]),
    });
  });

  it("阻断词命中时阻断", () => {
    const result = screenJob(
      { ...baseJob, description: `${baseJob.description} 本岗位属于外包项目。` },
      basePreferences,
    );

    expect(ruleById(result, "keyword.blocklist")).toMatchObject({
      decision: "block",
      evidence: ["外包"],
    });
  });

  it("警告词命中时进入 review", () => {
    const result = screenJob(
      { ...baseJob, description: `${baseJob.description} 团队目前实行大小周。` },
      basePreferences,
    );

    expect(ruleById(result, "keyword.warning")).toMatchObject({
      decision: "warning",
      evidence: ["大小周"],
    });
    expect(result.decision).toBe("review");
    expect(result.score).not.toBeNull();
  });

  it("必备技能任一匹配即通过", () => {
    const result = screenJob(baseJob, {
      ...basePreferences,
      skill: { requiredAny: ["Rust", "React"] },
    });

    expect(ruleById(result, "skill.required_any")).toMatchObject({
      decision: "pass",
      evidence: ["React"],
    });
  });

  it("JD 为空时进入 review", () => {
    const result = screenJob(
      { ...baseJob, title: "TypeScript 工程师", description: " \n " },
      basePreferences,
    );

    expect(ruleById(result, "jd.empty").decision).toBe("warning");
    expect(result.decision).toBe("review");
  });

  it("JD 太短时进入 review", () => {
    const result = screenJob(
      { ...baseJob, description: "TypeScript" },
      basePreferences,
    );

    expect(ruleById(result, "jd.too_short").decision).toBe("warning");
    expect(result.decision).toBe("review");
  });

  it("block 始终优先且不产生排序 score", () => {
    const result = screenJob(
      {
        ...baseJob,
        companyName: "风险公司",
        description: `${baseJob.description} 团队目前实行大小周。`,
      },
      basePreferences,
    );

    expect(ruleById(result, "company.blocklist").decision).toBe("block");
    expect(ruleById(result, "keyword.warning").decision).toBe("warning");
    expect(result.decision).toBe("block");
    expect(result.score).toBeNull();
  });
});
