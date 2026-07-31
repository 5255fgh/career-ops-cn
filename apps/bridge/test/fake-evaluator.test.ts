import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { createFakeEvaluator } from "../src/fake-evaluator.js";

describe("Fake Evaluator", () => {
  it("读取并校验 evaluation-result fixture", async () => {
    const evaluate = createFakeEvaluator();

    expect(await evaluate()).toEqual({
      score: 86,
      recommendation: "建议申请",
      rawReport:
        "岗位技术方向与求职偏好较匹配；技术栈包含 TypeScript 和 React。职位描述未说明团队规模，建议面试时进一步确认。",
    });
  });

  it("拒绝不符合 shared Schema 的 fixture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "career-ops-cn-evaluator-"));
    const invalidFixturePath = join(directory, "evaluation-result.json");
    await writeFile(invalidFixturePath, JSON.stringify({ score: 101 }));

    try {
      const evaluate = createFakeEvaluator(pathToFileURL(invalidFixturePath));
      await expect(evaluate()).rejects.toBeInstanceOf(ZodError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
