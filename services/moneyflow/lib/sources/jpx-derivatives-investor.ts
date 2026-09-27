/**
 * 取得元: JPX(大阪取引所) 先物・オプション
 *
 *   (1) 投資部門別取引状況（週間）
 *       https://www.jpx.co.jp/markets/statistics-derivatives/sector/index.html
 *       投資部門（自己・個人・海外投資家・証券会社・各種金融機関等）ごとの
 *       先物・オプション売買高/代金と、その差引（買い越し/売り越し）を商品別に集計した
 *       週次 CSV（`Tousi_DV_W_<from>_<to>.csv`）。
 *
 *   (2) 指数先物 取引参加者別建玉残高（週次）
 *       https://www.jpx.co.jp/markets/derivatives/open-interest/index.html
 *       日経225先物・日経225mini・TOPIX先物について、限月ごとに証券会社等の
 *       「取引参加者」単位で建玉（未決済ポジション）の売り越し/買い越し上位を
 *       ランキング形式で開示する週次 xlsx。年別 JSON 索引
 *       (`/automation/markets/derivatives/open-interest/json/open_interest_<year>.json`)
 *       がファイル URL を直接返すため、HTML パースが不要。
 *
 * ## スコープ (このモジュールが対象とするもの)
 * (1) はサイクル区分=週次・帳票種別（商品）を問わず全銘柄をカバーする
 *     （株価指数先物だけでなく、国債先物・金利先物・為替先物・商品先物・
 *     電力先物・各種オプションを含む。実測 2026-09-07〜09-11 週で 80 種類の
 *     商品コードが出現し、下記 {@link JPX_DERIV_PRODUCT_NAMES} は実測分を
 *     すべてカバーする。未知コードの行に遭遇したら黙って捨てず throw する）。
 * (2) は「指数先物」ファイル (`*_indexfut_oi_by_tp.xlsx`) のみを対象とする。
 *     同じ週次索引には「日経平均オプション」(`*_nk225op_oi_by_tp.xlsx`) と
 *     「有価証券オプション」(`*_secop_oi_by_tp.xlsx`) も含まれるが、これらは
 *     限月×プット/コール×銘柄別の全く異なる表構造（有価証券オプションは
 *     個別上場銘柄オプションを銘柄単位で列挙）で、指数先物版と共通のパーサでは
 *     扱えない。担当範囲の見積り（週次個別取得元 1 本分）を超える別パーサが
 *     必要になるため、今回は意図的に指数先物のみを実装する（オプション建玉は
 *     別チケットで指標を追加する余地として残す。**silent に握り潰しているのではなく、
 *     このファイルが対象外だと明示している**）。
 *
 * ## 利用条件 (personal-only)
 * JPX 利用規約により、商用目的のデータ収集・二次利用・再配信は JPX の許諾なしには
 * 禁止されている（有料の J-Quants Pro 等の契約が別途必要）。また「当サイトへの
 * 高頻度・高負荷に繋がる可能性のある自動取得等はご遠慮いただいております」と
 * 明記されているため、本モジュールは 1 回の実行で「一覧ページ 1 回 + 対象ファイル
 * 1 回」または「年一覧 JSON 1 回 + 週一覧 JSON 1 回 + 対象ファイル 1 回」のみ叩く
 * （バックフィルで複数週を遡る用途には使わない設計）。
 * kabulab-cf では計画 (`docs/moneyflow.md` 予定) の方針どおり、既存の
 * `license_tag=personal-only` と同じ扱いで **個人利用・非公開の Notion
 * ダッシュボードのみ** に使う。公開 API・公開 Web には出さない。
 *
 * ## 公表タイミング (実機確認 2026-09-27)
 * - (1) 投資部門別取引状況: 一覧ページに直近 5 週分の CSV/PDF リンクが載る。
 *   実測時点 (2026-09-27) で最新は対象週 2026-09-07〜09-11 のファイルで、
 *   一覧ページの構成から「対象週の翌週の第4営業日(通常木曜)15:30 目処」に
 *   公表される運用と分かる。
 * - (2) 指数先物建玉残高: 年別 JSON の `UpdateDate` フィールドに公表日時が
 *   入っている（実測: `"UpdateDate": "2026/09/24 15:31"`、最新 `TradeDate`
 *   は `20260918`）。トレード日（金曜想定）から翌週木曜 15:31 頃の公表で、
 *   (1) とほぼ同じ公表サイクル。
 * - どちらも「まだ公表されていない」の判定はサーバ側の一覧/索引を実際に見て
 *   最新公表期間を確認する以外に手段が無い（固定のスケジュール式で先読みしない。
 *   休場・システム障害等で遅れることがあるため）。{@link isPeriodNotYetPublished}
 *   はその比較だけを行う純関数。
 */

import * as XLSX from "xlsx";

// ブラウザ相当 UA。src/shared/jpx/sectors.ts・services/vwap-analysis/lib/margin.ts が
// 使っているものと同じ文字列 (JPX の WAF は UA ヘッダの有無で 403/200 が変わることを
// 実機確認済み)。この取得元固有の値ではないため、新規に別の UA 文字列を作らない。
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const JPX_BASE = "https://www.jpx.co.jp";
const SECTOR_INDEX_URL = `${JPX_BASE}/markets/statistics-derivatives/sector/index.html`;
const OI_YEARLIST_URL = `${JPX_BASE}/automation/markets/derivatives/open-interest/json/open_interest_yearlist.json`;

