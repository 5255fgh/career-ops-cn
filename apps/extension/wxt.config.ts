import { fileURLToPath } from 'node:url';

import { defineConfig } from 'wxt';

const bossAdapterEntry = fileURLToPath(
  new URL('../../packages/boss-adapter/src/index.ts', import.meta.url),
);
const sharedEntry = fileURLToPath(
  new URL('../../packages/shared/src/index.ts', import.meta.url),
);

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    resolve: {
      alias: {
        '@career-ops-cn/boss-adapter': bossAdapterEntry,
        '@career-ops-cn/shared': sharedEntry,
      },
    },
  }),
  manifest: {
    name: 'Career Ops CN',
    description: 'BOSS 直聘职位的本机只读筛选与评估侧栏',
    permissions: ['sidePanel', 'storage'],
    host_permissions: [
      '*://*.zhipin.com/*',
      '*://zhipin.com/*',
      'http://127.0.0.1/*',
    ],
    action: {
      default_title: '打开 Career Ops CN',
    },
  },
});
