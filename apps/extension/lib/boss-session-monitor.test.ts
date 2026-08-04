// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';

import { observeBossSessionChanges } from './boss-session-monitor';

describe('observeBossSessionChanges', () => {
  it('Text.data 改变时触发 session 安全检查', async () => {
    const root = document.createElement('div');
    const text = document.createTextNode('页面正常');
    root.append(text);
    document.body.append(root);
    const check = vi.fn();
    const observer = observeBossSessionChanges(root, check);

    text.data = '账号存在风险';

    await vi.waitFor(() => expect(check).toHaveBeenCalled());
    observer.disconnect();
    root.remove();
  });
});