async function fetchWithUa(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`JPX 取得失敗: HTTP ${res.status} ${res.statusText} (${url})`);
  }
  return res;
}

async function fetchText(url: string): Promise<string> {
  return (await fetchWithUa(url)).text();
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetchWithUa(url)).arrayBuffer());
}

async function fetchJson<T>(url: string): Promise<T> {
  return (await (await fetchWithUa(url)).json()) as T;
}

// ---------------------------------------------------------------------------
// 日付ユーティリティ (フォールバック無し: 解釈できない入力は throw する)
// ---------------------------------------------------------------------------

/** "YYYYMMDD" → "YYYY-MM-DD"。実在しない日付・非8桁は throw する。 */
function isoFromCompactDate(compact: string): string {
  if (!/^\d{8}$/.test(compact)) {
    throw new Error(`JPX: 日付が YYYYMMDD 形式ではありません: ${JSON.stringify(compact)}`);
  }
  const y = Number(compact.slice(0, 4));
  const m = Number(compact.slice(4, 6));
  const d = Number(compact.slice(6, 8));
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new Error(`JPX: 実在しない日付です: ${compact}`);
  }
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

/** "2026年09月18日" のような和暦日付表記を ISO へ変換する。 */
function isoFromJapaneseDate(label: string): string {
  const m = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(label.trim());
  if (!m) {
    throw new Error(`JPX: 日付表記を解釈できません: ${JSON.stringify(label)}`);
  }
  return isoFromCompactDate(`${m[1]}${m[2]!.padStart(2, "0")}${m[3]!.padStart(2, "0")}`);
}

// ---------------------------------------------------------------------------
// (1) 投資部門別取引状況 (先物・オプション、週間)
// ---------------------------------------------------------------------------

export interface InvestorTypeCsvLink {
  url: string;
  /** 対象週の開始日 (ISO) */
  periodFrom: string;
  /** 対象週の終了日 (ISO)。冪等キー・公表判定に使う */
  periodTo: string;
}

// アンカータグ全体 (href + 中身のテキスト) を捕捉する。一覧ページの「フォーマット
// 変更等のお知らせ」欄には、実データの週次テーブルとは別に、様式変更の告知に添付された
// 「サンプルファイル（ＣＳＶ版）」という恒久的なリンクが同じ `Tousi_DV_W_<from>_<to>.csv`
// 命名で残り続ける（2026-09-27 実機確認: 2026年4月13日の様式変更告知に添付された
// `Tousi_DV_W_20260413_20260417.csv` が本稿執筆時点でも一覧ページに残存している）。
// 実データの週次リンクはアイコン画像 (`<img ...>`) のみでリンクテキストを持たないのに対し、
// このサンプルリンクは「…サンプルファイル（ＣＳＶ版）」という可視テキストを持つため、
// アンカー内テキストで判別できる。
const CSV_LINK_RE =
  /<a\s+href="(\/markets\/statistics-derivatives\/sector\/[^"]*?Tousi_DV_W_(\d{8})_(\d{8})\.csv)"[^>]*>([\s\S]*?)<\/a>/g;

/**
 * 一覧ページ HTML から投資部門別取引状況(週間)CSV のリンクを抽出する純関数。
 * 対象週の終了日 (periodTo) 降順で返す。様式変更告知に添付された「サンプルファイル」
 * リンク（実データではない）はリンクテキストで判別して除外する。1 件も見つからなければ
 * 様式変更を疑って throw する（黙って空配列を返さない）。
 */
export function extractInvestorTypeCsvLinks(html: string): InvestorTypeCsvLink[] {
  const byPeriodTo = new Map<string, InvestorTypeCsvLink>();
  for (const m of html.matchAll(CSV_LINK_RE)) {
    const linkText = m[4]!;
    if (linkText.includes("サンプル")) continue; // 様式変更告知の恒久的なサンプルリンクを除外
    const periodTo = isoFromCompactDate(m[3]!);
    byPeriodTo.set(periodTo, {
      url: JPX_BASE + m[1]!,
      periodFrom: isoFromCompactDate(m[2]!),
      periodTo,
    });
  }
  if (byPeriodTo.size === 0) {
    throw new Error(
      "JPX 投資部門別取引状況: 一覧ページから Tousi_DV_W_*.csv リンクを抽出できません (様式変更の可能性)"
    );
  }
  return [...byPeriodTo.values()].sort((a, b) => (a.periodTo < b.periodTo ? 1 : -1));
}

export async function fetchInvestorTypeIndexHtml(): Promise<string> {
  return fetchText(SECTOR_INDEX_URL);
}

/**
 * 帳票種別コード → 商品名。
 *
 * 出典: 一覧ページ (`sector/03.html`「ご利用の手引き」) が指す
 * `guide_20260413.xls`（2026-09-27 実機取得・目視確認）の「帳票種別 詳細」表。
 * 実測 CSV (2026-09-07〜09-11 週) には 80 種類の帳票種別コードが出現し、
 * 下記マップはその 80 種類を全てカバーする（未知コードは黙って通さず throw する
 * ことで、様式変更・商品追加を検知する）。
 *
 * 末尾のコメント付き 5 件 (302/305/306/310/311) は guide 上「〔◯年◯月◯週
 * 以前のファイル用〕」と明記された廃止済み商品で、現行の週次データには出現しない
 * (実測で確認済み)。将来古い期間をバックフィルする用途のために残す。
 */
