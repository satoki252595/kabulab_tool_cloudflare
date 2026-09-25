/**
 * 有報テキスト 1 通分の Notion 保管ヘルパー (3 書込経路で共用)。
 *
 * D1 の 10GB 上限 (引き上げ不可) 対策として、有報テキスト本文は Notion
 * (全銘柄共通の単一「有報テキスト」DB) にのみ置く。D1 には索引と行 ID
 * (`yuho_documents.notion_doc_page_id`) を残す。呼び出し側は戻り値の行 ID
 * を D1 へ書き戻すこと。
 *
 * 抽出セクション 0 件 (no_text_sections / parse_error) は保管対象外として
 * Notion を呼ばずに戻る。空行を作らない (textParseStatus が D1 側に残り、
 * 「未保管」と区別できるため)。
 *
 * 失敗は throw する (呼び出し側で当該通だけ失敗計上し継続する。ルール2:
 * 握りつぶさない)。ポインタ NULL の通は P3 移行スクリプトが回収する。
 */
import {
  ensureStockTextDb,
  upsertStockTextRow,
} from "../../../../src/shared/notion-archive/index.js";

export interface DocTextSection {
  itemName: string;
  sectionKey: string;
  text: string;
}

export interface BackupDocTextResult {
  /** Notion 行 ID。skipped_empty のとき null */
  rowPageId: string | null;
  outcome: "recorded" | "skipped_existing" | "skipped_empty";
}

export async function backupDocTextToNotion(args: {
  /** 証券コード4桁 (例 "7203") — 親ページのキー */
  stockCode: string;
  /** EDINET 書類 ID — 行の冪等キー */
  docId: string;
  d1DocumentId: number;
  fiscalYearEnd: string;
  textParseStatus: string;
  sections: DocTextSection[];
  force?: boolean;
}): Promise<BackupDocTextResult> {
  const {
    stockCode,
    docId,
    d1DocumentId,
    fiscalYearEnd,
    textParseStatus,
    sections,
    force,
  } = args;
  if (sections.length === 0) {
    return { rowPageId: null, outcome: "skipped_empty" };
  }
  const { dbId } = await ensureStockTextDb();
  const { rowPageId, outcome } = await upsertStockTextRow({
    dbId,
    doc: { docId, stockCode, fiscalYearEnd, d1DocumentId, textParseStatus },
    sections,
    force,
  });
  return { rowPageId, outcome };
}
