import { describe, expect, it } from 'vitest';

import { isZhipinHost, isZhipinUrl } from './is-zhipin-host';

describe('isZhipinHost', () => {
  it.each(['zhipin.com', 'www.zhipin.com', 'WWW.ZHIPIN.COM.', '  www.zhipin.com  '])(
    'accepts %s',
    (hostname) => {
      expect(isZhipinHost(hostname)).toBe(true);
    },
  );

  it.each(['example.com', 'zhipin.com.example.com', 'notzhipin.com', ''])('rejects %s', (hostname) => {
    expect(isZhipinHost(hostname)).toBe(false);
  });
});

describe('isZhipinUrl', () => {
  it.each(['https://www.zhipin.com/web/geek/job', 'http://zhipin.com/'])('accepts %s', (url) => {
    expect(isZhipinUrl(url)).toBe(true);
  });

  it.each(['https://example.com/', 'https://zhipin.com.example.com/', 'chrome://extensions', 'bad'])(
    'rejects %s',
    (url) => {
      expect(isZhipinUrl(url)).toBe(false);
    },
  );
});
