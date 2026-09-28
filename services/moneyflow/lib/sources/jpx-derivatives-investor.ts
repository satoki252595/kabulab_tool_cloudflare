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
 * `license_tag=personal-only` と同じ扱いで **非公開の Notion
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
// 実データの週次リンクは一覧ページの週次テーブル (`<table class="overtable fixedhead">`)
// の行にだけ並び、様式変更告知のサンプルは表の外 (`<div>` のお知らせ欄) に置かれる
// (2026-09-27 実機確認)。「サンプル」という語の有無だけに頼ると、次回の告知で
// 「新様式ファイル」「見本」等の別の文言が使われた場合に、表の外の告知添付ファイルを
// 最新週として黙って採用してしまうため、抽出対象を <table> 要素の中身に限定する。
const TABLE_RE = /<table\b[^>]*>([\s\S]*?)<\/table>/g;

const CSV_LINK_RE =
  /<a\s+href="(\/markets\/statistics-derivatives\/sector\/[^"]*?Tousi_DV_W_(\d{8})_(\d{8})\.csv)"[^>]*>([\s\S]*?)<\/a>/g;

/**
 * 一覧ページ HTML から投資部門別取引状況(週間)CSV のリンクを抽出する純関数。
 * 対象週の終了日 (periodTo) 降順で返す。抽出対象は <table> 要素の中身だけ (実データの
 * 週次テーブル。表の外の告知欄に添付されたファイルは拾わない) で、さらに様式変更告知の
 * 「サンプルファイル」リンク（実データではない）はリンクテキストでも判別して除外する。1 件も見つからなければ
 * 様式変更を疑って throw する（黙って空配列を返さない）。
 *
 * 同じ対象週 (periodTo) に異なる URL の CSV が複数並んだ場合 (訂正版の併載・様式変更の
 * 告知サンプル等) は、HTML 内の出現順でどちらかを黙って採用せず throw する
 * (同一 URL の重複掲載は同じファイルなので 1 件にまとめる)。
 */
