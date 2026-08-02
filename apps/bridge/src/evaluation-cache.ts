import type { JobDetail } from "@career-ops-cn/shared";

import type { BridgeConfig } from "./config.js";
import { hashCanonical, normalizeJobDescription, sha256Text } from "./hashing.js";

export interface EvaluationCacheMetadata {
  jdHash: string;
  profileHash: string;
  rulesHash: string;
  promptVersion: string;
  modelId: string;
  evaluationSchemaVersion: string;
  inputHash: string;
  cacheKey: string;
}

function normalizeDetailUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.hostname = url.hostname.toLowerCase();
  if (url.port === "443") {
    url.port = "";
  }
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/u, "");
  }
  return url.toString();
}

export function buildEvaluationCacheMetadata(
  job: JobDetail,
  config: BridgeConfig,
): EvaluationCacheMetadata {
  const normalizedDescription = normalizeJobDescription(job.description);
  const jdHash = sha256Text(normalizedDescription);
  const profileHash = hashCanonical({ version: config.profileVersion });
  const rulesHash = hashCanonical(config.preferences);
  const inputHash = hashCanonical({
    job: {
      ...job,
      detailUrl: normalizeDetailUrl(job.detailUrl),
      description: normalizedDescription,
    },
    jdHash,
    profileHash,
    rulesHash,
    promptVersion: config.promptVersion,
    modelId: config.modelId,
    evaluationSchemaVersion: config.evaluationSchemaVersion,
  });

  return {
    jdHash,
    profileHash,
    rulesHash,
    promptVersion: config.promptVersion,
    modelId: config.modelId,
    evaluationSchemaVersion: config.evaluationSchemaVersion,
    inputHash,
    cacheKey: inputHash,
  };
}
