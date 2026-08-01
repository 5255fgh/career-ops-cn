import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SCAN_CONFIG } from './scan-controller';
import {
  loadExtensionSettings,
  saveBridgeToken,
  type ExtensionStorageArea,
} from './extension-settings';

describe('Extension local settings', () => {
  it('保存 Bridge token，并在首次读取时写入默认扫描配置', async () => {
    const values: Record<string, unknown> = {};
    const storage: ExtensionStorageArea = {
      get: vi.fn(async (keys: string[]) =>
        Object.fromEntries(keys.map((key) => [key, values[key]])),
      ),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(values, items);
      }),
    };

    await expect(saveBridgeToken(storage, 'mock-token')).resolves.toBe('mock-token');
    await expect(loadExtensionSettings(storage)).resolves.toEqual({
      bridgeToken: 'mock-token',
      scanConfig: DEFAULT_SCAN_CONFIG,
    });
    expect(values).toEqual({
      bridgeToken: 'mock-token',
      scanConfig: DEFAULT_SCAN_CONFIG,
    });
  });

  it('拒绝空 token', async () => {
    const storage: ExtensionStorageArea = {
      get: async () => ({}),
      set: async () => undefined,
    };
    await expect(saveBridgeToken(storage, '  ')).rejects.toThrow();
  });
});
