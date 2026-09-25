/**
 * 単語帳の「今の有効な版」の解決。設計: docs/005-yuho-quant-business-tags.md §3.2。
 *
 * 台帳 (`事業タグ単語帳（台帳）`) が正本。台帳に「版」種別の記録が 1 つも無い
 * 初回実行時のみ、コード管理の v1 (`./vocabulary/v1.json`) を「版 v1（有効）」
 * として台帳へ 1 回だけ投入する。v1.json は別工程 (単語帳データ整備) で
 * 追加される想定で、このモジュールはまだ存在しない前提で書く
 * (静的 import すると tsc の `resolveJsonModule` がファイル欠落で失敗するため、
 * `node:fs` で実行時に読む — 欠落時は明示的に throw する。ルール2)。
 *
 * 有効な版がちょうど 1 つでなければ throw する (0 個・2 個以上は運用異常)。
 */
import { readFileSync } from "node:fs";
import {
  createLedgerEntry,
  ensureLedgerDb,
  listLedgerEntries,
  readLedgerJson,
  type LedgerEntry,
} from "../../../../src/shared/notion-archive/index.js";
import { parseVocabulary } from "./vocabulary/load.js";
import type { Vocabulary } from "./vocabulary/schema.js";

export interface ActiveVocabularyResult {
  vocab: Vocabulary;
  entry: LedgerEntry;
  /** この呼び出しが v1 の初回投入を行ったか (ログ用) */
  seeded: boolean;
}

/**
 * `services/yuho-quant/src/biztag/vocabulary/v1.json` を読む
 * (別工程が用意するまで存在しない。実行時に無ければ明示的に throw する)。
 */
function loadSeedVocabularyV1(): Vocabulary {
  const path = new URL("./vocabulary/v1.json", import.meta.url);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    throw new Error(
      "単語帳 v1 の初期データ (services/yuho-quant/src/biztag/vocabulary/v1.json) が" +
        "見つかりません。別工程 (単語帳データ整備) で用意されるまで biztag は実行できません。",
      { cause: e }
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error("vocabulary/v1.json が JSON として解釈できません。", { cause: e });
  }
  return parseVocabulary(json);
}

/**
 * 今の有効な単語帳を解決する。台帳に「版」が 1 件も無ければ v1 を初回投入する。
 * `recordedAt` は台帳に新規投入する場合の「記録日」(JST, YYYY-MM-DD)。
 */
export async function resolveActiveVocabulary(recordedAt: string): Promise<ActiveVocabularyResult> {
  const dbId = await ensureLedgerDb();
  let versions = await listLedgerEntries(dbId, { kind: "版" });
  let seeded = false;

  if (versions.length === 0) {
    const seed = loadSeedVocabularyV1();
    await createLedgerEntry(dbId, {
      name: "版 v1",
      kind: "版",
      state: "有効",
      version: "v1",
      reason: "初期投入 (コード管理の vocabulary/v1.json を台帳へ1回だけ記録)",
      diff: "",
      rollbackFrom: null,
      json: seed,
      recordedAt,
    });
    seeded = true;
    versions = await listLedgerEntries(dbId, { kind: "版" });
  }

  const active = versions.filter((v) => v.state === "有効");
  if (active.length !== 1) {
    throw new Error(
      `resolveActiveVocabulary: 有効な単語帳の版が ${active.length} 件です (ちょうど1件である必要があります)`
    );
  }
  const entry = active[0];
  const json = await readLedgerJson(entry); // ハッシュ照合込み (不一致は LedgerIntegrityError)
  const vocab = parseVocabulary(json);
  return { vocab, entry, seeded };
}
