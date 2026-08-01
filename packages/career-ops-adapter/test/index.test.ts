import { access, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JobDetailSchema, type JobDetail } from "@career-ops-cn/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
  CareerOpsAdapterError,
  evaluateWithCareerOps,
  parseCareerOpsOutput,
} from "../src/index.js";

const fixtureDirectory = new URL(
  "../../../fixtures/career-ops-output/",
  import.meta.url,
);
const fakeCliUrl = new URL("./fake-cli.mjs", import.meta.url);
const temporaryRoots: string[] = [];

const readOutputFixture = (filename: string): Promise<string> =>
  readFile(new URL(filename, fixtureDirectory), "utf8");

async function createFakeCareerOpsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "career-ops-fake-"));
  temporaryRoots.push(root);
  await cp(fakeCliUrl, join(root, "openai-eval.mjs"));
  await cp(fixtureDirectory, join(root, "fixtures"), { recursive: true });
  return root;
}

async function waitForFile(path: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  throw new Error(`等待文件超时：${path}`);
}

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

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("parseCareerOpsOutput", () => {
  it("解析中文输出并保留完整 rawReport", async () => {
    const stdout = await readOutputFixture("normal-zh.txt");
    expect(parseCareerOpsOutput(stdout)).toEqual({
      company: "星河科技",
      role: "高级前端工程师",
      score: 4.2,
      archetype: "Builder",
      legitimacy: "high",
      recommendation: "apply",
      rawReport: stdout,
    });
  });

  it("解析英文输出", async () => {
    const stdout = await readOutputFixture("normal-en.txt");
    expect(parseCareerOpsOutput(stdout)).toMatchObject({
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
    const stdout = await readOutputFixture("summary-missing.txt");
    expect(() => parseCareerOpsOutput(stdout)).toThrowError(
      expect.objectContaining({ code: "SUMMARY_MISSING" }),
    );
  });

  it("score 损坏时失败", async () => {
    const stdout = await readOutputFixture("score-corrupt.txt");
    expect(() => parseCareerOpsOutput(stdout)).toThrowError(
      expect.objectContaining({ code: "SCORE_INVALID" }),
    );
  });

  it("score 越界时失败", async () => {
    const stdout = await readOutputFixture("score-out-of-range.txt");
    expect(() => parseCareerOpsOutput(stdout)).toThrowError(
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

  it("按阈值生成初始 recommendation", () => {
    const report = (score: number): string =>
      `---SCORE_SUMMARY---\nSCORE: ${score}\n---END_SUMMARY---\n`;
    expect(parseCareerOpsOutput(report(4)).recommendation).toBe("apply");
    expect(parseCareerOpsOutput(report(3.2)).recommendation).toBe("review");
    expect(parseCareerOpsOutput(report(3.19)).recommendation).toBe("skip");
  });
});

describe("evaluateWithCareerOps", () => {
  it("使用固定命令结构、传临时文件并清理", async () => {
    const careerOpsRoot = await createFakeCareerOpsRoot();
    const result = await evaluateWithCareerOps(jobDetail("normal-zh"), {
      careerOpsRoot,
    });

    expect(result).toMatchObject({
      score: 84,
      recommendation: "apply",
      company: "星河科技",
      role: "高级前端工程师",
      archetype: "Builder",
      legitimacy: "high",
    });

    const invocation = JSON.parse(
      await readFile(join(careerOpsRoot, "last-invocation.json"), "utf8"),
    ) as {
      execPath: string;
      scriptPath: string;
      args: string[];
      cwd: string;
      inputPath: string;
      input: JobDetail;
    };
    expect(invocation.execPath).toBe(process.execPath);
    expect(invocation.scriptPath).toBe(
      join(careerOpsRoot, "openai-eval.mjs"),
    );
    expect(invocation.args).toEqual([
      "--file",
      invocation.inputPath,
      "--no-save",
    ]);
    expect(invocation.cwd).toBe(careerOpsRoot);
    expect(invocation.input).toEqual(jobDetail("normal-zh"));
    await expect(access(invocation.inputPath)).rejects.toThrow();
    await expect(access(join(careerOpsRoot, "reports"))).rejects.toThrow();
  });

  it("openai-eval.mjs 不存在时失败", async () => {
    const careerOpsRoot = await mkdtemp(join(tmpdir(), "career-ops-empty-"));
    temporaryRoots.push(careerOpsRoot);
    await expectAdapterError(
      evaluateWithCareerOps(jobDetail("normal-zh"), { careerOpsRoot }),
      "SCRIPT_NOT_FOUND",
    );
  });

  it("API 认证错误不泄漏 API Key", async () => {
    const careerOpsRoot = await createFakeCareerOpsRoot();
    const error = await expectAdapterError(
      evaluateWithCareerOps(jobDetail("api-auth-error"), { careerOpsRoot }),
      "AUTHENTICATION_ERROR",
    );
    expect(error.message).not.toContain("sk-fixture-secret-value");
  });

  it("非零退出返回明确错误", async () => {
    const careerOpsRoot = await createFakeCareerOpsRoot();
    const error = await expectAdapterError(
      evaluateWithCareerOps(jobDetail("non-zero-exit"), { careerOpsRoot }),
      "NON_ZERO_EXIT",
    );
    expect(error.exitCode).toBe(2);
  });

  it("stdout 超限时终止子进程", async () => {
    const careerOpsRoot = await createFakeCareerOpsRoot();
    const error = await expectAdapterError(
      evaluateWithCareerOps(jobDetail("stdout-over-limit"), {
        careerOpsRoot,
        maxOutputBytes: 64,
      }),
      "OUTPUT_LIMIT_EXCEEDED",
    );
    expect(error.stream).toBe("stdout");
  });

  it("timeout 先终止当前子进程并返回 TIMEOUT", async () => {
    const careerOpsRoot = await createFakeCareerOpsRoot();
    const fixture = JSON.parse(
      await readOutputFixture("timeout.json"),
    ) as { expectedError: CareerOpsAdapterError["code"] };
    await expectAdapterError(
      evaluateWithCareerOps(jobDetail("timeout"), {
        careerOpsRoot,
        timeoutMs: 50,
      }),
      fixture.expectedError,
    );
  });

  it("AbortSignal 终止当前子进程并返回 CANCELLED", async () => {
    const careerOpsRoot = await createFakeCareerOpsRoot();
    const fixture = JSON.parse(
      await readOutputFixture("cancel.json"),
    ) as { expectedError: CareerOpsAdapterError["code"] };
    const controller = new AbortController();
    const evaluation = evaluateWithCareerOps(jobDetail("cancel"), {
      careerOpsRoot,
      signal: controller.signal,
    });
    const invocationPath = join(careerOpsRoot, "last-invocation.json");
    await waitForFile(invocationPath);
    const invocation = JSON.parse(
      await readFile(invocationPath, "utf8"),
    ) as { inputPath: string };
    controller.abort();
    await expectAdapterError(evaluation, fixture.expectedError);
    await expect(access(invocation.inputPath)).rejects.toThrow();
  });
});
