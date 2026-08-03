import { readFile } from "node:fs/promises";

import { JobDetailSchema, type JobDetail } from "@career-ops-cn/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CareerOpsAdapterError,
  evaluateWithCareerOps,
  parseCareerOpsOutput,
} from "../src/index.js";

const fixtureDirectory = new URL(
  "../../../fixtures/career-ops-output/",
  import.meta.url,
);

const readOutputFixture = (filename: string): Promise<string> =>
  readFile(new URL(filename, fixtureDirectory), "utf8");

function jobDetail(jobId: string): JobDetail {
  return JobDetailSchema.parse({
    jobId,
    title: "高级前端工程师",
    companyName: "星河科技",
    salaryText: "30-40K·14薪",
    location: "上海·浦东新区",
    experienceText: "5-10年",
    educationText: "本科",
    detailUrl: `https://www.zhipin.com/job_detail/${jobId}.html`,
    description: "负责 TypeScript 和 React 产品工程。",
    identityVerified: true,
  });
}

function useRemoteOpenAIEnvironment(): void {
  vi.stubEnv("OPENAI_API_KEY", "sk-SYNTHETIC_TEST_KEY_NOT_VALID_000000");
  vi.stubEnv("OPENAI_BASE_URL", "https://api.example.test/v1");
  vi.stubEnv("OPENAI_MODEL", "example-model");
}

function completionResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      choices: [{ message: { role: "assistant", content } }],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

async function expectAdapterError(
  promise: Promise<unknown>,
  code: CareerOpsAdapterError["code"],
): Promise<CareerOpsAdapterError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CareerOpsAdapterError);
    expect(error).toMatchObject({ code });
    return error as CareerOpsAdapterError;
  }
  throw new Error(`预期 ${code} 错误，但 Promise 成功完成。`);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("parseCareerOpsOutput", () => {
  it("解析中文输出并保留完整 rawReport", async () => {
    const output = await readOutputFixture("normal-zh.txt");
    expect(parseCareerOpsOutput(output)).toEqual({
      company: "星河科技",
      role: "高级前端工程师",
      score: 4.2,
      archetype: "Builder",
      legitimacy: "high",
      recommendation: "apply",
      rawReport: output,
    });
  });

  it("解析英文输出", async () => {
    const output = await readOutputFixture("normal-en.txt");
    expect(parseCareerOpsOutput(output)).toMatchObject({
      company: "Northstar Labs",
      role: "Product Engineer",
      score: 3.6,
      recommendation: "review",
    });
  });

  it("移除 ANSI 控制符", async () => {
    const fixture = JSON.parse(
      await readOutputFixture("ansi.json"),
    ) as { stdout: string };
    const result = parseCareerOpsOutput(fixture.stdout);
    expect(result).toMatchObject({
      company: "彩虹科技",
      score: 4,
      recommendation: "apply",
    });
    expect(result.rawReport).not.toContain("\u001b");
  });

  it("summary 缺失时失败", async () => {
    const output = await readOutputFixture("summary-missing.txt");
    expect(() => parseCareerOpsOutput(output)).toThrowError(
      expect.objectContaining({ code: "SUMMARY_MISSING" }),
    );
  });

  it("score 损坏时失败", async () => {
    const output = await readOutputFixture("score-corrupt.txt");
    expect(() => parseCareerOpsOutput(output)).toThrowError(
      expect.objectContaining({ code: "SCORE_INVALID" }),
    );
  });

  it("score 越界时失败", async () => {
    const output = await readOutputFixture("score-out-of-range.txt");
    expect(() => parseCareerOpsOutput(output)).toThrowError(
      expect.objectContaining({ code: "SCORE_OUT_OF_RANGE" }),
    );
  });

  it("可选字段缺失时返回 null，score 仍为必需字段", () => {
    const minimal = `${"---SCORE_SUMMARY---"}\nSCORE: 3.2\n---END_SUMMARY---\n`;
    expect(parseCareerOpsOutput(minimal)).toMatchObject({
      company: null,
      role: null,
      score: 3.2,
      archetype: null,
      legitimacy: null,
      recommendation: "review",
    });

    expect(() =>
      parseCareerOpsOutput(
        "---SCORE_SUMMARY---\nCOMPANY: Example\n---END_SUMMARY---\n",
      ),
    ).toThrowError(expect.objectContaining({ code: "SCORE_MISSING" }));
  });

  it("按阈值生成 recommendation", () => {
    const report = (score: number): string =>
      `---SCORE_SUMMARY---\nSCORE: ${score}\n---END_SUMMARY---\n`;
    expect(parseCareerOpsOutput(report(4)).recommendation).toBe("apply");
    expect(parseCareerOpsOutput(report(3.2)).recommendation).toBe("review");
    expect(parseCareerOpsOutput(report(3.19)).recommendation).toBe("skip");
  });
});

