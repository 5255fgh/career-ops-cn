import { fileURLToPath } from "node:url";

import {
  PreferencesSchema,
  type Preferences,
} from "@career-ops-cn/shared";
import { z } from "zod";

export const BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_PORT = 3847;
export const DEFAULT_EVALUATION_TIMEOUT_MS = 120_000;
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
  CAREER_OPS_CN_CAREER_OPS_ROOT: z.string().trim().min(1),
  CAREER_OPS_CN_EVALUATION_TIMEOUT_MS: z.preprocess(
    (value) => value ?? DEFAULT_EVALUATION_TIMEOUT_MS,
    z.coerce.number().int().positive(),
  ),
  CAREER_OPS_CN_PREFERENCES: z.string().trim().min(1).optional(),
});

export interface BridgeConfig {
  host: typeof BRIDGE_HOST;
  token: string;
  port: number;
  databasePath: string;
  careerOpsRoot: string;
  evaluationTimeoutMs: number;
  preferences: Preferences;
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
      "Bridge 配置无效：必须设置 CAREER_OPS_CN_TOKEN 和 CAREER_OPS_CN_CAREER_OPS_ROOT，并使用有效端口、数据库路径和评估超时。",
    );
  }

  return {
    host: BRIDGE_HOST,
    token: result.data.CAREER_OPS_CN_TOKEN,
    port: result.data.CAREER_OPS_CN_BRIDGE_PORT,
    databasePath: result.data.CAREER_OPS_CN_DATABASE_PATH,
    careerOpsRoot: result.data.CAREER_OPS_CN_CAREER_OPS_ROOT,
    evaluationTimeoutMs:
      result.data.CAREER_OPS_CN_EVALUATION_TIMEOUT_MS,
    preferences: parsePreferences(result.data.CAREER_OPS_CN_PREFERENCES),
  };
}
