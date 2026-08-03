import {
  EvaluationResultSchema,
  JobDetailSchema,
  type EvaluationResult,
  type JobDetail,
} from "@career-ops-cn/shared";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const ERROR_EXCERPT_LENGTH = 500;
const MAX_DIAGNOSTIC_LENGTH = 16 * 1024;
const GATEWAY_RETRY_DELAYS_MS = [250, 1_000] as const;
const SUMMARY_START = "---SCORE_SUMMARY---";
const SUMMARY_END = "---END_SUMMARY---";

const SYSTEM_PROMPT = `You are career-ops, an AI-powered job evaluator.

Evaluate only the evidence in the supplied BOSS JobDetail. There is no candidate
resume or external company research in this request. Never invent candidate
experience, company facts, benefits, salary details, or posting signals that are
not present in the input. Clearly label uncertainty and missing information.

Write all human-facing output in Simplified Chinese. Produce these sections:

A) Role Summary
- Company, role, location, compensation, seniority, education, and core duties.
- State which details are explicit and which are missing.

B) Requirements and Transferability
- Separate must-have skills, preferred skills, and responsibilities.
- Assess how specific, coherent, and realistically transferable the requirements are.
- Do not claim a personal CV match.

C) Level and Career Value
- Assess seniority consistency, ownership, growth potential, and likely trade-offs.

D) Compensation and Working Conditions
- Interpret only compensation and working-condition evidence in the JobDetail.
- Do not invent market benchmarks; list questions for missing terms.

E) Application Focus
- Give concise points the user could verify or emphasize before applying.
- Do not generate or rewrite a resume, cover letter, or application message.

F) Interview Plan
- Give focused verification questions about scope, team, expectations, and risks.

G) Posting Legitimacy
- Judge only the supplied text and identityVerified flag.
- Check specificity, internal consistency, unrealistic claims, discriminatory or
  coercive language, suspicious contact/payment requests, and missing essentials.
- Use exactly one label: High Confidence, Proceed with Caution, or Suspicious.

Scoring rules:
- Score the opportunity from 0.0 to 5.0 using role clarity, requirement coherence,
  compensation transparency, career value, and legitimacy.
- Missing evidence lowers confidence; serious fraud or safety signals lower the score.
- Use one decimal place and explain the main reasons. Do not manufacture precision.

At the very end, output exactly one machine-readable block with ASCII colons:

---SCORE_SUMMARY---
COMPANY: <company name from the input>
ROLE: <role title from the input>
SCORE: <decimal from 0.0 to 5.0>
ARCHETYPE: <Builder | Operator | Specialist | Leader | Generalist | Unknown>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---`;

const AbortSignalSchema = z.custom<AbortSignal>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    "addEventListener" in value &&
    "removeEventListener" in value,
  "必须是 AbortSignal",
);

const EvaluateWithCareerOpsOptionsSchema = z.strictObject({
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

const ChatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string(),
        }),
      }),
    )
    .min(1),
});

export type CareerOpsAdapterErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CONFIGURATION"
  | "AUTHENTICATION_ERROR"
  | "UPSTREAM_UNAVAILABLE"
  | "API_ERROR"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "TIMEOUT"
  | "CANCELLED"
  | "INVALID_MODEL_OUTPUT"
  | "SUMMARY_MISSING"
  | "SCORE_MISSING"
  | "SCORE_INVALID"
  | "SCORE_OUT_OF_RANGE";

export type CareerOpsRecommendation = "apply" | "review" | "skip";

export interface EvaluateWithCareerOpsOptions {
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
  httpStatus?: number | null;
  attempts?: number;
  diagnostic?: string | null;
}

interface CompatibleApiConfig {
  endpoint: string;
  endpointHost: string;
  model: string;
  apiKey: string;
}

