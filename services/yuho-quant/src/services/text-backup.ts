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
  readStockTextRow,
  upsertStockTextRow,
} from "../../../../src/shared/notion-archive/index.js";
import { notionRequest } from "../../../../src/shared/notion-archive/client.js";

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

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("有報テキストの読み戻しメタデータ型が不正");
  }
  return value as Record<string, unknown>;
}

function normalizedId(value: unknown): string {
  if (typeof value !== "string" ||
      !/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(value)) {
    throw new Error("有報テキストの読み戻し ID 型が不正");
  }
  return value.replaceAll("-", "").toLowerCase();
}

function propertyText(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("有報テキストの読み戻し文字プロパティが欠落");
  }
  return value.map((fragment: unknown) => {
    const rich = record(fragment);
    const text = record(rich.text);
    if (rich.type !== "text" || typeof text.content !== "string" ||
        typeof rich.plain_text !== "string" || rich.plain_text !== text.content) {
      throw new Error("有報テキストの読み戻し文字プロパティが不正");
    }
    return text.content;
  }).join("");
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
  // ACK や既存 docId の一致だけで D1 ポインタを確定しない。新規・再利用とも
  // 所属/全7プロパティと全文の往復を確認する (不一致を force で直さない)。
  const expectedRowId = normalizedId(rowPageId), expectedDbId = normalizedId(dbId);
  const page = record(await notionRequest<unknown>("GET", `/pages/${rowPageId}`));
  const parent = record(page.parent);
  if (page.object !== "page" || normalizedId(page.id) !== expectedRowId ||
      parent.type !== "database_id" || normalizedId(parent.database_id) !== expectedDbId ||
      page.archived !== false || page.in_trash !== false) {
    throw new Error("有報テキストの読み戻しページ所属/状態が不一致");
  }
  const properties = record(page.properties);
  const property = (name: string, type: string) => {
    const found = record(properties[name]);
    if (found.type !== type || (found.has_more !== undefined && found.has_more !== false)) {
      throw new Error("有報テキストの読み戻しプロパティ型/完全性が不正");
    }
    return found;
  };
  const date = record(property("会計期末", "date").date);
  if (propertyText(property("文書", "title").title) !== docId ||
      propertyText(property("銘柄コード", "rich_text").rich_text) !== stockCode ||
      property("D1文書ID", "number").number !== d1DocumentId ||
      date.start !== fiscalYearEnd || date.end !== null || date.time_zone !== null ||
      property("セクション件数", "number").number !== sections.length ||
      property("文字数合計", "number").number !== sections.reduce((total, section) => total + [...section.text].length, 0) ||
      record(property("抽出状態", "select").select).name !== textParseStatus) {
    throw new Error("有報テキストの読み戻し7プロパティが不一致");
  }
  const readback = await readStockTextRow(rowPageId);
  if (!Array.isArray(readback) || readback.length !== sections.length ||
      readback.some((section, index) => section.itemName !== sections[index]!.itemName ||
        section.sectionKey !== sections[index]!.sectionKey || section.text !== sections[index]!.text)) {
    throw new Error("有報テキストの読み戻し全文が不一致");
  }
  return { rowPageId, outcome };
}
