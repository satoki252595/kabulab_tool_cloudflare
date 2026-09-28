/**
 * 優良株 (blue chip) 判定
 *
 * rsi-screening の `services/rsi-screening/src/services/blue-chip-filter.ts`
 * からの純粋移植。
 *
 * 現在の優良株定義:
 *   - 売上高が過去 3 年で増加基調 AND
 *   - 営業利益率 TTM が閾値以上
 *
 * ただし売上高の供給元 (Yahoo) が連結と単体を混在させて返すため、
 * 判定窓に定義切り替えの疑い (隣接年比 2 倍超) があれば売上トレンドは null にする。
 * 詳細は `hasDefinitionBreak` のコメント。
 *
 * 元々は「営業利益率の 3 年トレンド + 売上高の 3 年トレンド」だったが、
 * Yahoo Finance が 2025 年頃に無料 quoteSummary API から `operatingIncome` を
 * 削除した (`{}` を返す) ため、historical な営業利益率は計算不能。代わりに
 * `financialData.operatingMargins` (TTM 単一値) を使って現在の収益性を判定する。
 */

import type { AnnualFinancial } from "../types.js";

export interface BlueChipEvaluation {
  isBlueChip: boolean;
  /** 営業利益率 TTM (0.1234 = 12.34%) */
  operatingMarginTtm: number | null;
  /**
   * 売上高トレンド: +1=上昇 / 0=横ばい / -1=下降 / null=判定不能
   *
   * null は「3 期分のデータが無い」だけでなく「連結/単体の混在で判定できない」、
   * 「年欠落・決算期変更・不明区分・未取得で年次比較できない」も含む。
   */
  revenueTrend: number | null;
}

/** 営業利益率 TTM の閾値 (日本株中央値付近 = 5%) */
export const OPERATING_MARGIN_TTM_THRESHOLD = 0.05;

/**
 * 時系列配列が「上昇基調」か判定する
 *
 * 最初→最後が +5% 以上増加 & 途中で -5% 超の年前年比下落が無ければ上昇基調。
 *
 * この関数は「与えられた数列の形」だけを見る純関数であり、
 * 売上定義の混在 (連結/単体) を検出する `hasDefinitionBreak` は**意図的に含めない**。
 * 2 倍段差ガードは「売上高という列の意味が途中で入れ替わっている」という
 * 供給元 (Yahoo) 固有の欠陥に対する措置であって、トレンド判定の一般則ではないため。
 * 売上高に対して使う場合は `evaluateBlueChip` 経由で呼び、
 * judgeTrend を直接呼ぶ経路を増やさないこと (ガードを素通りする)。
 *
 * @returns +1=上昇 / 0=横ばい / -1=下降 / null=判定不能
 */
export function judgeTrend(values: (number | null)[]): number | null {
  const valid = values.filter(
    (v): v is number => v !== null && Number.isFinite(v)
  );
  if (valid.length < 2) return null;

  const first = valid[0];
  const last = valid[valid.length - 1];
  if (first === 0) return null;

  const totalChange = (last - first) / Math.abs(first);

  let hasSignificantDrop = false;
  let hasSignificantRise = false;
  for (let i = 1; i < valid.length; i++) {
    const prev = valid[i - 1];
    if (prev === 0) continue;
    const yoy = (valid[i] - prev) / Math.abs(prev);
    if (yoy < -0.05) hasSignificantDrop = true;
    if (yoy > 0.05) hasSignificantRise = true;
  }

  if (totalChange > 0.05 && !hasSignificantDrop) return 1;
  if (totalChange < -0.05 && !hasSignificantRise) return -1;
  return 0;
}

/**
 * 「定義が混在している疑い」とみなす隣接年比の閾値。持株会社の単体/連結の
 * 段差 (10〜40 倍) を捉え、正当な倍増 (2〜3 倍帯) も「判定不能」に倒す
 * (優良株は判断できるものだけで良い)。値は blue-chip のテストが固定。
 */
export const DEFINITION_BREAK_RATIO = 2;

/**
 * 年次売上の系列に「連結/単体の定義が切り替わった疑い」があるか
 *
 * `core_stock_annual_financials.revenue` は Yahoo の生値だが、Yahoo は期ごとに
 * **連結と単体を混在させて返す** (持株会社では 10〜40 倍の段差が出る)。
 *
 * null (欠損年) は除外してから隣接判定するため、年が飛んでいる系列では
 * **隣接年ではなく「飛んだ先の年」との比**を見る ([100, null, 1000] → true)。
 * 欠損を挟んだ 2 年分の複利成長が 2 倍を超える場合も「判定不能」に倒れるが、
 * 欠損年のある系列で成長率を主張できない以上、null に倒すのが安全側。
 *
 * **このガードの限界 (是正ではなく止血)**:
 * 検出できるのは「定義が切り替わった**瞬間**」だけ。判定窓の 3 期すべてが単体に
 * (あるいはすべて連結に) 揃っている系列は段差を持たないので**素通りする**。
 * 持株会社 464 銘柄中 296 が系列内に 10 倍超のスパンを持つのだから、
 * 窓が単体側に揃って「単体の売上で優良株判定される」銘柄は必ず存在する。
 * 汚染そのものを消すには既存行の再構築が必要 (docs/001-rsi-screening.md 参照)。
 */
