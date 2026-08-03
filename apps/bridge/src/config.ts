import { fileURLToPath } from "node:url";

import {
  PreferencesSchema,
  type Preferences,
} from "@career-ops-cn/shared";
import { z } from "zod";

export const BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_PORT = 3847;
export const DEFAULT_EVALUATION_TIMEOUT_MS = 120_000;
export const DEFAULT_PROFILE_VERSION = "default-profile-v1";
export const DEFAULT_PROMPT_VERSION = "career-ops-cn-openai-v1";
export const DEFAULT_MODEL_ID = "deepseek-v4-flash";
const DEFAULT_OPENAI_MODEL_ID = "gpt-4o-mini";
export const DEFAULT_EVALUATION_SCHEMA_VERSION = "1";
export const DEFAULT_DATABASE_PATH = fileURLToPath(
  new URL("../career-ops-cn.sqlite", import.meta.url),
);

const DEFAULT_PREFERENCES: Preferences = {};

const EnvironmentSchema = z.object({
  CAREER_OPS_CN_TOKEN: z.string().trim().min(1),
  CAREER_OPS_CN_BRIDGE_PORT: z.preprocess(
    (value) => value ?? DEFAULT_BRIDGE_PORT,
    z.coerce.number().int().min(1).max(65_535),
  ),
  CAREER_OPS_CN_DATABASE_PATH: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_DATABASE_PATH),
  CAREER_OPS_CN_EVALUATION_TIMEOUT_MS: z.preprocess(
    (value) => value ?? DEFAULT_EVALUATION_TIMEOUT_MS,
    z.coerce.number().int().positive(),
  ),
  CAREER_OPS_CN_PREFERENCES: z.string().trim().min(1).optional(),
  CAREER_OPS_CN_PROFILE_VERSION: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_PROFILE_VERSION),
  CAREER_OPS_CN_PROMPT_VERSION: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_PROMPT_VERSION),
  CAREER_OPS_CN_MODEL_ID: z
    .string()
    .trim()
    .min(1)
    .optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_MODEL: z.string().trim().min(1).optional(),
  OPENAI_MODEL: z.string().trim().min(1).optional(),
  CAREER_OPS_CN_EVALUATION_SCHEMA_VERSION: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_EVALUATION_SCHEMA_VERSION),
});

export interface BridgeConfig {
  host: typeof BRIDGE_HOST;
  token: string;
  port: number;
  databasePath: string;
  evaluationTimeoutMs: number;
  preferences: Preferences;
  profileVersion: string;
  promptVersion: string;
  modelId: string;
  evaluationSchemaVersion: string;
}

function parsePreferences(value: string | undefined): Preferences {
  if (value === undefined) {
    return DEFAULT_PREFERENCES;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      "Bridge 配置无效：CAREER_OPS_CN_PREFERENCES 必须是 JSON。",
    );
  }

  const preferences = PreferencesSchema.safeParse(parsed);
  if (!preferences.success) {
    throw new Error(
      "Bridge 配置无效：CAREER_OPS_CN_PREFERENCES 不符合 Preferences 契约。",
    );
  }

  return preferences.data;
}

export function readBridgeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BridgeConfig {
  const result = EnvironmentSchema.safeParse(environment);

  if (!result.success) {
    throw new Error(
      "Bridge 配置无效：必须设置 CAREER_OPS_CN_TOKEN，并使用有效端口、数据库路径和评估超时。",
    );
  }

  return {
    host: BRIDGE_HOST,
    token: result.data.CAREER_OPS_CN_TOKEN,
    port: result.data.CAREER_OPS_CN_BRIDGE_PORT,
    databasePath: result.data.CAREER_OPS_CN_DATABASE_PATH,
    evaluationTimeoutMs:
      result.data.CAREER_OPS_CN_EVALUATION_TIMEOUT_MS,
    preferences: parsePreferences(result.data.CAREER_OPS_CN_PREFERENCES),
    profileVersion: result.data.CAREER_OPS_CN_PROFILE_VERSION,
    promptVersion: result.data.CAREER_OPS_CN_PROMPT_VERSION,
    modelId:
      result.data.CAREER_OPS_CN_MODEL_ID ??
      ((result.data.DEEPSEEK_API_KEY?.trim() ?? '') !== ''
        ? result.data.DEEPSEEK_MODEL ?? DEFAULT_MODEL_ID
        : result.data.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL_ID),
    evaluationSchemaVersion:
      result.data.CAREER_OPS_CN_EVALUATION_SCHEMA_VERSION,
  };
}
