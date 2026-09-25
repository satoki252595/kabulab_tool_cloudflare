/**
 * 有報テキストの Notion 保管 (D1 スリム化の受け皿)。
 *
 * D1 の 10GB 上限 (引き上げ不可) に対し、有報の非構造化テキスト
 * (約80万セクション・約3.5GB) を Notion へ移す。D1 には索引
 * (キー・項目名・文字数) と本モジュールが返す行 ID だけを残す。
 *
 * 構造 (2026-09-25 再配置。全銘柄共通の単一 DB — 銘柄別の子ページ/子DB は
 * 作らない):
 *   NOTION_ARCHIVE_PAGE_ID ページ ("一次データ保管")
 *   └─ 有報テキスト (単一 DB。ID = NOTION_YUHO_TEXT_DB_ID。1 行 = 1 通)
 *      ├─ プロパティ: D1 構造の鏡像 (文書・D1文書ID・銘柄コード・
 *      │  会計期末・セクション件数・文字数合計・抽出状態)
 *      └─ 本文: heading_2 目印 + セクション毎に heading_3 + code block 群
 *
 * 旧設計は証券コード毎に子ページ+子DB を作っていたが、数千件の子ページが
 * 累積して親ページ (旧「バックアップ」) が Notion 上で開けなくなり、
 * ユーザが該当ページをトラッシュする事態になった (2026-09-25)。以後は
 * 銘柄コードを行の1プロパティとして持つだけにし、親ページ配下に大量の
 * 子ページ/子DBを作らない (CLAUDE.md ルール6 に明記)。
 *
 * 非機能制約 (Notion API 公式 /reference/request-limits 準拠):
 *   - 全リクエストは client.ts の単一キュー (~2.6 req/s) を通る。
 *     公式上限は Business 以上 600 req/min・それ以外 180 req/min +
 *     ワークスペース共有枠。380ms ペーシングは全プランで安全側。
 *   - 1 追記 100 ブロック・1 ブロック rich_text 2000 文字・1 要求 500KB。
 *     1 通あたり平均 83 ブロック (実測) のため、ページ作成時の children
 *     直付け + 超過分の分割追記で収める。100 ブロック ≒ 最大 260KB で
 *     500KB 上限の内側。
 *   - ブロック数は有料 WS = 無制限 (Free 複数人は生涯 1,000)。本設計は
 *     有料 WS 前提 (2026-09-21 ユーザ確認)。Free では移行自体が不可。
 *   - DB は `NOTION_YUHO_TEXT_DB_ID` で固定 ID 参照する (Search/children
 *     走査をしない。P6 重複事件の教訓 — 大量行の子ページ走査は約1万件で
 *     打ち切られる実測があるため、そもそも走査しない設計にする)。
 *   - 有報テキストは不変 (訂正は別 docID の新規通)。読みの Cache は P2 側。
 *
 * 冪等: 行の有無 = DB クエリ (文書完全一致) で判定し、既存ならスキップ。
 * force 時のみ旧行を archived して作り直す (ブロックの選択削除 API が無い
 * ため。archived 行は残るが非表示で、移行は write-once のため通常出ない)。
 */
import { notionRequest } from "./client.js";
import { notionEnv } from "./env.js";

/** rich_text 1 ブロックの上限 (archive.ts と同一値) */
const RICH_TEXT_MAX = 2000;
/** 1 リクエストで付けられる children 上限 (作成・追記共通) */
const CHILDREN_PER_REQUEST = 100;

/**
 * 有報テキスト DB のタイトル (固定・全銘柄共通の単一 DB)。移行スクリプトが
 * 旧配置 (証券コード毎の子ページ配下に同名で作られていた子 DB) を見つける
 * ためにも使う。
 */
export const STOCK_TEXT_DB_TITLE = "有報テキスト";
/** 本文先頭の目印 (読みの構造検証用) */
export const TEXT_BODY_MARKER = "抽出テキスト全文";

export interface StockTextSection {
  /** 抽出元の項目名 (表記ゆれ前の原文ラベル) */
  itemName: string;
  /** TextSectionKey (39 項目) */
  sectionKey: string;
  /** プレーンテキスト本文 (欠落させない) */
  text: string;
}

export interface StockTextDoc {
  /** EDINET 書類 ID (例 S100W6XE) — 行の冪等キー */
  docId: string;
  /** 証券コード4桁 (例 "7203") — 行の「銘柄コード」列 */
  stockCode: string;
  /** 会計期末 (YYYY-MM-DD) */
  fiscalYearEnd: string;
  /** D1 yuho_documents.id (Notion→D1 逆引き用) */
  d1DocumentId: number;
  /** ok | no_text_sections | parse_error */
  textParseStatus: string;
}

