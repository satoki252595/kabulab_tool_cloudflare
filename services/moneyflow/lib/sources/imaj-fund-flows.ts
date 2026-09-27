/**
 * 取得元: 一般社団法人資産運用業協会 (IMAJ、旧・投資信託協会、2026-04-01 に
 * 日本投資顧問業協会と合併し改称。旧ドメイン toushin.or.jp は生きたまま
 * imaj.or.jp へ移行中で、統計データの xlsx リンクは 2026-09-27 時点でも
 * toushin.or.jp ドメインのまま配信されている)。
 *
 * 対象データセット (2つ、同じ協会・同じ「資産増減状況」フォーマット系列):
 *   B-1 「資産増減状況」    契約型公募投資信託 (株式投信/公社債投信 等) の
 *                          月次 設定額・解約額・償還額・資金増減額・純資産総額。
 *   D-1 「公募不動産投信の月末資産増減状況」 公募 J-REIT 全体の同種の月次系列。
 *
 * 出典ページ (一覧・年月確認用): https://www.toushin.or.jp/statistics/statistics/index.html
 *   2026-09-27 に当該ページの HTML を実際に取得し、B-1/D-1 の行が指す実リンク
 *   (下記 URL 定数) を直接確認した (`<th>B-1</th>` / `<th>D-1</th>` の同じ
 *   <tr> 内の <a href>)。
 *
 * URL は「月ごとに変わるファイル名」ではなく、**同一の固定 URL を協会が
 * 月次で上書き更新する**方式 (ファイル自身の中に 1989 年 or 2016 年〜最新月
 * までの時系列が丸ごと入っている)。そのため JPX の週次 PDF (`margin.ts` の
 * `latestMarginPdfUrl`) のような一覧ページのスクレイピングによる URL 解決は
 * 不要で、固定 URL への GET 1 回で足りる。バックナンバー個別ページも無い
 * (2026-09-27 時点で実測確認済み)。
 *
 * bot 対策 / 利用制限:
 *   - ログイン・CAPTCHA 無し。robots.txt 相当の明示的な自動取得禁止も見当た
 *     らず、ブラウザ相当 UA での単発 GET が 200 で通ることを実測済み。
 *   - 利用規約上の商用可否は原文で明記が見つからず (`commercial_use: unknown`
 *     ～ `prohibited` の記述が資料により分かれる)。本プロジェクトの方針
 *     (2026-09-27 決定: 個人利用限定) に合わせ、既存の `license_tag=
 *     personal-only` と同じ扱いとする (下記 `licenseTag` 参照)。
 *   - 1 回の実行につき、この 2 ファイルをそれぞれ 1 回だけ GET する
 *     (`downloadImajFundFlowsXlsx` / `downloadImajReitFlowsXlsx` を 1 回ずつ)。
 *
 * ルール2 (フォールバック禁止) の適用:
 *   - 想定と異なるシート名・ヘッダ列・期間ラベル・数値セルは全て throw する
 *     (`parseImajFundFlows` / `parseImajReitFlows`)。
 *   - セル値 "-" は (収益分配額の列を除き) 「その月にこの項目の発生が無い(=0)」という**原資料自身の
 *     表記** として 0 に変換する。これは JPX 信用残 PDF の "▲" (負符号) を
 *     `margin.ts` の `toInt` が解釈しているのと同種の「原資料の記法の解釈」
 *     であり、黙って既定値を埋めるフォールバックではない。根拠: 2026-09-27
 *     実ファイル (I0112B_pub_m.xlsx / F00B21_pub.xlsx) で対象列を全数検査し、
 *     "-" と数値の 0 が同一列に同時出現したことが無いことを確認済み
 *     (例: 公社債シート「償還額」列 452 行中 173 行が "-"、数値 0 は 0 行)。
 *   - 例外: 収益分配額 (E) 列の "-" は 1989年1月〜1997年3月に 3 区分とも 99 か月
 *     連続で現れ、「分配が無かった」ではなく「別掲されていない」と読めるため、
 *     0 にせず null (不明) で返す (`ImajFundFlowRow.profitDistributions` 参照)。
 */