export const JPX_DERIV_PRODUCT_NAMES: Readonly<Record<string, string>> = {
  "301": "日経225先物",
  "313": "日経225mini",
  "331": "日経225マイクロ先物",
  "314": "TOPIX先物",
  "316": "ミニTOPIX先物",
  "335": "JPXプライム150指数先物",
  "323": "JPX日経400先物",
  "449": "東証銀行業株価指数先物",
  "329": "東証REIT指数先物",
  "312": "RNP先物",
  "324": "東証グロース市場250指数先物",
  "309": "NYダウ先物",
  "325": "台湾加権指数先物",
  "326": "FTSE中国50先物",
  "315": "日経平均VI先物",
  "436": "米ドル/日本円先物",
  "437": "中国オフショア人民元/日本円先物",
  "438": "ユーロ/日本円先物",
  "317": "長期国債先物",
  "330": "長期国債先物（現金決済型ミニ）",
  "318": "超長期国債先物（ミニ）",
  "334": "TONA3か月金利先物",
  "400": "金標準先物",
  "443": "ポケットゴールド100先物",
  "401": "金ミニ先物",
  "402": "金限日先物",
  "403": "銀先物",
  "404": "白金標準先物",
  "444": "ポケットプラチナ100先物",
  "405": "白金ミニ先物",
  "406": "白金限日先物",
  "407": "パラジウム先物",
  "415": "CME原油等指数先物",
  "408": "ゴム（RSS3）先物",
  "409": "ゴム（TSR20）先物",
  "431": "上海天然ゴム先物",
  "410": "とうもろこし先物",
  "411": "一般大豆先物",
  "412": "小豆先物",
  "416": "バージガソリン先物",
  "417": "バージ灯油先物",
  "418": "バージ軽油先物",
  "419": "プラッツドバイ原油先物",
  "423": "東エリア・ベースロード電力先物",
  "422": "西エリア・ベースロード電力先物",
  "445": "中部エリア・ベースロード電力先物",
  "425": "東エリア・日中ロード電力先物",
  "424": "西エリア・日中ロード電力先物",
  "446": "中部エリア・日中ロード電力先物",
  "428": "東エリア・週間ベースロード電力先物",
  "427": "西エリア・週間ベースロード電力先物",
  "430": "東エリア・週間日中ロード電力先物",
  "429": "西エリア・週間日中ロード電力先物",
  "433": "東エリア・年度ベースロード電力先物",
  "432": "西エリア・年度ベースロード電力先物",
  "447": "中部エリア・年度ベースロード電力先物",
  "435": "東エリア・年度日中ロード電力先物",
  "434": "西エリア・年度日中ロード電力先物",
  "448": "中部エリア・年度日中ロード電力先物",
  "426": "LNG（プラッツJKM）先物",
  "420": "中京ローリーガソリン先物",
  "421": "中京ローリー灯油先物",
  "303": "日経225オプションプット",
  "304": "日経225オプションコール",
  "332": "日経225ミニオプションプット",
  "333": "日経225ミニオプションコール",
  "319": "TOPIXオプションプット",
  "320": "TOPIXオプションコール",
  "327": "JPX日経400オプションプット",
  "328": "JPX日経400オプションコール",
  "439": "東証銀行業株価指数オプションプット",
  "440": "東証銀行業株価指数オプションコール",
  "441": "東証REIT指数オプションプット",
  "442": "東証REIT指数オプションコール",
  "321": "国債先物オプションプット",
  "322": "国債先物オプションコール",
  "307": "有価証券オプションプット",
  "308": "有価証券オプションコール",
  "413": "金先物オプションプット",
  "414": "金先物オプションコール",
  // 廃止済み (現行週次データには出現しない。バックフィル用に保持)
  "302": "日経300先物（廃止・2011年2月1週以前用）",
  "305": "日経300オプションプット（廃止・2011年2月1週以前用）",
  "306": "日経300オプションコール（廃止・2011年2月1週以前用）",
  "310": "インドNifty50先物（廃止・2018年6月4週以前用）",
  "311": "MSCI Japan先物（廃止・2014年11月3週以前用）",
};

/**
 * 投資部門コード → 投資部門名。
 * 出典は {@link JPX_DERIV_PRODUCT_NAMES} と同じ guide xls の
 * 「投資部門コード 詳細」表 (2026-09-27 実機取得・目視確認)。
 * 実測 CSV に出現する 11 種類をすべてカバーする。
 */
export const JPX_DERIV_INVESTOR_NAMES: Readonly<Record<string, string>> = {
  "11": "自己",
  "21": "生保・損保",
  "22": "都銀・地銀等",
  "23": "信託銀行",
  "24": "その他金融機関",
  "31": "投資信託",
  "32": "事業法人",
  "33": "その他法人等",
  "41": "証券会社",
  "51": "個人",
  "60": "海外投資家",
};

export interface InvestorTypeRow {
  periodFrom: string;
  periodTo: string;
  productCode: string;
  productName: string;
  investorCode: string;
  investorName: string;
  /** 数量金額区分 (CSV「数量金額区分」1=数量, 2=代金) */
  metric: "volume" | "value";
  sales: number;
  purchases: number;
  /** 売+買の合計 (CSV「合計」列と照合済み) */
  total: number;
  /**
   * 買い越し(正)/売り越し(負)。CSV の「売-差引」「買-差引」は常にどちらか
   * 一方のみ非ゼロで、非ゼロ側の値がそのまま (買-売) の差引に一致する
   * (実測 1,760 行全件で検証済み)。この関数はその 2 列を単純加算するだけの
   * 正規化 (フォールバックではない)。
   */
  netBalance: number;
}

