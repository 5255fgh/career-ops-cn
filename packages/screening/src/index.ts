export type SalaryPeriod = "month" | "day" | "year" | "unknown";

export type SalaryConfidence = "high" | "medium" | "low";

export interface ParsedCnSalary {
  readonly raw: string;
  readonly period: SalaryPeriod;
  readonly min: number | null;
  readonly max: number | null;
  readonly monthsPerYear: number | null;
  readonly estimatedAnnualMin: number | null;
  readonly estimatedAnnualMax: number | null;
  readonly negotiable: boolean;
  readonly confidence: SalaryConfidence;
}

export interface ScreenableJob {
  readonly title: string;
  readonly companyName: string;
  readonly salaryText: string;
  readonly location: string;
  readonly description: string;
}

export interface ScreeningPreferences {
  readonly location?: {
    readonly allowed?: readonly string[];
  };
  readonly salary?: {
    readonly minimum?: number;
    readonly period?: Exclude<SalaryPeriod, "unknown">;
  };
  readonly company?: {
    readonly blocklist?: readonly string[];
  };
  readonly keyword?: {
    readonly blocklist?: readonly string[];
    readonly warning?: readonly string[];
  };
  readonly skill?: {
    readonly requiredAny?: readonly string[];
  };
  readonly jd?: {
    readonly minimumLength?: number;
  };
}

export type ScreeningRuleId =
  | "location.allowed"
  | "salary.minimum"
  | "company.blocklist"
  | "keyword.blocklist"
  | "keyword.warning"
  | "skill.required_any"
  | "jd.empty"
  | "jd.too_short";

export type RuleDecision = "pass" | "block" | "warning" | "unknown";

export interface RuleResult {
  readonly ruleId: ScreeningRuleId;
  readonly decision: RuleDecision;
  readonly reason: string;
  readonly evidence: readonly string[];
}

export type ScreeningDecision = "pass" | "review" | "block";

export interface JobScreeningResult {
  readonly decision: ScreeningDecision;
  readonly score: number | null;
  readonly salary: ParsedCnSalary;
  readonly rules: readonly RuleResult[];
}

const DEFAULT_MONTHS_PER_YEAR = 12;
const WORKING_DAYS_PER_YEAR = 250;
const DEFAULT_MINIMUM_JD_LENGTH = 20;
const RANGE_SEPARATOR = "[-~～—–至]";
const NUMBER_PATTERN = "(\\d+(?:\\.\\d+)?)";

const monthlyRangePattern = new RegExp(
  `^${NUMBER_PATTERN}(?:k|千)?${RANGE_SEPARATOR}${NUMBER_PATTERN}(?:k|千)(?:[·・x×*](\\d{1,2})薪)?(?:/月)?$`,
  "u",
);
const dailyRangePattern = new RegExp(
  `^${NUMBER_PATTERN}${RANGE_SEPARATOR}${NUMBER_PATTERN}元/(?:天|日)$`,
  "u",
);
const annualRangePattern = new RegExp(
  `^${NUMBER_PATTERN}${RANGE_SEPARATOR}${NUMBER_PATTERN}万/年$`,
  "u",
);
const monthlyLowerBoundPattern = new RegExp(
  `^${NUMBER_PATTERN}(?:k|千)(?:以上|起)$`,
  "u",
);

/**
 * 生成适合确定性匹配的 Unicode 键，同时保留中文和有意义的标点。
 */
export function normalizeUnicodeKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/\p{White_Space}+/gu, "");
}

function normalizeSalaryText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .trim()
    .replace(/\p{White_Space}+/gu, "");
}

