import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';

import { isZhipinUrl } from '../lib/is-zhipin-host';

export default defineBackground(() => {
  const setPanelEnabled = async (tabId: number, url?: string): Promise<void> => {
    let tabUrl = url;
    if (tabUrl === undefined) {
      tabUrl = (await browser.tabs.get(tabId)).url;
    }
    await browser.sidePanel.setOptions({
      tabId,
      enabled: tabUrl !== undefined && isZhipinUrl(tabUrl),
    });
  };

  void browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => {
      console.warn('无法配置点击扩展图标打开侧栏。', error);
    });

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url !== undefined || changeInfo.status === 'loading') {
      void setPanelEnabled(tabId, changeInfo.url ?? tab.url).catch(() => undefined);
    }
  });

  browser.tabs.onActivated.addListener(({ tabId }) => {
    void setPanelEnabled(tabId).catch(() => undefined);
  });

  void browser.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      if (tab.id !== undefined) {
        void setPanelEnabled(tab.id, tab.url).catch(() => undefined);
      }
    }
  });
});
