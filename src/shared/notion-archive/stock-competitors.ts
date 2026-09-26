/**
 * 「銘柄マスタ（補足）」への競合他社 relation (自己参照)。
 * 設計: docs/005-yuho-quant-business-tags.md「競合他社」節 §4 保存。
 *
 * `stock-supplement.ts` の DB (同じ dbId) に、以下の列だけを追加する
 * (「足りない列だけ足す」流儀は `stock-supplement.ts` と同じ)。
 * DB が既に存在する前提 (`ensureSupplementDb` で解決した dbId を渡す) なので、
 * 自己参照 relation (`database_id` = 自分自身) の作成順序問題は起きない
 * (新規作成時のみ「先に DB を作ってから自己参照列を PATCH で足す」順序を守る。
 * `ensureSupplementDb` が返す dbId は作成直後でも既に確定した ID)。
 *
 * 保存する列は最小限 (設計書 §4 の運営決定): 競合他社そのもの (relation) と、
 * 「いつ・どの書類で判定したか」を追跡するための 3 メタ列だけ。
 * 対称性の扱い: A の視点で判定した競合を A→B の relation として書くだけで、
 * B 側には自動で反映しない (設計書 §4 の運営決定。双方が互いを競合と見なす
 * 保証は無いため)。
 */
import { notionRequest } from "./client.js";
import { splitRichText, joinRichText } from "./rich-text.js";

export const COMPETITOR_PROPS = {
  competitors: "競合他社",
  judgedAt: "競合判定日",
  version: "競合判定の版",
  judgedDocId: "競合判定書類ID",
} as const;

interface NotionPropertyDef {
  id: string;
  type: string;
}
interface DbSchemaResponse {
  id: string;
  properties: Record<string, NotionPropertyDef>;
}

function extractIds(properties: Record<string, NotionPropertyDef>): Record<string, string> {
  return Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, v.id]));
}

/**
 * 競合他社関連の列を確保する (無ければ追加。既存があれば触らない)。
 * `dbId` は `ensureSupplementDb` が解決した「銘柄マスタ（補足）」の dbId。
 */
export async function ensureCompetitorColumns(dbId: string): Promise<Record<string, string>> {
  const schema = await notionRequest<DbSchemaResponse>("GET", `/databases/${dbId}`);
  const patch: Record<string, unknown> = {};
  if (!(COMPETITOR_PROPS.competitors in schema.properties)) {
    patch[COMPETITOR_PROPS.competitors] = {
      relation: { database_id: dbId, type: "single_property", single_property: {} },
    };
  }
  if (!(COMPETITOR_PROPS.judgedAt in schema.properties)) {
    patch[COMPETITOR_PROPS.judgedAt] = { date: {} };
  }
  if (!(COMPETITOR_PROPS.version in schema.properties)) {
    patch[COMPETITOR_PROPS.version] = { rich_text: {} };
  }
  if (!(COMPETITOR_PROPS.judgedDocId in schema.properties)) {
    patch[COMPETITOR_PROPS.judgedDocId] = { rich_text: {} };
  }
  if (Object.keys(patch).length === 0) {
    return extractIds(schema.properties);
  }
  const patched = await notionRequest<DbSchemaResponse>("PATCH", `/databases/${dbId}`, { properties: patch });
  return extractIds(patched.properties);
}

export interface CompetitorMeta {
  pageId: string;
  stockCode: string;
  /** 現在張られている競合他社の relation 先ページ ID。 */
  competitorPageIds: string[];
  judgedAt: string | null;
  /** 判定に使ったアルゴリズム版 (`candidateVersion` + jev モデル名の組)。 */
  version: string | null;
  /** 判定に使った有報書類ID (`有報書類ID` と比較し、書類が変わったら再判定する)。 */
  judgedDocId: string | null;
}

interface NotionPageProperty {
  rich_text?: Array<{ plain_text?: string }>;
  date?: { start?: string } | null;
  relation?: Array<{ id: string }>;
}
interface NotionPage {
  id: string;
  properties: Record<string, NotionPageProperty>;
}
interface QueryResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * 競合他社の判定状況 (メタ列だけ) を読む。`codePropertyId`/`codeColumnName` は
 * 呼び出し側 (`stock-supplement.ts` の `SUPPLEMENT_PROPS.code`) が渡す
 * (このモジュールは補足行の列名を知らない設計に保つ)。
 */
export async function loadCompetitorMeta(
  dbId: string,
  propertyIds: Record<string, string>,
  codeColumnName: string
): Promise<CompetitorMeta[]> {
  const columnNames = [
    codeColumnName,
    COMPETITOR_PROPS.competitors,
    COMPETITOR_PROPS.judgedAt,
    COMPETITOR_PROPS.version,
    COMPETITOR_PROPS.judgedDocId,
  ];
  const ids = columnNames.map((name) => {
    const id = propertyIds[name];
    if (!id) throw new Error(`loadCompetitorMeta: プロパティ ID が見つかりません: ${name}`);
    return id;
  });
  const qs = ids.map((id) => `filter_properties=${encodeURIComponent(id)}`).join("&");

  const rows: CompetitorMeta[] = [];
  let cursor: string | undefined;
  for (;;) {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await notionRequest<QueryResponse>("POST", `/databases/${dbId}/query?${qs}`, body);
    for (const page of res.results) {
      const p = page.properties;
      rows.push({
        pageId: page.id,
        stockCode: joinRichText(p[codeColumnName]?.rich_text),
        competitorPageIds: (p[COMPETITOR_PROPS.competitors]?.relation ?? []).map((r) => r.id),
        judgedAt: p[COMPETITOR_PROPS.judgedAt]?.date?.start ?? null,
        version: joinRichText(p[COMPETITOR_PROPS.version]?.rich_text) || null,
        judgedDocId: joinRichText(p[COMPETITOR_PROPS.judgedDocId]?.rich_text) || null,
      });
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return rows;
}

export interface WriteCompetitorRelationInput {
  /** 競合と判定した会社群 (relation 先ページ ID)。設計上 20 件程度まで。 */
  competitorPageIds: string[];
  judgedAt: string;
  version: string;
  judgedDocId: string;
}

const RELATION_MAX = 100;

/**
 * A の行に競合他社の relation とメタ列を書く。**A→B の一方向のみ**
 * (B 側には反映しない。ヘッダコメント参照)。
 */
export async function writeCompetitorRelation(pageId: string, input: WriteCompetitorRelationInput): Promise<void> {
  if (input.competitorPageIds.length > RELATION_MAX) {
    throw new Error(
      `writeCompetitorRelation: 競合他社の件数が上限 ${RELATION_MAX} を超えます (${input.competitorPageIds.length} 件)`
    );
  }
  await notionRequest("PATCH", `/pages/${pageId}`, {
    properties: {
      [COMPETITOR_PROPS.competitors]: { relation: input.competitorPageIds.map((id) => ({ id })) },
      [COMPETITOR_PROPS.judgedAt]: { date: { start: input.judgedAt } },
      [COMPETITOR_PROPS.version]: { rich_text: splitRichText(input.version) },
      [COMPETITOR_PROPS.judgedDocId]: { rich_text: splitRichText(input.judgedDocId) },
    },
  });
}