const CSV_COLUMN_COUNT = 12;

/** RFC4180 相当の 1 行 CSV パーサ (ダブルクオート・カンマ含む列に対応)。 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseIntStrict(raw: string, context: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${context}: 整数として解釈できない値です: ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * 投資部門別取引状況(週間)CSV を解析する純関数。
 *
 * @throws ヘッダ列数・データ列数が想定 (12列) と異なる、未知の帳票種別/投資部門
 *   コードが出現する、合計や差引の不変条件が崩れている、日付が解釈できない
 *   等、様式が想定と異なる場合。欠損・不整合を黙って埋めない (CLAUDE.md ルール2)。
 */
export function parseInvestorTypeCsv(csvText: string): InvestorTypeRow[] {
  const text = csvText.charCodeAt(0) === 0xfeff ? csvText.slice(1) : csvText;
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.length > 0);
  if (lines.length < 2) {
    throw new Error("JPX 投資部門別取引状況 CSV: データ行がありません");
  }
  const header = parseCsvLine(lines[0]!);
  if (header.length !== CSV_COLUMN_COUNT) {
    throw new Error(
      `JPX 投資部門別取引状況 CSV: ヘッダ列数が想定と異なります (期待 ${CSV_COLUMN_COUNT}, 実際 ${header.length}) — 様式変更の可能性`
    );
  }

  const rows: InvestorTypeRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]!);
    if (cols.length !== CSV_COLUMN_COUNT) {
      throw new Error(
        `JPX 投資部門別取引状況 CSV: ${i + 1}行目の列数が想定と異なります (${cols.length}) — 様式変更の可能性`
      );
    }
    const [
      productCode,
      cycle,
      ,
      periodFromRaw,
      periodToRaw,
      investorCode,
      metricCode,
      salesRaw,
      salesBalanceRaw,
      purchasesRaw,
      purchasesBalanceRaw,
      totalRaw,
    ] = cols as [
      string, string, string, string, string, string, string, string, string, string, string, string,
    ];
    const context = `JPX 投資部門別取引状況 CSV (${i + 1}行目)`;

    if (cycle !== "1") {
      throw new Error(`${context}: 週次ファイルなのにサイクル区分が "1" ではありません (${cycle})`);
    }
    const productName = JPX_DERIV_PRODUCT_NAMES[productCode];
    if (!productName) {
      throw new Error(`${context}: 未知の帳票種別コードです: ${productCode} — 様式変更/新商品の可能性`);
    }
    const investorName = JPX_DERIV_INVESTOR_NAMES[investorCode];
    if (!investorName) {
      throw new Error(`${context}: 未知の投資部門コードです: ${investorCode} — 様式変更の可能性`);
    }
    if (metricCode !== "1" && metricCode !== "2") {
      throw new Error(`${context}: 未知の数量金額区分です: ${metricCode}`);
    }

    const sales = parseIntStrict(salesRaw, context);
    const salesBalance = parseIntStrict(salesBalanceRaw, context);
    const purchases = parseIntStrict(purchasesRaw, context);
    const purchasesBalance = parseIntStrict(purchasesBalanceRaw, context);
    const total = parseIntStrict(totalRaw, context);

    if (total !== sales + purchases) {
      throw new Error(
        `${context}: 合計が売+買と一致しません (product=${productCode} investor=${investorCode}): ${total} != ${sales}+${purchases}`
      );
    }
    if (salesBalance !== 0 && purchasesBalance !== 0) {
      throw new Error(
        `${context}: 売差引・買差引が両方非ゼロです (product=${productCode} investor=${investorCode}) — 差引の符号規則の前提が崩れています`
      );
    }

    rows.push({
      periodFrom: isoFromCompactDate(periodFromRaw),
      periodTo: isoFromCompactDate(periodToRaw),
      productCode,
      productName,
      investorCode,
      investorName,
      metric: metricCode === "1" ? "volume" : "value",
      sales,
      purchases,
      total,
      netBalance: purchasesBalance + salesBalance,
    });
  }
  if (rows.length === 0) {
    throw new Error("JPX 投資部門別取引状況 CSV: 有効なデータ行を1件も抽出できませんでした");
  }
  return rows;
}

export interface InvestorTypeCsvData {
  link: InvestorTypeCsvLink;
  rows: InvestorTypeRow[];
  csvBytes: Uint8Array;
}

/** 一覧ページを取得し、最新週の CSV を取得・解析する。1 回の実行で HTML 1 回 + CSV 1 回のみ叩く。 */
export async function fetchLatestInvestorTypeCsvData(): Promise<InvestorTypeCsvData> {
  const html = await fetchInvestorTypeIndexHtml();
  const links = extractInvestorTypeCsvLinks(html);
  const link = links[0];
  if (!link) {
    throw new Error("JPX 投資部門別取引状況: 抽出したリンクが空です");
  }
  const csvBytes = await fetchBytes(link.url);
  const csvText = new TextDecoder("utf-8").decode(csvBytes);
  const rows = parseInvestorTypeCsv(csvText);
  return { link, rows, csvBytes };
}

// ---------------------------------------------------------------------------
// (2) 指数先物 取引参加者別建玉残高 (週次)
// ---------------------------------------------------------------------------

interface OiYearListResponse {
  UpdateDate: string;
  TableDatas: Array<{ Year: string; Jsonfile: string }>;
}

