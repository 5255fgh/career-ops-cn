export function isZhipinHost(hostname: string): boolean {
  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/u, '');

  return normalizedHostname === 'zhipin.com' || normalizedHostname.endsWith('.zhipin.com');
}

export function isZhipinUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && isZhipinHost(url.hostname);
  } catch {
    return false;
  }
}