export function hasDefinitionBreak(values: (number | null)[]): boolean {
  const valid = values.filter(
    (v): v is number => v !== null && Number.isFinite(v)
  );
  for (let i = 1; i < valid.length; i++) {
    const prev = valid[i - 1];
    const curr = valid[i];
    // 0 / 負の売上は比率が定義できない (符号反転で無意味な倍率になる) ため段差判定から除く。
    // 「0 を含む系列は無条件で null」にしない理由: 0 を含む窓は judgeTrend が
    // +1 を返せない (先頭の 0 は first===0 で null、途中/末尾の 0 は -100% の YoY 下落に
    // なり hasSignificantDrop が立つ) ので、素通りさせても優良株フラグには届かない。
    // ※ 負の売上だけは judgeTrend が Math.abs(first) を使うため +1 になり得る
    //   ([-100, 50, 60] → +1)。totalRevenue が負で返る例は実測に無いため
    //   judgeTrend 側は触っていないが、負値が入り始めたらここは穴になる。
    if (prev <= 0 || curr <= 0) continue;
    const ratio = curr / prev;
    if (ratio > DEFINITION_BREAK_RATIO || ratio < 1 / DEFINITION_BREAK_RATIO) {
      return true;
    }
  }
  return false;
}

/**
 * 2 つの実績期末が「年次の連続」か。暦年がちょうど +1 かつ月日が同一の
 * ときだけ真。欠年 (FY2022→FY2024)・決算期変更の端数期 (03-31→12-31)・
 * 移行に伴う月日のずれはここで弾く。期首/期間を持たない現状では
 * 同一月日の連続でも各期の正確な長さを証明できない (上場年初年度の
 * 短い第 1 期など) が、推測で弾くことはせず残件として docs に明記する。
 * 形式が 'YYYY-MM-DD' でない入力は投げずに偽 (判定不能に倒すだけ)。
 */
function isNextAnnualEnd(prev: string, curr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(prev) || !/^\d{4}-\d{2}-\d{2}$/.test(curr)) {
    return false;
  }
  return (
    Number(curr.slice(0, 4)) === Number(prev.slice(0, 4)) + 1 &&
    curr.slice(5) === prev.slice(5)
  );
}

/**
 * 判定窓の 3 期が年次比較できる並びか。
 *
 * 1. 3 期とも売上が確定値 (null・非有限は比較できない)
 * 2. 連結区分が既知 (連結/単体) かつ 3 期同一。'不明' は区分を保証できず、
 *    混在・欠落も比較できない
 * 3. 実績期末が年次で連続 (暦年 +1 かつ同月日)。実績期末を持たない入力
 *    (旧 Yahoo 年次) は連続を証明できないので比較しない
 *
 * 偽のとき呼び出し側は年率化・穴埋め・他データでの代替をせず、
 * revenueTrend を null (判定不能) に倒す。無い期の行は作らない。
 */
function isComparableAnnualWindow(window: AnnualFinancial[]): boolean {
  for (const f of window) {
    if (f.revenue === null || !Number.isFinite(f.revenue)) return false;
  }
  const [first, second, third] = window.map((f) => f.consolidated);
  if (first !== "連結" && first !== "単体") return false;
  if (second !== first || third !== first) return false;
  const [prev2, prev1, latest] = window.map((f) => f.fiscalPeriodEnd);
  if (prev2 === undefined || prev1 === undefined || latest === undefined) {
    return false;
  }
  return isNextAnnualEnd(prev2, prev1) && isNextAnnualEnd(prev1, latest);
}

/**
 * 優良株判定
 *
 * 判定窓は直近 3 期。`isComparableAnnualWindow` を通った並びだけを
 * 数値比較し、通らない並びは revenueTrend を null (判定不能) に倒す。
 * FY2022/FY2024/FY2026 のような飛び年は 3 年連続ではない。
 *
 * @param annualFinancials - 年度財務 (古い→新しい順)
 * @param operatingMarginTtm - TTM 営業利益率 (Yahoo TTM の定義のまま)
 */
export function evaluateBlueChip(
  annualFinancials: AnnualFinancial[],
  operatingMarginTtm: number | null
): BlueChipEvaluation {
  const recent = annualFinancials.slice(-3);

  if (recent.length < 3) {
    return { isBlueChip: false, operatingMarginTtm, revenueTrend: null };
  }

  if (!isComparableAnnualWindow(recent)) {
    return { isBlueChip: false, operatingMarginTtm, revenueTrend: null };
  }

  const revenues = recent.map((f) => f.revenue);

  // 判定窓の中に連結/単体の段差があるなら、この銘柄の売上トレンドは**判定できない**。
  // 「トレンドが悪い」のではないので 0 ではなく null に倒す
  // (`revenue_trend` は schema 上 nullable、stock-detail も `?? null` で受ける)。
  //
  // 採らなかった案: 書き込み側 (src/cron/daily.ts) で「段差があれば配列全体を書かずスキップ」。
  //   - 段差を持つ銘柄の年次売上が**将来にわたって更新停止**する
  //     (7203 は翌期の正当な FY2027 行も永久に入らなくなる)
  //   - 既存の汚染行はそのまま残るので「汚染は残り、更新だけ止まる」最悪の組み合わせになる
  //   - 合併・大型買収による正当な 2 倍増も恒久ブロックされる
  //   よって供給された値はそのまま保存し、**判定側で降りる**。
  const revenueTrend = hasDefinitionBreak(revenues)
    ? null
    : judgeTrend(revenues);

  const isBlueChip =
    revenueTrend === 1 &&
    operatingMarginTtm !== null &&
    operatingMarginTtm >= OPERATING_MARGIN_TTM_THRESHOLD;

  return { isBlueChip, operatingMarginTtm, revenueTrend };
}