import * as XLSX from "xlsx";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** 出典一覧ページ (URL 固定の裏取り・年月確認用。パースの入力には使わない) */
export const IMAJ_STATISTICS_INDEX_URL =
  "https://www.toushin.or.jp/statistics/statistics/index.html";

/** B-1「資産増減状況」(契約型公募投資信託・商品分類別) の固定 URL */
export const IMAJ_FUND_FLOWS_URL =
  "https://www.toushin.or.jp/tws/toukei_dw/I0112B_pub_m.xlsx";

/** D-1「公募不動産投信の月末資産増減状況」の固定 URL */
export const IMAJ_REIT_FLOWS_URL =
  "https://www.toushin.or.jp/tws/toukei_dw/F00B21_pub.xlsx";

/** 利用条件タグ。既存の `core_stocks.license_tag` 等と同じ語彙 (jss-api 側の説明文言と同義)。 */
export type MoneyflowLicenseTag = "personal-only";

const PERIOD_LABEL_RE = /^(\d{4})年(\d{1,2})月$/;

// ---------------------------------------------------------------------------
// (1) 取得
// ---------------------------------------------------------------------------

export interface ImajDownload {
  bytes: Uint8Array;
  url: string;
}

async function downloadXlsx(url: string, context: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,*/*",
    },
  });
  if (!res.ok) {
    throw new Error(
      `${context}: HTTP エラー ${res.status} ${res.statusText} (${url})`
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** B-1「資産増減状況」xlsx を取得する。1 回の実行で 1 回だけ GET する。 */
export async function downloadImajFundFlowsXlsx(): Promise<ImajDownload> {
  const bytes = await downloadXlsx(IMAJ_FUND_FLOWS_URL, "IMAJ 資産増減状況(B-1)");
  return { bytes, url: IMAJ_FUND_FLOWS_URL };
}

/** D-1「公募不動産投信の月末資産増減状況」xlsx を取得する。1 回の実行で 1 回だけ GET する。 */
export async function downloadImajReitFlowsXlsx(): Promise<ImajDownload> {
  const bytes = await downloadXlsx(
    IMAJ_REIT_FLOWS_URL,
    "IMAJ 公募REIT月末資産増減状況(D-1)"
  );
  return { bytes, url: IMAJ_REIT_FLOWS_URL };
}

// ---------------------------------------------------------------------------
// (2) パース (純関数)
// ---------------------------------------------------------------------------

/** 期間ラベル (例: "2026年8月") を "YYYY-MM" に正規化する。形式が違えば throw。 */
function parsePeriod(value: unknown, context: string): string {
  const s = String(value ?? "").trim();
  const m = s.match(PERIOD_LABEL_RE);
  if (!m) {
    throw new Error(
      `${context}: 期間ラベルが 'YYYY年M月' 形式ではありません: ${JSON.stringify(value)}`
    );
  }
  return `${m[1]}-${m[2].padStart(2, "0")}`;
}

/**
 * 円額セル (単位: 百万円) を解釈する。
 * "-" は原資料自身の「この月は当該項目の発生が無い(=0)」という表記
 * (モジュール冒頭のコメント参照)。それ以外の非数値は様式変更の疑いとして throw。
 */
function parseYen(value: unknown, context: string): number {
  if (typeof value === "number") return value;
  if (value === "-") return 0;
  throw new Error(`${context}: 数値セルが解釈できません: ${JSON.stringify(value)}`);
}

/**
 * "-" の意味が「発生無し(0)」と確定できない列用。"-" は null (不明) を返し、
 * それ以外は `parseYen` と同じく数値のみ受け付け、非数値は throw する。
 */
function parseYenOrNullForDash(value: unknown, context: string): number | null {
  if (value === "-") return null;
  return parseYen(value, context);
}

/**
 * ヘッダ行 (列位置 + 見出し文字列) が資料内に存在することを検証する。
 * 見つからなければ様式変更とみなし throw する。行位置そのものは返さない
 * (データ抽出は期間ラベルの正規表現マッチで行毎に判定するため、行位置に
 * 依存しない — タイトル行やコメント行の増減に対して頑健)。
 */
function assertHeaderPresent(
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  checks: ReadonlyArray<readonly [number, string]>,
  context: string
): void {
  const found = rows.some((row) =>
    checks.every(([col, text]) => String(row[col] ?? "").includes(text))
  );
  if (!found) {
    throw new Error(`${context}: ヘッダ行が見つかりません (様式が変わった可能性)`);
  }
}

// --- B-1 資産増減状況 (公募投信) -------------------------------------------

/** B-1 の商品分類区分。値は Notion 観測ログの「区分」列にそのまま使う識別子。 */
export type ImajFundCategory =
  | "total"
  | "equity"
  | "equity_ex_etf"
  | "equity_etf"
  | "bond";

/** 商品分類 → シート名。2026-09-27 実ファイルで確認したシート名 (全角ＥＴＦ表記)。 */
const FUND_CATEGORY_SHEET: Record<ImajFundCategory, string> = {
  total: "総合計",
  equity: "株式",
  equity_ex_etf: "株式 除ＥＴＦ",
  equity_etf: "株式 追加型 ＥＴＦ",
  bond: "公社債",
};

const FUND_HEADER_CHECKS: ReadonlyArray<readonly [number, string]> = [
  [1, "項目"],
  [2, "設定額"],
  [3, "解約額"],
  [4, "償還額"],
  [5, "資金増減額"],
  [6, "収益分配額"],
  [7, "運用増減額"],
  // 原本の見出しは「純資産\n増減額」。列 8 を未検証のままにすると列の挿入/入替が
  // 起きても純資産増減額に別列の値が黙って入るため、全データ列を検証する。
  [8, "増減額"],
  [9, "純資産総額"],
  [10, "ファンド数"],
];

export interface ImajFundFlowRow {
  category: ImajFundCategory;
  /** "YYYY-MM" */
  period: string;
  /** 設定額 (A)。百万円。 */
  sales: number;
  /** 解約額 (B)。百万円。 */
  repurchases: number;
  /** 償還額 (C)。百万円。 */
  redemptions: number;
  /** 資金増減額 (D) = (A)-((B)+(C))。百万円。設定-解約-償還の純フロー。 */
  netFlow: number;
  /**
   * 収益分配額 (E)。百万円。原本セルが "-" の場合は null (値が不明)。
   * この列の "-" は「分配が無かった」とは限らない: 2026-09-27 原本では
   * 総合計/株式/公社債の 1989年1月〜1997年3月 (99か月連続) が全て "-" で、
   * 当時も分配 (公社債投信の毎月分配等) は実在したので「別掲されていない」
   * 意味と読める。一方 ETF の "-" は分配の無い月とも読め、セル単位では区別
   * できないため、0 と決め打ちせず null (未取得) で返す (ルール2)。
   */
  profitDistributions: number | null;
  /** 運用増減額 (F)。百万円。市場変動による評価増減 (資金の流れとは別概念)。 */
  managementGain: number;
  /** 純資産増減額 ((D)-(E)+(F))。百万円。原資料の計算式表記どおり、再計算はしない。 */
  netAssetChange: number;
  /** 純資産総額 (月末残高)。百万円。 */
  totalNetAssets: number;
  /** ファンド数。 */
  fundCount: number;
}

function parseFundSheet(
  sheet: XLSX.WorkSheet,
  category: ImajFundCategory
): ImajFundFlowRow[] {
  const context = `IMAJ 資産増減状況(B-1) [${category}]`;
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
  });
  assertHeaderPresent(rows, FUND_HEADER_CHECKS, context);
  const dataRows = rows.filter((r) => PERIOD_LABEL_RE.test(String(r[1] ?? "")));
  if (dataRows.length === 0) {
    throw new Error(`${context}: データ行が 0 件です`);
  }
  return dataRows.map((r) => ({
    category,
    period: parsePeriod(r[1], context),
    sales: parseYen(r[2], `${context} 設定額`),
    repurchases: parseYen(r[3], `${context} 解約額`),
    redemptions: parseYen(r[4], `${context} 償還額`),
    netFlow: parseYen(r[5], `${context} 資金増減額`),
    profitDistributions: parseYenOrNullForDash(r[6], `${context} 収益分配額`),
    managementGain: parseYen(r[7], `${context} 運用増減額`),
    netAssetChange: parseYen(r[8], `${context} 純資産増減額`),
    totalNetAssets: parseYen(r[9], `${context} 純資産総額`),
    fundCount: parseYen(r[10], `${context} ファンド数`),
  }));
}

