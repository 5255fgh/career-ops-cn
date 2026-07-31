import {
  JobDetailSchema,
  MockJobDetailRequestSchema,
  MockJobDetailResponseSchema,
  PageContextRequestSchema,
  PageContextResponseSchema,
} from '@career-ops-cn/shared';
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';

import jobDetailFixture from '../../../fixtures/contracts/job-detail.json';
import { isZhipinHost } from '../lib/is-zhipin-host';

const mockJobDetail = JobDetailSchema.parse(jobDetailFixture);

export default defineContentScript({
  matches: ['*://*.zhipin.com/*', '*://zhipin.com/*'],
  main() {
    browser.runtime.onMessage.addListener(async (message: unknown) => {
      const pageContextRequest = PageContextRequestSchema.safeParse(message);

      if (pageContextRequest.success) {
        return PageContextResponseSchema.parse({
          type: 'page-context/response',
          isZhipin: isZhipinHost(window.location.hostname),
        });
      }

      const mockJobDetailRequest = MockJobDetailRequestSchema.safeParse(message);

      if (mockJobDetailRequest.success) {
        return MockJobDetailResponseSchema.parse({
          type: 'mock-job-detail/response',
          job: mockJobDetail,
        });
      }

      return undefined;
    });
  },
});
