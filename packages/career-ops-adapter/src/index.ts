import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  EvaluationResultSchema,
  JobDetailSchema,
  type EvaluationResult,
  type JobDetail,
} from "@career-ops-cn/shared";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 250;
const SUMMARY_START = "---SCORE_SUMMARY---";
const SUMMARY_END = "---END_SUMMARY---";
const ERROR_EXCERPT_LENGTH = 500;

const AbortSignalSchema = z.custom<AbortSignal>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    "addEventListener" in value &&
    "removeEventListener" in value,
  "必须是 AbortSignal",
);

const RunProcessOptionsSchema = z.strictObject({
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().trim().min(1).optional(),
  timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
  signal: AbortSignalSchema.optional(),
  maxOutputBytes: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_MAX_OUTPUT_BYTES),
});

const EvaluateWithCareerOpsOptionsSchema = z.strictObject({
  careerOpsRoot: z.string().trim().min(1),
  timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
  signal: AbortSignalSchema.optional(),
  maxOutputBytes: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_MAX_OUTPUT_BYTES),
});

const ParsedCareerOpsOutputSchema = z.strictObject({
  company: z.string().trim().min(1).nullable(),
  role: z.string().trim().min(1).nullable(),
  score: z.number().min(0).max(5),
  archetype: z.string().trim().min(1).nullable(),
  legitimacy: z.string().trim().min(1).nullable(),
  recommendation: z.enum(["apply", "review", "skip"]),
  rawReport: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, "rawReport 不能为空"),
});

export type CareerOpsAdapterErrorCode =
  | "INVALID_INPUT"
  | "SCRIPT_NOT_FOUND"
  | "PROCESS_START_FAILED"
  | "AUTHENTICATION_ERROR"
  | "NON_ZERO_EXIT"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "TIMEOUT"
  | "CANCELLED"
  | "SUMMARY_MISSING"
  | "SCORE_MISSING"
  | "SCORE_INVALID"
  | "SCORE_OUT_OF_RANGE";

export type CareerOpsRecommendation = "apply" | "review" | "skip";

export interface RunProcessOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

export interface RunProcessResult {
  stdout: string;
  stderr: string;
  exitCode: 0;
  signal: null;
}

export interface EvaluateWithCareerOpsOptions {
  careerOpsRoot: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

export interface ParsedCareerOpsOutput {
  company: string | null;
  role: string | null;
  score: number;
  archetype: string | null;
  legitimacy: string | null;
  recommendation: CareerOpsRecommendation;
  rawReport: string;
}

export interface CareerOpsEvaluationResult extends EvaluationResult {
  company: string | null;
  role: string | null;
  archetype: string | null;
  legitimacy: string | null;
  recommendation: CareerOpsRecommendation;
}

interface CareerOpsAdapterErrorOptions {
  cause?: unknown;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stream?: "stdout" | "stderr" | null;
}

export class CareerOpsAdapterError extends Error {
  readonly code: CareerOpsAdapterErrorCode;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stream: "stdout" | "stderr" | null;

