/**
 * ライセンス判定。公開面に出してよいものを**列レベル**で決める。
 *
 * 行の license_tag 1列では足りない。core_stocks は EDINETコードリスト由来
 * (commercial-ok) と JPX data_j.xls 由来 (personal-only) を1行に混在させており、
 * 行単位で許可すると market/sector33 まで公開面に出てしまう。
 */

export const COMMERCIAL_OK = "commercial-ok";
export const FACTUAL_CITE = "factual-cite";
export const PERSONAL_ONLY = "personal-only";

/** 公開面に「全量」出してよいタグ。 */
export function isPublishableInFull(tag: string | null | undefined): boolean {
  return tag === COMMERCIAL_OK;
}

/** 公開面に「メタデータと原典リンクだけ」出してよいタグ。 */
export function isPublishableAsMetadata(tag: string | null | undefined): boolean {
  return tag === COMMERCIAL_OK || tag === FACTUAL_CITE;
}

/**
 * 公開面に出してはいけない行か。
 * **未知のタグは出さない側に倒す**（新しいソースを足したときに既定で漏れない）。
 */
export function isRestricted(tag: string | null | undefined): boolean {
  return !isPublishableAsMetadata(tag);
}

/**
 * 公開面で伏せる列。値を null に潰し、キー自体は残す
 * （消すとクライアントが「その列が存在しない」と誤解するため）。
 */
export const RESTRICTED_COLUMNS: Record<string, readonly string[]> = {
  // JPX data_j.xlsx 由来。EDINETコードリスト由来の列とは出自が違う。
  //
  // **`sector33` はここに入らない。** 名前が似ているので `sector` と同じ扱いに
  // したくなるが、`sector` は kabulab-cf `src/cron/universe.ts` が JPX の33業種を
  // 書く既存列 (personal-only)、`sector33` は stockStock が EDINET コードリストの
  // 「提出者業種」を書く新設列 (commercial-ok) で、writer も一次ソースも違う。
  // 正本は `cloud_store/schema.py` の MIXED_LICENSE_COLUMNS と
  // `tests/fixtures/contracts/d1-license-map.json`。
  //
  // `core_stocks.sector33` は stockStock の master_sync (EDINET, 2026-09-13〜) が
  // 充填済み (2026-09-24 時点で現役普通株 3,700 件は NULL 0 件)。公開面の業種は
  // 既に `sector` から `sector33` へ切替済み (src/shared/db/public-columns.ts)。
  // 派生フラグも原入力の制約を継承する。WHERE 述語と値の公開は別の判断。
  core_stocks: ["market", "sector", "instrument_type", "is_active", "is_yutai"],
  // みんかぶ掲載文とその派生。私的利用の列を公開面では返さない。
  yutai_benefits: ["description", "short_summary", "estimated_value"],
};

export function redactColumns<T extends Record<string, unknown>>(
  table: string,
  row: T,
): T {
  const restricted = RESTRICTED_COLUMNS[table];
  if (!restricted) return row;
  const out = { ...row } as Record<string, unknown>;
  for (const column of restricted) {
    if (column in out) out[column] = null;
  }
  return out as T;
}
