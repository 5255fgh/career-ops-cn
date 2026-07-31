import { z } from "zod";

export const DEFAULT_BRIDGE_PORT = 3210;

const EnvironmentSchema = z.object({
  CAREER_OPS_CN_TOKEN: z.string().trim().min(1),
  CAREER_OPS_CN_BRIDGE_PORT: z.preprocess(
    (value) => value ?? DEFAULT_BRIDGE_PORT,
    z.coerce.number().int().min(1).max(65_535),
  ),
});

export interface BridgeConfig {
  token: string;
  port: number;
}

export function readBridgeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BridgeConfig {
  const result = EnvironmentSchema.safeParse(environment);

  if (!result.success) {
    throw new Error(
      "Bridge 配置无效：必须设置 CAREER_OPS_CN_TOKEN，并使用有效端口。",
    );
  }

  return {
    token: result.data.CAREER_OPS_CN_TOKEN,
    port: result.data.CAREER_OPS_CN_BRIDGE_PORT,
  };
}
