/**
 * G1・前向き検証向けの読み取り専用データ層 (内部面 `jss-api-private` のみ)。
 *
 * REST (`routes.ts` の `mountPrivate`) と MCP (`mcp.ts`) が同じ関数を共有する。
 * 既存契約に揃える:
 * - 欠損は捏造しない。壊れた保存値 (未知の license_tag / kind、不正な日付・
 *   JSON・R2 payload) は成功扱いにせず throw する (REST 500 / MCP isError)。
 * - クライアント由来の filter 不正は `G1FilterError` (REST 400 / MCP isError)。
 *   `undefined` だけが省略扱いで、`null`・非文字列・空文字列は不正
 *   (`supply.ts` の `parseSupplyFilter` と同じ規律)。
 * - 銘柄コードの検証自体は呼び出し側が `routes.ts` の `isValidCode` /
 *   `parseCodes` で行う (既存 fetcher と同じく、ここでは検証済み前提)。
 * - 日付 filter は `YYYY-MM-DD` の実在する暦日のみ。epoch 列
 *   (`ir_disclosures.pubdate` / `jss_financial_forecasts.disclosed_at`) への
 *   適用は JST の暦日 [00:00, 翌 00:00) として両端含む。
 */
import { boundedBytes } from "./jpx-margin";

/** クライアント由来の filter 不正。REST は 400 (保存データ由来の throw は 500)。 */
export class G1FilterError extends Error {
  readonly field: string;
  constructor(field: string, value: unknown) {
    super(`filter が不正: ${field}=${String(value)}`);
    this.name = "G1FilterError";
    this.field = field;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 実在する暦日の `YYYY-MM-DD` か (`supply.ts` と同一判定)。 */
export function isRealDate(value: string): boolean {
  return DATE_RE.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
}

/** 任意の日付 filter。`undefined` だけが省略。 */
export function parseG1Date(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isRealDate(value)) {
    throw new G1FilterError(name, value);
  }
  return value;
}

/** `from > to` は空範囲を黙って返さず不正にする。 */
export function assertG1Range(from: string | undefined, to: string | undefined): void {
  if (from && to && from > to) throw new G1FilterError("from", from);
}

/** JST 暦日の開始 epoch 秒。`to` 側は +86400 を排他上限に使う。 */
export function jstDayStartEpoch(date: string): number {
  const ms = Date.parse(`${date}T00:00:00+09:00`);
  if (!Number.isFinite(ms)) throw new Error(`JST 日変換ができない: ${date}`);
  return Math.floor(ms / 1000);
}

export const KNOWN_LICENSE_TAGS: ReadonlySet<string> = new Set([
  "commercial-ok",
  "factual-cite",
  "personal-only",
]);

/** 保存行の license_tag が既知3種でなければ出さない (未知は成功扱いしない)。 */
export function assertKnownLicenseTag(value: unknown, what: string): string {
  if (typeof value !== "string" || !KNOWN_LICENSE_TAGS.has(value)) {
    throw new Error(`未知の license_tag (${what}): ${String(value)}`);
  }
  return value;
}

/** 任意の非空文字列 filter (titleContains / tag 等)。 */
export function parseG1Text(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") throw new G1FilterError(name, value);
  return value;
}

function inPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

// ---------------------------------------------------------------------------
// 適時開示一覧 (ir_disclosures、表全体が factual-cite)
// ---------------------------------------------------------------------------

export interface DisclosuresOptions {
  code?: string;
  from?: string;
  to?: string;
  titleContains?: string;
  tag?: string;
  limit: number;
  cursor?: string;
}

/** カーソルは `"<pubdate epoch>:<id>"`。呼び出し側は不透明値としてそのまま返す。 */
export function parseDisclosuresCursor(value: unknown): { pubdate: number; id: number } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new G1FilterError("cursor", value);
  const m = /^(\d+):(\d+)$/.exec(value);
  if (!m) throw new G1FilterError("cursor", value);
  const pubdate = Number(m[1]);
  const id = Number(m[2]);
  if (!Number.isSafeInteger(pubdate) || !Number.isSafeInteger(id) || id <= 0) {
    throw new G1FilterError("cursor", value);
  }
  return { pubdate, id };
}

