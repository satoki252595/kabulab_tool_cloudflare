/**
 * `jss_financials` (③財務サマリ) の読み取り専用ミラー + 年次系列の gate。
 *
 * DDL の正本は pipeline 側
 * (`pipeline/src/jp_stock_pipeline/cloud_store/schema.py` の `_FINANCIALS`、
 * PK は `(code, fiscal_period_end, disclosure_type, consolidated)`)。
 * このファイルは **drizzle-kit の generate 対象にしない**
 * (`drizzle.d1.config.ts` の schema 配列へ追加しないこと)。追加すると
 * generate が `CREATE TABLE jss_financials` の migration を吐き、
 * 本番の既存表と衝突する。writer も持たない (stockStock 側が所有)。
 *
 * 列は読む 6 列だけ (使用 5 列 + license 列。YAGNI で全列は写さない)。
 * 公開面の数値クエリは `license_tag='commercial-ok'` (EDINET) を SQL 条件に
 * 必ず含める。TDnet 短信由来 (factual-cite) の行は公開面に出さない。
 * 来歴列を select しないだけでは公開制限にならないので、WHERE で落とす。
 */
import {
  sqliteTable,
  text,
  real,
  primaryKey,
} from "drizzle-orm/sqlite-core";

export const jssFinancials = sqliteTable(
  "jss_financials",
  {
    code: text("code").notNull(),
    /** 決算期末 'YYYY-MM-DD' */
    fiscalPeriodEnd: text("fiscal_period_end").notNull(),
    /** 本決算/1Q/2Q/中間/3Q/修正/予想。年度実績は '本決算' のみ */
    disclosureType: text("disclosure_type").notNull(),
    /** 連結/単体/不明。PK の一部なので NOT NULL (不明は番兵値) */
    consolidated: text("consolidated").notNull(),
    /** 実績売上高。予想は forecast_* 列 (読まない) */
    netSales: real("net_sales"),
    /** commercial-ok (EDINET) / factual-cite (TDnet 短信) / personal-only */
    licenseTag: text("license_tag").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.code,
        table.fiscalPeriodEnd,
        table.disclosureType,
        table.consolidated,
      ],
    }),
  ]
);

/** 公開面に出せる license_tag。EDINET 由来のみ */
export const PUBLISHABLE_LICENSE_TAG = "commercial-ok";

/** gate へ渡す本決算行 (SQL で disclosure_type='本決算' 済みのもの) */
export interface JssAnnualRow {
  fiscalPeriodEnd: string;
  consolidated: string;
  revenue: number | null;
}

/** 年次系列の 1 点 (古い→新しい順に並ぶ) */
export interface AnnualSeriesPoint {
  /** 決算期末の暦年 (表示用。銘柄間の横並び比較には使わない) */
  fiscalYear: number;
  /** 実績期末 'YYYY-MM-DD' */
  fiscalPeriodEnd: string;
  /** 連結区分。系列内は単一 */
  consolidated: string;
  /** 本決算の実績売上高。未取得は null */
  revenue: number | null;
}

/**
 * 系列に使う連結区分の優先順。同じ最新期に連結と単体の両方があるときは
 * 連結を取る (既存の正準優先)。'不明' は writer が判定不能時に立てる番兵値。
 */
const SCOPE_PRIORITY = ["連結", "単体", "不明"] as const;

/**
 * 短期決算とみなす最大の期末間隔 (日)。正規の事業年度は 354〜378 日
 * (53 週決算を含む) なので、330 日 (11 ヶ月) 未満の間隔で来た期は
 * 決算期変更の端数期として年次比較から外す。外した期は欠落として残し、
 * 他の期で埋めない。15 ヶ月級の延長型移行期 (400〜600 日の窓) は
 * ここでは検出しない (未対応の残件。2 倍超の段差は従来の
 * hasDefinitionBreak が判定不能に倒す)。
 */
const SHORT_PERIOD_MAX_GAP_DAYS = 330;

