/**
 * 東北大『日本語評価極性辞書』(oseti リポ JSON 化版) のロード + 整形。
 *
 * - 用言 (pn_wago.json): キー = 用言 (動詞/形容詞・基本形/活用形), 値 = ラベル
 *     - ラベル "ネガ（経験）" / "ネガ（評価）" → -1
 *     - ラベル "ポジ（経験）" / "ポジ（評価）" → +1
 *     - "中立 (経験)" 等は除外 (0 を返さない — 判定対象外)
 * - 名詞 (pn_noun.json): キー = 名詞, 値 = "p" (positive) / "n" (negative) / "e" (neutral)
 *     - "p" → +1, "n" → -1, "e" → 除外
 *
 * プロセス内で 1 度だけ JSON.parse して Map 化 (再呼出しはキャッシュ返却)。
 * 帰属表記は dictionary/LICENSE.md と UI disclaimer で行う。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export type Polarity = 1 | -1;

interface DictMaps {
  wago: Map<string, Polarity>;
  noun: Map<string, Polarity>;
}

let cached: DictMaps | null = null;

function dictDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // services/ir-catalog/src/services/pdf-sentiment/dict/ → dictionary/
  return resolve(here, "..", "dictionary");
}

function buildWago(): Map<string, Polarity> {
  const path = resolve(dictDir(), "pn_wago.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  const map = new Map<string, Polarity>();
  for (const [keyRaw, label] of Object.entries(raw)) {
    // oseti の用言キーは "あきらめる た" のように活用形を空白で繋いだ複合表記。
    // 形態素解析では基本形/活用後で複数形が出るので、各分割形ごとに登録する。
    if (label.startsWith("ポジ")) {
      for (const k of splitWagoKey(keyRaw)) map.set(k, 1);
    } else if (label.startsWith("ネガ")) {
      for (const k of splitWagoKey(keyRaw)) map.set(k, -1);
    }
    // それ以外 (中立等) は登録しない
  }
  return map;
}

function splitWagoKey(key: string): string[] {
  // "あきらめる た" のような空白区切りは「あきらめる」「た」の連語で 1 表現を成す
  // が、辞書側の精度を保つため、まず分かち書き全体を 1 つのキーとして登録し、
  // 加えて先頭の単体形 (動詞本体) も登録する。
  const parts = key.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length <= 1) return [key];
  return [key, parts[0]];
}

function buildNoun(): Map<string, Polarity> {
  const path = resolve(dictDir(), "pn_noun.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  const map = new Map<string, Polarity>();
  for (const [k, v] of Object.entries(raw)) {
    if (v === "p") map.set(k, 1);
    else if (v === "n") map.set(k, -1);
    // "e" (中立) は登録しない
  }
  return map;
}

export function loadDict(): DictMaps {
  if (cached) return cached;
  cached = { wago: buildWago(), noun: buildNoun() };
  return cached;
}