interface OiYearResponse {
  UpdateDate: string;
  TableDatas: Array<{
    TradeDate: string;
    IndexFutures: string;
    IndexOptions: string;
    SecuritiesOptions: string;
  }>;
}

/** 年一覧 JSON → 最新年の週一覧 JSON → 最新週の IndexFutures xlsx を取得する。 */
export async function fetchLatestIndexFuturesOiFile(): Promise<{
  tradeDate: string;
  url: string;
  bytes: Uint8Array;
}> {
  const yearList = await fetchJson<OiYearListResponse>(OI_YEARLIST_URL);
  if (!yearList.TableDatas || yearList.TableDatas.length === 0) {
    throw new Error("JPX 建玉残高: 年一覧 JSON が空です (様式変更の可能性)");
  }
  let latestYearEntry = yearList.TableDatas[0]!;
  for (const y of yearList.TableDatas) {
    if (Number(y.Year) > Number(latestYearEntry.Year)) latestYearEntry = y;
  }

  const yearData = await fetchJson<OiYearResponse>(JPX_BASE + latestYearEntry.Jsonfile);
  if (!yearData.TableDatas || yearData.TableDatas.length === 0) {
    throw new Error(`JPX 建玉残高: ${latestYearEntry.Year}年の週次一覧が空です`);
  }
  let latest = yearData.TableDatas[0]!;
  for (const w of yearData.TableDatas) {
    if (w.TradeDate > latest.TradeDate) latest = w;
  }
  if (!latest.IndexFutures) {
    throw new Error(`JPX 建玉残高: tradeDate=${latest.TradeDate} に指数先物ファイルのパスがありません`);
  }

  const url = JPX_BASE + latest.IndexFutures;
  const bytes = await fetchBytes(url);
  return { tradeDate: isoFromCompactDate(latest.TradeDate), url, bytes };
}

export interface FuturesOiRow {
  /** guide が定義する商品名そのまま (＜…＞見出しの中身)。"日経225先物"|"日経225mini"|"TOPIX先物" のいずれか。 */
  product: string;
  /** 限月 (YYYY-MM) */
  contractMonth: string;
  /** そのサイド内での順位 (1が最大) */
  rank: number;
  side: "net_short" | "net_long";
  participantCode: string;
  participantName: string;
  /** 建玉残高 (枚) */
  openInterest: number;
}

export interface IndexFuturesOiData {
  /** 建玉残高の基準日 (ISO)。ファイル名の tradeDate と一致することを検証済み。 */
  asOfDate: string;
  rows: FuturesOiRow[];
}

function cellStr(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function cellNum(v: unknown, context: string): number {
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  if (!Number.isFinite(n)) {
    throw new Error(`${context}: 数値として解釈できない値です: ${JSON.stringify(v)}`);
  }
  return n;
}

const EXPECTED_OI_TITLE = "指数先物取引参加者別建玉残高";
const CONTRACT_MONTH_RE = /^(\d{4})年(\d{1,2})月限月$/;

function parseContractMonth(label: string): string {
  const m = CONTRACT_MONTH_RE.exec(label);
  if (!m) {
    throw new Error(`JPX 建玉残高: 限月表記を解釈できません: ${JSON.stringify(label)}`);
  }
  return `${m[1]}-${m[2]!.padStart(2, "0")}`;
}

/**
 * 「指数先物取引参加者別建玉残高」xlsx シートを解析する純関数
 * (`XLSX.utils.sheet_to_json(sheet, { header: 1 })` が返す 2 次元配列を受け取る)。
 *
 * レイアウト: 商品ごとに `＜商品名＞` 見出し行があり、以降のランキング行は
 * 「左ブロック(限月A・売超参加者・買超参加者)」8列 + 空白2列 +
 * 「右ブロック(限月B・売超参加者・買超参加者)」8列 の並びになる
 * (2026-09-18 現在ファイルで実測・{@link JPX_FUTURES_OI_FIXTURE_PATH} で検証)。
 *
 * @throws タイトル行・基準日表記が想定と異なる、見出しより前にデータ行が出現する、
 *   参加者コード/名称/建玉数量が一部だけ欠けている等、様式が想定と異なる場合。
 */
export function parseIndexFuturesOiGrid(grid: unknown[][]): IndexFuturesOiData {
  const title = cellStr(grid[0]?.[0]);
  if (title !== EXPECTED_OI_TITLE) {
    throw new Error(
      `JPX 建玉残高: タイトル行が想定と異なります (${JSON.stringify(title)}) — 様式変更の可能性`
    );
  }
  const asOfLabel = cellStr(grid[1]?.[0]);
  const asOfMatch = /^（\s*(\d{4}年\d{1,2}月\d{1,2}日)現在\s*）$/.exec(asOfLabel);
  if (!asOfMatch) {
    throw new Error(`JPX 建玉残高: 基準日表記が想定と異なります: ${JSON.stringify(asOfLabel)}`);
  }
  const asOfDate = isoFromJapaneseDate(asOfMatch[1]!);

  const rows: FuturesOiRow[] = [];
  let currentProduct: string | null = null;

  for (const row of grid) {
    const c0 = cellStr(row[0]);
    if (c0.startsWith("＜") && c0.endsWith("＞")) {
      currentProduct = c0.slice(1, -1);
      continue;
    }
    if (!/^\d+$/.test(c0)) continue; // タイトル・小見出し・空行はスキップ

    if (!currentProduct) {
      throw new Error(
        "JPX 建玉残高: 商品見出し(＜…＞)より前にランキング行が出現しました — 様式変更の可能性"
      );
    }

    for (const offset of [0, 10] as const) {
      const monthLabel = cellStr(row[offset + 1]);
      if (!monthLabel) continue; // 右ブロックの限月が無い(片側だけの)週がある
      const rankRaw = cellStr(row[offset]);
      if (!/^\d+$/.test(rankRaw)) continue; // 左右でランキング行数が揃わない週がある
      const contractMonth = parseContractMonth(monthLabel);
      const rank = Number(rankRaw);

      for (const [side, codeCol] of [
        ["net_short", offset + 2],
        ["net_long", offset + 5],
      ] as const) {
        const code = cellStr(row[codeCol]);
        const name = cellStr(row[codeCol + 1]);
        const oiRaw = row[codeCol + 2];
        const hasOi = oiRaw !== "" && oiRaw !== undefined && oiRaw !== null;
        if (!code && !name && !hasOi) continue; // その順位に参加者がいない (末尾)

        const context = `JPX 建玉残高 (product=${currentProduct} month=${contractMonth} side=${side} rank=${rank})`;
        if (!code || !name || !hasOi) {
          throw new Error(`${context}: 参加者コード/名称/建玉数量の一部だけが欠けています`);
        }
        rows.push({
          product: currentProduct,
          contractMonth,
          rank,
          side,
          participantCode: code,
          participantName: name,
          openInterest: cellNum(oiRaw, context),
        });
      }
    }
  }

  if (rows.length === 0) {
    throw new Error("JPX 建玉残高: 有効な行を1件も抽出できませんでした — 様式変更の可能性");
  }
  return { asOfDate, rows };
}

/** xlsx バイト列 → シート → {@link parseIndexFuturesOiGrid}。 */
export function parseIndexFuturesOiWorkbook(bytes: Uint8Array): IndexFuturesOiData {
  const workbook = XLSX.read(bytes, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error("JPX 建玉残高: xlsx にシートがありません");
  }
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error("JPX 建玉残高: シートを読み込めません");
  }
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
  return parseIndexFuturesOiGrid(grid);
}

