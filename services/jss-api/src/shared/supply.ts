/**
 * 需給 API の出典境界。返却データの種類から `meta.attribution` の
 * sources を決める。writer 契約 (`pipeline/.../models.py SupplyPoint` /
 * `docs/CF-CANONICAL-DESIGN.md`): `data_type` / `series` キーは
 * `jsf_zandaka` / `jsf_shina` / `jpx_margin` の3種のみ。
 *
 * - 既知3種以外 (未知・非文字列) は成功扱いしない (throw)。
 *   REST では返却データ由来の throw は 500、filter 由来は
 *   `SupplyFilterError` を捕まえて 400。MCP は全て isError。
 * - 実際に返す非空データだけから算出する。全て空なら `[]`
 *   (licenses `personal-only` は維持し、呼び出し側で付ける)。
 */

export const SUPPLY_TYPES = ["jsf_zandaka", "jsf_shina", "jpx_margin"] as const;
export type SupplyDataType = (typeof SUPPLY_TYPES)[number];

const KNOWN_TYPES: ReadonlySet<string> = new Set(SUPPLY_TYPES);

/** クライアント由来の filter 不正。REST は 400 で返す (返却データ由来は 500)。 */
export class SupplyFilterError extends Error {
  readonly filterName: string;
  constructor(filterName: string, value: unknown) {
    super(`需給 filter が不正: ${filterName}=${String(value)}`);
    this.name = "SupplyFilterError";
    this.filterName = filterName;
  }
}

/** 既知3種を厳密に検証する。未知・非文字列は throw (成功扱いしない)。 */
export function assertKnownSupplyType(value: unknown, what: string): SupplyDataType {
  if (typeof value !== "string" || !KNOWN_TYPES.has(value)) {
    throw new Error(`未知の需給種類 (${what}): ${String(value)}`);
  }
  return value as SupplyDataType;
}

/**
 * 厳密 map: `jsf_*` → 日証金、`jpx_margin` → JPX。
 * 返値は `envelope.ts` の `ATTRIBUTION` のキー (文言はそちらが正本)。
 */
export function sourceKeyOfSupplyType(dataType: SupplyDataType): "日証金" | "JPX" {
  return dataType === "jpx_margin" ? "JPX" : "日証金";
}

/**
 * latest 行配列 → sources。固定順 [日証金, JPX]。
 * 未知・非文字列の行 type は throw。空配列なら `[]`。
 */
export function supplySourcesFromLatest(rows: ReadonlyArray<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(sourceKeyOfSupplyType(assertKnownSupplyType(row.data_type, "jss_supply_latest.data_type")));
  }
  return ["日証金", "JPX"].filter((s) => seen.has(s));
}

/**
 * filter 適用後の series オブジェクト → sources。非空の既知系列のみ。
 * 未知 key は空配列でも throw。値が配列でない key も throw。
 */
export function supplySourcesFromSeries(series: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  for (const [key, points] of Object.entries(series)) {
    const dataType = assertKnownSupplyType(key, `series key: ${key}`);
    if (!Array.isArray(points)) throw new Error(`需給系列が配列でない: ${key}`);
    if (points.length === 0) continue;
    seen.add(sourceKeyOfSupplyType(dataType));
  }
  return ["日証金", "JPX"].filter((s) => seen.has(s));
}

/** 検証済みの需給 point。`d` は YYYY-MM-DD 文字列で確定している。 */
export interface SupplyPoint {
  d: string;
  [key: string]: unknown;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 返却対象の1系列を検証して配列として返す (日付 filter の前に呼ぶ)。
 * 未知 key・非配列値は throw。さらに全 point を non-null 非配列
 * オブジェクトかつ `d: string YYYY-MM-DD` で検証する。呼び出し側は
 * 検証済み `p.d` を直接比較し、fallback (`??`) や `String()` 強制をしない
 * ({} / d 欠損・非文字列の黙殺を防ぐ)。
 * filter で除外される key は検証しない (応答に含まれないものは契約の対象外)。
 */
export function seriesPointsArray(key: string, value: unknown): SupplyPoint[] {
  assertKnownSupplyType(key, `series key: ${key}`);
  if (!Array.isArray(value)) throw new Error(`需給系列が配列でない: ${key}`);
  for (const point of value) {
    if (typeof point !== "object" || point === null || Array.isArray(point)) {
      throw new Error(`需給 point が不正 (series=${key})`);
    }
    const d = (point as Record<string, unknown>).d;
    if (typeof d !== "string" || !DATE_RE.test(d)) {
      throw new Error(`需給 point の d が YYYY-MM-DD でない (series=${key})`);
    }
  }
  return value as SupplyPoint[];
}

/**
 * R2 payload の `series` の存在・形状を検証する。
 * `?? {}` で欠損を黙殺しない (ルール2)。欠損・非オブジェクトは throw。
 */
export function assertSeriesObject(series: unknown): Record<string, unknown> {
  if (typeof series !== "object" || series === null || Array.isArray(series)) {
    throw new Error("需給 payload に series オブジェクトが無い");
  }
  return series as Record<string, unknown>;
}

/**
 * 任意 filter の検証と正規化。生入力のまま渡すこと (呼び出し側で
 * `String()` 変換・truthiness 判定を先にしない。`false` / `0` が未指定に
 * 消えたり `['jpx_margin']` が正規型に化けたりするのを防ぐ)。
 *
 * `undefined` だけが省略扱い。`null`・非文字列・空文字列は不正。
 * `data_type` / `series` は既知3種、`from` / `to` は YYYY-MM-DD
 * (ohlcv と同一書式・同一正規表現)。
 * 不正は `SupplyFilterError` (REST 400 / MCP isError)。
 */
export function parseSupplyFilter(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") throw new SupplyFilterError(name, value);
  if (name === "data_type" || name === "series") {
    if (!KNOWN_TYPES.has(value)) throw new SupplyFilterError(name, value);
    return value;
  }
  if (name === "from" || name === "to") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new SupplyFilterError(name, value);
    return value;
  }
  // name は呼び出し側の固定値 (クライアント由来でない) なので到達不能のはず。
  // 万一到達したら実装バグとして 500 側へ落とす。
  throw new Error(`未知の需給 filter 名: ${name}`);
}