/**
 * B-1「資産増減状況」xlsx バイト列から、5 つの商品分類区分すべての
 * 月次行を返す (縦持ち・全区分まとめて)。
 * @throws シート欠落 / ヘッダ列不一致 / データ行 0 件 / セル値が解釈不能な場合
 */
export function parseImajFundFlows(bytes: Uint8Array): ImajFundFlowRow[] {
  const wb = XLSX.read(bytes, { type: "array" });
  const out: ImajFundFlowRow[] = [];
  for (const category of Object.keys(FUND_CATEGORY_SHEET) as ImajFundCategory[]) {
    const sheetName = FUND_CATEGORY_SHEET[category];
    const sheet = wb.Sheets[sheetName];
    if (!sheet) {
      throw new Error(
        `IMAJ 資産増減状況(B-1): シート「${sheetName}」が見つかりません (様式変更の疑い)`
      );
    }
    out.push(...parseFundSheet(sheet, category));
  }
  return out;
}

// --- D-1 公募REIT月末資産増減状況 ------------------------------------------

const REIT_SHEET_NAME = "月次";

const REIT_HEADER_CHECKS: ReadonlyArray<readonly [number, string]> = [
  [1, "項目"],
  [2, "追加出資金額"],
  [3, "出資払戻金額"],
  [4, "資本金増減額"],
  [5, "その他増減額"],
  [6, "資産増減額"],
  [7, "純資産総額"],
  // 列 8〜13 も検証する (未検証だと列の挿入/入替時に資産総額・口数・本数へ
  // 別列の値が黙って入る — 様式変更は throw で止める)。原本の見出しは改行入り
  // (例: 「ファンド\n本数」) なので改行を跨がない部分文字列で照合する。
  [8, "資産総額"],
  [9, "出資総額"],
  [10, "負債総額"],
  [11, "組入不動産の総額"],
  [12, "月末総口数"],
  [13, "本数"],
];

