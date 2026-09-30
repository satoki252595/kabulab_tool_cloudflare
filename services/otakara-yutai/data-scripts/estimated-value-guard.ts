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
 * 企業提示 (company) の名目認定。LLM の推定値を company として採用してよいかの
 * 決定論判定 (純関数)。`sanitizeEstimatedValue` (危険値の除去) とは別物で、
 * sanitize を通ってもここで HOLD なら company にしない (root bug の修正:
 * 旧 planSummaryImport は sanitize + 金額表現の存在だけで company を付けていた)。
 *
 * positive は「受益の額面 scope の同定」が必須で、整数一致だけでは足りない。
 * 利用価格・購入金額条件 (優待価格○円、○円以上の買物で) との一致は額面の
 * 根拠にならない。単価×数量・ポイント×レートの組合せは同一 clause 内のもの
 * だけ認める (全文 cross product は無関係 clause の金額を拾う)。
 * 否定マーカー (choice/addon/resale/approx) は全文で見る: 別 clause の
 * 免責 (※金額は目安) を見逃す方が危険なため、安全側 (HOLD) に倒す。
 *
 * QUALIFY (exact, per-benefit — 整数の完全一致のみ。2% 許容は使わない):
 * - face-literal: 値と一致する額面表示 (○円相当 / ○円分 / ○円券の隣接)。
 *   年間・合計・範囲・購入条件・換算レート・単価つきの金額は額面候補から除く
 * - coupon-unit: 同一 clause 内の明示の単価 (1枚当たり○円相当・○円券) ×
 *   per-grant 数量 (単価の基数・年間数量を除く)。
 *   額面×数量の明示積 (100円×25枚) も同じ扱い
 * - points-rate: 同一 clause 内の明示の厳密レート (1ポイント1円) × ポイント数
 *   (販促・レート基数を除く)
 * HOLD:
 * - approx: ≒/約 (約款等の複合語を除く)
 * - foreign: 外貨額面の未換算 / lottery: 抽選賞品 / discount: 割引の金額化
 * - choice: 選択肢の別価値 (単一代表値は不正確)
 * - addon: 付帯物の別価値 / resale: 転売・買取相場
 * - annual: 年間合計を各月に充当
 * - multi_face_components: 額面候補が2種類以上 (部分摘み・合算はしない)
 * - unit_partial: 単価だけの値 (数量つきの受益全体ではない)
 * - no_per_grant_face: 上のいずれにも当たらない (無関係の金額・数量、推定合計等)
 *
 * 文言+値だけの判定が `qualifyCompanyNominal`。株数・権利月の recipient
 * context を含む厳密判定は `qualifyCompanyPerGrantValue` (要約取込と
 * full-import carry の両方が同じ関数を使う。述語の二重化はしない)。
 *
 * 機械判定の対象外 (人手監査に委ねる): 同一文言の別 instrument の部分摘み
 * (A券/B券の片方だけ等)、無標識の併給 (+優待品) の部分額。「+」は「+税」
 * 記法と衝突するため addon マーカーにしない。「コース」「プラン」は物理的
 * 施設・料金体系の意味がありうるため choice マーカーにしない。
 */
export type CompanyNominalVerdict =
  | { qualified: true; rule: "face-literal" | "coupon-unit" | "points-rate" }
  | { qualified: false; code: string; detail: string };

/**
 * 内部の保存形式 headed-description (producer が DB `description` に書く形)。
 *
 * 表の h3 見出しは額面の positive 根拠にできないが、種別・選択・抽選の
 * context (negative) として判定に要る。別列を持たず、保存文の先頭行に
 * `【種別：<JSON文字列>】` を置く。空でない見出しは必ず persist する
 * (本文に含まれていても落とさない — 包含は heading-scope HOLD と等価では
 * ない。条件の黙殺 = fallback はしない)。見出し bytes は JSON
 * encoding で全保持し (】・改行も壊さない)、positive 本文と分離する。
 * 空見出しだけ素の本文で正直に欠落させる。
 * marker の無い旧保存文は `{ heading: null, body: 原文 }` で素通しし、
 * 旧判定と 1 文字も変えない。marker 付きで壊れた保存文は
 * `malformed: true` で返す — 正の全文としては扱わず、呼び出し側が
 * HOLD/STOP する (qualifier は HOLD verdict、carry キーは STOP)。
 * 公開面は `description` 列自体を引かない (app.ts) ので届かない。
 */
/** headed 保存形式の先頭 marker。summary-contract の echo 拒否と共有する (単一真実)。 */
export const HEADED_MARK = "【種別：";

export type SplitHeaded = { heading: string | null; body: string; malformed: boolean };

/** 保存形を作る。空見出しは素の本文、それ以外は必ず headed で全 bytes 保持。 */
export function headedDescription(heading: string, body: string): string {
  const h = heading ?? "";
  if (h === "") return body;
  return `${HEADED_MARK}${JSON.stringify(h)}】\n${body}`;
}

