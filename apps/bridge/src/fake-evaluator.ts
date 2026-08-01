import { readFile } from "node:fs/promises";

import {
  EvaluationResultSchema,
} from "@career-ops-cn/shared";

import type { Evaluator } from "./dependencies.js";

export const DEFAULT_EVALUATION_FIXTURE_URL = new URL(
  "../../../fixtures/contracts/evaluation-result.json",
  import.meta.url,
);

export function createFakeEvaluator(
  fixtureUrl: URL = DEFAULT_EVALUATION_FIXTURE_URL,
): Evaluator {
  return async (_job, _options) => {
    const contents = await readFile(fixtureUrl, "utf8");
    return EvaluationResultSchema.parse(JSON.parse(contents));
  };
}
