import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Career Ops CN',
    description: 'Career Ops CN 浏览器扩展基础环境',
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
