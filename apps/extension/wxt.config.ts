import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Career Ops CN',
    description: 'Career Ops CN 浏览器扩展基础环境',
    permissions: ['sidePanel'],
    host_permissions: ['*://*.zhipin.com/*', '*://zhipin.com/*'],
    action: {
      default_title: '打开 Career Ops CN',
    },
  },
});
