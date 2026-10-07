/**
 * INC-20261008-kabulab_tool_cloudflare-ir-pdf-502
 *
 * 適時開示 PDF を Notion に残す前に TDnet 原本が消える事故の、ログ用タグと
 * 処理順。保存済み行の照会を省き、未保存を古い順に処理するための共有部。
 */

export const IR_PDF_ARCHIVE_INCIDENT_TAG =
  "[INC-20261008-kabulab_tool_cloudflare-ir-pdf-502]";

const ID_CHUNK = 40;

/** 打ち切り・skip の tdnetId を、件数と一緒に残す。空なら何も出さない。 */
export function logIrPdfIncident(
  kind: string,
  tdnetIds: readonly string[]
): void {
  if (tdnetIds.length === 0) return;
  for (let offset = 0; offset < tdnetIds.length; offset += ID_CHUNK) {
    const slice = tdnetIds.slice(offset, offset + ID_CHUNK);
    console.warn(
      `${IR_PDF_ARCHIVE_INCIDENT_TAG} ${kind} count=${tdnetIds.length} offset=${offset} tdnetIds=${slice.join(",")}`
    );
  }
}

/**
 * 公開が古い開示を先にする。同じ発表日時は銘柄コード、さらに TDnet ID で
 * 安定化する（入力順に依存させない）。
 */
export function compareDisclosuresForArchive(
  a: { pubdate: string; ticker: string; key: string },
  b: { pubdate: string; ticker: string; key: string }
): number {
  if (a.pubdate !== b.pubdate) return a.pubdate < b.pubdate ? -1 : 1;
  if (a.ticker !== b.ticker) return a.ticker < b.ticker ? -1 : 1;
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  return 0;
}