/**
 * 保存形を切り分ける。先頭行の marker だけを見る (文中の同形は無視)。
 * 見出し部は末尾 `】` まで貪欲に取り JSON として読む (見出し内の `】` 可)。
 */
export function splitHeadedDescription(stored: string): SplitHeaded {
  if (!stored.startsWith(HEADED_MARK)) return { heading: null, body: stored, malformed: false };
  const nl = stored.indexOf("\n");
  const first = nl < 0 ? stored : stored.slice(0, nl);
  if (!first.endsWith("】")) return { heading: null, body: stored, malformed: true };
  let heading: unknown;
  try {
    heading = JSON.parse(first.slice(HEADED_MARK.length, -1));
  } catch {
    return { heading: null, body: stored, malformed: true };
  }
  if (typeof heading !== "string") return { heading: null, body: stored, malformed: true };
  return { heading, body: nl < 0 ? "" : stored.slice(nl + 1), malformed: false };
}

/** 約の複合語 (近似の意味を持たないため approx 判定から除く)。 */
const YAKU_COMPOUNDS = [
  "約款",
  "契約",
  "条約",
  "婚約",
  "予約",
  "節約",
  "解約",
  "旧約",
  "新約",
  "誓約",
  "制約",
  "規約",
  "要約",
  "概要",
  "簡約",
  "集約",
  "約定",
  "約数",
  "約分",
  "倹約",
];

function hasApproxMarker(descRaw: string): boolean {
  const desc = normalizeNumeric(descRaw);
  if (desc.includes("≒")) return true;
  let stripped = desc;
  for (const c of YAKU_COMPOUNDS) stripped = stripped.split(c).join("");
  return stripped.includes("約");
}

/** 選択肢の存在 (単一金額では代表できない)。 */
function hasChoiceMarker(descRaw: string): boolean {
  return /選択|選べ|お選び|どちらか|いずれか|[①②③④⑤⑥⑦⑧⑨⑩]/.test(normalizeNumeric(descRaw));
}

/** 付帯物の存在 (金額の対象が本体+付帯で、全額が不明)。 */
function hasAddonMarker(descRaw: string): boolean {
  return /さらに|加えて|別途|併せて|あわせて|それに加え/.test(normalizeNumeric(descRaw));
}

/** 転売・買取相場の存在 (企業提示の額面ではない)。 */
function hasResaleMarker(descRaw: string): boolean {
  return /転売|オークション|ヤフオク|メルカリ|中古相場|買取価格|フリマ/.test(normalizeNumeric(descRaw));
}

/**
 * 円建て金額の出現位置つき抽出。ポイント/pt は含めない
 * (qualifier はポイントを円扱いしない。明示レートがある場合だけ
 * points-rate 規則で別に見る)。
 */
function extractStrictYenSpans(descRaw: string): YenSpan[] {
  const desc = normalizeNumeric(descRaw);
  const spans: YenSpan[] = [];
  const num = (m: string): number => Number(m.replace(/,/g, ""));
  const push = (m: RegExpMatchArray, value: number): void => {
    if (m.index === undefined) return;
    spans.push({ value, index: m.index, end: m.index + m[0].length });
  };
  // 数値境界: 小数・桁の一部の断片 (0.5円の「5円」) は採らない。
  // 未対応の小数トークンは拒否 (小数演算はしない)。
  for (const m of desc.matchAll(/(?<![0-9.．])([0-9][0-9,]*)\s*万\s*円/g)) {
    push(m, num(m[1]) * 10000);
  }
  for (const m of desc.matchAll(/(?<![0-9.．])([0-9][0-9,]*)\s*千\s*円/g)) {
    push(m, num(m[1]) * 1000);
  }
  for (const m of desc.matchAll(/(?<![0-9.．])([0-9][0-9,]*)\s*円/g)) {
    const v = num(m[1]);
    if (v > 0) push(m, v);
  }
  return spans;
}

/** span の直前が「年間」か (年間合計の金額・数量は per-grant の根拠にしない)。 */
function isAnnualSpan(desc: string, index: number): boolean {
  return /年間\s*$/.test(desc.slice(Math.max(0, index - 8), index));
}

/**
 * 額面にならない金額 span か (正規化後テキストで判定):
 * - 年間・合計・総額・累計つき (期間合計・総額は per-grant の額面ではない)
 * - 範囲・近似つき (〜○円、約○円、≒○円。端の値だけ摘むのは tier-pick と同じ。
 *   約は漢字複合語 (節約・予約等) の一部を除く)
 * - 購入条件・利用条件つき (○円以上/以下/未満/超/から/まで/ごとに使える、
 *   ○円引き/割引。使うための条件額・割引額は受益の額面ではない。
 *   税込注記 ([税込]/（税込）) を挟む形も同じ)
 * - 換算レート・単価つき (○ポイント○円、1枚当たり○円、○枚につき○円。
 *   レート・単価自体は受益全体の額面ではない。括弧挟みも同じ)。
 *   素の並置 (3枚セット（10,000円相当）のような set-total) までは除かない —
 *   実形に単価読みの根拠が無く、除くと set-total を誤爆するため。
 */
