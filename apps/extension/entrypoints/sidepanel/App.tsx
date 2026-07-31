import { PageContextRequestSchema, PageContextResponseSchema } from '@career-ops-cn/shared';
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';

import { isZhipinUrl } from '../../lib/is-zhipin-host';

type PageStatus = 'checking' | 'zhipin' | 'other';

async function readActivePageStatus(): Promise<PageStatus> {
  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });

  if (activeTab?.id === undefined) {
    return 'other';
  }

  if (activeTab.url !== undefined) {
    return isZhipinUrl(activeTab.url) ? 'zhipin' : 'other';
  }

  try {
    const request = PageContextRequestSchema.parse({ type: 'page-context/request' });
    const response: unknown = await browser.tabs.sendMessage(activeTab.id, request);
    const parsedResponse = PageContextResponseSchema.safeParse(response);

    return parsedResponse.success && parsedResponse.data.isZhipin ? 'zhipin' : 'other';
  } catch {
    return 'other';
  }
}

export function App() {
  const [pageStatus, setPageStatus] = useState<PageStatus>('checking');

  useEffect(() => {
    let disposed = false;
    let refreshSequence = 0;

    const refresh = () => {
      const sequence = ++refreshSequence;

      void readActivePageStatus().then((nextStatus) => {
        if (!disposed && sequence === refreshSequence) {
          setPageStatus(nextStatus);
        }
      });
    };

    refresh();
    browser.tabs.onActivated.addListener(refresh);
    browser.tabs.onUpdated.addListener(refresh);

    return () => {
      disposed = true;
      browser.tabs.onActivated.removeListener(refresh);
      browser.tabs.onUpdated.removeListener(refresh);
    };
  }, []);

  const pageDescription =
    pageStatus === 'checking'
      ? '正在识别当前页面…'
      : pageStatus === 'zhipin'
        ? '当前页面是 zhipin.com'
        : '当前页面不是 zhipin.com';

  return (
    <main className="panel">
      <p className="eyebrow">Career Ops CN</p>
      <h1>基础环境可用</h1>
      <p className={`page-status page-status--${pageStatus}`} role="status" aria-live="polite">
        <span className="status-dot" aria-hidden="true" />
        {pageDescription}
      </p>
    </main>
  );
}