function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function parseTags(raw: unknown, tdnetId: unknown): string[] {
  if (typeof raw !== "string") {
    throw new Error(`ir_disclosures.tags が文字列でない (tdnet_id=${String(tdnetId)})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`ir_disclosures.tags が JSON でない (tdnet_id=${String(tdnetId)})`);
  }
  if (!Array.isArray(parsed) || parsed.some((t) => typeof t !== "string")) {
    throw new Error(`ir_disclosures.tags が文字列配列でない (tdnet_id=${String(tdnetId)})`);
  }
  return parsed as string[];
}

/**
 * 開示1件=1行を新しい順 (`pubdate DESC, id DESC`) で返す。
 * `code` は `core_stocks.code` (4文字正準形) で引き、TDnet 表記の
 * `company_code` (5文字) も原文のまま併記する。本文テキスト・センチメント・
 * Notion ID は返さない (事実メタのみ)。
 */
export async function fetchDisclosures(
  db: D1Database,
  options: DisclosuresOptions,
): Promise<{ rows: Record<string, unknown>[]; cursor: string | null }> {
  assertG1Range(options.from, options.to);
  const cursor = parseDisclosuresCursor(options.cursor);
  const conds: string[] = [];
  const params: unknown[] = [];
  if (options.code) {
    conds.push("s.code = ?");
    params.push(options.code);
  }
  if (options.from) {
    conds.push("d.pubdate >= ?");
    params.push(jstDayStartEpoch(options.from));
  }
  if (options.to) {
    conds.push("d.pubdate < ?");
    params.push(jstDayStartEpoch(options.to) + 86400);
  }
  if (options.titleContains) {
    conds.push("d.title LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(options.titleContains)}%`);
  }
  if (options.tag) {
    conds.push(
      "(d.primary_tag = ? OR EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = ?))",
    );
    params.push(options.tag, options.tag);
  }
  if (cursor) {
    conds.push("(d.pubdate < ? OR (d.pubdate = ? AND d.id < ?))");
    params.push(cursor.pubdate, cursor.pubdate, cursor.id);
  }
  params.push(options.limit + 1);
  const { results } = await db.prepare(
    "SELECT s.code AS code, d.company_code, d.company_name, d.tdnet_id, d.title," +
      " d.pubdate, d.document_url, d.xbrl_url, d.markets_string, d.tags," +
      " d.primary_tag, d.ingested_at, d.id AS _id" +
      " FROM ir_disclosures d JOIN core_stocks s ON s.id = d.stock_id" +
      (conds.length > 0 ? ` WHERE ${conds.join(" AND ")}` : "") +
      " ORDER BY d.pubdate DESC, d.id DESC LIMIT ?",
  ).bind(...params).all<Record<string, unknown>>();
  const page = results.slice(0, options.limit);
  const rows = page.map((r) => {
    if (typeof r.pubdate !== "number" || !Number.isFinite(r.pubdate)) {
      throw new Error(`ir_disclosures.pubdate が epoch 数値でない (tdnet_id=${String(r.tdnet_id)})`);
    }
    const { _id, tags, ...rest } = r;
    return {
      ...rest,
      xbrl_url: r.xbrl_url ?? null,
      has_xbrl: r.xbrl_url !== null && r.xbrl_url !== undefined,
      tags: parseTags(tags, r.tdnet_id),
    };
  });
  const last = page[page.length - 1];
  const next = results.length > options.limit && last
    ? `${String(last.pubdate)}:${String(last._id)}`
    : null;
  return { rows, cursor: next };
}

// ---------------------------------------------------------------------------
// 財務要約 (jss_financials、行ごとに license_tag)
// ---------------------------------------------------------------------------

