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
   * null は「3 期分のデータが無い」だけでなく「連結/単体の混在で判定できない」も含む。
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
 * 「定義が混在している疑い」とみなす隣接年比の閾値
 *
 * 2 倍 (= 1/0.5) を境にした理由:
 *   - 持株会社の単体売上は連結の 2〜10% しかなく、段差は 10〜40 倍になる
 *   - 合併・大型買収による**正当な**倍増は 2〜3 倍帯に集中する (実測 619 ペア)
 * つまり 2 倍は正当な急成長を巻き込む側に振った保守的な閾値ではなく、
 * 正当な倍増も「判定不能」に倒す。優良株は「判断できるもの」だけで良い、という判断。
 */
export const DEFINITION_BREAK_RATIO = 2;

/**
 * 年次売上の系列に「連結/単体の定義が切り替わった疑い」があるか
 *
 * `core_stock_annual_financials.revenue` は Yahoo `quoteSummary` の
 * `incomeStatementHistory[].totalRevenue` の生値だが、Yahoo はこの配列の期ごとに
 * **連結 (売上収益) と単体 (親会社単体の売上高) を混在させて返す**。
 * 持株会社では単体が連結の 2〜10% しかないため、同一銘柄の系列内に 10〜40 倍の段差が出る。
 *
 * 層別実測 (銘柄名に「ホールディングス/ＨＤ」を含むかで分けた):
 *   - 持株会社   464 銘柄中 296 (63.8%) が自系列内 max/min > 10 倍
 *   - それ以外 3,285 銘柄中 185 (5.6%)
 *   → 11.4 倍の濃縮。重複行・単位混在・TTM 混入はいずれも実測で否定済み
 *     (UNIQUE(stock_id, fiscal_year) が実在し重複 0 件、隣接年比 1e4 超は 0 件、
 *      この表へ流れるのは通期の incomeStatementHistory のみ)。
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
 * 優良株判定
 *
 * @param annualFinancials - 年度財務 (古い→新しい順)
 * @param operatingMarginTtm - TTM 営業利益率
 */
export function evaluateBlueChip(
  annualFinancials: AnnualFinancial[],
  operatingMarginTtm: number | null
): BlueChipEvaluation {
  const recent = annualFinancials.slice(-3);

  if (recent.length < 3) {
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