export interface ImajReitFlowRow {
  /** "YYYY-MM" */
  period: string;
  /** 追加出資金額 (A)。百万円。投資口の追加発行(公募増資等)による資金流入。 */
  capitalIncrease: number;
  /** 出資払戻金額 (B)。百万円。 */
  capitalDistribution: number;
  /** 資本金増減額 (C) = (A)-(B)。百万円。REIT 全体への純粋な資金の出入り。 */
  capitalChange: number;
  /** その他増減額 (D)。百万円。運用による剰余金(当期損益+内部留保)の増減。資金の流れとは別概念。 */
  otherChange: number;
  /** 資産増減額 (C)+(D)。百万円。 */
  assetChange: number;
  /** 当月末純資産総額 (残高)。百万円。 */
  totalNetAssets: number;
  /** 資産総額。百万円。 */
  totalAssets: number;
  /** 出資総額。百万円。 */
  totalCapitalContribution: number;
  /** 負債総額 (有利子負債+投資法人債+敷金保証金)。百万円。 */
  totalLiabilities: number;
  /** 組入不動産の総額 (各投資法人の開示評価額ベース)。百万円。 */
  totalBookValueRealEstate: number;
  /** 月末総口数。 */
  totalIssuedUnits: number;
  /** ファンド本数。 */
  fundCount: number;
}