  constructor(
    code: CareerOpsAdapterErrorCode,
    message: string,
    options: CareerOpsAdapterErrorOptions = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "CareerOpsAdapterError";
    this.code = code;
    this.exitCode = options.exitCode ?? null;
    this.signal = options.signal ?? null;
    this.stream = options.stream ?? null;
  }
}

function asInvalidInputError(
  message: string,
  cause: unknown,
): CareerOpsAdapterError {
  return new CareerOpsAdapterError("INVALID_INPUT", message, { cause });
}

function stripAnsi(value: string): string {
  return value.replace(
    /[\u001B\u009B](?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g,
    "",
  );
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/(OPENAI_API_KEY\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(Authorization\s*:\s*Bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/(api[_ -]?key\s*(?:is|=|:)\s*)\S+/gi, "$1[REDACTED]");
}

function errorExcerpt(stderr: string): string {
  return redactSensitiveText(stripAnsi(stderr))
    .trim()
    .slice(0, ERROR_EXCERPT_LENGTH);
}

function isAuthenticationError(stderr: string): boolean {
  return /(?:\b401\b|authentication|unauthorized|incorrect api key|invalid api key)/i.test(
    stripAnsi(stderr),
  );
}

function recommendationForScore(score: number): CareerOpsRecommendation {
  if (score >= 4) {
    return "apply";
  }
  if (score >= 3.2) {
    return "review";
  }
  return "skip";
}

export function runProcess(options: RunProcessOptions): Promise<RunProcessResult> {
  const parsedOptions = RunProcessOptionsSchema.safeParse(options);
  if (!parsedOptions.success) {
    return Promise.reject(
      asInvalidInputError("子进程参数无效。", parsedOptions.error),
    );
  }

  const {
    command,
    args,
    cwd,
    timeoutMs,
    signal: abortSignal,
    maxOutputBytes,
  } = parsedOptions.data;

  if (abortSignal?.aborted === true) {
    return Promise.reject(
      new CareerOpsAdapterError("CANCELLED", "career-ops 执行已取消。"),
    );
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalError: CareerOpsAdapterError | undefined;
    let terminationTimer: NodeJS.Timeout | undefined;

    const terminate = (error: CareerOpsAdapterError): void => {
      if (terminalError !== undefined) {
        return;
      }
      terminalError = error;

      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      child.kill("SIGTERM");
      terminationTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, TERMINATION_GRACE_MS);
      terminationTimer.unref();
    };

    const handleChunk = (
      stream: "stdout" | "stderr",
      chunk: Buffer,
    ): void => {
      if (terminalError !== undefined) {
        return;
      }

      if (stream === "stdout") {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > maxOutputBytes) {
          terminate(
            new CareerOpsAdapterError(
              "OUTPUT_LIMIT_EXCEEDED",
              `career-ops stdout 超过 ${maxOutputBytes} 字节限制。`,
              { stream },
            ),
          );
          return;
        }
        stdoutChunks.push(chunk);
        return;
      }

      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxOutputBytes) {
        terminate(
          new CareerOpsAdapterError(
            "OUTPUT_LIMIT_EXCEEDED",
            `career-ops stderr 超过 ${maxOutputBytes} 字节限制。`,
            { stream },
          ),
        );
        return;
      }
      stderrChunks.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      handleChunk("stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      handleChunk("stderr", chunk);
    });

    const timeoutTimer = setTimeout(() => {
      terminate(
        new CareerOpsAdapterError(
          "TIMEOUT",
          `career-ops 执行超过 ${timeoutMs} 毫秒。`,
        ),
      );
    }, timeoutMs);
    timeoutTimer.unref();

    const abortListener = (): void => {
      terminate(
        new CareerOpsAdapterError("CANCELLED", "career-ops 执行已取消。"),
      );
    };
    abortSignal?.addEventListener("abort", abortListener, { once: true });

    child.once("error", (cause) => {
      if (terminalError === undefined) {
        terminalError = new CareerOpsAdapterError(
          "PROCESS_START_FAILED",
          "无法启动 career-ops 子进程。",
          { cause },
        );
      }
    });

    child.once("close", (exitCode, exitSignal) => {
      clearTimeout(timeoutTimer);
      if (terminationTimer !== undefined) {
        clearTimeout(terminationTimer);
      }
      abortSignal?.removeEventListener("abort", abortListener);

      if (terminalError !== undefined) {
        rejectPromise(terminalError);
        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      if (exitCode !== 0) {
        if (isAuthenticationError(stderr)) {
          rejectPromise(
            new CareerOpsAdapterError(
              "AUTHENTICATION_ERROR",
              "career-ops API 认证失败。",
              { exitCode, signal: exitSignal },
            ),
          );
          return;
        }

        const excerpt = errorExcerpt(stderr);
        const suffix = excerpt.length === 0 ? "" : `：${excerpt}`;
        rejectPromise(
          new CareerOpsAdapterError(
            "NON_ZERO_EXIT",
            `career-ops 以非零状态 ${exitCode ?? "unknown"} 退出${suffix}`,
            { exitCode, signal: exitSignal },
          ),
        );
        return;
      }

      resolvePromise({ stdout, stderr, exitCode: 0, signal: null });
    });
  });
}

