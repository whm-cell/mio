/** Both ordinary OAuth and QR login accept only a path under the configured auth origin. */
export function wechatCallbackURL(value: unknown, origin: string, fallback: string) {
  const path = value === undefined ? fallback : value;
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\u0000-\u001f\u007f\\]/.test(path)
  )
    return;
  const url = new URL(path, origin);
  return url.origin === origin ? url.href : undefined;
}