interface HeadingBlock {
  id: string;
  type: string;
  heading_2?: { rich_text: Array<{ plain_text?: string; text?: { content: string } }> };
  heading_3?: { rich_text: Array<{ plain_text?: string; text?: { content: string } }> };
  code?: { rich_text: Array<{ plain_text?: string; text?: { content: string } }> };
}

interface ChildrenResponse {
  results: HeadingBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

/** プロセス内キャッシュ: 有報テキスト DB ID (単一 DB のため銘柄コード不要) */
let cachedDbId: string | null = null;


const TEXT_PARSE_STATUS_OPTIONS = [
  { name: "ok", color: "green" },
  { name: "no_text_sections", color: "gray" },
  { name: "parse_error", color: "red" },
] as const;

const TEXT_DB_PROPERTIES = {
  文書: { title: {} },
  D1文書ID: { number: {} },
  銘柄コード: { rich_text: {} },
  会計期末: { date: {} },
  セクション件数: { number: {} },
  文字数合計: { number: {} },
  抽出状態: { select: { options: TEXT_PARSE_STATUS_OPTIONS } },
} as const;

function richText(content: string): { text: { content: string } } {
  return { text: { content } };
}

/** 文字列を rich_text 上限で code block 群に分割 (欠落させない) */
function textToCodeBlocks(text: string): unknown[] {
  const blocks: unknown[] = [];
  // 空本文でも 1 ブロック置く (セクションの存在を消さない)
  const chunks = text.length
    ? Math.ceil(text.length / RICH_TEXT_MAX)
    : 1;
  for (let i = 0; i < chunks; i++) {
    blocks.push({
      object: "block",
      type: "code",
      code: {
        language: "plain text",
        rich_text: [
          {
            type: "text",
            ...richText(text.slice(i * RICH_TEXT_MAX, (i + 1) * RICH_TEXT_MAX)),
          },
        ],
      },
    });
  }
  return blocks;
}

/**
 * 1 通分の本文ブロック列を作る (純粋関数)。
 * heading_2 目印 + セクション毎に heading_3 + code block 群。
 */
export function buildTextBodyBlocks(sections: StockTextSection[]): unknown[] {
  const blocks: unknown[] = [
    {
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [
          {
            type: "text",
            ...richText(`${TEXT_BODY_MARKER} (${sections.length}項目)`),
          },
        ],
      },
    },
  ];
  for (const s of sections) {
    blocks.push({
      object: "block",
      type: "heading_3",
      heading_3: {
        rich_text: [
          { type: "text", ...richText(`${s.itemName} (${s.sectionKey})`) },
        ],
      },
    });
    blocks.push(...textToCodeBlocks(s.text));
  }
  return blocks;
}

interface DbSchemaResponse {
  properties: Record<string, { type: string }>;
}

/**
 * 有報テキスト DB (単一・固定 ID) を確保する。`NOTION_YUHO_TEXT_DB_ID` を
 * 正のソースとして直接 GET し、足りない列だけ非破壊 PATCH する
 * (`stock-supplement.ts` の `ensureSupplementDb` と同じ流儀)。Search や
 * children 走査は行わない (ID 固定のため不要)。DB が見つからない
 * (ID 誤り・削除等) は config エラーとして throw し、黙って新規 DB を
 * 作らない (誤った ID を握りつぶすと孤立 DB が増える — ルール2)。
 * 2 回目以降はプロセス内キャッシュのみで 0 コール。
 */
export async function ensureStockTextDb(): Promise<{ dbId: string }> {
  if (cachedDbId) return { dbId: cachedDbId };
  const dbId = notionEnv.NOTION_YUHO_TEXT_DB_ID();
  const schema = await notionRequest<DbSchemaResponse>(
    "GET",
    `/databases/${dbId}`
  );
  const missing = Object.entries(TEXT_DB_PROPERTIES).filter(
    ([name]) => !(name in schema.properties)
  );
  if (missing.length > 0) {
    await notionRequest("PATCH", `/databases/${dbId}`, {
      properties: Object.fromEntries(missing),
    });
  }
  cachedDbId = dbId;
  return { dbId };
}

/** 子 DB 内の文書行を探す (文書タイトル完全一致) */
export async function findStockTextRowId(
  dbId: string,
  docId: string
): Promise<string | null> {
  const res = await notionRequest<{ results: Array<{ id: string }> }>(
    "POST",
    `/databases/${dbId}/query`,
    { filter: { property: "文書", title: { equals: docId } }, page_size: 1 }
  );
  return res.results[0]?.id ?? null;
}