describe("evaluateWithCareerOps", () => {
  it("直接调用 OpenAI-compatible API 并保持现有评估字段", async () => {
    useRemoteOpenAIEnvironment();
    const output = (await readOutputFixture("normal-zh.txt")).trim();
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(completionResponse(output));
    vi.stubGlobal("fetch", fetchMock);

    const input = jobDetail("normal-zh");
    const result = await evaluateWithCareerOps(input, { timeoutMs: 5_000 });

    expect(result).toEqual({
      score: 84,
      recommendation: "apply",
      rawReport: output,
      company: "星河科技",
      role: "高级前端工程师",
      archetype: "Builder",
      legitimacy: "high",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.example.test/v1/chat/completions");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(
      "Bearer sk-SYNTHETIC_TEST_KEY_NOT_VALID_000000",
    );
    const request = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      stream: boolean;
      temperature: number;
    };
    expect(request.model).toBe("example-model");
    expect(request.stream).toBe(false);
    expect(request.temperature).toBe(0.4);
    expect(request.messages[0]?.content).toContain("A) Role Summary");
    expect(request.messages[0]?.content).toContain(
      "Do not generate or rewrite a resume",
    );
    expect(request.messages[1]?.content).toContain(
      JSON.stringify(input, null, 2),
    );
  });

  it("回环 HTTP endpoint 不要求 API Key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_BASE_URL", "http://127.0.0.1:45678/v1/");
    vi.stubEnv("OPENAI_MODEL", "local-model");
    const output = (await readOutputFixture("normal-en.txt")).trim();
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(completionResponse(output));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      evaluateWithCareerOps(jobDetail("local")),
    ).resolves.toMatchObject({ score: 72, recommendation: "review" });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  });

  it("远程 endpoint 缺少 API Key 时明确失败", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_BASE_URL", "https://api.example.test/v1");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expectAdapterError(
      evaluateWithCareerOps(jobDetail("missing-key")),
      "AUTHENTICATION_ERROR",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("API 认证错误不泄漏 API Key", async () => {
    useRemoteOpenAIEnvironment();
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(
      new Response(
        "incorrect api key sk-SYNTHETIC_TEST_KEY_NOT_VALID_000000",
        { status: 401 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await expectAdapterError(
      evaluateWithCareerOps(jobDetail("api-auth-error")),
      "AUTHENTICATION_ERROR",
    );
    expect(error.message).not.toContain(
      "sk-SYNTHETIC_TEST_KEY_NOT_VALID_000000",
    );
  });

  it("502/503/504 网关错误有限重试后可以恢复", async () => {
    vi.useFakeTimers();
    useRemoteOpenAIEnvironment();
    const output = (await readOutputFixture("normal-zh.txt")).trim();
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(completionResponse(output));
    vi.stubGlobal("fetch", fetchMock);

    const evaluation = evaluateWithCareerOps(jobDetail("gateway-retry"));
    await vi.runAllTimersAsync();

    await expect(evaluation).resolves.toMatchObject({ score: 84 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("网关持续失败时保留状态、次数和脱敏诊断", async () => {
    vi.useFakeTimers();
    useRemoteOpenAIEnvironment();
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(
      new Response(
        "upstream overloaded; api key: sk-SYNTHETIC_TEST_KEY_NOT_VALID_000000",
        { status: 503 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const evaluation = evaluateWithCareerOps(jobDetail("gateway-failure"));
    const rejection = expectAdapterError(evaluation, "UPSTREAM_UNAVAILABLE");
    await vi.runAllTimersAsync();
    const error = await rejection;

    expect(error).toMatchObject({ httpStatus: 503, attempts: 3 });
    expect(error.diagnostic).toContain("upstream overloaded");
    expect(error.diagnostic).not.toMatch(/\bsk-[A-Za-z0-9_-]+\b/u);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("超出响应大小限制时失败", async () => {
    useRemoteOpenAIEnvironment();
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(completionResponse("x".repeat(1_000)));
    vi.stubGlobal("fetch", fetchMock);

    const error = await expectAdapterError(
      evaluateWithCareerOps(jobDetail("over-limit"), {
        maxOutputBytes: 64,
      }),
      "OUTPUT_LIMIT_EXCEEDED",
    );
    expect(error.httpStatus).toBe(200);
  });

  it("timeout 会中止 HTTP 请求并返回 TIMEOUT", async () => {
    useRemoteOpenAIEnvironment();
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockImplementation(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expectAdapterError(
      evaluateWithCareerOps(jobDetail("timeout"), { timeoutMs: 10 }),
      "TIMEOUT",
    );
  });

  it("AbortSignal 会中止 HTTP 请求并返回 CANCELLED", async () => {
    useRemoteOpenAIEnvironment();
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockImplementation(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const evaluation = evaluateWithCareerOps(jobDetail("cancel"), {
      signal: controller.signal,
    });
    controller.abort();

    await expectAdapterError(evaluation, "CANCELLED");
  });

  it("无效 API JSON、空结果和缺少 summary 都会失败", async () => {
    useRemoteOpenAIEnvironment();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    await expectAdapterError(
      evaluateWithCareerOps(jobDetail("invalid-json")),
      "INVALID_MODEL_OUTPUT",
    );

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    await expectAdapterError(
      evaluateWithCareerOps(jobDetail("empty-choices")),
      "INVALID_MODEL_OUTPUT",
    );

    fetchMock.mockResolvedValueOnce(
      completionResponse("只有分析正文，没有机器摘要。"),
    );
    await expectAdapterError(
      evaluateWithCareerOps(jobDetail("missing-summary")),
      "SUMMARY_MISSING",
    );
  });
});