export class CareerOpsAdapterError extends Error {
  readonly code: CareerOpsAdapterErrorCode;
  readonly httpStatus: number | null;
  readonly attempts: number;
  readonly diagnostic: string | null;

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
    this.httpStatus = options.httpStatus ?? null;
    this.attempts = options.attempts ?? 1;
    this.diagnostic = options.diagnostic ?? null;
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
    .replace(/((?:DEEPSEEK|OPENAI)_API_KEY\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(Authorization\s*:\s*Bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/(api[_ -]?key\s*(?:is|=|:)\s*)\S+/gi, "$1[REDACTED]");
}

function diagnosticText(value: string): string {
  return redactSensitiveText(stripAnsi(value))
    .trim()
    .slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function errorExcerpt(value: string): string {
  return diagnosticText(value).slice(0, ERROR_EXCERPT_LENGTH);
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

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function readCompatibleApiConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CompatibleApiConfig {
  const deepSeekApiKey = environment.DEEPSEEK_API_KEY?.trim() ?? "";
  const useDeepSeek = deepSeekApiKey.length > 0;
  const baseUrlVariable = useDeepSeek
    ? "DEEPSEEK_BASE_URL"
    : "OPENAI_BASE_URL";
  const apiKeyVariable = useDeepSeek
    ? "DEEPSEEK_API_KEY"
    : "OPENAI_API_KEY";
  const baseUrl = (
    useDeepSeek
      ? environment.DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL
      : environment.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL
  ).replace(/\/+$/u, "");
  const model = useDeepSeek
    ? environment.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL
    : environment.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
  const apiKey = useDeepSeek
    ? deepSeekApiKey
    : environment.OPENAI_API_KEY?.trim() ?? "";

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch (cause) {
    throw new CareerOpsAdapterError(
      "INVALID_CONFIGURATION",
      `${baseUrlVariable} 不是有效 URL。`,
      { cause },
    );
  }

  const loopback = isLoopback(parsedUrl.hostname);
  if (parsedUrl.protocol !== "https:" && !(loopback && parsedUrl.protocol === "http:")) {
    throw new CareerOpsAdapterError(
      "INVALID_CONFIGURATION",
      `远程 ${baseUrlVariable} 必须使用 HTTPS；HTTP 只允许回环地址。`,
    );
  }
  if (!loopback && apiKey.length === 0) {
    throw new CareerOpsAdapterError(
      "AUTHENTICATION_ERROR",
      `缺少 ${parsedUrl.hostname} 所需的 ${apiKeyVariable}。`,
    );
  }

  return {
    endpoint: `${baseUrl}/chat/completions`,
    endpointHost: parsedUrl.hostname,
    model,
    apiKey,
  };
}

async function readResponseText(
  response: Response,
  maxOutputBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxOutputBytes) {
    throw new CareerOpsAdapterError(
      "OUTPUT_LIMIT_EXCEEDED",
      `OpenAI-compatible 响应超过 ${maxOutputBytes} 字节限制。`,
      { httpStatus: response.status },
    );
  }

  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxOutputBytes) {
        await reader.cancel();
        throw new CareerOpsAdapterError(
          "OUTPUT_LIMIT_EXCEEDED",
          `OpenAI-compatible 响应超过 ${maxOutputBytes} 字节限制。`,
          { httpStatus: response.status },
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8",
  );
}

async function requestEvaluation(
  input: JobDetail,
  config: CompatibleApiConfig,
  options: z.infer<typeof EvaluateWithCareerOpsOptionsSchema>,
): Promise<string> {
  if (isAborted(options.signal)) {
    throw new CareerOpsAdapterError("CANCELLED", "career-ops 评估已取消。");
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  timeout.unref();

  const cancel = (): void => {
    controller.abort(options.signal?.reason);
  };
  options.signal?.addEventListener("abort", cancel, { once: true });

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.apiKey.length > 0) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(config.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `JOB DESCRIPTION TO EVALUATE:\n\n${JSON.stringify(input, null, 2)}`,
          },
        ],
        stream: false,
        temperature: 0.4,
      }),
      signal: controller.signal,
    });
    const responseText = await readResponseText(
      response,
      options.maxOutputBytes,
    );

    if (response.status === 401 || response.status === 403) {
      throw new CareerOpsAdapterError(
        "AUTHENTICATION_ERROR",
        `OpenAI-compatible API 认证失败（HTTP ${response.status}）。`,
        { httpStatus: response.status },
      );
    }
    if (
      response.status === 502 ||
      response.status === 503 ||
      response.status === 504
    ) {
      throw new CareerOpsAdapterError(
        "UPSTREAM_UNAVAILABLE",
        `OpenAI-compatible provider 返回 HTTP ${response.status}。`,
        {
          httpStatus: response.status,
          diagnostic: diagnosticText(responseText),
        },
      );
    }
    if (!response.ok) {
      const excerpt = errorExcerpt(responseText);
      const suffix = excerpt.length === 0 ? "" : `：${excerpt}`;
      throw new CareerOpsAdapterError(
        "API_ERROR",
        `OpenAI-compatible API 返回 HTTP ${response.status}${suffix}`,
        {
          httpStatus: response.status,
          diagnostic: diagnosticText(responseText),
        },
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(responseText);
    } catch (cause) {
      throw new CareerOpsAdapterError(
        "INVALID_MODEL_OUTPUT",
        "OpenAI-compatible API 返回了无效 JSON。",
        { cause },
      );
    }

    const completion = ChatCompletionSchema.safeParse(decoded);
    if (!completion.success) {
      throw new CareerOpsAdapterError(
        "INVALID_MODEL_OUTPUT",
        "OpenAI-compatible API 响应缺少文本结果。",
        { cause: completion.error },
      );
    }
    const content = completion.data.choices[0]?.message.content.trim() ?? "";
    if (content.length === 0) {
      throw new CareerOpsAdapterError(
        "INVALID_MODEL_OUTPUT",
        "OpenAI-compatible API 返回了空评估。",
      );
    }
    return content;
  } catch (error) {
    if (error instanceof CareerOpsAdapterError) {
      throw error;
    }
    if (timedOut) {
      throw new CareerOpsAdapterError(
        "TIMEOUT",
        `career-ops 评估超过 ${options.timeoutMs} 毫秒。`,
        { cause: error },
      );
    }
    if (isAborted(options.signal)) {
      throw new CareerOpsAdapterError(
        "CANCELLED",
        "career-ops 评估已取消。",
        { cause: error },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new CareerOpsAdapterError(
      "API_ERROR",
      `OpenAI-compatible API 调用失败：${errorExcerpt(message)}`,
      { cause: error, diagnostic: diagnosticText(message) },
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
  }
}

async function waitForRetry(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (isAborted(signal)) {
    throw new CareerOpsAdapterError("CANCELLED", "career-ops 评估已取消。");
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      rejectPromise(
        new CareerOpsAdapterError("CANCELLED", "career-ops 评估已取消。"),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function parseCareerOpsOutput(output: string): ParsedCareerOpsOutput {
  const strippedOutput = stripAnsi(output);
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
  options: EvaluateWithCareerOpsOptions = {},
): Promise<CareerOpsEvaluationResult> {
  const parsedInput = JobDetailSchema.safeParse(input);
  if (!parsedInput.success) {
    throw asInvalidInputError("JobDetail 输入无效。", parsedInput.error);
  }

  const parsedOptions = EvaluateWithCareerOpsOptionsSchema.safeParse(options);
  if (!parsedOptions.success) {
    throw asInvalidInputError("career-ops 适配器参数无效。", parsedOptions.error);
  }

  const config = readCompatibleApiConfig();
  const gatewayDiagnostics: string[] = [];
  let evaluationText: string | undefined;
  for (
    let attempt = 1;
    attempt <= GATEWAY_RETRY_DELAYS_MS.length + 1;
    attempt += 1
  ) {
    try {
      evaluationText = await requestEvaluation(
        parsedInput.data,
        config,
        parsedOptions.data,
      );
      break;
    } catch (error) {
      if (
        !(error instanceof CareerOpsAdapterError) ||
        error.code !== "UPSTREAM_UNAVAILABLE"
      ) {
        throw error;
      }
      gatewayDiagnostics.push(
        `attempt ${attempt}: ${error.diagnostic ?? error.message}`,
      );
      const retryDelay = GATEWAY_RETRY_DELAYS_MS[attempt - 1];
      if (retryDelay === undefined) {
        throw new CareerOpsAdapterError(
          "UPSTREAM_UNAVAILABLE",
          `OpenAI-compatible provider HTTP ${error.httpStatus ?? "unknown"}，${attempt} 次尝试均失败。`,
          {
            cause: error,
            httpStatus: error.httpStatus,
            attempts: attempt,
            diagnostic: gatewayDiagnostics
              .join("\n\n")
              .slice(0, MAX_DIAGNOSTIC_LENGTH),
          },
        );
      }
      await waitForRetry(retryDelay, parsedOptions.data.signal);
    }
  }

  if (evaluationText === undefined) {
    throw new CareerOpsAdapterError(
      "UPSTREAM_UNAVAILABLE",
      "OpenAI-compatible provider 重试未返回结果。",
      { attempts: GATEWAY_RETRY_DELAYS_MS.length + 1 },
    );
  }

  const parsedOutput = parseCareerOpsOutput(evaluationText);
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
}