/**
 * D-1「公募不動産投信の月末資産増減状況」xlsx バイト列から月次行を返す。
 * @throws シート欠落 / ヘッダ列不一致 / データ行 0 件 / セル値が解釈不能な場合
 */
export function parseImajReitFlows(bytes: Uint8Array): ImajReitFlowRow[] {
  const wb = XLSX.read(bytes, { type: "array" });
  const sheet = wb.Sheets[REIT_SHEET_NAME];
  const context = "IMAJ 公募REIT月末資産増減状況(D-1)";
  if (!sheet) {
    throw new Error(
      `${context}: シート「${REIT_SHEET_NAME}」が見つかりません (様式変更の疑い)`
    );
  }
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
  });
  assertHeaderPresent(rows, REIT_HEADER_CHECKS, context);
  const dataRows = rows.filter((r) => PERIOD_LABEL_RE.test(String(r[1] ?? "")));
  if (dataRows.length === 0) {
    throw new Error(`${context}: データ行が 0 件です`);
  }
  return dataRows.map((r) => ({
    period: parsePeriod(r[1], context),
    capitalIncrease: parseYen(r[2], `${context} 追加出資金額`),
    capitalDistribution: parseYen(r[3], `${context} 出資払戻金額`),
    capitalChange: parseYen(r[4], `${context} 資本金増減額`),
    otherChange: parseYen(r[5], `${context} その他増減額`),
    assetChange: parseYen(r[6], `${context} 資産増減額`),
    totalNetAssets: parseYen(r[7], `${context} 当月末純資産総額`),
    totalAssets: parseYen(r[8], `${context} 資産総額`),
    totalCapitalContribution: parseYen(r[9], `${context} 出資総額`),
    totalLiabilities: parseYen(r[10], `${context} 負債総額`),
    totalBookValueRealEstate: parseYen(r[11], `${context} 組入不動産の総額`),
    totalIssuedUnits: parseYen(r[12], `${context} 月末総口数`),
    fundCount: parseYen(r[13], `${context} ファンド本数`),
  }));
}

// ---------------------------------------------------------------------------
// (3) 期間判定・「まだ公表されていない」判定
// ---------------------------------------------------------------------------

export interface PublicationStatus {
  requestedPeriod: string;
  latestAvailablePeriod: string;
  status: "published" | "not_yet_published";
}

/**
 * この資料は月次のみ (週次・四半期・年次の概念は無い)。
 * ファイル自体が最新月まで延伸更新される単一の時系列なので、「最新公表期間」は
 * パース結果の行に含まれる period の最大値そのもの。要求期間がそれより
 * 新しければ「まだ公表されていない」であり、エラーではない (ルール2:
 * 欠損を欠損のまま返す。無理に値を合成しない)。
 * @throws rows が空の場合 (パース結果が無い状態で判定はできない)
 */
export function judgeImajPublicationStatus(
  requestedPeriod: string,
  rows: ReadonlyArray<{ period: string }>
): PublicationStatus {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(requestedPeriod)) {
    // "2026-8" のような非ゼロ埋めは文字列比較で "2026-08" より大きくなり、
    // 公表済みの月を「未公表」と誤判定するため、形式違いは throw する。
    throw new Error(
      `judgeImajPublicationStatus: requestedPeriod は 'YYYY-MM' 形式で指定してください: ${JSON.stringify(requestedPeriod)}`
    );
  }
  if (rows.length === 0) {
    throw new Error(
      "judgeImajPublicationStatus: rows が空です (取得/パース結果が無い状態で判定できません)"
    );
  }
  let latestAvailablePeriod = rows[0]!.period;
  for (const r of rows) {
    if (r.period > latestAvailablePeriod) latestAvailablePeriod = r.period;
  }
  return {
    requestedPeriod,
    latestAvailablePeriod,
    status:
      requestedPeriod > latestAvailablePeriod ? "not_yet_published" : "published",
  };
}