function isNonFaceSpanBefore(desc: string, span: YenSpan): boolean {
  const before = desc.slice(Math.max(0, span.index - 12), span.index);
  if (/(?:年間|合計|総額|累計)\s*$/.test(before)) return true;
  if (/[〜～≒＝=]\s*$/.test(before)) return true;
  const yaku = before.match(/約\s*$/);
  if (yaku?.index !== undefined) {
    const prev = before[yaku.index - 1];
    if (prev === undefined || !/[\u4e00-\u9fff]/.test(prev)) return true;
  }
  if (/(?:ポイント|(?<![A-Za-z])pt)\s*[（(]?\s*(?:当たり|あたり|当り)?\s*$/.test(before)) return true;
  if (/(?:枚|個|口|冊|本|セット|点|回)\s*[（(]?\s*(?:当たり|あたり|当り)\s*$/.test(before)) return true;
  if (/(?:枚|個|口|冊|本|セット|点|回|ポイント|(?<![A-Za-z])pt)\s*につき\s*$/.test(before)) return true;
  return false;
}

function isNonFaceSpanAfter(desc: string, span: YenSpan): boolean {
  const after = desc.slice(span.end, span.end + 12);
  return /^(?:\[[^\]]*\]|（[^）]*）|\([^)]*\))?(?:以上|以下|未満|超|から|まで|ごと|毎|引き|割引|オフ|OFF)/.test(
    after
  );
}

function isNonFaceSpan(desc: string, span: YenSpan): boolean {
  return isNonFaceSpanBefore(desc, span) || isNonFaceSpanAfter(desc, span);
}

/** 額面候補の span (年間・合計・範囲・購入条件つきを除く)。 */
function extractFaceSpans(descRaw: string): YenSpan[] {
  const desc = normalizeNumeric(descRaw);
  return extractStrictYenSpans(descRaw).filter((s) => !isNonFaceSpan(desc, s));
}

/**
 * 円建て金額 (万/千/円。ポイントは除く) の distinct 値。年間・合計・範囲・
 * 購入条件つきは除く。複数月・複数 tier の曖昧さ判定に使う
 * (per-grant 候補が 2 種類以上あれば文言から 1 つに決めない)。
 */
export function extractStrictYenAmounts(descRaw: string): number[] {
  return [...new Set(extractFaceSpans(descRaw).map((s) => s.value))];
}

/**
 * 券の隣接窓 (文字数)。「○円相当の商品券」「○円分の商品券」を拾う幅。
 * clause 境界 (。、；・括弧) で切る — 別 clause の券は数えない。
 */
const TICKET_WINDOW_CHARS = 8;