export function parseCareerOpsOutput(stdout: string): ParsedCareerOpsOutput {
  const strippedOutput = stripAnsi(stdout);
  const summaryStart = strippedOutput.indexOf(SUMMARY_START);
  if (summaryStart === -1) {
    throw new CareerOpsAdapterError(
      "SUMMARY_MISSING",
      "career-ops 输出缺少 SCORE_SUMMARY 区块。",
    );
  }

  const contentStart = summaryStart + SUMMARY_START.length;
  const summaryEnd = strippedOutput.indexOf(SUMMARY_END, contentStart);
  if (summaryEnd === -1) {
    throw new CareerOpsAdapterError(
      "SUMMARY_MISSING",
      "career-ops 输出缺少完整的 SCORE_SUMMARY 区块。",
    );
  }

  const fields = new Map<string, string>();
  const summaryBody = strippedOutput.slice(contentStart, summaryEnd);
  for (const line of summaryBody.split(/\r?\n/)) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }
    const key = line.slice(0, colonIndex).trim().toUpperCase();
    const value = line.slice(colonIndex + 1).trim();
    fields.set(key, value);
  }

  const scoreText = fields.get("SCORE");
  if (scoreText === undefined || scoreText.length === 0) {
    throw new CareerOpsAdapterError(
      "SCORE_MISSING",
      "career-ops summary 缺少 SCORE。",
    );
  }

  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(scoreText)) {
    throw new CareerOpsAdapterError(
      "SCORE_INVALID",
      "career-ops SCORE 无法解析为数字。",
    );
  }

  const score = Number(scoreText);
  if (!Number.isFinite(score)) {
    throw new CareerOpsAdapterError(
      "SCORE_INVALID",
      "career-ops SCORE 无法解析为有限数字。",
    );
  }
  if (score < 0 || score > 5) {
    throw new CareerOpsAdapterError(
      "SCORE_OUT_OF_RANGE",
      "career-ops SCORE 必须在 0 到 5 之间。",
    );
  }

  const nullableField = (name: string): string | null => {
    const value = fields.get(name)?.trim();
    return value === undefined || value.length === 0 ? null : value;
  };

  const parsed = ParsedCareerOpsOutputSchema.safeParse({
    company: nullableField("COMPANY"),
    role: nullableField("ROLE"),
    score,
    archetype: nullableField("ARCHETYPE"),
    legitimacy: nullableField("LEGITIMACY"),
    recommendation: recommendationForScore(score),
    rawReport: strippedOutput,
  });
  if (!parsed.success) {
    throw asInvalidInputError("career-ops 输出未通过边界校验。", parsed.error);
  }
  return parsed.data;
}

export async function evaluateWithCareerOps(
  input: JobDetail,
  options: EvaluateWithCareerOpsOptions,
): Promise<CareerOpsEvaluationResult> {
  const parsedInput = JobDetailSchema.safeParse(input);
  if (!parsedInput.success) {
    throw asInvalidInputError("JobDetail 输入无效。", parsedInput.error);
  }

  const parsedOptions = EvaluateWithCareerOpsOptionsSchema.safeParse(options);
  if (!parsedOptions.success) {
    throw asInvalidInputError("career-ops 适配器参数无效。", parsedOptions.error);
  }

  const careerOpsRoot = resolve(parsedOptions.data.careerOpsRoot);
  const scriptPath = join(careerOpsRoot, "openai-eval.mjs");
  try {
    const scriptStats = await stat(scriptPath);
    if (!scriptStats.isFile()) {
      throw new Error("不是文件");
    }
  } catch (cause) {
    throw new CareerOpsAdapterError(
      "SCRIPT_NOT_FOUND",
      `未找到 career-ops evaluator：${scriptPath}`,
      { cause },
    );
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "career-ops-cn-"));
  const jobDetailPath = join(temporaryDirectory, "job-detail.json");

  try {
    await writeFile(
      jobDetailPath,
      `${JSON.stringify(parsedInput.data, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const result = await runProcess({
      command: process.execPath,
      args: [scriptPath, "--file", jobDetailPath, "--no-save"],
      cwd: careerOpsRoot,
      timeoutMs: parsedOptions.data.timeoutMs,
      maxOutputBytes: parsedOptions.data.maxOutputBytes,
      ...(parsedOptions.data.signal === undefined
        ? {}
        : { signal: parsedOptions.data.signal }),
    });
    const parsedOutput = parseCareerOpsOutput(result.stdout);
    const evaluation = EvaluationResultSchema.parse({
      score: Math.round(parsedOutput.score * 20),
      recommendation: parsedOutput.recommendation,
      rawReport: parsedOutput.rawReport,
      company: parsedOutput.company,
      role: parsedOutput.role,
      archetype: parsedOutput.archetype,
      legitimacy: parsedOutput.legitimacy,
    });

    return {
      ...evaluation,
      company: evaluation.company ?? null,
      role: evaluation.role ?? null,
      archetype: evaluation.archetype ?? null,
      legitimacy: evaluation.legitimacy ?? null,
      recommendation: parsedOutput.recommendation,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