// ---------------------------------------------------------------------------
// (4) 指標定義
// ---------------------------------------------------------------------------

export type MoneyflowRequirement = "R1" | "R2" | "R3" | "R4";

/**
 * 「何を測るか」の語彙 (計画ドキュメント docs 由来の共通語彙に合わせる):
 *   net_flow           : 投資部門別等の「買い越し/売り越し」(誰が買ったか)
 *   gross_turnover     : 総取引額 (グロス)。買い越し/売り越しではない
 *   holdings_stock     : ある時点の残高 (フローではない)
 *   positions          : 建玉・ポジション残高
 *   fund_flow          : ファンドへの設定-解約(-償還) 等、対象そのものへの純粋な資金の出入り
 *   estimated          : 評価損益等を差し引いた推定値
 *   price_only         : 価格・指数のみで資金フローを表さない
 */
export type MoneyflowFlowType =
  | "net_flow"
  | "gross_turnover"
  | "holdings_stock"
  | "positions"
  | "fund_flow"
  | "estimated"
  | "price_only";

export interface MoneyflowIndicatorDefinition {
  key: string;
  label: string;
  requirements: MoneyflowRequirement[];
  flowType: MoneyflowFlowType;
  /** 何を測るか。財務的に正確な定義 (CLAUDE.md ルール7 の精神: 噛み砕きと引き換えに誤った定義を教えない)。 */
  measures: string;
  /** 投資初心者向けの平易な説明 (1〜3文、具体例つき)。 */
  plainExplanation: string;
  unit: string;
  sourceUrl: string;
  licenseTag: MoneyflowLicenseTag;
  frequency: "monthly";
  /** この指標の限界・注意点。 */
  limitations: string;
}

export const IMAJ_FUND_FLOWS_INDICATORS: MoneyflowIndicatorDefinition[] = [
  {
    key: "imaj_fund_net_flow",
    label: "公募投信の資金増減額",
    requirements: ["R2"],
    flowType: "fund_flow",
    measures:
      "契約型公募投資信託 (株式投信・公社債投信) の月次資金増減額 " +
      "(設定額-(解約額+償還額))。区分は商品分類 (総合計/株式投信/株式投信(除ETF)/" +
      "ETF/公社債投信)。ファンドという器そのものへの純粋な資金の出入りであり、" +
      "上場ETF・REITの取引所での二次市場売買 (投資部門別の買い越し/売り越し) とは別概念。",
    plainExplanation:
      "投資信託に新しく入ってきたお金(設定額)から、解約・償還で出ていったお金を" +
      "引いた金額。プラスなら資金が純増、マイナスなら純減。例えば設定1兆円・解約8千億円" +
      "なら資金増減額は+2千億円。",
    unit: "百万円",
    sourceUrl: IMAJ_FUND_FLOWS_URL,
    licenseTag: "personal-only",
    frequency: "monthly",
    limitations:
      "実額(市場価格ベース)であり、二次市場での投資家間の売買代金(グロス)は含まない。" +
      "ETF区分・除ETF区分は2001年7月分以降のみ存在する(それ以前は総合計/株式/公社債の" +
      "3区分のみ)。当月分は翌月中旬〜下旬に掲載される。",
  },
  {
    key: "imaj_fund_net_asset_total",
    label: "公募投信の純資産総額",
    requirements: ["R2"],
    flowType: "holdings_stock",
    measures:
      "契約型公募投資信託の月末純資産総額 (残高)。区分は商品分類。資金の流出入" +
      "だけでなく市場変動による評価増減 (運用増減額) も反映した残高であり、フローではない。",
    plainExplanation:
      "その投資信託カテゴリに、今いくら資産が積み上がっているか(残高)。資金増減額" +
      "(フロー)と違い、値上がり・値下がりによる評価額の変化も含む。",
    unit: "百万円",
    sourceUrl: IMAJ_FUND_FLOWS_URL,
    licenseTag: "personal-only",
    frequency: "monthly",
    limitations: "残高(ストック)であり、その月の資金の流入出そのものではない。",
  },
];