function rowProperties(
  doc: StockTextDoc,
  sections: StockTextSection[]
): Record<string, unknown> {
  const charTotal = sections.reduce(
    (acc, s) => acc + [...s.text].length,
    0
  );
  return {
    文書: { title: [{ type: "text", ...richText(doc.docId) }] },
    D1文書ID: { number: doc.d1DocumentId },
    銘柄コード: { rich_text: [{ type: "text", ...richText(doc.stockCode) }] },
    会計期末: { date: { start: doc.fiscalYearEnd } },
    セクション件数: { number: sections.length },
    文字数合計: { number: charTotal },
    抽出状態: { select: { name: doc.textParseStatus } },
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface UpsertStockTextRowResult {
  rowPageId: string;
  outcome: "recorded" | "skipped_existing";
}

/**
 * 1 通分の全文を子 DB 行 + 本文ブロックとして冪等記録する。
 * 既存行はスキップ (force 時のみ旧行を archived して作り直す)。
 */
export async function upsertStockTextRow(args: {
  dbId: string;
  doc: StockTextDoc;
  sections: StockTextSection[];
  force?: boolean;
}): Promise<UpsertStockTextRowResult> {
  const { dbId, doc, sections, force } = args;
  const existing = await findStockTextRowId(dbId, doc.docId);
  if (existing && !force) {
    return { rowPageId: existing, outcome: "skipped_existing" };
  }
  if (existing && force) {
    await notionRequest("PATCH", `/pages/${existing}`, { archived: true });
  }
  const blocks = buildTextBodyBlocks(sections);
  const [first, ...rest] = chunk(blocks, CHILDREN_PER_REQUEST);
  const created = await notionRequest<{ id: string }>("POST", "/pages", {
    parent: { database_id: dbId },
    properties: rowProperties(doc, sections),
    children: first ?? [],
  });
  for (const part of rest) {
    await notionRequest("PATCH", `/blocks/${created.id}/children`, {
      children: part,
    });
  }
  return { rowPageId: created.id, outcome: "recorded" };
}

function blockText(
  rich: Array<{ plain_text?: string; text?: { content: string } }> | undefined
): string {
  return (rich ?? [])
    .map((r) => r.plain_text ?? r.text?.content ?? "")
    .join("");
}

/**
 * 行の本文ブロックを読み戻してセクション列に復元する (P2 の読み経路用)。
 * 先頭が目印 heading_2 でなければ throw (別形式の行を黙って解釈しない)。
 */
export async function readStockTextRow(
  rowPageId: string
): Promise<StockTextSection[]> {
  const blocks: HeadingBlock[] = [];
  let cursor: string | null = null;
  for (;;) {
    const qs: string =
      cursor !== null
        ? `?start_cursor=${cursor}&page_size=100`
        : "?page_size=100";
    const res: ChildrenResponse = await notionRequest<ChildrenResponse>(
      "GET",
      `/blocks/${rowPageId}/children${qs}`
    );
    blocks.push(...res.results);
    if (!res.has_more || res.next_cursor === null) break;
    cursor = res.next_cursor;
  }
  const [marker, ...rest] = blocks;
  if (
    marker?.type !== "heading_2" ||
    !blockText(marker.heading_2?.rich_text).startsWith(TEXT_BODY_MARKER)
  ) {
    throw new Error(
      `Notion 有報テキスト行の形式が違う (先頭が目印ではない): page=${rowPageId}`
    );
  }
  const sections: StockTextSection[] = [];
  let current: StockTextSection | null = null;
  const flush = () => {
    if (current) sections.push(current);
    current = null;
  };
  for (const b of rest) {
    if (b.type === "heading_3") {
      flush();
      const heading = blockText(b.heading_3?.rich_text);
      const m = /^(.*) \(([^()]+)\)$/.exec(heading);
      current = {
        itemName: m ? m[1]! : heading,
        sectionKey: m ? m[2]! : "",
        text: "",
      };
    } else if (b.type === "code" && current) {
      current.text += blockText(b.code?.rich_text);
    } else if (b.type === "code" && !current) {
      throw new Error(
        `Notion 有報テキスト行の形式が違う (見出しの無い本文): page=${rowPageId}`
      );
    }
    // 目印以外の heading_2 等の混入は無視しない — 未知形式として落とす
    else {
      throw new Error(
        `Notion 有報テキスト行の形式が違う (想定外ブロック ${b.type}): page=${rowPageId}`
      );
    }
  }
  flush();
  return sections;
}