/** 最新週の指数先物建玉残高を取得・解析する。ファイル名の tradeDate とシート内基準日の一致も検証する。 */
export async function fetchLatestIndexFuturesOiData(): Promise<{
  tradeDate: string;
  url: string;
  xlsxBytes: Uint8Array;
  data: IndexFuturesOiData;
}> {
  const { tradeDate, url, bytes } = await fetchLatestIndexFuturesOiFile();
  const data = parseIndexFuturesOiWorkbook(bytes);
  if (data.asOfDate !== tradeDate) {
    throw new Error(
      `JPX 建玉残高: ファイル名の tradeDate (${tradeDate}) とシート内の基準日 (${data.asOfDate}) が一致しません`
    );
  }
  return { tradeDate, url, xlsxBytes: bytes, data };
}

// ---------------------------------------------------------------------------
// 期間・公表判定
// ---------------------------------------------------------------------------

/**
 * target (ISO 日付) が latestAvailable (実際に取得できた最新公表期間の ISO 日付)
 * より新しければ「まだ公表されていない」と判定する。
 *
 * 固定のスケジュール式 (「木曜15:30を過ぎたら公表済みとみなす」等) では判定しない。
 * JPX の公表は休場・システム更新等で前後するため、実際に一覧/索引を取得して
 * 得られた最新期間とだけ比較する (このモジュールの他の fetch* 関数が返す
 * `link.periodTo` / `tradeDate` を latestAvailable に渡す)。
 */
export function isPeriodNotYetPublished(args: {
  target: string;
  latestAvailable: string;
}): boolean {
  return args.target > args.latestAvailable;
}

// ---------------------------------------------------------------------------
// 指標定義 (資金フロー｜指標定義 DB 相当)
// ---------------------------------------------------------------------------

export type MoneyflowRequirement = "R1" | "R2" | "R3" | "R4";

export type MoneyflowMeasureType =
  | "net_flow"
  | "gross_turnover"
  | "holdings_stock"
  | "positions"
  | "fund_flow"
  | "estimated"
  | "price_only";

export interface MoneyflowIndicatorDefinition {
  key: string;
  displayName: string;
  requirements: MoneyflowRequirement[];
  measures: MoneyflowMeasureType;
  /** 平易な説明 (中学生でも分かる言葉。数値例を含む) */
  plainDescription: string;
  /** 財務的に正確な定義 (噛み砕きと引き換えに誤らせない) */
  definition: string;
  unit: string;
  sourceUrl: string;
  usageTerms: string;
  frequency: "weekly" | "monthly" | "quarterly" | "yearly";
  limitations: string[];
}

export const INDICATOR_NET_BALANCE_KEY = "jpx_deriv_investor_net_balance";
export const INDICATOR_GROSS_TURNOVER_KEY = "jpx_deriv_investor_gross_turnover";
export const INDICATOR_FUTURES_OI_KEY = "jpx_futures_oi_by_participant";

const USAGE_TERMS_PERSONAL_ONLY =
  "JPX 利用規約により、商用目的のデータ収集・二次利用・再配信は JPX の許諾なしには禁止 " +
  "(personal-only)。kabulab では個人利用・非公開の Notion ダッシュボードのみに使い、" +
  "公開 API・公開 Web ページには出さない。高頻度の自動取得も規約上ご遠慮くださいと明記されて" +
  "いるため、1 回の実行につき最小限の回数のみアクセスする。";