/**
 * 返す列は明示リストのみ (`SELECT *` はしない)。内部識別子
 * (`stock_id` / Notion の `raw_page_id`) は出さない。
 * 発行済株式数の列はこの表に存在しない (調査結果は README 参照)。
 */
export const FINANCIALS_COLUMNS = [
  "code", "fiscal_period_end", "disclosure_type", "consolidated",
  "accounting_standard", "net_sales", "operating_income", "ordinary_income",
  "net_income", "eps", "bps", "roe_pct", "roa_pct", "equity_ratio_pct",
  "cf_operating", "cf_investing", "cf_financing", "dps_actual", "dps_forecast",
  "forecast_net_sales", "forecast_operating_income", "forecast_ordinary_income",
  "forecast_net_income", "forecast_eps", "disclosed_at", "doc_id",
  "raw_sha256", "source", "license_tag", "data_date", "fetched_at", "quality",
] as const;

/**
 * 銘柄ごとの財務要約 (実績+短信予想列) を期末の新しい順で返す。
 * `limit` は**1銘柄あたり**の上限 (銘柄内 `ROW_NUMBER` で切る)。
 * `from` / `to` は `fiscal_period_end` (期末日) への両端含む絞り込み。
 * 行の `license_tag` が既知3種以外なら throw する。
 */
export async function fetchFinancialsByCodes(
  db: D1Database,
  codes: string[],
  options: { from?: string; to?: string; limit: number },
): Promise<Record<string, unknown>[]> {
  assertG1Range(options.from, options.to);
  const cols = FINANCIALS_COLUMNS.map((c) => `f.${c}`).join(", ");
  const conds = [`f.code IN (${inPlaceholders(codes.length)})`];
  const params: unknown[] = [...codes];
  if (options.from) {
    conds.push("f.fiscal_period_end >= ?");
    params.push(options.from);
  }
  if (options.to) {
    conds.push("f.fiscal_period_end <= ?");
    params.push(options.to);
  }
  params.push(options.limit);
  const { results } = await db.prepare(
    `SELECT ${FINANCIALS_COLUMNS.join(", ")}, name FROM (` +
      `SELECT ${cols}, s.name AS name, ROW_NUMBER() OVER (PARTITION BY f.code` +
      " ORDER BY f.fiscal_period_end DESC, f.disclosure_type ASC, f.consolidated ASC) AS rn" +
      " FROM jss_financials f LEFT JOIN core_stocks s ON s.code = f.code" +
      ` WHERE ${conds.join(" AND ")}) WHERE rn <= ?` +
      " ORDER BY code ASC, fiscal_period_end DESC, disclosure_type ASC, consolidated ASC",
  ).bind(...params).all<Record<string, unknown>>();
  for (const row of results) {
    assertKnownLicenseTag(row.license_tag, `jss_financials.license_tag code=${String(row.code)}`);
  }
  return results;
}

// ---------------------------------------------------------------------------
// 会社予想の開示単位履歴 (jss_financial_forecasts、行ごとに license_tag)
// ---------------------------------------------------------------------------

export const FORECAST_COLUMNS = [
  "code", "doc_id", "disclosed_at", "target_period_end", "forecast_scope",
  "consolidated", "forecast_net_sales", "forecast_operating_income",
  "forecast_ordinary_income", "forecast_net_income", "forecast_eps",
  "dps_forecast", "dps_target_period_end", "source_period_end",
  "source_disclosure_type", "raw_sha256", "source", "license_tag", "fetched_at",
] as const;

/**
 * 1銘柄の予想履歴を**全行**、開示時刻の古い順で返す
 * (`jp_forecast_latest` の最新1行に対する時系列版。列ごとの合成はしない)。
 * `from` / `to` は `disclosed_at` への JST 暦日絞り込みで、開示時刻が
 * NULL の行は範囲指定時に対象外になる (範囲内と証明できないため)。
 * 並びは `(disclosed_at IS NULL), disclosed_at ASC, fetched_at ASC, doc_id ASC`。
 */