/** 'YYYY-MM-DD' を UTC epoch ミリ秒へ。形式が壊れていたら投げる */
function periodEndMs(value: string, what: string): number {
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    throw new Error(`${what} の形式が不正: ${value}`);
  }
  return ms;
}

/** 決算期末 'YYYY-MM-DD' から表示用の暦年を取る。形式が壊れていたら投げる */
function fiscalYearOf(fiscalPeriodEnd: string): number {
  const year = Number(fiscalPeriodEnd.slice(0, 4));
  if (!Number.isInteger(year)) {
    throw new Error(`fiscal_period_end の形式が不正: ${fiscalPeriodEnd}`);
  }
  return year;
}

/**
 * jss 本決算行から年次系列を作る (古い→新しい順)。001 銘柄詳細の表示と
 * 日次 sync の優良株選定 (`evaluateBlueChip` の入力) で共用する gate。
 *
 * 1. `asOf` (当日 'YYYY-MM-DD') より後の期末は未来期として落とす。
 *    '本決算' に未来の期が混ざっても実績比較に入れない。
 * 2. 使う連結区分は**最新の本決算期末**に明示されたもので決め、全期間を
 *    その区分に絞る。最新期に連結と単体の両方があれば連結を優先し、
 *    最新期に不明しか無ければ不明のまま (古い既知区分で埋めない)。
 *    全履歴の連結有無で永久優先すると、最新 FY で単体化した企業の
 *    最新年度を捨てる事故になる。
 * 3. 直前 kept 期との間隔が 330 日未満の期は短期決算 (決算期変更の端数期)
 *    として落とす。年欠落 (gap) と null は保持し、補完しない。
 *
 * 訂正は writer が disclosed_at ガード付き完全置換 (#131。NULL を含めて
 * Notion 正本をそのまま反映) で同一 PK 行へ反映済みなので、'本決算' 行を
 * そのまま読むことが訂正最新版を読むことになる。ここで新旧を選ばない。
 *
 * @param rows - 1 銘柄ぶんの本決算行 (license_tag='commercial-ok' 済み)
 * @param asOf - 基準日 'YYYY-MM-DD'。これより後の期末は未来期として落とす
 */
export function pickAnnualSeries(
  rows: JssAnnualRow[],
  asOf: string
): AnnualSeriesPoint[] {
  periodEndMs(asOf, "asOf");
  const actuals = rows.filter((r) => r.fiscalPeriodEnd <= asOf);
  if (actuals.length === 0) return [];
  const sorted = [...actuals].sort((a, b) =>
    a.fiscalPeriodEnd < b.fiscalPeriodEnd
      ? -1
      : a.fiscalPeriodEnd > b.fiscalPeriodEnd
        ? 1
        : 0
  );
  const latestEnd = sorted[sorted.length - 1].fiscalPeriodEnd;
  const scope = SCOPE_PRIORITY.find((s) =>
    sorted.some((r) => r.fiscalPeriodEnd === latestEnd && r.consolidated === s)
  );
  if (scope === undefined) {
    throw new Error(
      "jss_financials の最新期に未知の連結区分しか無い " +
        "(writer 契約違反: 連結/単体/不明のいずれかが必要)"
    );
  }
  const points: AnnualSeriesPoint[] = [];
  for (const r of sorted) {
    if (r.consolidated !== scope) continue;
    const prev = points[points.length - 1];
    if (
      prev !== undefined &&
      (periodEndMs(r.fiscalPeriodEnd, "fiscal_period_end") -
        periodEndMs(prev.fiscalPeriodEnd, "fiscal_period_end")) /
        86400000 <
        SHORT_PERIOD_MAX_GAP_DAYS
    ) {
      continue;
    }
    points.push({
      fiscalYear: fiscalYearOf(r.fiscalPeriodEnd),
      fiscalPeriodEnd: r.fiscalPeriodEnd,
      consolidated: r.consolidated,
      revenue: r.revenue,
    });
  }
  return points;
}
