/**
 * 適時開示 PDF テキストから数値を抽出するための共有ユーティリティ。
 *
 * 適時開示は東証様式テンプレに強く拘束されるため、ある程度パターン化された
 * 数値抽出が高精度で動く (ルール1: 推測ではなく確実に抽出できた値のみを使う)。
 *
 * - **マイナス記号** の揺らぎ: `-` (ASCII), `−` (U+2212 マイナス記号),
 *   `△` (U+25B3 三角), `▲` (U+25B2 黒三角), `▴` (U+25B4) を全て負として扱う
 * - **数値表記**: 半角数字 + 全角数字、3桁カンマ区切り、小数点
 * - **単位**: 円 / 百万円 / 千円 / 億円 / 兆円 — 内部では「円」に正規化
 *
 * 抽出できない数値は **NaN** を返す (`0` で埋めない — ルール1)。
 */

/** 全角数字 → 半角、`△`/`▲`/`−` → `-` の正規化 */
export function normalizeForNumber(s: string): string {
  return s
    .replace(/[０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0)
    )
    .replace(/[△▲▴]/g, "-")
    .replace(/[−ー―‐]/g, "-")
    .replace(/，/g, ",")
    .replace(/．/g, ".");
}

/** 単位を「円」に正規化した倍率を返す。未知単位は null (誤判定回避) */
function unitMultiplier(unit: string): number | null {
  if (unit === "" || unit === "円") return 1;
  if (unit === "千円" || unit === "千 円") return 1_000;
  if (unit === "百万円" || unit === "百 万円") return 1_000_000;
  if (unit === "億円" || unit === "億 円") return 100_000_000;
  if (unit === "兆円" || unit === "兆 円") return 1_000_000_000_000;
  return null;
}

/**
 * 数値文字列 (例 "1,234.5" / "△500" / "▲1,200") を Number に変換。
 * カンマ・空白は許容。マイナス記号バリエーションは全て負として扱う。
 * 抽出できなければ NaN。
 */
export function parseJpNumber(raw: string): number {
  const s = normalizeForNumber(raw).replace(/[\s,]/g, "");
  if (s === "" || s === "-") return NaN;
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * 「数値 + 単位」を 1 セットとして抽出し、円に正規化した値を返す。
 * 単位を強制したい場合は requireUnit に指定単位群を渡す。
 */
export function parseAmount(
  raw: string,
  requireUnit?: ReadonlyArray<string>
): number {
  const norm = normalizeForNumber(raw);
  // 数値部分のみを取り出す (単位文字を含めると parseJpNumber が拒否するため)
  const numMatch = norm.match(/-?\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\s*\d+(?:\.\d+)?/);
  if (!numMatch) return NaN;
  const n = parseJpNumber(numMatch[0]);
  if (!Number.isFinite(n)) return NaN;
  // 数値直後の単位を検出
  const m = norm.match(/(?:百万円|千円|億円|兆円|円)/);
  const unit = m ? m[0] : "";
  if (requireUnit && requireUnit.length > 0 && !requireUnit.includes(unit)) {
    return NaN;
  }
  const mult = unitMultiplier(unit);
  return mult === null ? NaN : n * mult;
}

/**
 * 「前回〇〇 → 今回〇〇」「前回発表予想 (A) … 修正後予想 (B)」のような
 * 2 つの数値のペアを抽出するためのヘルパ。
 *
 * key (例: "営業利益" / "1株当たり配当") をテキスト内で見つけ、その近傍 (≤180文字)
 * から 2 つの数値を順に取り出す。テンプレが「前回 → 今回」の順固定なので、
 * 1 個目 = before、2 個目 = after として扱う (ルール: テンプレ依存を明示)。
 *
 * 単位を強制する場合は requireUnit を指定。両側で単位が異なる場合は NaN。
 */
export function extractBeforeAfter(
  text: string,
  key: string,
  requireUnit?: ReadonlyArray<string>,
  windowChars = 200
): { before: number; after: number } | null {
  const norm = normalizeForNumber(text);
  const keyIdx = norm.indexOf(key);
  if (keyIdx < 0) return null;
  // key の周辺 (key の直後から windowChars 文字) を切り出し
  const slice = norm.slice(keyIdx, keyIdx + key.length + windowChars);
  // 数値抽出 (符号 + カンマ区切り + 単位)
  const rx =
    /(-?\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(百万円|千円|億円|兆円|円)?/g;
  const found: Array<{ num: number; unit: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = rx.exec(slice)) !== null) {
    const numRaw = m[1];
    const unit = m[2] ?? "";
    const n = parseJpNumber(numRaw);
    if (!Number.isFinite(n)) continue;
    if (requireUnit && requireUnit.length > 0 && !requireUnit.includes(unit)) {
      continue;
    }
    const mult = unitMultiplier(unit);
    if (mult === null) continue;
    found.push({ num: n * mult, unit });
    if (found.length >= 2) break;
  }
  if (found.length < 2) return null;
  // 単位を強制した場合は両側で一致を確認
  if (requireUnit && requireUnit.length > 0 && found[0].unit !== found[1].unit) {
    return null;
  }
  return { before: found[0].num, after: found[1].num };
}
