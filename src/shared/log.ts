/**
 * 最小ロガー (L-63)。`console.log` 直叩きの代わりに使う。
 * 将来レベル制御や出力先切替が必要になったらここに足す。
 */
export const log = {
  info: (...args: unknown[]): void => {
    console.info(...args);
  },
  warn: (...args: unknown[]): void => {
    console.warn(...args);
  },
  error: (...args: unknown[]): void => {
    console.error(...args);
  },
};