function toFiniteNumber(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unknownSalary(raw: string): ParsedCnSalary {
  return {
    raw,
    period: "unknown",
    min: null,
    max: null,
    monthsPerYear: null,
    estimatedAnnualMin: null,
    estimatedAnnualMax: null,
    negotiable: false,
    confidence: "low",
  };
}

export function parseCnSalary(raw: string): ParsedCnSalary {
  const normalized = normalizeSalaryText(raw);

  if (/^(?:薪资)?面议$/u.test(normalized)) {
    return {
      ...unknownSalary(raw),
      negotiable: true,
      confidence: "high",
    };
  }

  const monthlyRange = monthlyRangePattern.exec(normalized);
  if (monthlyRange !== null) {
    const minimum = toFiniteNumber(monthlyRange[1]);
    const maximum = toFiniteNumber(monthlyRange[2]);
    const explicitMonths = toFiniteNumber(monthlyRange[3]);
    const monthsPerYear = explicitMonths ?? DEFAULT_MONTHS_PER_YEAR;

    if (
      minimum !== null &&
      maximum !== null &&
      minimum <= maximum &&
      Number.isInteger(monthsPerYear) &&
      monthsPerYear >= 1 &&
      monthsPerYear <= 24
    ) {
      const min = Math.round(minimum * 1_000);
      const max = Math.round(maximum * 1_000);
      return {
        raw,
        period: "month",
        min,
        max,
        monthsPerYear,
        estimatedAnnualMin: min * monthsPerYear,
        estimatedAnnualMax: max * monthsPerYear,
        negotiable: false,
        confidence: "high",
      };
    }
  }

  const dailyRange = dailyRangePattern.exec(normalized);
  if (dailyRange !== null) {
    const minimum = toFiniteNumber(dailyRange[1]);
    const maximum = toFiniteNumber(dailyRange[2]);

    if (minimum !== null && maximum !== null && minimum <= maximum) {
      return {
        raw,
        period: "day",
        min: minimum,
        max: maximum,
        monthsPerYear: null,
        estimatedAnnualMin: Math.round(minimum * WORKING_DAYS_PER_YEAR),
        estimatedAnnualMax: Math.round(maximum * WORKING_DAYS_PER_YEAR),
        negotiable: false,
        confidence: "medium",
      };
    }
  }

  const annualRange = annualRangePattern.exec(normalized);
  if (annualRange !== null) {
    const minimum = toFiniteNumber(annualRange[1]);
    const maximum = toFiniteNumber(annualRange[2]);

    if (minimum !== null && maximum !== null && minimum <= maximum) {
      const min = Math.round(minimum * 10_000);
      const max = Math.round(maximum * 10_000);
      return {
        raw,
        period: "year",
        min,
        max,
        monthsPerYear: null,
        estimatedAnnualMin: min,
        estimatedAnnualMax: max,
        negotiable: false,
        confidence: "high",
      };
    }
  }

  const monthlyLowerBound = monthlyLowerBoundPattern.exec(normalized);
  if (monthlyLowerBound !== null) {
    const parsedMinimum = toFiniteNumber(monthlyLowerBound[1]);
    if (parsedMinimum !== null) {
      const min = Math.round(parsedMinimum * 1_000);
      return {
        raw,
        period: "month",
        min,
        max: null,
        monthsPerYear: DEFAULT_MONTHS_PER_YEAR,
        estimatedAnnualMin: min * DEFAULT_MONTHS_PER_YEAR,
        estimatedAnnualMax: null,
        negotiable: false,
        confidence: "high",
      };
    }
  }

  return unknownSalary(raw);
}

interface NormalizedEntry {
  readonly raw: string;
  readonly key: string;
}

function normalizedEntries(values: readonly string[] | undefined): NormalizedEntry[] {
  return (values ?? [])
    .map((raw) => ({ raw, key: normalizeUnicodeKey(raw) }))
    .filter(({ key }) => key.length > 0);
}

function findContainedEntries(
  text: string,
  values: readonly string[] | undefined,
): string[] {
  const key = normalizeUnicodeKey(text);
  return normalizedEntries(values)
    .filter((entry) => key.includes(entry.key))
    .map((entry) => entry.raw);
}

function ruleResult(
  ruleId: ScreeningRuleId,
  decision: RuleDecision,
  reason: string,
  evidence: readonly string[] = [],
): RuleResult {
  return { ruleId, decision, reason, evidence };
}

function evaluateLocation(
  job: ScreenableJob,
  preferences: ScreeningPreferences,
): RuleResult {
  const allowed = normalizedEntries(preferences.location?.allowed);
  if (allowed.length === 0) {
    return ruleResult("location.allowed", "pass", "未设置地点限制");
  }

  const locationKey = normalizeUnicodeKey(job.location);
  if (locationKey.length === 0) {
    return ruleResult("location.allowed", "unknown", "职位地点为空，无法判断");
  }

  const locationCityKey = locationKey.endsWith("市")
    ? locationKey.slice(0, -1)
    : locationKey;
  const matched = allowed.filter((entry) => {
    const allowedCityKey = entry.key.endsWith("市")
      ? entry.key.slice(0, -1)
      : entry.key;
    return (
      locationCityKey === allowedCityKey || locationCityKey.startsWith(allowedCityKey)
    );
  });

  if (matched.length > 0) {
    return ruleResult("location.allowed", "pass", "职位地点在允许范围内", [
      job.location,
      ...matched.map((entry) => entry.raw),
    ]);
  }

  return ruleResult("location.allowed", "block", "职位地点不在允许范围内", [
    job.location,
    ...allowed.map((entry) => entry.raw),
  ]);
}

function salaryMinimumForPeriod(
  salary: ParsedCnSalary,
  targetPeriod: Exclude<SalaryPeriod, "unknown">,
): number | null {
  if (salary.min === null) {
    return null;
  }

  if (salary.period === targetPeriod) {
    return salary.min;
  }

  const annualMinimum = salary.estimatedAnnualMin;
  if (annualMinimum === null) {
    return null;
  }

  if (targetPeriod === "year") {
    return annualMinimum;
  }
  if (targetPeriod === "month") {
    return annualMinimum / DEFAULT_MONTHS_PER_YEAR;
  }
  return annualMinimum / WORKING_DAYS_PER_YEAR;
}

function evaluateSalary(
  salary: ParsedCnSalary,
  preferences: ScreeningPreferences,
): RuleResult {
  const minimum = preferences.salary?.minimum;
  if (minimum === undefined) {
    return ruleResult("salary.minimum", "pass", "未设置薪资下限", [salary.raw]);
  }

  if (!Number.isFinite(minimum) || minimum < 0) {
    return ruleResult(
      "salary.minimum",
      "unknown",
      "薪资下限配置无效，无法判断",
      [String(minimum)],
    );
  }

  const targetPeriod = preferences.salary?.period ?? "month";
  const actualMinimum = salaryMinimumForPeriod(salary, targetPeriod);
  if (actualMinimum === null) {
    return ruleResult("salary.minimum", "unknown", "职位薪资下限无法确定", [
      salary.raw,
    ]);
  }

  const evidence = [
    salary.raw,
    `职位下限:${actualMinimum}`,
    `要求下限:${minimum}`,
    `周期:${targetPeriod}`,
  ];
  if (actualMinimum < minimum) {
    return ruleResult("salary.minimum", "block", "职位薪资下限低于要求", evidence);
  }

  return ruleResult("salary.minimum", "pass", "职位薪资下限达到要求", evidence);
}

function evaluateCompany(
  job: ScreenableJob,
  preferences: ScreeningPreferences,
): RuleResult {
  const blocked = normalizedEntries(preferences.company?.blocklist);
  if (blocked.length === 0) {
    return ruleResult("company.blocklist", "pass", "公司黑名单为空");
  }

  const companyKey = normalizeUnicodeKey(job.companyName);
  if (companyKey.length === 0) {
    return ruleResult("company.blocklist", "unknown", "公司名称为空，无法判断");
  }

  const matched = blocked.filter(
    (entry) => companyKey.includes(entry.key) || entry.key.includes(companyKey),
  );
  if (matched.length > 0) {
    return ruleResult("company.blocklist", "block", "公司命中黑名单", [
      job.companyName,
      ...matched.map((entry) => entry.raw),
    ]);
  }

  return ruleResult("company.blocklist", "pass", "公司未命中黑名单", [
    job.companyName,
  ]);
}

function screeningText(job: ScreenableJob): string {
  return `${job.title}\n${job.description}`;
}

function evaluateKeywordBlocklist(
  job: ScreenableJob,
  preferences: ScreeningPreferences,
): RuleResult {
  const configured = normalizedEntries(preferences.keyword?.blocklist);
  if (configured.length === 0) {
    return ruleResult("keyword.blocklist", "pass", "阻断词列表为空");
  }

  const matched = findContainedEntries(screeningText(job), configured.map(({ raw }) => raw));
  if (matched.length > 0) {
    return ruleResult("keyword.blocklist", "block", "职位文本命中阻断词", matched);
  }

  if (normalizeUnicodeKey(job.description).length === 0) {
    return ruleResult(
      "keyword.blocklist",
      "unknown",
      "JD 为空，无法完整检查阻断词",
      [job.title],
    );
  }

  return ruleResult("keyword.blocklist", "pass", "职位文本未命中阻断词");
}

function evaluateKeywordWarning(
  job: ScreenableJob,
  preferences: ScreeningPreferences,
): RuleResult {
  const configured = normalizedEntries(preferences.keyword?.warning);
  if (configured.length === 0) {
    return ruleResult("keyword.warning", "pass", "警告词列表为空");
  }

  const matched = findContainedEntries(screeningText(job), configured.map(({ raw }) => raw));
  if (matched.length > 0) {
    return ruleResult("keyword.warning", "warning", "职位文本命中警告词", matched);
  }

  if (normalizeUnicodeKey(job.description).length === 0) {
    return ruleResult(
      "keyword.warning",
      "unknown",
      "JD 为空，无法完整检查警告词",
      [job.title],
    );
  }

  return ruleResult("keyword.warning", "pass", "职位文本未命中警告词");
}

function normalizedDescriptionLength(description: string): number {
  const normalized = description
    .normalize("NFKC")
    .trim()
    .replace(/\p{White_Space}+/gu, " ");
  return Array.from(normalized).length;
}

function minimumJdLength(preferences: ScreeningPreferences): number {
  const configured = preferences.jd?.minimumLength;
  return configured !== undefined && Number.isInteger(configured) && configured >= 1
    ? configured
    : DEFAULT_MINIMUM_JD_LENGTH;
}

function evaluateRequiredSkills(
  job: ScreenableJob,
  preferences: ScreeningPreferences,
): RuleResult {
  const required = normalizedEntries(preferences.skill?.requiredAny);
  if (required.length === 0) {
    return ruleResult("skill.required_any", "pass", "未设置必备技能");
  }

  const matched = findContainedEntries(screeningText(job), required.map(({ raw }) => raw));
  if (matched.length > 0) {
    return ruleResult("skill.required_any", "pass", "职位至少命中一项必备技能", matched);
  }

  const descriptionLength = normalizedDescriptionLength(job.description);
  if (descriptionLength < minimumJdLength(preferences)) {
    return ruleResult(
      "skill.required_any",
      "unknown",
      "JD 信息不足，无法确认必备技能",
      required.map(({ raw }) => raw),
    );
  }

  return ruleResult(
    "skill.required_any",
    "block",
    "职位未命中任何必备技能",
    required.map(({ raw }) => raw),
  );
}

function evaluateJdEmpty(job: ScreenableJob): RuleResult {
  if (normalizeUnicodeKey(job.description).length === 0) {
    return ruleResult("jd.empty", "warning", "JD 为空，需要人工复核");
  }

  return ruleResult("jd.empty", "pass", "JD 非空");
}

function evaluateJdTooShort(
  job: ScreenableJob,
  preferences: ScreeningPreferences,
): RuleResult {
  const actualLength = normalizedDescriptionLength(job.description);
  const requiredLength = minimumJdLength(preferences);
  const evidence = [`实际长度:${actualLength}`, `最小长度:${requiredLength}`];

  if (actualLength < requiredLength) {
    return ruleResult("jd.too_short", "warning", "JD 过短，需要人工复核", evidence);
  }

  return ruleResult("jd.too_short", "pass", "JD 长度充足", evidence);
}

function scoreNonBlockedRules(rules: readonly RuleResult[]): number {
  const earned = rules.reduce((score, rule) => {
    if (rule.decision === "pass") {
      return score + 1;
    }
    if (rule.decision === "warning") {
      return score + 0.5;
    }
    return score;
  }, 0);

  return Math.round((earned / rules.length) * 100);
}

export function screenJob(
  job: ScreenableJob,
  preferences: ScreeningPreferences,
): JobScreeningResult {
  const salary = parseCnSalary(job.salaryText);
  const rules: readonly RuleResult[] = [
    evaluateLocation(job, preferences),
    evaluateSalary(salary, preferences),
    evaluateCompany(job, preferences),
    evaluateKeywordBlocklist(job, preferences),
    evaluateKeywordWarning(job, preferences),
    evaluateRequiredSkills(job, preferences),
    evaluateJdEmpty(job),
    evaluateJdTooShort(job, preferences),
  ];

  if (rules.some((rule) => rule.decision === "block")) {
    return { decision: "block", score: null, salary, rules };
  }

  const decision = rules.some(
    (rule) => rule.decision === "warning" || rule.decision === "unknown",
  )
    ? "review"
    : "pass";

  return {
    decision,
    score: scoreNonBlockedRules(rules),
    salary,
    rules,
  };
}
