/** 診断ログへ載せるメッセージ上限。完全な件数・コードは別フィールドで保持する。 */
const ROOT_CAUSE_MESSAGE_MAX_LENGTH = 1_000;

/**
 * Error.cause を辿り、肥大化を抑えた診断メッセージとして返す。
 *
 * Drizzle 等は具体的な upstream エラーを cause に包み、表層 message には巨大な
 * SQL/params だけを載せるため、表層だけでは根本原因を失う。
 */
export function rootCauseMessage(error: unknown): string {
  let current: unknown = error;
  const messages: string[] = [];
  const seen = new Set<unknown>();

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    // Drizzle の表層は巨大な SQL/params だけなので捨て、具体的な D1 cause を残す。
    if (!current.message.startsWith("Failed query:")) {
      messages.push(current.message);
    }
    if (current.cause === undefined) break;
    current = current.cause;
  }

  if (!(current instanceof Error) && current !== undefined) {
    messages.push(String(current));
  }
  const message =
    [...new Set(messages)].join(" / 原因: ") ||
    (error instanceof Error ? error.message : String(error));
  return message.length > ROOT_CAUSE_MESSAGE_MAX_LENGTH
    ? `${message.slice(0, ROOT_CAUSE_MESSAGE_MAX_LENGTH)}…`
    : message;
}