export function extractInvestorTypeCsvLinks(html: string): InvestorTypeCsvLink[] {
  const byPeriodTo = new Map<string, InvestorTypeCsvLink>();
  const tableBodies = [...html.matchAll(TABLE_RE)].map((t) => t[1]!);
  for (const m of tableBodies.flatMap((body) => [...body.matchAll(CSV_LINK_RE)])) {
    const linkText = m[4]!;
    if (linkText.includes("サンプル")) continue; // 様式変更告知の恒久的なサンプルリンクを除外
    const periodTo = isoFromCompactDate(m[3]!);
    const link: InvestorTypeCsvLink = {
      url: JPX_BASE + m[1]!,
      periodFrom: isoFromCompactDate(m[2]!),
      periodTo,
    };
    const existing = byPeriodTo.get(periodTo);
    if (existing && (existing.url !== link.url || existing.periodFrom !== link.periodFrom)) {
      throw new Error(
        `JPX 投資部門別取引状況: 同じ対象週 (${periodTo}) の CSV リンクが複数あり、どれが実データか判別できません ` +
          `(${existing.url} / ${link.url}) — 訂正版の併載・様式変更の可能性`
      );
    }
    byPeriodTo.set(periodTo, link);
  }
  if (byPeriodTo.size === 0) {
    throw new Error(
      "JPX 投資部門別取引状況: 一覧ページの週次テーブル (<table>) 内から Tousi_DV_W_*.csv リンクを抽出できません (様式変更の可能性)"
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
   * 正規化 (フォールバックではない)。加算結果が (買 − 売) と一致することは
   * {@link parseInvestorTypeCsv} が行ごとに検証し、一致しなければ throw する。
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
  // Number("") / Number(" ") は 0、Number("0x10") は 16、Number("1e3") は 1000 になるため、
  // 空欄 (欠損) を 0 として黙って記録したり、想定外の表記を数値化したりしないよう、
  // 前後空白の除去 (表記揺れの正規化) 後に符号付き10進整数の形だけを受け付ける。
  const trimmed = raw.trim();
  const n = Number(trimmed);
  if (!/^-?\d+$/.test(trimmed) || !Number.isSafeInteger(n)) {
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
  // 帳票種別×投資部門×数量金額区分 は 1 ファイル内で一意のはず。重複があると観測ログの
  // キー (期間|指標|区分) が衝突し、後勝ちで黙って上書きされるため止める。
  const seenKeys = new Map<string, number>();
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
    // 差引の意味 (買 − 売。売り越しは負) を毎回検証する。一度の実測に頼らず、
    // 様式変更で符号の付け方 (売り越しを正の値で表す等) や差引の意味 (前週比等) が
    // 変わったら、符号の逆な/意味の違う純売買を黙って記録せずに止める。
    const netBalance = purchasesBalance + salesBalance;
    if (netBalance !== purchases - sales) {
      throw new Error(
        `${context}: 差引 (買-差引 ${purchasesBalance} + 売-差引 ${salesBalance} = ${netBalance}) が ` +
          `買 − 売 (${purchases} − ${sales} = ${purchases - sales}) と一致しません ` +
          `(product=${productCode} investor=${investorCode}) — 差引の符号規則・意味の前提が崩れています`
      );
    }

    const rowKey = `${productCode}|${investorCode}|${metricCode}`;
    const seenAt = seenKeys.get(rowKey);
    if (seenAt !== undefined) {
      throw new Error(
        `${context}: 帳票種別 ${productCode}・投資部門 ${investorCode}・数量金額区分 ${metricCode} の行が ` +
          `${seenAt}行目と重複しています — どちらが正しい値か判別できません`
      );
    }
    seenKeys.set(rowKey, i + 1);

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
      netBalance,
    });
  }
  if (rows.length === 0) {
    throw new Error("JPX 投資部門別取引状況 CSV: 有効なデータ行を1件も抽出できませんでした");
  }
  // 週次ファイルは 1 週分のみを含む。複数の対象週が混ざっていたら、どの週の値として
  // 記録すべきか決められないので止める。
  const first = rows[0]!;
  const otherPeriod = rows.find(
    (r) => r.periodFrom !== first.periodFrom || r.periodTo !== first.periodTo
  );
  if (otherPeriod) {
    throw new Error(
      `JPX 投資部門別取引状況 CSV: 1 ファイルに複数の対象週が混在しています ` +
        `(${first.periodFrom}〜${first.periodTo} と ${otherPeriod.periodFrom}〜${otherPeriod.periodTo})`
    );
  }
  // 様式変更の告知に添付されるサンプル CSV は全行ゼロ埋め (実データではない)。
  // リンク抽出のサンプル除外をすり抜けた場合でも、架空値 (全ゼロ) を実測値として
  // 記録しないよう止める (CLAUDE.md ルール1)。実際の週次データで全商品・全投資部門の
  // 売買が 0 になることは無い。
  if (rows.every((r) => r.total === 0)) {
    throw new Error(
      "JPX 投資部門別取引状況 CSV: 全行の合計が 0 です — 実データではなく様式変更告知のサンプルファイル等の可能性"
    );
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
  // 観測ログは行の periodTo、一次データの冪等キーは link.periodTo を使うため、
  // 両者がずれたまま記録しない (parseInvestorTypeCsv が全行同一週であることは検証済み)。
  const first = rows[0]!;
  if (first.periodFrom !== link.periodFrom || first.periodTo !== link.periodTo) {
    throw new Error(
      `JPX 投資部門別取引状況: ファイル名の対象週 (${link.periodFrom}〜${link.periodTo}) と ` +
        `CSV 内の対象週 (${first.periodFrom}〜${first.periodTo}) が一致しません (${link.url})`
    );
  }
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
  // Year / TradeDate が想定形式でないと数値比較・文字列比較が意味を失い、黙って
  // 古い年・古い週を「最新」として選んでしまう (NaN との比較は常に false)。
  // 1 件でも形式外があれば止める。
  for (const y of yearList.TableDatas) {
    if (!/^\d{4}$/.test(String(y.Year))) {
      throw new Error(`JPX 建玉残高: 年一覧 JSON の Year が YYYY 形式ではありません: ${JSON.stringify(y.Year)}`);
    }
  }
  let latestYearEntry = yearList.TableDatas[0]!;
  for (const y of yearList.TableDatas) {
    if (Number(y.Year) > Number(latestYearEntry.Year)) latestYearEntry = y;
  }

  const yearData = await fetchJson<OiYearResponse>(JPX_BASE + latestYearEntry.Jsonfile);
  if (!yearData.TableDatas || yearData.TableDatas.length === 0) {
    throw new Error(`JPX 建玉残高: ${latestYearEntry.Year}年の週次一覧が空です`);
  }
  for (const w of yearData.TableDatas) {
    if (!/^\d{8}$/.test(String(w.TradeDate))) {
      throw new Error(
        `JPX 建玉残高: ${latestYearEntry.Year}年の週次一覧の TradeDate が YYYYMMDD 形式ではありません: ${JSON.stringify(w.TradeDate)}`
      );
    }
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

/**
 * 建玉数量 (枚) のセル値を非負整数として読む。空白だけのセルを Number(" ") = 0 として
 * 黙って 0 枚にしない。売超/買超は差引の大きさ (正の枚数) なので、負値・小数は
 * 様式/符号規則の変更とみなして止める。桁区切りカンマの除去は表記の正規化。
 */
function cellOpenInterest(v: unknown, context: string): number {
  const raw = typeof v === "number" ? String(v) : cellStr(v).replace(/,/g, "");
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n)) {
    throw new Error(`${context}: 建玉数量を非負の整数として解釈できません: ${JSON.stringify(v)}`);
  }
  return n;
}

const EXPECTED_OI_TITLE = "指数先物取引参加者別建玉残高";
/** 左ブロック (列0〜7) と右ブロック (列10〜17) の先頭列。列8〜9は空白。 */
const OI_BLOCK_OFFSETS = [0, 10] as const;
/** ブロック先頭からの相対列: 売超(コード・名称・数量) = 2,3,4 / 買超(コード・名称・数量) = 5,6,7 */
const OI_PARTICIPANT_COLS = [2, 3, 4, 5, 6, 7] as const;
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
 * (2026-09-18 現在ファイルで実測。テストの実フィクスチャ `jpx-futures-oi-20260918-indexfut.xlsx` で検証)。
 *
 * 左右のブロックはランキング行数が揃わない週があるため、ブロックごとに独立して読む
 * (片側だけに順位がある行も、その片側を取りこぼさない)。
 *
 * @throws タイトル行・基準日表記が想定と異なる、見出しより前にデータ行が出現する、
 *   参加者コード/名称/建玉数量が一部だけ欠けている、順位や限月が無いのに参加者の
 *   値があるブロックがある (結合セル等で黙って取りこぼす恐れ) 等、様式が想定と異なる場合。
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
  const seenKeys = new Set<string>();
  let currentProduct: string | null = null;

  for (const row of grid) {
    const c0 = cellStr(row[0]);
    if (c0.startsWith("＜") && c0.endsWith("＞")) {
      currentProduct = c0.slice(1, -1);
      continue;
    }
    // 左右どちらかのブロックに順位 (数字) がある行だけがランキング行。
    // 左ブロックだけで判定すると、右ブロックの方が行数の多い週に右側の下位を黙って落とす。
    const isRankingRow = OI_BLOCK_OFFSETS.some((offset) => /^\d+$/.test(cellStr(row[offset])));
    if (!isRankingRow) continue; // タイトル・小見出し・空行はスキップ

    if (!currentProduct) {
      throw new Error(
        "JPX 建玉残高: 商品見出し(＜…＞)より前にランキング行が出現しました — 様式変更の可能性"
      );
    }

    for (const offset of OI_BLOCK_OFFSETS) {
      const rankRaw = cellStr(row[offset]);
      const monthLabel = cellStr(row[offset + 1]);
      const hasParticipantCell = OI_PARTICIPANT_COLS.some((k) => cellStr(row[offset + k]) !== "");
      if (!/^\d+$/.test(rankRaw) || !monthLabel) {
        // このブロックはこの行に順位/限月が無い (左右でランキング行数が揃わない週・
        // 片側の限月だけの週)。参加者の値まで空なら何も無いので読み飛ばすが、値がある
        // のに順位/限月が読めない (結合セル・列ずれ等) なら黙って捨てずに止める。
        if (hasParticipantCell) {
          throw new Error(
            `JPX 建玉残高 (product=${currentProduct}): 順位 (${JSON.stringify(rankRaw)}) または限月 ` +
              `(${JSON.stringify(monthLabel)}) が無いブロックに参加者の値があります — 結合セル・様式変更の可能性`
          );
        }
        continue;
      }
      const contractMonth = parseContractMonth(monthLabel);
      const rank = Number(rankRaw);

      for (const [side, codeCol] of [
        ["net_short", offset + 2],
        ["net_long", offset + 5],
      ] as const) {
        const code = cellStr(row[codeCol]);
        const name = cellStr(row[codeCol + 1]);
        const oiRaw = row[codeCol + 2];
        const hasOi = cellStr(oiRaw) !== "";
        if (!code && !name && !hasOi) continue; // その順位に参加者がいない (末尾)

        const context = `JPX 建玉残高 (product=${currentProduct} month=${contractMonth} side=${side} rank=${rank})`;
        if (!code || !name || !hasOi) {
          throw new Error(`${context}: 参加者コード/名称/建玉数量の一部だけが欠けています`);
        }
        // 同じ商品・限月・サイド・順位が 2 回出たら (左右ブロックが同じ限月・商品見出しの
        // 重複等) どちらが正しいか判別できないので止める (観測ログの区分も衝突する)。
        const rowKey = `${currentProduct}|${contractMonth}|${side}|${rank}`;
        if (seenKeys.has(rowKey)) {
          throw new Error(`${context}: 同じ商品・限月・サイド・順位の行が重複しています — 様式変更の可能性`);
        }
        seenKeys.add(rowKey);
        rows.push({
          product: currentProduct,
          contractMonth,
          rank,
          side,
          participantCode: code,
          participantName: name,
          openInterest: cellOpenInterest(oiRaw, context),
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
  "(personal-only)。kabulab では非公開の Notion ダッシュボードのみに使い、" +
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
      "先物・オプションは、買い手と売り手が必ず同じ枚数だけいるゼロサムの取引なので、" +
        "全投資部門の純売買を足し合わせるとほぼ打ち消し合う（本指標は投資部門「間」の" +
        "資金の向きを見るためのもので、市場への資金の純流入そのものではない）。",
      "商品(帳票種別)は80種類が混在し、日経225先物のような株価指数だけでなく、国債" +
        "先物・金利先物・為替先物・商品(コモディティ)先物・電力先物・各種オプションを含む。" +
        "区分（segment）で商品名を必ず確認すること。",
      "オプションの「代金」はオプション料（プレミアム）の受け払い額で、先物の「代金」" +
        "（約定価格×数量×取引単位＝取引の元本の大きさ）とは意味が違う。商品をまたいで" +
        "代金を足し合わせたり大小を比べたりしないこと。",
      "「自己(11)」は取引参加者（取引所で直接売買できる証券会社等）が自分の勘定で行う売買。" +
        "「証券会社(41)」は委託（取引参加者が受けた注文）側の顧客区分で、取引参加者に" +
        "注文を出した証券会社の売買。同じ証券会社の自己勘定の売買でも、取引参加者として" +
        "自ら発注すれば自己(11)、別の取引参加者に注文を出せば証券会社(41)に計上される。",
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
      "オプションの「代金」はオプション料（プレミアム）の受け払い額で、先物の「代金」" +
        "（約定価格×数量×取引単位＝取引の元本の大きさ）とは意味が違う。商品をまたいで" +
        "代金を足し合わせたり大小を比べたりしないこと。",
    ],
  },
  {
    key: INDICATOR_FUTURES_OI_KEY,
    displayName: "指数先物 取引参加者別建玉残高（上位ランキング）",
    requirements: ["R3"],
    measures: "positions",
    plainDescription:
      "週末時点で、日経225先物・日経225mini・TOPIX先物の「建玉」(まだ決済していない" +
      "未決済のポジション) について、証券会社などの取引参加者ごとに買い建玉と売り建玉を" +
      "差し引きし、『売り越し(売り建玉が買い建玉を上回る分)が大きい順』『買い越し(買い" +
      "建玉が売り建玉を上回る分)が大きい順』に並べたランキング。フロー(その週に動いた" +
      "資金の量)ではなく、ある時点の残高(ストック)である点に注意。例えば「野村証券が" +
      "日経225先物2026年12月限月の買超1位で33,866枚」なら、その時点で同社(自己+顧客" +
      "合算)の買い建玉が売り建玉を33,866枚上回り、その差が全参加者の中で最も大きい、" +
      "という意味（買い建玉そのものの総数ではない）。",
    definition:
      "JPX(大阪取引所)「取引参加者別建玉残高一覧」xlsx の、限月ごとの売超/買超" +
      "参加者ランキング上位の建玉数量(枚)。数量は各参加者の売建玉と買建玉の差引" +
      "(売超=売り越し枚数、買超=買い越し枚数)で、売り・買いそれぞれの総建玉(グロス)" +
      "ではない。取引参加者(証券会社等)単位の集計であり、投資部門別(個人・海外投資家等)" +
      "の内訳ではない。",
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