export const IMAJ_REIT_FLOWS_INDICATORS: MoneyflowIndicatorDefinition[] = [
  {
    key: "imaj_reit_net_flow",
    label: "公募REITの資本金増減額",
    requirements: ["R2"],
    flowType: "fund_flow",
    measures:
      "公募不動産投資法人 (J-REIT) 全体の月次資本金増減額 " +
      "(追加出資金額-出資払戻金額)。投資口の追加発行(公募増資等)による資金流入から、" +
      "出資払戻による流出を引いた額。東証での投資口の二次市場売買 " +
      "(投資部門別売買状況の買い越し/売り越し) とは別概念。",
    plainExplanation:
      "REIT(不動産の詰め合わせに投資する商品)全体が、新しい出資(増資)でどれだけ" +
      "お金を集め、払い戻しでどれだけ出したかの差額。プラスならREIT全体への資金純流入。",
    unit: "百万円",
    sourceUrl: IMAJ_REIT_FLOWS_URL,
    licenseTag: "personal-only",
    frequency: "monthly",
    limitations:
      "公募REIT全体(私募は含まない)の合算値であり、銘柄別の内訳はこの資料には無い。" +
      "当月分の掲載は公募投信本体 (B-1) より1か月ほど遅れる傾向がある " +
      "(2026-09-27 実測: B-1 は2026年8月分まで、D-1 は2026年7月分まで)。",
  },
  {
    key: "imaj_reit_net_asset_total",
    label: "公募REITの純資産総額",
    requirements: ["R2"],
    flowType: "holdings_stock",
    measures:
      "公募REIT全体の当月末純資産総額 (残高)。各投資法人の貸借対照表上の純資産 " +
      "(出資総額+剰余金) の合計であり、投資口の市場価格 (時価総額) ではない。" +
      "原本では前月比の増減が資本金増減額+その他増減額 (剰余金の増減) と一致し、" +
      "投資口価格の上げ下げは反映されない。",
    plainExplanation:
      "REIT全体が帳簿の上で持っている正味の財産(資産から借入金などの負債を引いた額)の合計。" +
      "株価にあたる投資口価格の上がり下がりは含まない。例えばREIT価格が1割下がっても、" +
      "この値はほぼ変わらない。",
    unit: "百万円",
    sourceUrl: IMAJ_REIT_FLOWS_URL,
    licenseTag: "personal-only",
    frequency: "monthly",
    limitations:
      "残高(ストック)であり、その月の資金の流入出そのものではない。帳簿価額ベースのため、" +
      "公募投信の純資産総額 (時価ベース) とは性質が異なり、単純に比較・合算できない。",
  },
];

// ---------------------------------------------------------------------------
// 縦長の観測レコード (期間・指標キー・区分・値・単位・近似/推定フラグ)
// ---------------------------------------------------------------------------

export interface MoneyflowObservation {
  /** "YYYY-MM" */
  period: string;
  indicatorKey: string;
  /** 区分 (商品分類等)。単一区分の指標は固定文字列。 */
  category: string;
  value: number;
  unit: string;
  /** この資料の値は実額集計であり近似計算を含まないため、この関数の出力は常に false。 */
  isApproximate: boolean;
  /** この資料の値は実測値でありモデル推定を含まないため、この関数の出力は常に false。 */
  isEstimated: boolean;
}