export const INDICATOR_DEFINITIONS: readonly MoneyflowIndicatorDefinition[] = [
  {
    key: INDICATOR_NET_BALANCE_KEY,
    displayName: "先物・オプション 投資部門別 純売買（買い越し・売り越し）",
    requirements: ["R3"],
    measures: "net_flow",
    plainDescription:
      "その週、日経225先物などの先物・オプションを、投資部門（外国人投資家・個人・" +
      "証券会社・各種金融機関など）ごとに『買った量が売った量よりどれだけ多いか・" +
      "少ないか』を示す値。プラスなら買い越し（その部門は売るより買う方が多かった）、" +
      "マイナスなら売り越し。例えば海外投資家がある週+8,343枚なら、その週は差し引き" +
      "8,343枚分、買いが売りより多かったという意味。",
    definition:
      "JPX 投資部門別取引状況(先物・オプション)の「買-差引」「売-差引」列を合算した値。" +
      "JPX 自身のガイド (guide_20260413.xls) は「売-差引」を『売取引高又は売代金の差引き』、" +
      "「買-差引」を『買取引高又は買代金の差引き』とのみ説明しており、実測では常にどちらか" +
      "一方のみが非ゼロで、その値は (買取引高又は買代金) − (売取引高又は売代金) に厳密に" +
      "一致する (合計12列・1,760行全件で検証済み)。先物・オプションはゼロサム取引 (誰かの" +
      "買いは必ず別の誰かの売り) のため、ある投資部門の買い越しは市場全体の資金の純増を" +
      "意味しない — あくまで投資部門間の資金の「向き」の指標。",
    unit: "商品の数量金額区分により「枚」(数量) または「円」(代金) のいずれか。",
    sourceUrl: "https://www.jpx.co.jp/markets/statistics-derivatives/sector/index.html",
    usageTerms: USAGE_TERMS_PERSONAL_ONLY,
    frequency: "weekly",
    limitations: [
      "先物・オプションはゼロサムの相対取引なので、市場全体の合計は常にゼロに近づく" +
        "（本指標は投資部門「間」の資金の向きを見るためのもので、市場への資金の純流入" +
        "そのものではない）。",
      "商品(帳票種別)は80種類が混在し、日経225先物のような株価指数だけでなく、国債" +
        "先物・金利先物・為替先物・商品(コモディティ)先物・電力先物・各種オプションを含む。" +
        "区分（segment）で商品名を必ず確認すること。",
      "投資部門コードのうち「証券会社(41)」は委託取引区分内の顧客分類であり、" +
        "自己取引(11)とは別区分（証券会社自身の自己勘定取引は11に計上される）。",
    ],
  },
  {
    key: INDICATOR_GROSS_TURNOVER_KEY,
    displayName: "先物・オプション 投資部門別 売買代金・出来高（グロス）",
    requirements: ["R3"],
    measures: "gross_turnover",
    plainDescription:
      "その週、ある投資部門（例: 個人）が先物・オプションを売った量と買った量を単純に" +
      "足し合わせた値。『どの投資部門がどれだけ活発に取引したか』の目安であり、" +
      "資金がどちらに向かったかは示さない（買い越し/売り越しは別の指標『純売買』を見る）。",
    definition:
      "JPX 投資部門別取引状況(先物・オプション)の「合計」列（売+買の和、CSV上で" +
      "売+買=合計であることを検証済み）。",
    unit: "商品の数量金額区分により「枚」(数量) または「円」(代金) のいずれか。",
    sourceUrl: "https://www.jpx.co.jp/markets/statistics-derivatives/sector/index.html",
    usageTerms: USAGE_TERMS_PERSONAL_ONLY,
    frequency: "weekly",
    limitations: [
      "グロスの取引量であり、買い越し/売り越しの向きは含まない。",
      "商品(帳票種別)80種類が混在するため、区分（segment）の商品名を必ず確認すること。",
    ],
  },
  {
    key: INDICATOR_FUTURES_OI_KEY,
    displayName: "指数先物 取引参加者別建玉残高（上位ランキング）",
    requirements: ["R3"],
    measures: "positions",
    plainDescription:
      "週末時点で、日経225先物・日経225mini・TOPIX先物の「建玉」(まだ決済していない" +
      "未決済のポジション) を、証券会社などの取引参加者ごとに『売り建玉が多い順』" +
      "『買い建玉が多い順』でランキングしたもの。フロー(その週に動いた資金の量)では" +
      "なく、ある時点の残高(ストック)である点に注意。例えば「野村証券が日経225先物" +
      "2026年12月限月の買い建玉ランキング1位で33,866枚」なら、その証券会社(自己+顧客" +
      "合算)がその時点で最も大きい買いポジションを持っている、という意味。",
    definition:
      "JPX(大阪取引所)「取引参加者別建玉残高一覧」xlsx の、限月ごとの売超/買超" +
      "参加者ランキング上位の建玉数量(枚)。取引参加者(証券会社等)単位の集計であり、" +
      "投資部門別(個人・海外投資家等)の内訳ではない。",
    unit: "枚 (建玉数量)",
    sourceUrl: "https://www.jpx.co.jp/markets/derivatives/open-interest/index.html",
    usageTerms: USAGE_TERMS_PERSONAL_ONLY,
    frequency: "weekly",
    limitations: [
      "ストック(残高)であり、その週に新たに動いた資金の量(フロー)ではない。週次の" +
        "残高の増減を見て初めて「その週の資金の方向性」の近似指標になる。",
      "各限月・各サイド(売超/買超)ともランキング上位（実測で最大15位）までしか" +
        "開示されず、ランキング外の参加者やランキング外を合算した「その他」の数値は" +
        "公表されない。母集団全体を捕捉する指標ではない。",
      "投資部門別(個人/海外投資家等)ではなく取引参加者(証券会社等の会社単位。自己" +
        "勘定と顧客からの委託が合算されている)単位の集計。",
      "対象商品は日経225先物・日経225mini・TOPIX先物の3つのみ。同じ週次索引に含まれる" +
        "日経平均オプション・有価証券オプションの建玉残高は、表構造が大きく異なるため" +
        "このモジュールでは未対応 (意図的にスコープ外。別途対応が必要)。",
    ],
  },
];

