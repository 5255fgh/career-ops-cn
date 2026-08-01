import {
  BridgeSettingsSchema,
  ScanConfigSchema,
  type ScanConfig,
} from '@career-ops-cn/shared';

import { DEFAULT_SCAN_CONFIG } from './scan-controller';

export const BRIDGE_TOKEN_STORAGE_KEY = 'bridgeToken';
export const SCAN_CONFIG_STORAGE_KEY = 'scanConfig';

export interface ExtensionStorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface ExtensionLocalSettings {
  bridgeToken: string | null;
  scanConfig: ScanConfig;
}

export async function loadExtensionSettings(
  storage: ExtensionStorageArea,
): Promise<ExtensionLocalSettings> {
  const stored = await storage.get([
    BRIDGE_TOKEN_STORAGE_KEY,
    SCAN_CONFIG_STORAGE_KEY,
  ]);
  const token = BridgeSettingsSchema.safeParse({
    bridgeToken: stored[BRIDGE_TOKEN_STORAGE_KEY],
  });
  const config = ScanConfigSchema.safeParse(stored[SCAN_CONFIG_STORAGE_KEY]);
  const scanConfig = config.success ? config.data : DEFAULT_SCAN_CONFIG;

  if (!config.success) {
    await storage.set({ [SCAN_CONFIG_STORAGE_KEY]: scanConfig });
  }

  return {
    bridgeToken: token.success ? token.data.bridgeToken : null,
    scanConfig,
  };
}

export async function saveBridgeToken(
  storage: ExtensionStorageArea,
  token: string,
): Promise<string> {
  const settings = BridgeSettingsSchema.parse({ bridgeToken: token });
  await storage.set(settings);
  return settings.bridgeToken;
}
