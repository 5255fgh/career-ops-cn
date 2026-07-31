import { readFile } from "node:fs/promises";

import {
  EvaluationResultSchema,
  type EvaluationResult,
} from "@career-ops-cn/shared";

export const DEFAULT_EVALUATION_FIXTURE_URL = new URL(
  "../../../fixtures/contracts/evaluation-result.json",
  import.meta.url,
);

export type Evaluator = () => Promise<EvaluationResult>;

export function createFakeEvaluator(
  fixtureUrl: URL = DEFAULT_EVALUATION_FIXTURE_URL,
): Evaluator {
  return async () => {
    const contents = await readFile(fixtureUrl, "utf8");
    return EvaluationResultSchema.parse(JSON.parse(contents));
  };
}