// ---------------------------------------------------------------------------
// 観測ログ (資金フロー｜観測ログ DB 相当) 用の縦長レコード
// ---------------------------------------------------------------------------

export interface MoneyflowObservation {
  /** 対象期間の終端 (ISO 日付)。週次データは週末日 (投資部門別は periodTo、建玉残高は asOfDate)。 */
  period: string;
  periodType: "week";
  /** {@link INDICATOR_DEFINITIONS} の key と一致する */
  indicatorKey: string;
  /** 区分 (商品名・投資部門名・限月・順位など、人間可読なラベル。全角｜区切り) */
  segment: string;
  value: number;
  unit: string;
  /** 近似値か (このモジュールの値はすべて JPX 公表値そのままの実測値なので常に false) */
  isApproximate: boolean;
  measurement: "actual" | "estimated";
}

/** 投資部門別取引状況の行を「純売買」「売買代金・出来高(グロス)」の2指標分の観測ログへ変換する。 */
export function investorTypeRowsToObservations(rows: InvestorTypeRow[]): MoneyflowObservation[] {
  const out: MoneyflowObservation[] = [];
  for (const r of rows) {
    const unit = r.metric === "value" ? "円" : "枚";
    const segment = `${r.productName}｜${r.investorName}｜${r.metric === "value" ? "代金" : "数量"}`;
    out.push({
      period: r.periodTo,
      periodType: "week",
      indicatorKey: INDICATOR_NET_BALANCE_KEY,
      segment,
      value: r.netBalance,
      unit,
      isApproximate: false,
      measurement: "actual",
    });
    out.push({
      period: r.periodTo,
      periodType: "week",
      indicatorKey: INDICATOR_GROSS_TURNOVER_KEY,
      segment,
      value: r.total,
      unit,
      isApproximate: false,
      measurement: "actual",
    });
  }
  return out;
}

/** 指数先物建玉残高の行を観測ログへ変換する。 */
export function indexFuturesOiToObservations(data: IndexFuturesOiData): MoneyflowObservation[] {
  return data.rows.map((r) => ({
    period: data.asOfDate,
    periodType: "week",
    indicatorKey: INDICATOR_FUTURES_OI_KEY,
    segment: `${r.product}｜${r.contractMonth}限月｜${r.side === "net_short" ? "売超" : "買超"}${r.rank}位｜${r.participantName}`,
    value: r.openInterest,
    unit: "枚",
    isApproximate: false,
    measurement: "actual",
  }));
}

// ---------------------------------------------------------------------------
// 一次データアーカイブ入力 (ルール6: 実際の recordPrimaryData() 呼び出しは
// 統合担当のスクリプトが行う。このモジュールは呼び出し引数を組み立てる純関数のみ提供する)
// ---------------------------------------------------------------------------

export interface MoneyflowPrimaryFile {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

export interface MoneyflowArchiveInput {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: MoneyflowPrimaryFile[];
}

/** 週次冪等キー ("moneyflow" サービス, `jpx-deriv-investor-<periodTo>`) + CSV 実体で記録入力を組む。 */
export function investorTypeCsvArchiveInput(data: InvestorTypeCsvData): MoneyflowArchiveInput {
  return {
    service: "moneyflow",
    key: `jpx-deriv-investor-${data.link.periodTo}`,
    source: data.link.url,
    metadata: {
      periodFrom: data.link.periodFrom,
      periodTo: data.link.periodTo,
      rowCount: data.rows.length,
      bytes: data.csvBytes.byteLength,
    },
    files: [
      {
        bytes: data.csvBytes,
        filename: `jpx-deriv-investor-${data.link.periodTo}.csv`,
        contentType: "text/csv",
      },
    ],
  };
}

/** 週次冪等キー ("moneyflow" サービス, `jpx-futures-oi-indexfut-<tradeDate>`) + xlsx 実体で記録入力を組む。 */
export function indexFuturesOiArchiveInput(args: {
  tradeDate: string;
  url: string;
  xlsxBytes: Uint8Array;
  rowCount: number;
}): MoneyflowArchiveInput {
  return {
    service: "moneyflow",
    key: `jpx-futures-oi-indexfut-${args.tradeDate}`,
    source: args.url,
    metadata: {
      tradeDate: args.tradeDate,
      rowCount: args.rowCount,
      bytes: args.xlsxBytes.byteLength,
    },
    files: [
      {
        bytes: args.xlsxBytes,
        filename: `jpx-futures-oi-indexfut-${args.tradeDate}.xlsx`,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ],
  };
}