export async function fetchForecastHistory(
  db: D1Database,
  code: string,
  options: { from?: string; to?: string; limit: number },
): Promise<Record<string, unknown>[]> {
  assertG1Range(options.from, options.to);
  const cols = FORECAST_COLUMNS.map((c) => `f.${c}`).join(", ");
  const conds = ["f.code = ?"];
  const params: unknown[] = [code];
  if (options.from) {
    conds.push("f.disclosed_at >= ?");
    params.push(jstDayStartEpoch(options.from));
  }
  if (options.to) {
    conds.push("f.disclosed_at < ?");
    params.push(jstDayStartEpoch(options.to) + 86400);
  }
  params.push(options.limit);
  const { results } = await db.prepare(
    `SELECT ${cols}, s.name AS name` +
      " FROM jss_financial_forecasts f LEFT JOIN core_stocks s ON s.code = f.code" +
      ` WHERE ${conds.join(" AND ")}` +
      " ORDER BY (f.disclosed_at IS NULL), f.disclosed_at ASC, f.fetched_at ASC, f.doc_id ASC" +
      " LIMIT ?",
  ).bind(...params).all<Record<string, unknown>>();
  for (const row of results) {
    assertKnownLicenseTag(row.license_tag, `jss_financial_forecasts.license_tag code=${String(row.code)}`);
  }
  return results;
}

// ---------------------------------------------------------------------------
// 上場・廃止・市場変更イベント (universe_official_events、personal-only)
// ---------------------------------------------------------------------------

export const EVENT_KINDS = ["delist", "listing", "transfer"] as const;
const EVENT_KIND_SET: ReadonlySet<string> = new Set(EVENT_KINDS);

export function parseEventKind(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !EVENT_KIND_SET.has(value)) {
    throw new G1FilterError("kind", value);
  }
  return value;
}

/** カーソルは `"<effective_date>:<id>"`。 */
export function parseEventsCursor(value: unknown): { date: string; id: number } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new G1FilterError("cursor", value);
  const m = /^(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(value);
  if (!m || !isRealDate(m[1] as string)) throw new G1FilterError("cursor", value);
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) throw new G1FilterError("cursor", value);
  return { date: m[1] as string, id };
}

export interface UniverseEventsOptions {
  kind?: string;
  from?: string;
  to?: string;
  code?: string;
  limit: number;
  cursor?: string;
}

/** 発効日の新しい順。保存行の kind / 日付が壊れていれば throw する。 */
export async function fetchUniverseEvents(
  db: D1Database,
  options: UniverseEventsOptions,
): Promise<{ rows: Record<string, unknown>[]; cursor: string | null }> {
  assertG1Range(options.from, options.to);
  const cursor = parseEventsCursor(options.cursor);
  const conds: string[] = [];
  const params: unknown[] = [];
  if (options.kind) {
    conds.push("kind = ?");
    params.push(options.kind);
  }
  if (options.code) {
    conds.push("code = ?");
    params.push(options.code);
  }
  if (options.from) {
    conds.push("effective_date >= ?");
    params.push(options.from);
  }
  if (options.to) {
    conds.push("effective_date <= ?");
    params.push(options.to);
  }
  if (cursor) {
    conds.push("(effective_date < ? OR (effective_date = ? AND id < ?))");
    params.push(cursor.date, cursor.date, cursor.id);
  }
  params.push(options.limit + 1);
  const { results } = await db.prepare(
    "SELECT code, kind, effective_date, name, market_from, market_to, source_url," +
      " fetched_at, raw_sha, archive_key, last_seen_fetched_at, id AS _id" +
      " FROM universe_official_events" +
      (conds.length > 0 ? ` WHERE ${conds.join(" AND ")}` : "") +
      " ORDER BY effective_date DESC, id DESC LIMIT ?",
  ).bind(...params).all<Record<string, unknown>>();
  const page = results.slice(0, options.limit);
  const rows = page.map((r) => {
    if (typeof r.kind !== "string" || !EVENT_KIND_SET.has(r.kind)) {
      throw new Error(`universe_official_events.kind が未知: ${String(r.kind)}`);
    }
    if (typeof r.effective_date !== "string" || !isRealDate(r.effective_date)) {
      throw new Error(`universe_official_events.effective_date が不正: ${String(r.effective_date)}`);
    }
    const { _id, ...rest } = r;
    return rest;
  });
  const last = page[page.length - 1];
  const next = results.length > options.limit && last
    ? `${String(last.effective_date)}:${String(last._id)}`
    : null;
  return { rows, cursor: next };
}

