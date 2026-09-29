/**
 * moneyflow アダプタ: JPX「投資部門別売買状況」(株式、週次・月次)。
 *
 * 取得・解析・様式検証は取得元モジュール `../sources/jpx-investor-equity.ts` が担い、
 * ここでは Phase 1 の Notion 3 DB (指標定義 / 観測ログ / 取込ログ) へつなぐ
 * `MoneyflowSourceSpec` を 2 つ (週次・月次。公表タイミングも一覧ページも別) export する。
 *
 *   - `jpx-investor-equity-weekly`  … 冪等キー `jpx-investor-equity-weekly-YYYY-Www`
 *     (期間終了日の ISO 週。一覧ページの行ラベル「2026年9月第2週(9月7日～9月11日)」の
 *     終了日から決め、toObservations でファイル内の期間終了日と突き合わせる)
 *   - `jpx-investor-equity-monthly` … 冪等キー `jpx-investor-equity-monthly-YYYY-MM`
 *     (JPX がその月次ファイルを帰属させている年月。集計期間は週単位で区切られ暦月と
 *     一致しないため、期間開始・終了はファイルに書かれた実際の集計期間を使う)
 *
 * 冪等キーに版は含めない。JPX は定期的な改訂 (速報→確報) をしないが、誤りがあれば
 * 公表後に訂正することがある (週次一覧ページに「訂正情報（2024年9月10日）」の掲載あり)。
 * 訂正後のファイルは同じキーのため自動では取り直さない — この限界は指標定義の「限界」に明記する。
 *
 * 1 バッチの行数: 旧様式は 4 市場 × 15 投資部門 × (金額/株数) × (買い越し/売買合計) = 240 行、
 * 新様式は 4 市場 × 14 投資部門 × (金額/株数) × (買い越し/売買合計) = 224 行。
 *
 * 様式変更 (2026-09-29 の user 決定: 旧方式互換・移行要件なし、新様式ファースト):
 * 週次は 2026-09-29 掲載分から単一ファイルの新様式になり、実ファイル
 * (`stock_1_w_20260914_20260918.xlsx`、2026年9月第3週分) で検証済み
 * (単位は見出しどおり千株/千円、112件全件で買い-売り=差引・売り+買い=合計が一致)。
 * 本アダプタは週次の新旧どちらの様式も受け付ける。月次は 2026-10-08 掲載分からの
 * 新様式が未公表のため、新様式の月次レコードは受け付けずに throw する
 * (unknown-reject。公表後に実ファイルで検証して対応する)。
 *
 * 新旧の投資部門名: 両様式で名前が同じ8部門 (証券会社・投資信託・事業法人・
 * その他法人等・生保・損保・都銀・地銀等・信託銀行・その他金融機関) は JPX の定義が
 * 同一のため同じ系列として扱う。それ以外は名前が違う (旧: 自己計/委託計/総計/法人/
 * 個人/海外投資家/金融機関 → 新: 自己現金/自己信用/個人現金/個人信用/
 * 海外投資家法人/海外投資家個人) ため混ざらない。旧系列への無言合流はしない。
 */
import {
  MONTHLY_INDEX_URL,
  WEEKLY_INDEX_URL,
  jpxInvestorEquityArchiveInput,
  latestWeeklyEntry,
  parseInvestorEquityWorkbook,
  parseMonthlyIndexHtml,
  parseWeeklyIndexHtml,
  pickLatestPublishedMonth,
  type FetchedInvestorEquity,
  type InvestorEquityMarket,
  type InvestorEquityPeriodType,
  type InvestorEquityRecord,
} from "../sources/jpx-investor-equity.js";
import { isoWeekLabelOf } from "../iso-week.js";
import {
  requireSpecFile,
  type FetchedBatch,
  type MoneyflowSourceSpec,
  type ObservationDraft,
  type SpecFile,
} from "../source-spec.js";
import type { IndicatorDefInput, MoneyflowFrequency } from "../../../../src/shared/notion-archive/index.js";

// 取得元モジュールと同一のブラウザ相当 UA (モジュールは UA 定数も「一覧ページだけ取る」
// 関数も export していないため、resolve で一覧ページだけを軽く取るのに同じ値を使う。
// UA を付けない fetch は JPX の WAF に 403 で弾かれる — モジュールの注記参照)。
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const WEEKLY_SPEC_NAME = "jpx-investor-equity-weekly";
const MONTHLY_SPEC_NAME = "jpx-investor-equity-monthly";

