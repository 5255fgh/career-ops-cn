import { fileURLToPath } from "node:url";

import { z } from "zod";

export const DEFAULT_BRIDGE_PORT = 3210;
export const DEFAULT_DATABASE_PATH = fileURLToPath(
  new URL("../career-ops-cn.sqlite", import.meta.url),
);

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
});

export interface BridgeConfig {
  token: string;
  port: number;
  databasePath: string;
}

export function readBridgeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BridgeConfig {
  const result = EnvironmentSchema.safeParse(environment);

  if (!result.success) {
    throw new Error(
      "Bridge 配置无效：必须设置 CAREER_OPS_CN_TOKEN，并使用有效端口和数据库路径。",
    );
  }

  return {
    token: result.data.CAREER_OPS_CN_TOKEN,
    port: result.data.CAREER_OPS_CN_BRIDGE_PORT,
    databasePath: result.data.CAREER_OPS_CN_DATABASE_PATH,
  };
}