/** B-1 パース結果を縦長の観測レコードへ変換する (指標×区分 それぞれ1行)。 */
export function toImajFundFlowObservations(
  rows: ReadonlyArray<ImajFundFlowRow>
): MoneyflowObservation[] {
  const out: MoneyflowObservation[] = [];
  for (const r of rows) {
    out.push({
      period: r.period,
      indicatorKey: "imaj_fund_net_flow",
      category: r.category,
      value: r.netFlow,
      unit: "百万円",
      isApproximate: false,
      isEstimated: false,
    });
    out.push({
      period: r.period,
      indicatorKey: "imaj_fund_net_asset_total",
      category: r.category,
      value: r.totalNetAssets,
      unit: "百万円",
      isApproximate: false,
      isEstimated: false,
    });
  }
  return out;
}

/** D-1 パース結果を縦長の観測レコードへ変換する。区分は市場全体固定 ("reit_public")。 */
export function toImajReitFlowObservations(
  rows: ReadonlyArray<ImajReitFlowRow>
): MoneyflowObservation[] {
  const out: MoneyflowObservation[] = [];
  for (const r of rows) {
    out.push({
      period: r.period,
      indicatorKey: "imaj_reit_net_flow",
      category: "reit_public",
      value: r.capitalChange,
      unit: "百万円",
      isApproximate: false,
      isEstimated: false,
    });
    out.push({
      period: r.period,
      indicatorKey: "imaj_reit_net_asset_total",
      category: "reit_public",
      value: r.totalNetAssets,
      unit: "百万円",
      isApproximate: false,
      isEstimated: false,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Notion 一次データアーカイブ (ルール6) の入力を組む純関数。
// **このモジュールは recordPrimaryData() を呼ばない** (Notion 書込は統合担当)。
// 戻り値は src/shared/notion-archive の RecordPrimaryDataInput と構造互換。
// ---------------------------------------------------------------------------

export interface PrimaryDataArchiveInput {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
}

const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function latestPeriodOf(rows: ReadonlyArray<{ period: string }>, context: string): string {
  if (rows.length === 0) {
    throw new Error(`${context}: rows が空です (アーカイブ入力を組めません)`);
  }
  let latest = rows[0]!.period;
  for (const r of rows) if (r.period > latest) latest = r.period;
  return latest;
}

/** B-1 の取得物を Notion 一次データ記録 (`recordPrimaryData`) 用の入力に変換する。 */
export function imajFundFlowsArchiveInput(params: {
  bytes: Uint8Array;
  url: string;
  rows: ReadonlyArray<ImajFundFlowRow>;
}): PrimaryDataArchiveInput {
  const latest = latestPeriodOf(params.rows, "imajFundFlowsArchiveInput");
  return {
    service: "moneyflow",
    key: `imaj-fund-flows-${latest}`,
    source: params.url,
    metadata: {
      latestPeriod: latest,
      rowCount: params.rows.length,
      categories: [...new Set(params.rows.map((r) => r.category))],
      bytes: params.bytes.byteLength,
    },
    files: [
      {
        bytes: params.bytes,
        filename: `imaj-fund-flows-${latest}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
      },
    ],
  };
}

/** D-1 の取得物を Notion 一次データ記録 (`recordPrimaryData`) 用の入力に変換する。 */
export function imajReitFlowsArchiveInput(params: {
  bytes: Uint8Array;
  url: string;
  rows: ReadonlyArray<ImajReitFlowRow>;
}): PrimaryDataArchiveInput {
  const latest = latestPeriodOf(params.rows, "imajReitFlowsArchiveInput");
  return {
    service: "moneyflow",
    key: `imaj-reit-flows-${latest}`,
    source: params.url,
    metadata: {
      latestPeriod: latest,
      rowCount: params.rows.length,
      bytes: params.bytes.byteLength,
    },
    files: [
      {
        bytes: params.bytes,
        filename: `imaj-reit-flows-${latest}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
      },
    ],
  };
}