/** 一次データのファイル名の接頭辞 (`jpxInvestorEquityArchiveInput` の命名と同じ)。 */
const VALUE_FILE_PREFIX = "investor-equity-value-";
const VOLUME_FILE_PREFIX = "investor-equity-volume-";
const UNIFIED_FILE_PREFIX = "investor-equity-unified-";

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`JPX 投資部門別売買状況: HTTP エラー ${res.status} ${res.statusText} (${url})`);
  }
  return res;
}

function urlBasename(url: string): string {
  const name = url.split("/").pop();
  if (!name) throw new Error(`JPX 投資部門別売買状況: URL からファイル名を取得できません: "${url}"`);
  return name;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// 指標定義
// ---------------------------------------------------------------------------

const SOURCE_NOTE =
  "出典: JPX「投資部門別売買状況」(資本金30億円以上の取引参加者経由の取引を集計した値。" +
  "全取引の網羅ではない)。";

const COMMON_LIMITATIONS =
  "集計対象は資本金30億円以上の取引参加者経由の取引のみで、全取引の網羅ではない" +
  "(そのため「総計」でも売りと買いは一致せず、総計の買い越しはゼロにならない)。内国普通株式が" +
  "対象で ETF・REIT・優先株式等は含まない。ToSTNeT (立会外) 取引を含む。東証33業種別の" +
  "内訳は JPX 公式統計に存在しない (市場区分別のみ)。区分は「市場 / 投資部門」で、市場は" +
  "東証プライム・東証スタンダード・東証グロース・二市場 (東京・名古屋の合算)。旧様式の" +
  "投資部門には他の部門の合計行も含む (総計=自己計+委託計、委託計=法人+個人+海外投資家+" +
  "証券会社、法人=投資信託+事業法人+その他法人等+金融機関、金融機関=生保・損保+" +
  "都銀・地銀等+信託銀行+その他金融機関)。合計行と内訳を足し合わせると二重計上になる。" +
  "新様式 (週次 2026-09-29 掲載分〜) に合計行は無く、14部門はすべて葉 " +
  "(自己現金/自己信用/個人現金/個人信用/海外投資家法人/海外投資家個人 + 旧様式と同名の" +
  "8部門)。旧様式の自己計/委託計/総計/法人/個人/海外投資家/金融機関の系列は新様式では" +
  "更新されない (系列終了)。旧様式の表下の「自己・個人の現金/信用」「海外投資家の法人/" +
  "個人」の内訳は取り込んでいない (新様式はこの内訳を列として持つ)。" +
  "前期比は記録しない (空欄)。" +
  "公表後の訂正: JPX は誤りがあれば公表済みの値を訂正することがある (一覧ページの「訂正情報」で" +
  "告知。例: 2024年9月10日)。この取込は同じ期間を1回しか取得しないため、訂正は自動では" +
  "反映されない (反映するには保管済みの一次データをごみへ退避してから取り込み直す)。" +
  "様式変更: 週次は 2026-09-29 掲載分から単一ファイルの新様式になり、実ファイル" +
  "(2026年9月第3週分) で検証済み (単位は見出しどおり千株/千円。新旧で名前が同じ8部門は" +
  " JPX の定義が同一のため同じ系列、それ以外は名前が違うため混ざらない)。月次は" +
  " 2026-10-08 掲載分からの新様式が未公表のため、新様式の月次は取込を停止する" +
  " (失敗として記録される。公表後に実ファイルで検証して対応する)。";

const WEEKLY_LIMITATIONS =
  COMMON_LIMITATIONS +
  "公表: 毎週第4営業日 (通常木曜、祝日で後ろ倒しあり) 午後3時30分に前週分。" +
  "対象期間ラベルは期間終了日の ISO 週 (YYYY-Www) で、JPX の「◯月第n週」とは数え方が違う。" +
  "月をまたぐ週を JPX がどちらの月に数えるかの規則は公表資料で確認できていない" +
  " (確認できた例は 2026年9月第1週 = 8/31〜9/4 のみ)。終了日が翌月に入る週" +
  " (例: 9/28〜10/2) は月の帰属を推測せず取込失敗として止める。";

const MONTHLY_LIMITATIONS =
  COMMON_LIMITATIONS +
  "公表: 翌月、前月最終週の週次発表と同日の午後3時30分。" +
  "対象期間ラベル (YYYY-MM) は JPX がその月次に帰属させた年月で、集計期間は週単位で" +
  "区切られ暦月と一致しない (例: 2026年8月 = 8/3〜8/28。8/31 は9月分に入る)。" +
  "期間開始・終了にはファイルに書かれた実際の集計期間を記録する。";

type IndicatorKind =
  | "net_flow_value"
  | "gross_turnover_value"
  | "net_flow_volume"
  | "gross_turnover_volume"
  | "sell_value"
  | "buy_value"
  | "sell_volume"
  | "buy_volume";

const KIND_TEXT: Record<IndicatorKind, { displayName: string; flowType: IndicatorDefInput["flowType"]; description: string }> = {
  net_flow_value: {
    displayName: "投資部門別 買い越し額 (株式)",
    flowType: "純買い越し",
    description:
      "個人・海外投資家・証券会社・投資信託などの投資部門ごとに、期間中に株を「買った金額」" +
      "から「売った金額」を引いた値 (期間中の流れ=フロー。保有残高=ストックではない)。" +
      "プラスなら買い越し、マイナスなら売り越し。単位は円 (JPX の千円表示を円に換算)。" +
      "例: 海外投資家が +3,000億円なら、その期間に海外投資家は売った額より 3,000億円多く" +
      "日本株を買った。ただし取引には必ず売り手がいるため、ほぼ同じ額をほかの部門 (個人など)" +
      "が売り越しており、「株式市場全体にお金が流れ込んだ額」ではない。" +
      "定義: 投資部門別の株式売買代金について 買付金額 − 売付金額。市場区分別。" +
      SOURCE_NOTE,
  },
  gross_turnover_value: {
    displayName: "投資部門別 売買代金 (株式)",
    flowType: "売買代金",
    description:
      "ある投資部門が期間中に売った金額と買った金額を足し合わせた値で、その部門がどれだけ" +
      "活発に売買したかを示す (期間中のフロー)。プラス・マイナスの向きは無く、買い越し/" +
      "売り越し (お金が正味どちら向きに動いたか) ではない。単位は円 (千円表示を円に換算)。" +
      "例: 個人の売買代金が 23兆円でも、それは売りと買いの合計であり、個人が 23兆円を" +
      "株に投じたという意味ではない。定義: 売付金額 + 買付金額。市場区分別。" +
      SOURCE_NOTE,
  },
  net_flow_volume: {
    displayName: "投資部門別 買い越し株数 (株式)",
    flowType: "純買い越し",
    description:
      "買い越し額と同じ考え方を、金額ではなく株数で見たもの: 期間中に買った株数 − 売った株数" +
      " (期間中のフロー)。プラスなら買い越し、マイナスなら売り越し。単位は株 (JPX の千株表示を" +
      "株に換算)。株価の高い株と安い株では同じ株数でも金額が大きく違うため、金額版と" +
      "併せて見る。定義: 投資部門別の株式売買高について 買付株数 − 売付株数。市場区分別。" +
      SOURCE_NOTE,
  },
  gross_turnover_volume: {
    displayName: "投資部門別 売買高 (株式)",
    flowType: "売買代金",
    description:
      "ある投資部門が期間中に売った株数と買った株数を足し合わせた値 (売買代金の株数版。" +
      "期間中のフロー)。取引の活発さを示し、買い越し/売り越しの向きは表さない。" +
      "単位は株 (千株表示を株に換算)。定義: 売付株数 + 買付株数。市場区分別。" +
      SOURCE_NOTE,
  },
  sell_value: {
    displayName: "投資部門別 売付額 (株式)",
    flowType: "売買代金",
    description:
      "ある投資部門が期間中に株を売った金額そのもの (期間中のフロー。新様式ファイルの" +
      "公式売付セルの直接値で、net/gross のような派生計算ではない)。単位は円 " +
      "(JPX の千円表示を円に換算)。買い越し/売り越しの向きは表さない。" +
      "定義: 投資部門別の株式売付金額。市場区分別。" +
      SOURCE_NOTE,
  },
  buy_value: {
    displayName: "投資部門別 買付額 (株式)",
    flowType: "売買代金",
    description:
      "ある投資部門が期間中に株を買った金額そのもの (期間中のフロー。新様式ファイルの" +
      "公式買付セルの直接値で、net/gross のような派生計算ではない)。単位は円 " +
      "(JPX の千円表示を円に換算)。買い越し/売り越しの向きは表さない。" +
      "定義: 投資部門別の株式買付金額。市場区分別。" +
      SOURCE_NOTE,
  },
  sell_volume: {
    displayName: "投資部門別 売付株数 (株式)",
    flowType: "売買代金",
    description:
      "ある投資部門が期間中に株を売った株数そのもの (期間中のフロー。売付額の株数版。" +
      "新様式ファイルの公式売付セルの直接値)。単位は株 (千株表示を株に換算)。" +
      "定義: 投資部門別の株式売付株数。市場区分別。" +
      SOURCE_NOTE,
  },
  buy_volume: {
    displayName: "投資部門別 買付株数 (株式)",
    flowType: "売買代金",
    description:
      "ある投資部門が期間中に株を買った株数そのもの (期間中のフロー。買付額の株数版。" +
      "新様式ファイルの公式買付セルの直接値)。単位は株 (千株表示を株に換算)。" +
      "定義: 投資部門別の株式買付株数。市場区分別。" +
      SOURCE_NOTE,
  },
};

const KINDS: readonly IndicatorKind[] = [
  "net_flow_value",
  "gross_turnover_value",
  "net_flow_volume",
  "gross_turnover_volume",
];

/**
 * 新様式の公式売付/買付セル用 (週次のみ。月次は future 0 のため付けない)。
 * カタログ定義だけ先行し、観測行の配線 (toDrafts) は新週次パーサ側 (C) が行う。
 */
const WEEKLY_EXTRA_KINDS: readonly IndicatorKind[] = [
  "sell_value",
  "buy_value",
  "sell_volume",
  "buy_volume",
];

/**
 * 指標キー。取得元モジュールのキー (`jpx_investor_equity_<kind>`) に頻度の接尾辞を付ける。
 * 週次と月次は指標定義の「頻度」が異なるため、同じキーを共有できない
 * (取込 CLI は同じキーの異なる定義を throw する)。
 */
function indicatorKey(kind: IndicatorKind, periodType: InvestorEquityPeriodType): string {
  return `jpx_investor_equity_${kind}_${periodType}`;
}

function buildIndicators(periodType: InvestorEquityPeriodType): IndicatorDefInput[] {
  const frequency: MoneyflowFrequency = periodType === "weekly" ? "週次" : "月次";
  const label = periodType === "weekly" ? "週次" : "月次";
  const kinds = periodType === "weekly" ? [...KINDS, ...WEEKLY_EXTRA_KINDS] : KINDS;
  const baseLimitations = periodType === "weekly" ? WEEKLY_LIMITATIONS : MONTHLY_LIMITATIONS;
  return kinds.map((kind) => ({
    key: indicatorKey(kind, periodType),
    displayName: `${KIND_TEXT[kind].displayName} ${label}`,
    requirement: "R1",
    flowType: KIND_TEXT[kind].flowType,
    description: KIND_TEXT[kind].description,
    sourceUrl: periodType === "weekly" ? WEEKLY_INDEX_URL : MONTHLY_INDEX_URL,
    license: "personal-only",
    frequency,
    limitations: WEEKLY_EXTRA_KINDS.includes(kind)
      ? baseLimitations +
        "この指標は新様式ファイル (2026-09-29 掲載分〜) の公式売付/買付セルを直接" +
        "記録する。旧様式系列 (net/gross) とは定義が違い、無言で合流しない。"
      : baseLimitations,
  }));
}

export const JPX_INVESTOR_EQUITY_WEEKLY_INDICATORS: readonly IndicatorDefInput[] = buildIndicators("weekly");
export const JPX_INVESTOR_EQUITY_MONTHLY_INDICATORS: readonly IndicatorDefInput[] = buildIndicators("monthly");

// ---------------------------------------------------------------------------
// 区分 (市場 / 投資部門)
// ---------------------------------------------------------------------------

/** 市場の日本語表記 (JPX のシート見出し「東証プライム」「二市場」等そのまま)。 */
const MARKET_JA: Readonly<Record<InvestorEquityMarket, string>> = {
  "TSE Prime": "東証プライム",
  "TSE Standard": "東証スタンダード",
  "TSE Growth": "東証グロース",
  "Tokyo & Nagoya": "二市場",
};

/** 旧様式の主表の投資部門 (これ以外の名前は様式変更として throw する)。 */
const LEGACY_INVESTOR_CATEGORIES: ReadonlySet<string> = new Set([
  "自己計",
  "委託計",
  "総計",
  "法人",
  "個人",
  "海外投資家",
  "証券会社",
  "投資信託",
  "事業法人",
  "その他法人等",
  "金融機関",
  "生保・損保",
  "都銀・地銀等",
  "信託銀行",
  "その他金融機関",
]);

/**
 * 新様式の投資部門 (実ファイル `stock_1_w_20260914_20260918.xlsx` で確認した14列。
 * これ以外の名前は様式変更として throw する)。証券会社・投資信託・事業法人・
 * その他法人等・生保・損保・都銀・地銀等・信託銀行・その他金融機関の8部門は
 * 旧様式と名前も JPX の定義も同じため、同じ区分 (同じ系列) として扱う。
 */
const UNIFIED_INVESTOR_CATEGORIES: ReadonlySet<string> = new Set([
  "自己現金",
  "自己信用",
  "個人現金",
  "個人信用",
  "海外投資家法人",
  "海外投資家個人",
  "証券会社",
  "投資信託",
  "事業法人",
  "その他法人等",
  "生保・損保",
  "都銀・地銀等",
  "信託銀行",
  "その他金融機関",
]);

function categoryOf(rec: InvestorEquityRecord): string {
  const market = MARKET_JA[rec.market];
  if (market === undefined) {
    throw new Error(`JPX 投資部門別売買状況: 未知の市場です: "${rec.market}"`);
  }
  const known =
    rec.formatVersion === "unified_single_file" ? UNIFIED_INVESTOR_CATEGORIES : LEGACY_INVESTOR_CATEGORIES;
  if (!known.has(rec.investorCategory)) {
    throw new Error(
      `JPX 投資部門別売買状況: 未知の投資部門です: "${rec.investorCategory}" (${rec.formatVersion} の様式変更の可能性)`
    );
  }
  return `${market} / ${rec.investorCategory}`;
}

// ---------------------------------------------------------------------------
// 冪等キー
// ---------------------------------------------------------------------------

// 週次一覧ページの行ラベル: "2026年9月第2週(9月7日～9月11日)" / "2026年9月第1週(8月31日～9月4日)"
const WEEKLY_INDEX_LABEL_RE = /^(\d{4})年(\d{1,2})月第(\d)週\((\d{1,2})月(\d{1,2})日[～〜~](\d{1,2})月(\d{1,2})日\)$/;

/**
 * 週次一覧ページの行ラベルから冪等キーを作る (期間終了日の ISO 週)。
 * 終了日の月がラベルの月と違う (例: 9/28〜10/2 を「9月第5週」とする) 場合は、
 * 年の帰属を推測せず throw する (取得元モジュールのタイトル検証と同じ方針)。
 */
export function weeklyKeyFromIndexLabel(label: string): string {
  const m = WEEKLY_INDEX_LABEL_RE.exec(label.trim());
  if (!m) throw new Error(`JPX 投資部門別売買状況 (週次一覧): 行ラベルの様式が想定外です: "${label}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const endMonth = Number(m[6]);
  const endDay = Number(m[7]);
  if (endMonth !== month) {
    throw new Error(
      `JPX 投資部門別売買状況 (週次一覧): ラベルの月 (${month}) と期間終了日の月 (${endMonth}) が一致しません: "${label}"`
    );
  }
  const periodEnd = `${year}-${pad2(endMonth)}-${pad2(endDay)}`;
  const d = new Date(`${periodEnd}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== periodEnd) {
    throw new Error(`JPX 投資部門別売買状況 (週次一覧): 期間終了日が暦日として不正です: "${label}"`);
  }
  return `${WEEKLY_SPEC_NAME}-${isoWeekLabelOf(d)}`;
}

function periodFromKey(key: string, periodType: InvestorEquityPeriodType): string {
  const re =
    periodType === "weekly"
      ? new RegExp(`^${WEEKLY_SPEC_NAME}-(\\d{4}-W\\d{2})$`)
      : new RegExp(`^${MONTHLY_SPEC_NAME}-(\\d{4}-\\d{2})$`);
  const m = re.exec(key);
  if (!m) throw new Error(`JPX 投資部門別売買状況: 冪等キーの様式が想定外です (${periodType}): "${key}"`);
  return m[1];
}

// ---------------------------------------------------------------------------
// 解析 (純関数)
// ---------------------------------------------------------------------------

// レコードの periodLabel: "2026年9月第2週" / "2026年8月"
const RECORD_LABEL_RE = /^(\d{4})年(\d{1,2})月(?:第\d週)?$/;

interface ParsedBatch {
  period: string;
  periodStart: string;
  periodEnd: string;
  records: InvestorEquityRecord[];
}

/**
 * 金額ファイル・株数ファイル (旧様式) または単一ファイル (新様式・週次のみ) を解析し、
 * 1 バッチ (同じ期間・同じ様式) であることを確かめる。
 * 期間ラベル (週次 YYYY-Www / 月次 YYYY-MM) はファイルの中身から決める。
 */
function parseBatch(files: readonly SpecFile[], periodType: InvestorEquityPeriodType): ParsedBatch {
  const unifiedFile = files.find((f) => f.filename.startsWith(UNIFIED_FILE_PREFIX));
  if (unifiedFile !== undefined) {
    return parseUnifiedBatch(files, unifiedFile, periodType);
  }
  const valueFile = requireSpecFile(files, (n) => n.startsWith(VALUE_FILE_PREFIX), "JPX 投資部門別 金額ファイル");
  const volumeFile = requireSpecFile(files, (n) => n.startsWith(VOLUME_FILE_PREFIX), "JPX 投資部門別 株数ファイル");
  const valueRecords = parseInvestorEquityWorkbook(valueFile.bytes, valueFile.filename.slice(VALUE_FILE_PREFIX.length));
  const volumeRecords = parseInvestorEquityWorkbook(
    volumeFile.bytes,
    volumeFile.filename.slice(VOLUME_FILE_PREFIX.length)
  );
  const unified = [...valueRecords, ...volumeRecords].find((r) => r.formatVersion !== "legacy_split_files");
  if (unified) {
    throw new Error(
      `JPX 投資部門別売買状況: ${VALUE_FILE_PREFIX}・${VOLUME_FILE_PREFIX} のファイルに` +
        `新様式 (${unified.formatVersion}) のレコードが混ざっています (ファイル名と中身の様式が不一致)`
    );
  }
  if (valueRecords.length === 0 || valueRecords.some((r) => r.metric !== "value")) {
    throw new Error(`JPX 投資部門別売買状況: ${valueFile.filename} が金額 (value) のファイルではありません`);
  }
  if (volumeRecords.length === 0 || volumeRecords.some((r) => r.metric !== "volume")) {
    throw new Error(`JPX 投資部門別売買状況: ${volumeFile.filename} が株数 (volume) のファイルではありません`);
  }
  const records = [...valueRecords, ...volumeRecords];
  const first = records[0] as InvestorEquityRecord;
  const signature = (r: InvestorEquityRecord): string =>
    `${r.formatVersion}|${r.periodType}|${r.periodLabel}|${r.periodStart}|${r.periodEnd}`;
  const mismatched = records.find((r) => signature(r) !== signature(first));
  if (mismatched) {
    throw new Error(
      `JPX 投資部門別売買状況: 金額/株数ファイルの期間・様式が食い違っています (${signature(first)} と ${signature(mismatched)})`
    );
  }
  if (first.periodType !== periodType) {
    throw new Error(`JPX 投資部門別売買状況: ${periodType} のはずが ${first.periodType} のファイルでした`);
  }
  if (first.periodStart === null || first.periodEnd === null) {
    throw new Error(`JPX 投資部門別売買状況: ${first.periodLabel} の集計期間 (開始/終了) が不明です`);
  }
  let period: string;
  if (periodType === "weekly") {
    period = isoWeekLabelOf(new Date(`${first.periodEnd}T00:00:00Z`));
  } else {
    const m = RECORD_LABEL_RE.exec(first.periodLabel);
    if (!m) throw new Error(`JPX 投資部門別売買状況: 月次の期間表題が想定外です: "${first.periodLabel}"`);
    period = `${m[1]}-${pad2(Number(m[2]))}`;
  }
  return { period, periodStart: first.periodStart, periodEnd: first.periodEnd, records };
}

/**
 * 新様式の単一ファイルを解析し、1 バッチ (同じ期間・週次) であることを確かめる。
 * 月次の新様式 (2026-10-08 掲載分〜) は未公表のため受け付けず throw する。
 */
function parseUnifiedBatch(
  files: readonly SpecFile[],
  unifiedFile: SpecFile,
  periodType: InvestorEquityPeriodType
): ParsedBatch {
  if (files.length !== 1) {
    throw new Error(
      `JPX 投資部門別売買状況: 新様式の単一ファイル (${unifiedFile.filename}) と他のファイルが混ざっています`
    );
  }
  if (periodType !== "weekly") {
    throw new Error(
      "JPX 投資部門別売買状況: 月次の新様式ファイルです。月次の新様式 (2026-10-08 掲載分〜) は" +
        "未公表のため実ファイルで検証するまで取り込みません"
    );
  }
  const records = parseInvestorEquityWorkbook(
    unifiedFile.bytes,
    unifiedFile.filename.slice(UNIFIED_FILE_PREFIX.length)
  );
  const legacy = records.find((r) => r.formatVersion !== "unified_single_file");
  if (records.length === 0 || legacy !== undefined) {
    throw new Error(
      `JPX 投資部門別売買状況: ${unifiedFile.filename} が新様式の単一ファイルではありません`
    );
  }
  const first = records[0] as InvestorEquityRecord;
  const signature = (r: InvestorEquityRecord): string =>
    `${r.formatVersion}|${r.periodType}|${r.periodLabel}|${r.periodStart}|${r.periodEnd}`;
  const mismatched = records.find((r) => signature(r) !== signature(first));
  if (mismatched) {
    throw new Error(
      `JPX 投資部門別売買状況: 単一ファイル内で期間・様式が食い違っています (${signature(first)} と ${signature(mismatched)})`
    );
  }
  if (first.periodType !== periodType) {
    throw new Error(`JPX 投資部門別売買状況: ${periodType} のはずが ${first.periodType} のファイルでした`);
  }
  if (first.periodStart === null || first.periodEnd === null) {
    throw new Error(`JPX 投資部門別売買状況: ${first.periodLabel} の集計期間 (開始/終了) が不明です`);
  }
  const period = isoWeekLabelOf(new Date(`${first.periodEnd}T00:00:00Z`));
  return { period, periodStart: first.periodStart, periodEnd: first.periodEnd, records };
}

function toDrafts(key: string, files: readonly SpecFile[], periodType: InvestorEquityPeriodType): ObservationDraft[] {
  const keyPeriod = periodFromKey(key, periodType);
  const batch = parseBatch(files, periodType);
  if (batch.period !== keyPeriod) {
    throw new Error(
      `JPX 投資部門別売買状況: 冪等キー ${key} とファイルの期間 (${batch.period}: ${batch.periodStart}〜${batch.periodEnd}) が一致しません`
    );
  }
  const drafts: ObservationDraft[] = [];
  for (const rec of batch.records) {
    let unit: ObservationDraft["unit"];
    if (rec.unit === "thousand_yen") unit = "円";
    else if (rec.unit === "thousand_shares") unit = "株";
    else throw new Error(`JPX 投資部門別売買状況: 未知の単位です: "${String(rec.unit)}"`);
    const suffix = rec.metric === "value" ? "value" : "volume";
    const common = {
      period: batch.period,
      periodStart: batch.periodStart,
      periodEnd: batch.periodEnd,
      category: categoryOf(rec),
      categoryKind: "投資部門" as const,
      unit,
      changeFromPrev: null,
      approximate: false,
      measureKind: "実測" as const,
    };
    // 千円 → 円、千株 → 株 (いずれも ×1,000。値は整数なので誤差なし)
    drafts.push({ ...common, indicatorKey: indicatorKey(`net_flow_${suffix}`, periodType), value: rec.net * 1000 });
    drafts.push({
      ...common,
      indicatorKey: indicatorKey(`gross_turnover_${suffix}`, periodType),
      value: rec.total * 1000,
    });
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// 取得
// ---------------------------------------------------------------------------

async function fetchBatch(
  args: {
    key: string;
    periodType: InvestorEquityPeriodType;
    indexUrl: string;
    indexLabel: string;
  } & ({ kind: "legacy"; valueUrl: string; volumeUrl: string } | { kind: "unified"; unifiedUrl: string })
): Promise<FetchedBatch> {
  let fetched: FetchedInvestorEquity;
  if (args.kind === "unified") {
    const unifiedBytes = new Uint8Array(await (await fetchOk(args.unifiedUrl)).arrayBuffer());
    const records = parseInvestorEquityWorkbook(unifiedBytes, urlBasename(args.unifiedUrl));
    fetched = {
      kind: "unified",
      periodType: args.periodType,
      unifiedUrl: args.unifiedUrl,
      unifiedBytes,
      records,
    };
  } else {
    // JPX 規約の「高頻度・高負荷の自動取得の自粛」に合わせ、2 本を順に取る。
    const valueBytes = new Uint8Array(await (await fetchOk(args.valueUrl)).arrayBuffer());
    const volumeBytes = new Uint8Array(await (await fetchOk(args.volumeUrl)).arrayBuffer());
    const valueRecords = parseInvestorEquityWorkbook(valueBytes, urlBasename(args.valueUrl));
    const volumeRecords = parseInvestorEquityWorkbook(volumeBytes, urlBasename(args.volumeUrl));
    fetched = {
      kind: "legacy",
      periodType: args.periodType,
      valueUrl: args.valueUrl,
      volumeUrl: args.volumeUrl,
      valueBytes,
      volumeBytes,
      records: [...valueRecords, ...volumeRecords],
    };
  }
  const archive = jpxInvestorEquityArchiveInput(fetched);
  const files = archive.files.map((f) => ({ ...f }));
  // resolve で決めたキーとファイルの中身が一致することを、保管前に確かめる
  // (一覧ページとリンク先の食い違い・様式変更を一次データとして誤ったキーで保管しない)。
  toDrafts(args.key, files, args.periodType);
  return {
    key: args.key,
    source: archive.source,
    metadata: {
      ...archive.metadata,
      indexUrl: args.indexUrl,
      indexLabel: args.indexLabel,
    },
    files,
  };
}

export const JPX_INVESTOR_EQUITY_WEEKLY_SPEC: MoneyflowSourceSpec = {
  name: WEEKLY_SPEC_NAME,
  indicators: JPX_INVESTOR_EQUITY_WEEKLY_INDICATORS,
  async resolve() {
    const html = await (await fetchOk(WEEKLY_INDEX_URL)).text();
    const latest = latestWeeklyEntry(parseWeeklyIndexHtml(html));
    const key = weeklyKeyFromIndexLabel(latest.label);
    const base = {
      key,
      periodType: "weekly" as const,
      indexUrl: WEEKLY_INDEX_URL,
      indexLabel: latest.label,
    };
    return {
      key,
      fetch: () =>
        latest.kind === "unified"
          ? fetchBatch({ ...base, kind: "unified", unifiedUrl: latest.unifiedXlsxUrl })
          : fetchBatch({ ...base, kind: "legacy", valueUrl: latest.valueXlsUrl, volumeUrl: latest.volumeXlsUrl }),
    };
  },
  toObservations({ key, files }) {
    return toDrafts(key, files, "weekly");
  },
};

export const JPX_INVESTOR_EQUITY_MONTHLY_SPEC: MoneyflowSourceSpec = {
  name: MONTHLY_SPEC_NAME,
  indicators: JPX_INVESTOR_EQUITY_MONTHLY_INDICATORS,
  async resolve() {
    const html = await (await fetchOk(MONTHLY_INDEX_URL)).text();
    const latest = pickLatestPublishedMonth(parseMonthlyIndexHtml(html));
    const { valueXlsUrl, volumeXlsUrl } = latest;
    if (valueXlsUrl === null || volumeXlsUrl === null) {
      // pickLatestPublishedMonth が保証する。型を絞るための検査
      throw new Error(`JPX 投資部門別売買状況 (月次): ${latest.year}年${latest.month}月のファイル URL が揃っていません`);
    }
    const key = `${MONTHLY_SPEC_NAME}-${latest.year}-${pad2(latest.month)}`;
    return {
      key,
      fetch: () =>
        fetchBatch({
          key,
          periodType: "monthly",
          indexUrl: MONTHLY_INDEX_URL,
          indexLabel: `${latest.year}年${latest.month}月`,
          kind: "legacy",
          valueUrl: valueXlsUrl,
          volumeUrl: volumeXlsUrl,
        }),
    };
  },
  toObservations({ key, files }) {
    return toDrafts(key, files, "monthly");
  },
};

export const JPX_INVESTOR_EQUITY_SPECS: readonly MoneyflowSourceSpec[] = [
  JPX_INVESTOR_EQUITY_WEEKLY_SPEC,
  JPX_INVESTOR_EQUITY_MONTHLY_SPEC,
];