// ---------------------------------------------------------------------------
// 銘柄マスタ最小読み取り (core_stocks、列単位ライセンス地図)
// ---------------------------------------------------------------------------

/**
 * 返す列と各列のライセンス。`jss_column_license` の宣言
 * (`MIXED_LICENSE_COLUMNS` / 共有契約 `d1-license-map.json`) と一致させ、
 * テストで契約ファイルと突き合わせる。地図に無い列は選択しない。
 * 業種は EDINET 由来の `sector33` のみ (JPX 由来の `sector` は出さない)。
 */
export const MASTER_COLUMN_LICENSES: Record<string, string> = {
  code: "commercial-ok",
  name: "commercial-ok",
  sector33: "commercial-ok",
  is_active: "personal-only",
};
export const MASTER_COLUMNS = Object.keys(MASTER_COLUMN_LICENSES);
/** 列タグの和集合。最も厳しい `personal-only` を含む。 */
export const MASTER_LICENSES: string[] = [...new Set(Object.values(MASTER_COLUMN_LICENSES))];

export interface UniverseMasterOptions {
  codes?: string[];
  activeOnly: boolean;
  limit: number;
  /** 直前ページ最後の `code`。`codes` 指定時は使わない。 */
  cursor?: string;
}

/**
 * `code ASC` で返す。`codes` 指定時はその集合だけ (カーソルなし)。
 * `is_active` は保存値 1/0 を boolean へ写し、それ以外は壊れた保存値として throw。
 */
export async function fetchUniverseMaster(
  db: D1Database,
  options: UniverseMasterOptions,
): Promise<{ rows: Record<string, unknown>[]; cursor: string | null }> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (options.codes) {
    conds.push(`code IN (${inPlaceholders(options.codes.length)})`);
    params.push(...options.codes);
  }
  if (options.activeOnly) conds.push("is_active = 1");
  if (!options.codes && options.cursor) {
    conds.push("code > ?");
    params.push(options.cursor);
  }
  const paged = !options.codes;
  if (paged) params.push(options.limit + 1);
  const { results } = await db.prepare(
    `SELECT ${MASTER_COLUMNS.join(", ")} FROM core_stocks` +
      (conds.length > 0 ? ` WHERE ${conds.join(" AND ")}` : "") +
      " ORDER BY code ASC" +
      (paged ? " LIMIT ?" : ""),
  ).bind(...params).all<Record<string, unknown>>();
  const page = paged ? results.slice(0, options.limit) : results;
  const rows = page.map((r) => {
    if (r.is_active !== 1 && r.is_active !== 0) {
      throw new Error(`core_stocks.is_active が 1/0 でない (code=${String(r.code)})`);
    }
    return { ...r, is_active: r.is_active === 1 };
  });
  const last = page[page.length - 1];
  const next = paged && results.length > options.limit && last ? String(last.code) : null;
  return { rows, cursor: next };
}

// ---------------------------------------------------------------------------
// R2 10年分日足 (vwap-data の daily/{code}.json、personal-only)
// ---------------------------------------------------------------------------

export interface OhlcvR2Bar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  adj?: number | null;
}

