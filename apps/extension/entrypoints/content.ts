import { PageContextRequestSchema, PageContextResponseSchema } from '@career-ops-cn/shared';
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';

import { isZhipinHost } from '../lib/is-zhipin-host';

export default defineContentScript({
  matches: ['*://*.zhipin.com/*', '*://zhipin.com/*'],
  main() {
    browser.runtime.onMessage.addListener(async (message: unknown) => {
      const request = PageContextRequestSchema.safeParse(message);

      if (!request.success) {
        return undefined;
      }

      return PageContextResponseSchema.parse({
        type: 'page-context/response',
        isZhipin: isZhipinHost(window.location.hostname),
      });
    });
  },
});
