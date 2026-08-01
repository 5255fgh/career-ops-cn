import type {
  EvaluationResult,
  JobCard,
  JobDetail,
  Preferences,
  ScreeningResult,
} from "@career-ops-cn/shared";

import { bridgeFailure } from "./errors.js";

export interface EvaluationOptions {
  careerOpsRoot: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export type EvaluationOutput = EvaluationResult;

export type Evaluator = (
  job: JobDetail,
  options: EvaluationOptions,
) => Promise<EvaluationOutput>;

export interface ScreenableJob {
  title: string;
  companyName: string;
  salaryText: string;
  location: string;
  description: string;
}

export interface ScreeningPreferences {
  location?: { allowed?: readonly string[] };
  salary?: {
    minimum?: number;
    period?: "month" | "day" | "year";
  };
  company?: { blocklist?: readonly string[] };
  keyword?: {
    blocklist?: readonly string[];
    warning?: readonly string[];
  };
  skill?: {
    requiredAny?: readonly string[];
  };
  jd?: { minimumLength?: number };
}

export interface ScreeningRuleResult {
  decision: "pass" | "block" | "warning" | "unknown";
  reason: string;
}

export interface JobScreeningResult {
  decision: "pass" | "review" | "block";
  rules: readonly ScreeningRuleResult[];
}

export type ScreenJob = (
  job: ScreenableJob,
  preferences: ScreeningPreferences,
) => JobScreeningResult | Promise<JobScreeningResult>;

interface ScreeningModule {
  screenJob?: unknown;
}

interface CareerOpsAdapterModule {
  evaluateWithCareerOps?: unknown;
}

export function toScreenableJob(job: JobCard | JobDetail): ScreenableJob {
  return {
    title: job.title,
    companyName: job.companyName,
    salaryText: job.salaryText,
    location: job.location,
    description: "description" in job ? job.description : "",
  };
}

export function toScreeningPreferences(
  preferences: Preferences,
): ScreeningPreferences {
  return {
    ...(preferences.location === undefined
      ? {}
      : {
          location: {
            ...(preferences.location.allowed === undefined
              ? {}
              : { allowed: preferences.location.allowed }),
          },
        }),
    ...(preferences.salary === undefined
      ? {}
      : {
          salary: {
            ...(preferences.salary.minimum === undefined
              ? {}
              : { minimum: preferences.salary.minimum }),
            ...(preferences.salary.period === undefined
              ? {}
              : { period: preferences.salary.period }),
          },
        }),
    ...(preferences.company === undefined
      ? {}
      : {
          company: {
            ...(preferences.company.blocklist === undefined
              ? {}
              : { blocklist: preferences.company.blocklist }),
          },
        }),
    ...(preferences.keyword === undefined
      ? {}
      : {
          keyword: {
            ...(preferences.keyword.blocklist === undefined
              ? {}
              : { blocklist: preferences.keyword.blocklist }),
            ...(preferences.keyword.warning === undefined
              ? {}
              : { warning: preferences.keyword.warning }),
          },
        }),
    ...(preferences.skill === undefined
      ? {}
      : {
          skill: {
            ...(preferences.skill.requiredAny === undefined
              ? {}
              : { requiredAny: preferences.skill.requiredAny }),
          },
        }),
    ...(preferences.jd === undefined
      ? {}
      : {
          jd: {
            ...(preferences.jd.minimumLength === undefined
              ? {}
              : { minimumLength: preferences.jd.minimumLength }),
          },
        }),
  };
}

export function toScreeningResult(
  jobId: string,
  result: JobScreeningResult,
): ScreeningResult {
  return {
    jobId,
    matched: result.decision !== "block",
    reasons: result.rules.map(({ reason }) => reason),
  };
}

export function createRealScreenJob(): ScreenJob {
  let implementation: Promise<ScreenJob> | undefined;

  return async (job, preferences) => {
    implementation ??= import("@career-ops-cn/screening").then(
      (loaded: ScreeningModule) => {
        if (typeof loaded.screenJob !== "function") {
          throw new Error("screening 包没有公开 screenJob。");
        }
        return loaded.screenJob as ScreenJob;
      },
    );
    return (await implementation)(job, preferences);
  };
}

export function createRealEvaluator(): Evaluator {
  let implementation: Promise<Evaluator> | undefined;

  return async (job, options) => {
    implementation ??= import("@career-ops-cn/career-ops-adapter").then(
      (loaded: CareerOpsAdapterModule) => {
        if (typeof loaded.evaluateWithCareerOps !== "function") {
          throw bridgeFailure(
            "CAREER_OPS_NOT_FOUND",
            "career-ops-adapter 没有公开 evaluateWithCareerOps。",
          );
        }

        return loaded.evaluateWithCareerOps as Evaluator;
      },
    );

    return (await implementation)(job, options);
  };
}