/** span 直後の窓に券があるか (○円券 / ○円相当の商品券)。 */
function hasTicketAfter(desc: string, span: YenSpan): boolean {
  const window = desc.slice(span.end, span.end + TICKET_WINDOW_CHARS).split(/[。、；\n（(]/)[0];
  return window !== undefined && window.includes("券");
}

/**
 * 額面表示の値 (○円相当 / ○円分 / ○円券の隣接)。企業の額面 scope の同定で、
 * 素の金額一致 (利用価格・購入金額条件との一致) は採らない。
 */
function extractFaceValues(descRaw: string): number[] {
  const desc = normalizeNumeric(descRaw);
  const out: number[] = [];
  for (const s of extractFaceSpans(descRaw)) {
    const rest = desc.slice(s.end, s.end + 6);
    if (/^\s*相当/.test(rest) || rest.startsWith("分") || hasTicketAfter(desc, s)) {
      out.push(s.value);
    }
  }
  return out;
}

/** 券の額面 unit (○円券)。同一 clause 内の数量と掛けて coupon-unit 規則で見る。 */
function extractTicketUnits(clauseRaw: string): number[] {
  const clause = normalizeNumeric(clauseRaw);
  const out: number[] = [];
  for (const s of extractStrictYenSpans(clause)) {
    if (!isNonFaceSpan(clause, s) && hasTicketAfter(clause, s)) out.push(s.value);
  }
  return out;
}

/**
 * 見出しの型付き券 unit (○円券・○円割引券など券名つき額面)。
 * headed coupon-unit 規則だけが使う。券の隣接が必須で、bare 通貨は採らない。
 * 単価・レート・年間・範囲つきは除く (既存の before 境界をそのまま使う)。
 * after 側は券名の一部としての割引/引き (500円割引券) だけ採り、範囲の
 * 下端摘み (500～1000円券の 500) は除く。数量との積は呼び出し側で見る。
 */
function extractHeadedTicketUnits(headingRaw: string): number[] {
  const h = normalizeNumeric(headingRaw);
  const out: number[] = [];
  for (const s of extractStrictYenSpans(headingRaw)) {
    if (!hasTicketAfter(h, s)) continue;
    if (isNonFaceSpanBefore(h, s)) continue;
    const after = h.slice(s.end, s.end + 12);
    if (/^\s*[〜～]/.test(after)) continue;
    if (isNonFaceSpanAfter(h, s) && !/^(?:割引|値引|引き)券/.test(after)) continue;
    out.push(s.value);
  }
  return out;
}

/** 年間数量 (「年間 6枚」)。年間合計の金額化チェックに使う。 */
function extractAnnualQuantities(descRaw: string): number[] {
  const desc = normalizeNumeric(descRaw);
  const out: number[] = [];
  for (const m of desc.matchAll(/年間[^\d\n。]{0,6}([0-9][0-9,]*)\s*(?:枚|個|口|冊|本|セット|点|回)/g)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (n >= 1 && n <= 100) out.push(n);
  }
  return out;
}

/**
 * 単価表現の基数 (1枚当たり○円の「1枚」) を落とす。基数は付与数ではなく
 * 単価の定義域なので、数量ヒントに混ぜると単価×1=単価の shortcut が通る。
 */
function stripUnitCardinals(desc: string): string {
  return desc.replace(
    /[0-9][0-9,]*\s*(?:枚|個|口|冊|本|セット|点|回)(?=\s*(?:当たり|あたり|当り|につき))/g,
    ""
  );
}

/** 年間数量を除いた per-grant の数量ヒント (単価の基数・小数トークンを除く)。 */
function extractPerGrantQuantities(descRaw: string): number[] {
  const desc = normalizeNumeric(descRaw);
  // 小数トークン (×2.5枚) は数量にしない。整数部の切り出し (2・5) は捏造のため。
  // 既存の extractQuantities 自体は変えない (旧経路の挙動不変)。
  const dedecimal = desc.replace(/[0-9][0-9,]*[.．][0-9]+/g, "");
  const stripped = dedecimal.replace(/年間[^\d\n。]{0,6}[0-9][0-9,]*\s*(?:枚|個|口|冊|本|セット|点|回)/g, "");
  return extractQuantities(stripUnitCardinals(stripped));
}

/** 明示の単価 (1枚当たり○円相当)。値そのまま (万/千換算つき)。 */
function extractCouponUnits(descRaw: string): number[] {
  const desc = normalizeNumeric(descRaw);
  const out: number[] = [];
  // 1 の境界: 桁の一部 (21枚当たりの「1枚」) は基数にしない。
  for (const m of desc.matchAll(
    /(?<![0-9.．])1\s*(?:枚|個|口|セット|点|回|冊|本)\s*(?:当たり|あたり|当り|につき)\s*([0-9][0-9,]*)\s*(万\s*円|千\s*円|円)/g
  )) {
    const mult = m[2].startsWith("万") ? 10000 : m[2].startsWith("千") ? 1000 : 1;
    out.push(Number(m[1].replace(/,/g, "")) * mult);
  }
  return out;
}

/** 額面×数量の明示積 (100円×25枚) の unit/qty 対。年間にかかるものは除く。 */
function extractFaceProductPairs(descRaw: string): { unit: number; qty: number }[] {
  const desc = normalizeNumeric(descRaw);
  const out: { unit: number; qty: number }[] = [];
  // unit の数値境界 (qty 側は「円×N枚」の剛直形が自己防衛する)。
  for (const m of desc.matchAll(
    /(?<![0-9.．])([0-9][0-9,]*)\s*(万\s*円|千\s*円|円)\s*[×x✕]\s*([0-9][0-9,]*)\s*(?:枚|個|口|セット|点|回|冊|本)/gi
  )) {
    if (m.index !== undefined && isAnnualSpan(desc, m.index)) continue;
    const mult = m[2].startsWith("万") ? 10000 : m[2].startsWith("千") ? 1000 : 1;
    const unit = Number(m[1].replace(/,/g, "")) * mult;
    const qty = Number(m[3].replace(/,/g, ""));
    if (qty >= 1 && qty <= 100) out.push({ unit, qty });
  }
  return out;
}

/** 額面×数量の明示積 (100円×25枚)。 */
function extractFaceProducts(descRaw: string): number[] {
  return extractFaceProductPairs(descRaw).map((p) => p.unit * p.qty);
}

/** 明示積の unit 側 (100円×25枚の 100)。単価 literal の抑止に使う。 */
function extractFaceProductUnits(descRaw: string): number[] {
  return extractFaceProductPairs(descRaw).map((p) => p.unit);
}

/** 販促ポイント (還元/付与/倍) か。extractYenSpans と同じ 6 文字規則。 */
function isPromoPointsAfter(desc: string, end: number): boolean {
  return /還元|付与|倍/.test(desc.slice(end, end + 6));
}

/** レート式の基数 (1ポイント1円の「1ポイント」) か。レート自体は付与数ではない。 */
function isRateCardinalAfter(desc: string, end: number): boolean {
  const after = desc.slice(end, end + 10);
  return (
    /^\s*[（(]?\s*(?:[≒＝=×x✕]|約)?\s*[0-9]/.test(after) ||
    /^\s*(?:当たり|あたり|当り|は|=|→|：|:|につき)/.test(after)
  );
}

/** ポイント数 (販促・レート基数を除く)。位置つき。 */
function extractPointSpans(descRaw: string): YenSpan[] {
  const desc = normalizeNumeric(descRaw);
  const spans: YenSpan[] = [];
  const push = (m: RegExpMatchArray): void => {
    if (m.index === undefined) return;
    const end = m.index + m[0].length;
    if (isPromoPointsAfter(desc, end)) return;
    const v = Number(m[1].replace(/,/g, ""));
    if (v <= 0) return;
    if (v === 1 && isRateCardinalAfter(desc, end)) return;
    spans.push({ value: v, index: m.index, end });
  };
  // 数値境界: 小数の断片 (2.5ポイントの「5ポイント」) は採らない。
  for (const m of desc.matchAll(/(?<![0-9.．])([0-9][0-9,]*)\s*ポイント/g)) push(m);
  for (const m of desc.matchAll(/(?<![0-9.．])([0-9][0-9,]*)\s*pt\b/gi)) push(m);
  return spans;
}

/**
 * 明示の厳密レート (1ポイント1円)。1ポイントの基数を縛る 2 形だけ採る。
 * 基数なし形 (ポイントN円相当) はポイント総額の表示から単位レートを捏造する
 * ため採らない。≒/約つきは approx 規則で先に HOLD される。結合子なしの
 * 離れ形 (「1ポイント 対象商品1500円」) は採らない。
 */
function extractExactRates(descRaw: string): number[] {
  const desc = normalizeNumeric(descRaw);
  const out: number[] = [];
  const push = (m: RegExpMatchArray): void => {
    out.push(Number(m[1].replace(/,/g, "")));
  };
  // 1 の境界: 桁の一部の 1 (5001ポイントの末尾「1」) は基数にしない。
  for (const m of desc.matchAll(/(?<![0-9.．])1(?:ポイント|pt)([0-9][0-9,]*)\s*円/g)) push(m);
  for (const m of desc.matchAll(
    /(?<![0-9.．])1\s*(?:ポイント|pt)\s*(?:は|=|→|：|:|当たり|あたり|当り|につき)\s*([0-9][0-9,]*)\s*円/g
  )) {
    push(m);
  }
  return out;
}

/**
 * 値が単価 (1枚当たり・○円券・○円相当×数量の unit) で、受益に数量 (2以上)
 * がつくか。単価だけでは受益全体の額ではないので literal shortcut を塞ぐ
 * (全体額の明示か単価×数量の積だけが positive)。抑止は全文で見る
 * (HOLD 方向の安全側)。数量は基数・年間を除いた per-grant のもの。
 */
function isUnitPricedWhole(descRaw: string, value: number): boolean {
  const units = new Set([
    ...extractCouponUnits(descRaw),
    ...extractTicketUnits(descRaw),
    ...extractFaceProductUnits(descRaw),
  ]);
  if (!units.has(value)) return false;
  return extractPerGrantQuantities(descRaw).some((q) => q >= 2);
}

/**
 * 文言を clause (句) に割る。単価×数量・ポイント×レートの組合せは同一
 * clause 内のものだけ認める — 全文 cross product は無関係 clause の金額を
 * 拾って無関係な積を作る。括弧は割らない (「(1ポイント1円相当)」は一体)。
 */
function splitClauses(descRaw: string): string[] {
  return normalizeNumeric(descRaw)
    .split(/[。、；\n]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/** 株数条件 tier の列挙 (N株以上)。文言に複数あれば tier 混在。 */
function distinctShareThresholds(desc: string): Set<number> {
  const out = new Set<number>();
  for (const m of desc.matchAll(/([0-9][0-9,]*)\s*株以上/g)) {
    out.add(Number(m[1].replace(/,/g, "")));
  }
  return out;
}

/** 保有年数条件 tier の列挙 (N年以上/未満/超)。 */
function distinctYearThresholds(desc: string): Set<number> {
  const out = new Set<number>();
  for (const m of desc.matchAll(/([0-9][0-9,]*)\s*年(?:以上|未満|超)/g)) {
    out.add(Number(m[1].replace(/,/g, "")));
  }
  return out;
}

/**
 * 文言自体に複数の条件 tier が並ぶか (要約の文言とは無関係に判定する。
 * 要約から保有年ラベルを消しても回避できない)。tier 混在 + per-grant 候補額
 * が 2 種類以上あれば、tier↔金額の対応づけは構文解析なしに決めないので HOLD。
 * 金額が 1 種類なら tier-pick の余地が無いのでここでは落とさない
 * (経過措置の注記に年数条件が並ぶだけの単一額面の行まで落とさないため)。
 */
function hasMultiConditionTiers(descRaw: string): boolean {
  const desc = normalizeNumeric(descRaw);
  if (distinctShareThresholds(desc).size >= 2) return true;
  if (distinctYearThresholds(desc).size >= 2) return true;
  if (/年(?:以上|超)/.test(desc) && /年(?:未満|以下)/.test(desc)) return true;
  if (/初年度/.test(desc) && /年(?:以上|未満|超)/.test(desc)) return true;
  return false;
}

export function qualifyCompanyNominal(descRaw: string, value: number | null): CompanyNominalVerdict {
  if (value === null || !Number.isInteger(value) || value <= 0) {
    return { qualified: false, code: "no-value", detail: "値が無いか非正整数" };
  }
  if (hasApproxMarker(descRaw)) {
    return { qualified: false, code: "approx", detail: "≒/約つき (概算の企業提示ではない)" };
  }
  if (isUnconvertedForeignAmount(descRaw, value)) {
    return { qualified: false, code: "foreign", detail: "外貨額面の未換算" };
  }
  if (isLotteryPrizeAmount(descRaw, value)) {
    return { qualified: false, code: "lottery", detail: "抽選賞品の金額" };
  }
  if (isDiscountWithoutRedeemable(descRaw)) {
    return { qualified: false, code: "discount", detail: "割引の金額化 (換金金券なし)" };
  }
  if (hasChoiceMarker(descRaw)) {
    return { qualified: false, code: "choice", detail: "選択肢の別価値あり (単一代表値は不正確)" };
  }
  if (hasAddonMarker(descRaw)) {
    return { qualified: false, code: "addon", detail: "付帯物の別価値あり (全額不明)" };
  }
  if (hasResaleMarker(descRaw)) {
    return { qualified: false, code: "resale", detail: "転売・買取相場 (企業提示の額面ではない)" };
  }
  const desc = normalizeNumeric(descRaw);
  const annualYen = extractStrictYenSpans(descRaw)
    .filter((s) => isAnnualSpan(desc, s.index))
    .map((s) => s.value);
  if (annualYen.includes(value)) {
    return { qualified: false, code: "annual", detail: "年間合計を各月に充当" };
  }
  // 額面候補が2種類以上あれば、1つを摘んでも合算しても全体額にならない。
  // 部分値も任意の合計も作らない (fail-closed)。recipient/month の一致は
  // 部分を全体にしないので、context とは無関係にここで落とす。
  const faces = extractFaceValues(descRaw);
  if (new Set(faces).size >= 2) {
    return {
      qualified: false,
      code: "multi_face_components",
      detail: "額面候補が複数あり全体額を一意に決めない (部分摘み・合算はしない)",
    };
  }
  // 額面表示 (○円相当/○円分/○円券)。素の金額一致は採らない。
  // 単価だけの値は受益全体ではないのでここで塞ぐ (unit_partial)。
  if (faces.includes(value)) {
    if (isUnitPricedWhole(descRaw, value)) {
      return {
        qualified: false,
        code: "unit_partial",
        detail: "単価のみで受益全体の額ではない (数量つき。全体額か単価×数量だけが positive)",
      };
    }
    return { qualified: true, rule: "face-literal" };
  }
  // 単価 × per-grant 数量 (同一 clause 内)。年間数量での一致は annual。
  // 単価は 1枚当たり表示と券額面 (○円券) の両方を見る。
  for (const clause of splitClauses(descRaw)) {
    const units = [...extractCouponUnits(clause), ...extractTicketUnits(clause)];
    if (units.length === 0) continue;
    const perGrantQty = extractPerGrantQuantities(clause);
    if (units.some((u) => perGrantQty.some((q) => u * q === value))) {
      return { qualified: true, rule: "coupon-unit" };
    }
    const annualQty = extractAnnualQuantities(clause);
    if (units.some((u) => annualQty.some((q) => u * q === value))) {
      return { qualified: false, code: "annual", detail: "年間数量での金額化" };
    }
  }
  // 額面×数量の明示積 (100円×25枚)。単一正規表現なので同一 clause 性は自明。
  if (extractFaceProducts(descRaw).includes(value)) {
    return { qualified: true, rule: "coupon-unit" };
  }
  // ポイント × 厳密レート (同一 clause 内)。
  for (const clause of splitClauses(descRaw)) {
    const points = extractPointSpans(clause).map((s) => s.value);
    const rates = extractExactRates(clause);
    if (rates.length > 0 && rates.some((r) => points.some((p) => p * r === value))) {
      return { qualified: true, rule: "points-rate" };
    }
  }
  return { qualified: false, code: "no_per_grant_face", detail: "企業提示の exact な額面根拠が無い (無関係の金額・数量、推定合計等)" };
}

/**
 * company 値の厳密判定に使う recipient context。要約取込では同一文言の
 * group 全行分、carry では 1 行分を渡す (どちらも同じ関数・同じ述語)。
 */
export type PerGrantContext = {
  readonly minShares: readonly number[];
  readonly recordMonths: readonly number[];
  /**
   * 表の h3 見出し (原文)。HOLD 語の走査にだけ使い、額面の根拠にはしない。
   * 見出しだけにある選択・抽選・割引等の条件を落とさないため
   * (8022 の 3,300 円は見出し「直営ゴルフスクールの入会金 無料」が正体)。
   * 省略可 (DB 行だけの呼び出しでは欠ける)。
   */
  readonly headings?: readonly string[];
};

/**
 * 見出しの scope HOLD 走査。額面の positive 認定はしない (見出しの金額を
 * 根拠に company へ上げない)。抽選は見出しの scope で HOLD し、見出し自体に
 * 金額・当選人数があるかは問わない (7578「抽選式株主優待」+ 本文「1口」)。
 * 選択肢は従来どおり見出し単独で HOLD を保つ。割引はここでは見ない —
 * 型付き券 unit 規則の後に、見出し+本文の joint で別に見る。
 */
function headingScopeHold(heading: string, value: number | null): CompanyNominalVerdict | null {
  if (hasApproxMarker(heading)) {
    return { qualified: false, code: "approx", detail: "見出しに概算表記" };
  }
  if (value !== null && isUnconvertedForeignAmount(heading, value)) {
    return { qualified: false, code: "foreign", detail: "見出しに外貨額面" };
  }
  if (normalizeNumeric(heading).includes("抽選")) {
    return { qualified: false, code: "lottery", detail: "見出しが抽選 scope" };
  }
  if (hasChoiceMarker(heading)) {
    return { qualified: false, code: "choice", detail: "見出しに選択肢" };
  }
  if (hasAddonMarker(heading)) {
    return { qualified: false, code: "addon", detail: "見出しに付帯物の別価値" };
  }
  if (hasResaleMarker(heading)) {
    return { qualified: false, code: "resale", detail: "見出しに転売・買取相場" };
  }
  return null;
}

/** 見出し+本文の joint 割引 HOLD。換金性例外は本文から来てよい (9616 の券額面を殺さない)。 */
function headingDiscountHold(heading: string, body: string): CompanyNominalVerdict | null {
  if (
    isDiscountWithoutRedeemable(heading) &&
    isDiscountWithoutRedeemable(`${heading}\n${body}`)
  ) {
    return { qualified: false, code: "discount", detail: "見出しが割引 (見出し+本文に換金金券なし)" };
  }
  return null;
}

/**
 * headed 型付き coupon-unit 規則 (4680「500円割引券」+ 本文「1枚」)。
 * 通るのは narrow な 1 形だけ: 見出しの型付き券 unit が単一値 × 本文の
 * per-grant 数量が単一値 × 積が値と整数完全一致。generic な見出し通貨は
 * 採らない (unit 抽出が券隣接必須)。数量は既存の per-grant 抽出
 * (年間・単価基数・小数を除く) をそのまま使い、複数 distinct は曖昧で
 * 落とす (4680 sh300 の「3枚」+ 利用条件「1日1枚」は適用しない)。
 * 許容誤差・推定レート・cross-clause の組合せは無い。見出しは当該行自身の
 * 保存見出し・同一キーの ctx 見出しだけで、他行の見出しは引かない
 * (direct same-benefit context は構造で保証。lookup は無い)。
 * 呼び出し側が本文 nominal の HOLD コードで絞る (no_per_grant_face の
 * 純粋な額面欠落だけが対象。本文の choice/approx/lottery 等の negative
 * 判定は authoritative で、この規則は上書きしない)。
 */
function qualifyHeadedCouponUnit(
  headings: readonly string[],
  body: string,
  value: number | null
): CompanyNominalVerdict | null {
  if (value === null || !Number.isInteger(value) || value <= 0) return null;
  const units = new Set<number>();
  for (const h of headings) {
    for (const u of extractHeadedTicketUnits(h)) units.add(u);
  }
  if (units.size !== 1) return null;
  const qtys = [...new Set(extractPerGrantQuantities(body))];
  if (qtys.length !== 1) return null;
  const [unit] = [...units];
  const [qty] = qtys;
  if (unit * qty !== value) return null;
  return { qualified: true, rule: "coupon-unit" };
}

/**
 * company 値の共有厳密判定 (純関数)。要約取込 (`planSummaryImport`) と
 * full-import carry (`planCarry`) の両方がこの 1 関数を使う
 * (importer と carry で別述語を持たない)。
 *
 * - group の株数条件が混ざれば 1 つの金額を決めない (group 全体 HOLD)
 * - 複数月の group で per-grant 候補額が 2 種類以上あれば HOLD
 *   (max/約数などの算術ヒューリスティクスは根拠にならないので使わない。
 *   単一候補 + 下の qualifier 通過だけが明示の per-grant 根拠)
 * - 文言自体に複数 tier が並び per-grant 候補額が 2 種類以上あれば HOLD
 *   (要約の文言とは無関係。要約から tier ラベルを消しても回避できない)
 * - 上を抜けたら文言+値の qualifier (`qualifyCompanyNominal`)
 */
export function qualifyCompanyPerGrantValue(
  descRaw: string,
  value: number | null,
  ctx: PerGrantContext
): CompanyNominalVerdict {
  // headed 保存形は先に切り分ける。本文だけが positive 規則の入力で、
  // 保存見出しは ctx 見出しと束ねて HOLD 走査にだけ使う。marker 無し旧文は
  // body = 原文・見出し無しで旧判定と同一。壊れた headed は正の全文に
  // しない (HOLD で止め、company へ上げない)。
  const split = splitHeadedDescription(descRaw);
  if (split.malformed) {
    return {
      qualified: false,
      code: "malformed_headed_contract",
      detail: "保存文の headed 契約が壊れている (正の本文として扱わない)",
    };
  }
  const { heading: storedHeading, body } = split;
  const headings = [...(storedHeading ? [storedHeading] : []), ...(ctx.headings ?? [])];
  if (new Set(ctx.minShares).size > 1) {
    return {
      qualified: false,
      code: "mixed_share_context",
      detail: `同一文言の行で株数条件が異なる (${[...new Set(ctx.minShares)].sort((a, b) => a - b).join(",")}株。tier 混在のため金額を1つに決めない)`,
    };
  }
  const amounts = extractStrictYenAmounts(body);
  if (new Set(ctx.recordMonths).size > 1 && amounts.length >= 2) {
    return {
      qualified: false,
      code: "multi_month_amounts",
      detail: "複数月の同一文言に per-grant 候補額が2種類以上 (文言から1つに決めない)",
    };
  }
  if (amounts.length >= 2 && hasMultiConditionTiers(body)) {
    return {
      qualified: false,
      code: "ambiguous_condition_tiers",
      detail: "文言自体に複数 tier が並び per-grant 候補額が2種類以上 (tier↔金額の対応づけ不能)",
    };
  }
  for (const heading of headings) {
    const hold = headingScopeHold(heading, value);
    if (hold) return hold;
  }
  // 本文 nominal を先に求める (既存ラベルを保つ)。本文 HOLD のうち純粋な
  // 額面欠落 (no_per_grant_face) だけ headed 型付き coupon-unit 規則の対象に
  // し、choice/approx/lottery 等の本文 negative 判定は authoritative
  // (上書きしない)。joint 割引は nominal qualified の返却より先に見る —
  // 割引見出し + 換金性の無い本文額面は HOLD で止める (9616 の券額面は
  // joint 換金性例外で通す)。最後に本文 nominal を返す。
  const nominal = qualifyCompanyNominal(body, value);
  if (!nominal.qualified && nominal.code === "no_per_grant_face") {
    const headedCoupon = qualifyHeadedCouponUnit(headings, body, value);
    if (headedCoupon) return headedCoupon;
  }
  for (const heading of headings) {
    const hold = headingDiscountHold(heading, body);
    if (hold) return hold;
  }
  return nominal;
}

/**
 * 利回り・スコア計算用の backend 合成 (1 箇所。述語の二重化はしない)。
 * company の非 null 値を共有厳密判定にかけ、通過分だけ返す。
 * 裸の company スタンプ (legacy の未認定値) は落とす。不認定・不明は
 * null (no-data) にし、0 にはしない。公開面は使わない
 * (公開は `trusted-value.ts` の最小境界だけ。guard を bundle に入れない)。
 */
export function trustedCompanyYieldValue(
  row: {
    description: string;
    estimatedValue: number | null;
    estimateValueSource: string | null;
  },
  group: { minShares: readonly number[]; recordMonths: readonly number[] },
): number | null {
  if (row.estimateValueSource !== "company" || row.estimatedValue === null) return null;
  const verdict = qualifyCompanyPerGrantValue(row.description, row.estimatedValue, {
    minShares: group.minShares,
    recordMonths: group.recordMonths,
  });
  return verdict.qualified ? row.estimatedValue : null;
}

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


