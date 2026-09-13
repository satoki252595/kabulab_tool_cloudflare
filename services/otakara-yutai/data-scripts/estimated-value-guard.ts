/**
 * 優待の推定金額 (`estimated_value`) の決定論ガード。
 *
 * もとは `interpret-benefits.ts` (ローカル LLM 経路) の内部関数だった。要約を
 * クラウド LLM に外出ししたので、**LLM の出力を信用しない取り込み側**
 * (`summary-import.ts`) が同じ判定を使えるよう、純関数だけを切り出した。
 * 判定の中身は移設前と同一 (挙動を変えずに置き場所だけ変えている)。
 *
 * CLAUDE.md ルール1/2: 過大評価は優待利回り (割安判定) の誤誘導になる。
 * 確信が持てない値は捏造せず「未取得 (null)」として落とすのが正。
 * false-positive (本来妥当な値を null 化) はユーザー方針 (null 多めに倒す)
 * に従い許容する — 過大評価より安全側。
 */

/** 全角数字・カンマを半角化 */
function normalizeNumeric(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xfee0))
    .replace(/，/g, ",");
}

/**
 * description 中の数量ヒント (枚/個/口/名/冊/本/セット/点/回, ×N) を抽出。
 * 高額値の digit-grounding で「額面 × 数量」だけを許可する乗数集合に使う
 * (任意倍率 1..30 だと 20万 → 200万 のような 10 倍誤読を誤って容認するため)。
 */
export function extractQuantities(descRaw: string): number[] {
  const d = normalizeNumeric(descRaw);
  const q = new Set<number>();
  for (const m of d.matchAll(
    /([0-9][0-9,]*)\s*(?:枚|個|口|名|冊|本|セット|点|回)/g
  )) {
    const n = Number(m[1].replace(/,/g, ""));
    if (n >= 1 && n <= 100) q.add(n);
  }
  for (const m of d.matchAll(/[×x✕]\s*([0-9][0-9,]*)/gi)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (n >= 1 && n <= 100) q.add(n);
  }
  return [...q];
}

/**
 * description から円建ての金額候補を抽出する (万=×10000 / 千=×1000)。
 * 株主優待ポイント (カタログ交換型) は SYSTEM_PROMPT で 1pt=1円 換算を採用する
 * ため、ここでも円建て候補として含める (決定論ガードの digit-grounding が
 * 高額ポイント値を「根拠不明」と誤判定して null 化するのを防ぐ)。
 */
export function extractYenAmounts(descRaw: string): number[] {
  const desc = normalizeNumeric(descRaw);
  const amounts = new Set<number>();
  const num = (m: string): number => Number(m.replace(/,/g, ""));
  for (const m of desc.matchAll(/([0-9][0-9,]*)\s*万\s*円/g)) {
    amounts.add(num(m[1]) * 10000);
  }
  for (const m of desc.matchAll(/([0-9][0-9,]*)\s*千\s*円/g)) {
    amounts.add(num(m[1]) * 1000);
  }
  for (const m of desc.matchAll(/([0-9][0-9,]*)\s*円/g)) {
    const v = num(m[1]);
    if (v > 0) amounts.add(v);
  }
  // 株主優待カタログ交換ポイント = 1pt 1円 相当として金額候補に含める。
  // ただし「○○ポイント還元 / 付与」「ポイント○倍」のような買い物販促ポイントは
  // 現金等価でないため grounding 根拠に含めない (高額帯の過大評価ガードを
  // 緩めないため。直後 6 文字に販促語があれば除外する)。
  const PROMO_AFTER = /還元|付与|倍/;
  for (const m of desc.matchAll(/([0-9][0-9,]*)\s*ポイント/g)) {
    const after = desc.slice(
      m.index + m[0].length,
      m.index + m[0].length + 6
    );
    if (PROMO_AFTER.test(after)) continue;
    const v = num(m[1]);
    if (v > 0) amounts.add(v);
  }
  for (const m of desc.matchAll(/([0-9][0-9,]*)\s*pt\b/gi)) {
    const v = num(m[1]);
    if (v > 0) amounts.add(v);
  }
  return [...amounts];
}

/** 割引・値引き系か (換金性のある金券表現が無いことが条件) */
export function isDiscountWithoutRedeemable(descRaw: string): boolean {
  const desc = normalizeNumeric(descRaw);
  const isDiscount =
    /割引|値引|優待価格|割引価格|[0-9]\s*[%％]\s*(?:off|オフ)?|\boff\b/i.test(
      desc
    );
  if (!isDiscount) return false;
  const hasRedeemable =
    /円分|円相当|円券|円分券|QUO|クオ|ギフトカード|ギフト券|商品券|おこめ券|お米券|図書カード|プリペイドカード|カタログギフト/i.test(
      desc
    );
  return !hasRedeemable;
}

/** ¥50,000 以上のしきい値 (この帯のみ厳格に digit-grounding 検証) */
export const HIGH_VALUE_THRESHOLD = 50000;

/**
 * LLM の estimatedValue を決定論的に検証し、疑わしければ null を返す。
 * - 割引系で換金金券表現が無い → null
 * - 高額 (>=¥50,000) で、本文の金額候補 (×個数 1..30 / 合計) のいずれとも
 *   桁が一致しない → 桁取り違え/根拠不明として null
 */
export function sanitizeEstimatedValue(
  descRaw: string,
  value: number | null
): number | null {
  if (value === null) return null;
  if (isDiscountWithoutRedeemable(descRaw)) return null;
  if (value < HIGH_VALUE_THRESHOLD) return value;

  const amounts = extractYenAmounts(descRaw);
  if (amounts.length === 0) return null; // 高額なのに本文に金額表現が無い
  const tol = (base: number): number => Math.max(1, base * 0.02);
  // 許可乗数 = 1 ∪ 本文の数量ヒント。任意倍率は使わない (10 倍誤読を弾く)。
  const multipliers = new Set<number>([1, ...extractQuantities(descRaw)]);
  const grounded = amounts.some(
    (a) =>
      a > 0 &&
      [...multipliers].some((m) => Math.abs(value - a * m) <= tol(a * m))
  );
  const sum = amounts.reduce((s, a) => s + a, 0);
  const matchesSum = sum > 0 && Math.abs(value - sum) <= tol(sum);
  return grounded || matchesSum ? value : null;
}
