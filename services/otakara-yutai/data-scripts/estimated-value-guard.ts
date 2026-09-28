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
    // fromCharCode が正。String(数値) は十進文字列化なので「４」(0xFF14) が
    // "52" (0x34 の十進) になる誤変換だった (2026-09-28 修正。#29 以前から
    // 全角の金額・数量が壊れていた: 「４万円」→ 520,000 円、「２枚」→ 50 枚)。
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
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
  // 人数の単位 (名・人・様・組) は数量にしない。当選人数 (「各5名」) で
  // 金額を掛けると賞金総額が通り、1株主持分あたりの価値ではなくなる。
  // 人数は金額の単位 (円) と掛からない (raw の 20 人で 20% を根拠づけられない
  // のと同じく、単位の意味が違う)。「1名義」のような按分も1株主持分の
  // 数量ではないため数えない。
  for (const m of d.matchAll(
    /([0-9][0-9,]*)\s*(?:枚|個|口|冊|本|セット|点|回)/g
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
  return [...new Set(extractYenSpans(descRaw).map((s) => s.value))];
}

/** 金額表現の出現位置。抽選賞品の隣接判定に使う。 */
export type YenSpan = {
  value: number;
  /** 正規化後テキスト上の開始位置。 */
  index: number;
  /** 正規化後テキスト上の終了位置 (排他的)。 */
  end: number;
};

/**
 * 金額候補の出現位置つき抽出。収集順 (万→千→円→ポイント→pt) と除外条件は
 * 従来の extractYenAmounts と同一。抽選賞品の判定が「値が本文のどこに出るか」
 * を要するため位置を残す。
 */
export function extractYenSpans(descRaw: string): YenSpan[] {
  const desc = normalizeNumeric(descRaw);
  const spans: YenSpan[] = [];
  const num = (m: string): number => Number(m.replace(/,/g, ""));
  const push = (m: RegExpMatchArray, value: number): void => {
    // matchAll (g フラグ) は index を必ず持つ。型上は optional なので落とす。
    if (m.index === undefined) return;
    spans.push({ value, index: m.index, end: m.index + m[0].length });
  };
  for (const m of desc.matchAll(/([0-9][0-9,]*)\s*万\s*円/g)) {
    push(m, num(m[1]) * 10000);
  }
  for (const m of desc.matchAll(/([0-9][0-9,]*)\s*千\s*円/g)) {
    push(m, num(m[1]) * 1000);
  }
  for (const m of desc.matchAll(/([0-9][0-9,]*)\s*円/g)) {
    const v = num(m[1]);
    if (v > 0) push(m, v);
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
    if (v > 0) push(m, v);
  }
  for (const m of desc.matchAll(/([0-9][0-9,]*)\s*pt\b/gi)) {
    const v = num(m[1]);
    if (v > 0) push(m, v);
  }
  return spans;
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
 * 当選人数トークンと金額表現の隣接 window (文字数)。抽選賞品の判定に使う。
 * 固定値で、確率も閾値調整もない (販促ポイント除外の「直後 6 文字」と同じ流儀)。
 * 文境界 (。、改行) を跨ぐ隣接は数えない — 固定分と抽選の別文併記
 * (「ギフト1,000円相当。抽選で5名に旅行券」) を誤って弾かないため。
 * 純抽選の実命中 4 行の金額↔人数は同一文内 (gap「相当:」「に」) なので、
 * 文境界で切っても取り逃がさない (2026-09-28 全 5,331 行で確認)。
 */
export const LOTTERY_ADJACENCY_CHARS = 8;

/** R1 の隣接 window を区切る文境界。読点 (、) は同一文として扱う。 */
const LOTTERY_SENTENCE_END = /[。．！？!?\n]/;

/**
 * 値が抽選賞品の金額か (仕様書 §6「寄付・社会貢献・抽選」→ null の機械判定)。
 *
 * 仕様書は抽選を null と定めるが、旧ガードは抽選を一切見ていなかったため
 * 賞品額・最高賞品額・賞金総額がそのまま通り、優待利回りの分子に入っていた
 * (2026-09-28 監査 F4)。ここでは**当選人数つきの賞品表記**だけを機械的に弾く:
 *   - R1 隣接: 全文に「抽選」を含み、かつ値と一致する金額表現の ±8 文字以内に
 *     当選人数 (各N名 / N名に / N名リスト) がある
 *     (例: 「8万円相当:30名」「抽選で8名に15万円相当」)
 *   - R2 総額: 全文に「抽選」を含み、値が「総額○○円」と一致し、かつ賞品表に
 *     各N名の配分がある (例: 「総額900万円」「8万円相当 各10名」)
 *
 * 「抽選」は文を区切らず全文で見る。賞品表と抽選記述が別文の純抽選
 * (「80,000円相当:40名 … 抽選で付与」) が実在するため、同一文縛りにすると
 * 取り逃がす。逆に金額と当選人数の隣接は同一文内に限る: 文境界を跨いで弾くと
 * 固定分との別文併記 (「ギフト1,000円相当。抽選で5名に旅行券」。gap「。抽選で」
 * = 5 文字) を誤って落とす。純抽選の実命中 4 行の金額↔人数は同一文内なので
 * 取り逃がさない。2026-09-28 時点の全 5,331 行で検証し、的中は真の純抽選
 * 4 行のみ・誤検出 0 (文境界カット後も同一の 4 行)。
 *
 * 除外 (固定分との併記を誤って弾かないため):
 *   - 「各株主」配下の人数 (株主持分ごとの付与 = 固定)。「1名義」「名前」の
 *     ような非当選の「名」も数えない。「2名で来店」「1名まで」の条件人数も
 *     当選人数にしない (助詞で区別する)。
 *   - 賞品額が当選人数から離れている行 (別文の抽選・購入条件つき) は対象外。
 *     機械的に切り分けられないため、生成側の仕様遵守と人手の再確認に委ねる。
 *     (2026-09-28 時点の残件は修復計画で null 化する)
 */
export function isLotteryPrizeAmount(descRaw: string, value: number): boolean {
  const desc = normalizeNumeric(descRaw);
  if (!desc.includes("抽選")) return false;
  const tol = (base: number): number => Math.max(1, base * 0.02);
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= tol(b);

  // 当選人数トークンの出現範囲。名義/名前/名簿のような非当選の「名」、
  // 条件人数 (N名で/N名まで) を除く。
  const winnerSpans: { index: number; end: number }[] = [];
  const unit = String.raw`(?:名様|名|人|様|組)`;
  const notName = String.raw`(?![義前簿寄])`;
  // 按分表現 (各株主1名・お客様1名) は当選人数にしない。全パターン共通。
  const isApportioned = (index: number): boolean =>
    /(?:株主|お客様)\s?$/.test(desc.slice(Math.max(0, index - 5), index));
  const pushAll = (re: RegExp): void => {
    for (const m of desc.matchAll(re)) {
      if (m.index === undefined || isApportioned(m.index)) continue;
      winnerSpans.push({ index: m.index, end: m.index + m[0].length });
    }
  };
  // 各N名 (各株主などの按分配布は除く)。R2 (総額) はこの配分表つきだけを見る:
  // 固定ギフトの総額と無関係な抽選が同文にある併記 (「総額5000円のギフト。
  // 抽選で1組に旅行券」) を誤って弾かないため。
  const kakuPrize = new RegExp(String.raw`各(?!\s*株主)\s*[0-9][0-9,]*\s*` + unit + notName, "g");
  pushAll(kakuPrize);
  const hasKakuPrize = new RegExp(
    String.raw`各(?!\s*株主)\s*[0-9][0-9,]*\s*` + unit + notName
  ).test(desc);
  // N名に (当選配布)
  pushAll(new RegExp(String.raw`[0-9][0-9,]*\s*` + unit + notName + String.raw`\s*に`, "g"));
  // N名リスト (賞品表の「○○円相当:50名」。文末・区切りで終わるものだけ)
  pushAll(
    new RegExp(
      String.raw`[0-9][0-9,]*\s*` + unit + notName + String.raw`(?=\s*(?:[、，。．」』）)\n]|$))`,
      "g"
    )
  );
  if (winnerSpans.length === 0) return false;

  // R2: 値が総額表示と一致し、賞品表 (各N名) を伴う
  if (hasKakuPrize) {
    for (const m of desc.matchAll(/総額\s*([0-9][0-9,]*)\s*(万\s*円|千\s*円|円)/g)) {
      const mult = m[2].startsWith("万") ? 10000 : m[2].startsWith("千") ? 1000 : 1;
      const total = Number(m[1].replace(/,/g, "")) * mult;
      if (near(value, total)) return true;
    }
  }

  // R1: 値と一致する金額表現に当選人数が同一文内で隣接する
  const spans = extractYenSpans(descRaw);
  for (const s of spans) {
    if (!near(value, s.value)) continue;
    for (const w of winnerSpans) {
      const gapStr = w.index >= s.end ? desc.slice(s.end, w.index) : desc.slice(w.end, s.index);
      if (gapStr.length <= LOTTERY_ADJACENCY_CHARS && !LOTTERY_SENTENCE_END.test(gapStr)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 外貨額面の未換算の値か (仕様書 §6「外貨建て」→ null の機械判定)。
 *
 * 旧ガードは金額帯によらず外貨を見ていなかったため、`25USD×4=100USD` の
 * 180 が 180 円として通っていた (2026-09-28 監査 F5)。低額帯は digit-grounding
 * を素通しする分、ここで通貨の取り違えだけは見る: 外貨額面と一致し、かつ
 * 円の金額表現と一致しない値は null。外貨と円の併記で円額面と一致する値
 * (「100USD (約15,000円)」の 27000) は通す。為替推定はしない。
 * 原通貨の情報は掲載文に残り、値は未評価 (null) になる。
 */
export function isUnconvertedForeignAmount(descRaw: string, value: number): boolean {
  const desc = normalizeNumeric(descRaw);
  const faces: number[] = [];
  const num = (m: string): number => Number(m.replace(/,/g, ""));
  const currency = String.raw`(?:USD|USドル|米ドル)`;
  for (const m of desc.matchAll(new RegExp(String.raw`([0-9][0-9,]*)\s*` + currency, "gi"))) {
    faces.push(num(m[1]));
  }
  for (const m of desc.matchAll(new RegExp(currency + String.raw`\s*([0-9][0-9,]*)`, "gi"))) {
    faces.push(num(m[1]));
  }
  if (faces.length === 0) return false;
  const tol = (base: number): number => Math.max(1, base * 0.02);
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= tol(b);
  if (!faces.some((f) => near(value, f))) return false;
  // 円額面とも一致するなら円の値として通す
  return !extractYenSpans(descRaw).some((s) => near(value, s.value));
}

/**
 * LLM の estimatedValue を決定論的に検証し、疑わしければ null を返す。
 * - 0・負・小数 → null (スキーマの positive と二重化。旧経路の 0 値混入の再発防止)
 * - 割引系で換金金券表現が無い → null
 * - 抽選賞品の金額 (当選人数つきの賞品表記) → null
 * - 外貨額面の未換算 (低額帯の素通しも塞ぐ) → null
 * - 高額 (>=¥50,000) で、本文の金額候補 (×本文の数量ヒント / 合計) のいずれとも
 *   桁が一致しない → 桁取り違え/根拠不明として null
 */
export function sanitizeEstimatedValue(
  descRaw: string,
  value: number | null
): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value <= 0) return null;
  if (isDiscountWithoutRedeemable(descRaw)) return null;
  if (isLotteryPrizeAmount(descRaw, value)) return null;
  if (isUnconvertedForeignAmount(descRaw, value)) return null;
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

/**
 * 取り込み済みの値を次回フェッチで持ち越してよいか。取り込みゲート
 * (sanitize + 金額表現の存在) と同じ判定を 1 関数に束ねたもので、
 * `planSummaryImport` の value_guard / value_ungrounded とペアになる。
 * 持ち越し時に壊れた解釈を無検証で温存しないための判定 (fetch の全削除→
 * 再 INSERT が旧解釈を捨てる際、検証済みのものだけ戻す)。
 */
export function isCarryableValue(descRaw: string, value: number | null): boolean {
  if (value === null) return false;
  if (sanitizeEstimatedValue(descRaw, value) !== value) return false;
  return extractYenAmounts(descRaw).length > 0;
}