export interface OhlcvR2Result {
  code: string;
  /** 保存オブジェクトの `updated`。保存側に無ければ null (推定で埋めない)。 */
  updated: string | null;
  bars: OhlcvR2Bar[];
  splits: { date: string; ratio: number }[];
}

const OHLCV_R2_MAX_BYTES = 8 * 1024 ** 2;

function assertFiniteNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`daily payload の ${what} が有限数でない`);
  }
  return value;
}

/**
 * `daily/{code}.json` の保存バーを**そのまま**返す。この API は分割調整も
 * 配当調整も適用しない (二重調整をしない)。`bars` は保存された
 * `{date,o,h,l,c,v}` (+ 保存されていれば `adj`)、`splits` は保存された
 * `{date,ratio}` の全件で、両者は分離したまま返す。`from`/`to` は
 * `bars` の日付絞り込み (両端含む) で、`splits` は絞らない
 * (範囲外の分割も呼び出し側の調整判定に要るため)。
 * オブジェクトが無ければ null (→ 404)。形が壊れていれば throw (→ 500)。
 * `proof` / `corporateEvents` 等の保存メタは返さない。
 */
export async function fetchOhlcvR2(
  bucket: R2Bucket,
  code: string,
  options: { from?: string; to?: string },
): Promise<OhlcvR2Result | null> {
  assertG1Range(options.from, options.to);
  const object = await bucket.get(`daily/${code}.json`);
  if (!object) return null;
  const payload = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
      .decode(await boundedBytes(object, OHLCV_R2_MAX_BYTES)),
  ) as unknown;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("daily payload がオブジェクトでない");
  }
  const obj = payload as Record<string, unknown>;
  if (obj.code !== code) {
    throw new Error(`daily payload の code が一致しない: ${String(obj.code)}`);
  }
  let updated: string | null;
  if (!("updated" in obj) || obj.updated === null) {
    updated = null;
  } else if (typeof obj.updated === "string") {
    updated = obj.updated;
  } else {
    throw new Error("daily payload の updated が文字列でない");
  }
  if (!Array.isArray(obj.bars)) throw new Error("daily payload に bars 配列が無い");
  if (!Array.isArray(obj.splits)) throw new Error("daily payload に splits 配列が無い");
  const bars: OhlcvR2Bar[] = obj.bars.map((raw, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`daily bars[${i}] がオブジェクトでない`);
    }
    const b = raw as Record<string, unknown>;
    if (typeof b.date !== "string" || !isRealDate(b.date)) {
      throw new Error(`daily bars[${i}].date が YYYY-MM-DD でない`);
    }
    const bar: OhlcvR2Bar = {
      date: b.date,
      o: assertFiniteNumber(b.o, `bars[${i}].o`),
      h: assertFiniteNumber(b.h, `bars[${i}].h`),
      l: assertFiniteNumber(b.l, `bars[${i}].l`),
      c: assertFiniteNumber(b.c, `bars[${i}].c`),
      v: assertFiniteNumber(b.v, `bars[${i}].v`),
    };
    if ("adj" in b) {
      bar.adj = b.adj === null ? null : assertFiniteNumber(b.adj, `bars[${i}].adj`);
    }
    return bar;
  });
  const splits = obj.splits.map((raw, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`daily splits[${i}] がオブジェクトでない`);
    }
    const s = raw as Record<string, unknown>;
    if (typeof s.date !== "string" || !isRealDate(s.date)) {
      throw new Error(`daily splits[${i}].date が YYYY-MM-DD でない`);
    }
    const ratio = assertFiniteNumber(s.ratio, `splits[${i}].ratio`);
    if (ratio <= 0) throw new Error(`daily splits[${i}].ratio が正でない`);
    return { date: s.date, ratio };
  });
  const ranged = bars.filter(
    (b) => (!options.from || b.date >= options.from) && (!options.to || b.date <= options.to),
  );
  return { code, updated, bars: ranged, splits };
}



