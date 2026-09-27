/**
 * 取得元: 日本暗号資産等取引業協会 (JVCEA) 会員統計情報「会員の暗号資産取引状況表（月次）」
 *
 * 一覧ページ: https://jvcea.or.jp/statistics/information/
 * 実ファイル例: https://jvcea.or.jp/cms2026/wp-content/uploads/2026/08/202607-KOUKAI-01-FINAL.pdf
 *   (ファイル名 "YYYYMM-KOUKAI-01-FINAL.pdf" の YYYYMM は、その cumulative
 *    ファイルが収録する最新月。2018年9月分から毎月1行ずつ追記される累積表で、
 *    ページを開くたびにファイル自体が最新のものへ差し替わる — 過去分の URL は
 *    残らない。よって「最新ファイルの URL」は一覧ページを都度パースして得る
 *    必要があり、月から逆算で組み立てられない。)
 *
 * PDF の実レイアウト (2026-09-27 実機確認、フィクスチャ参照) は 1〜2 ページ目が
 * 全会員合算の月次表 (本パーサの対象)、3〜8 ページ目が銘柄別 (BTC/XRP/ETH/…)
 * の保有状況表。今回のスコープ (現物取引高・証拠金取引建玉・預り資産・口座数)
 * はすべて 1〜2 ページ目の合算表でまかなえるため、3 ページ目以降 (銘柄別内訳)
 * は対象外とする (必要になれば別の取得元として追加する)。
 *
 * 列構成 (合算表、注1〜8 は PDF 本文の脚注): 年/月 に続けて 19 個の数値列。
 *   取引高:       現物取引(数量,金額) / 証拠金取引(数量,金額)
 *   利用者預託金残高: 暗号資産(数量,金額) / 金銭等(金額) / 合計(金額) / うち証拠金額(金額)
 *   証拠金取引建玉残高: 利用者残高 売建(数,額) / 買建(数,額) / 合計(数,額)
 *   利用者口座数:   全体(設定,稼働) / うち証拠金取引(設定,稼働)
 *
 * ルール1/ルール2 に基づく設計判断:
 *   - 「数量」列 (現物取引数量・証拠金取引数量・預託金の暗号資産数量・建玉数量)
 *     は、複数の暗号資産 (BTC/ETH/XRP/…) の「1通貨単位」をそのまま合算した値
 *     (ページ冒頭の注記 "数量＝各暗号資産における1通貨単位" のとおり)。
 *     異なる通貨の数量を単純加算しても経済的な意味を持たない (ビットコイン
 *     1枚とリップル1枚を足しても「暗号資産2」という意味のある量にはならない)。
 *     指標として意味を持たせられないため、JvceaCryptoRow には生値として残す
 *     (ソースの原文をそのまま保持する) が、JVCEA_CRYPTO_INDICATORS / 観測ログ
 *     変換 (jvceaCryptoRowToObservations) からは意図的に除外し、円建て
 *     (「金額」列) のみを指標として公開する。
 *   - 「暗号資産の預り資産増減」を価格変動抜きの推定純増減として出す設計
 *     (計画書 R3 の「推定」欄) は、時価データ (CoinGecko 等) との突合が前提
 *     であり本ファイル単体では行わない。ここでは JVCEA 公表値をそのまま
 *     (isEstimated=false) で返す。推定計算は別の取得元 (CoinGecko 等) と
 *     統合する工程の責務とする。
 */
import { extractText, getDocumentProxy } from "unpdf";

// 既存の JPX 系取得コード (src/shared/jpx/sectors.ts, services/vwap-analysis/lib/margin.ts)
// と同じブラウザ相当 UA 文字列。プロジェクト内に export された共有定数は無い
// (2026-09-27 時点、grep 確認済み) ため、既存箇所と同一の文字列をここでも直書きする。
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const STATISTICS_INFO_URL = "https://jvcea.or.jp/statistics/information/";

// ---------------------------------------------------------------------------
// (1) 最新ファイルの URL 解決
// ---------------------------------------------------------------------------

export interface JvceaCryptoLatestInfo {
  /** 最新の累積 PDF の URL (月ごとに変わる) */
  pdfUrl: string;
  /** その PDF が収録する最新月 (YYYY-MM)。ファイル名 "YYYYMM-KOUKAI-01-FINAL.pdf" 由来 */
  latestMonth: string;
}

/**
 * 統計情報ページの HTML から「会員統計 月次データ」累積 PDF の最新版 URL を得る。
 * 複数の "*-KOUKAI-01-FINAL.pdf" リンクが見つかった場合 (旧年度版アーカイブ等)
 * は、ファイル名の YYYYMM が最大のものを採る。
 *
 * @throws リンクが1件も見つからない場合 (様式変更の疑い)
 */
export function parseLatestJvceaCryptoPdfUrl(html: string): JvceaCryptoLatestInfo {
  const re = /https:\/\/jvcea\.or\.jp\/[^"'\s]*?(\d{6})-KOUKAI-01-FINAL\.pdf/g;
  const matches = [...html.matchAll(re)];
  if (matches.length === 0) {
    throw new Error(
      "JVCEA 統計情報ページ: 会員統計 月次データ (*-KOUKAI-01-FINAL.pdf) へのリンクが" +
        "見つかりません。様式が変わった可能性があります。"
    );
  }
  matches.sort((a, b) => a[1]!.localeCompare(b[1]!));
  const best = matches[matches.length - 1]!;
  const yyyymm = best[1]!;
  const month = Number(yyyymm.slice(4, 6));
  if (month < 1 || month > 12) {
    throw new Error(`JVCEA 統計情報ページ: ファイル名の月が不正です: ${yyyymm}`);
  }
  return {
    pdfUrl: best[0],
    latestMonth: `${yyyymm.slice(0, 4)}-${yyyymm.slice(4, 6)}`,
  };
}

/** 統計情報ページを取得し、最新の累積 PDF の URL と収録最新月を返す。 */
export async function fetchJvceaCryptoLatestInfo(): Promise<JvceaCryptoLatestInfo> {
  const res = await fetch(STATISTICS_INFO_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(
      `JVCEA 統計情報ページ HTTP エラー: ${res.status} ${res.statusText} (${STATISTICS_INFO_URL})`
    );
  }
  return parseLatestJvceaCryptoPdfUrl(await res.text());
}

// ---------------------------------------------------------------------------
// (2) PDF 本文 → 型付きレコードの純関数パーサ
// ---------------------------------------------------------------------------

export interface JvceaCryptoRow {
  /** 対象月 (YYYY-MM)。取引高は月間集計、残高・建玉・口座数は月末時点 (注7) */
  period: string;
  /** 現物取引 数量 (全暗号資産合算、参考値。単位混在につき指標化しない) */
  spotTurnoverQty: number;
  /** 現物取引 金額 (百万円、月間) */
  spotTurnoverJpy: number;
  /** 証拠金取引 数量 (取引高、全暗号資産合算、参考値) */
  marginTurnoverQty: number;
  /** 証拠金取引 金額 (取引高、百万円、月間) */
  marginTurnoverJpy: number;
  /** 利用者預託金残高 暗号資産 数量 (全暗号資産合算、参考値) */
  depositsCryptoQty: number;
  /** 利用者預託金残高 暗号資産 金額 (百万円、月末) */
  depositsCryptoJpy: number;
  /** 利用者預託金残高 金銭等 金額 (百万円、月末) */
  depositsCashJpy: number;
  /** 利用者預託金残高 合計 (暗号資産+金銭等、百万円、月末) */
  depositsTotalJpy: number;
  /** 利用者預託金残高 うち証拠金額 (百万円、月末) */
  depositsMarginJpy: number;
  /** 証拠金取引建玉残高 売建数 (全暗号資産合算、参考値) */
  marginPositionSellQty: number;
  /** 証拠金取引建玉残高 買建数 (全暗号資産合算、参考値) */
  marginPositionBuyQty: number;
  /** 証拠金取引建玉残高 数量合計 (参考値) */
  marginPositionTotalQty: number;
  /** 証拠金取引建玉残高 売建額 (百万円、月末) */
  marginPositionSellJpy: number;
  /** 証拠金取引建玉残高 買建額 (百万円、月末) */
  marginPositionBuyJpy: number;
  /** 証拠金取引建玉残高 金額合計 (百万円、月末) */
  marginPositionTotalJpy: number;
  /** 利用者口座数 全体 設定口座 (累計開設数、月末) */
  accountsTotalEstablished: number;
  /** 利用者口座数 全体 稼働口座 (当月に取引または残高がある口座数、月末) */
  accountsTotalActive: number;
  /** 利用者口座数 うち証拠金取引 設定口座 (全体口座数の内数、月末) */
  accountsMarginEstablished: number;
  /** 利用者口座数 うち証拠金取引 稼働口座 (全体口座数の内数、月末) */
  accountsMarginActive: number;
}

const NUM_FIELD_COUNT = 19;
const ROW_LINE_RE = /^(\d{4})\s+(\d{1,2})\s+(.*)$/;

function toInt(token: string, context: string): number {
  if (!/^\d{1,3}(,\d{3})*$/.test(token) && !/^\d+$/.test(token)) {
    throw new Error(
      `JVCEA 会員統計: 数値として解釈できないトークン "${token}" (${context})。` +
        "様式が変わった可能性があります。"
    );
  }
  const n = Number(token.replace(/,/g, ""));
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`JVCEA 会員統計: 想定範囲外の数値 "${token}" (${context})`);
  }
  return n;
}

function assertContiguousMonths(periods: string[]): void {
  const sorted = [...periods].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new Error("JVCEA 会員統計: 同一月が複数回出現しています (様式変更/重複抽出の疑い)");
  }
  for (let i = 1; i < sorted.length; i++) {
    const [py, pm] = sorted[i - 1]!.split("-").map(Number) as [number, number];
    const [cy, cm] = sorted[i]!.split("-").map(Number) as [number, number];
    const expMonth = pm === 12 ? 1 : pm + 1;
    const expYear = pm === 12 ? py + 1 : py;
    if (cy !== expYear || cm !== expMonth) {
      throw new Error(
        `JVCEA 会員統計: 月次系列が連続していません (${sorted[i - 1]} の次が ${sorted[i]})。` +
          "抽出漏れ・様式変更の可能性があります。"
      );
    }
  }
}

/**
 * unpdf `extractText({ mergePages: false })` が返す 1 ページ分ずつのテキスト配列
 * (会員統計 月次データ PDF の 1〜2 ページ目相当) から、合算表を型付きレコードへ
 * 変換する純関数。
 *
 * @throws 想定した列数 (19) に合わない行がある、数値として解釈できないトークン
 *   がある、月が重複・不連続である場合。様式変更を暗黙のデフォルト値で
 *   吸収せず、必ず失敗させる (ルール2)。
 */
export function parseJvceaCryptoText(pageTexts: string[]): JvceaCryptoRow[] {
  const rows: JvceaCryptoRow[] = [];
  for (const pageText of pageTexts) {
    for (const line of pageText.split("\n")) {
      const m = ROW_LINE_RE.exec(line.trim());
      if (!m) continue;
      const month = Number(m[2]);
      if (month < 1 || month > 12) continue; // 表内の行ではない (脚注等)
      const year = Number(m[1]);
      const rest = m[3]!.trim();
      if (rest.length === 0) continue;
      const tokens = rest.split(/\s+/);
      if (tokens.length !== NUM_FIELD_COUNT) {
        throw new Error(
          `JVCEA 会員統計: 行の数値列数が想定 (${NUM_FIELD_COUNT}) と異なります ` +
            `(実際 ${tokens.length}): "${line.trim()}"`
        );
      }
      const period = `${year}-${String(month).padStart(2, "0")}`;
      const ctx = (label: string) => `${period} ${label}`;
      const v = tokens.map((t, i) => toInt(t!, ctx(`列${i}`)));
      rows.push({
        period,
        spotTurnoverQty: v[0]!,
        spotTurnoverJpy: v[1]!,
        marginTurnoverQty: v[2]!,
        marginTurnoverJpy: v[3]!,
        depositsCryptoQty: v[4]!,
        depositsCryptoJpy: v[5]!,
        depositsCashJpy: v[6]!,
        depositsTotalJpy: v[7]!,
        depositsMarginJpy: v[8]!,
        marginPositionSellQty: v[9]!,
        marginPositionBuyQty: v[10]!,
        marginPositionTotalQty: v[11]!,
        marginPositionSellJpy: v[12]!,
        marginPositionBuyJpy: v[13]!,
        marginPositionTotalJpy: v[14]!,
        accountsTotalEstablished: v[15]!,
        accountsTotalActive: v[16]!,
        accountsMarginEstablished: v[17]!,
        accountsMarginActive: v[18]!,
      });
    }
  }
  if (rows.length === 0) {
    throw new Error("JVCEA 会員統計: 表の行が1件も抽出できませんでした (様式変更の疑い)");
  }
  assertContiguousMonths(rows.map((r) => r.period));
  return rows;
}

// ---------------------------------------------------------------------------
// 期間の判定 (月次・「まだ公表されていない」)
// ---------------------------------------------------------------------------

/** この取得元の公表頻度。月次のみ (週次・四半期・年次の系列は無い)。 */
export const JVCEA_CRYPTO_FREQUENCY = "monthly" as const;

/**
 * 対象月が既に公表済みかどうかを判定する。
 *
 * 「翌月に公表」とだけ分かっていて具体的な公表日は一次情報に明記が無いため
 * (2026-09-27 時点の調査で latency は "翌月に公表" 止まり)、カレンダーからの
 * 憶測 (例:「翌月5日には出ているはず」) はしない (ルール2)。必ず
 * `fetchJvceaCryptoLatestInfo()` で実際にサイトが収録している最新月を取得し、
 * それと比較することでのみ判定する。
 */
export function isJvceaCryptoMonthPublished(
  targetMonth: string,
  latestAvailableMonth: string
): boolean {
  if (!/^\d{4}-\d{2}$/.test(targetMonth) || !/^\d{4}-\d{2}$/.test(latestAvailableMonth)) {
    throw new Error("JVCEA 会員統計: period は YYYY-MM 形式で指定してください");
  }
  return targetMonth <= latestAvailableMonth;
}

// ---------------------------------------------------------------------------
// (1)+(2) 結合: 取得
// ---------------------------------------------------------------------------

export interface JvceaCryptoData {
  /** 取得した PDF が収録する最新月 (YYYY-MM) */
  latestMonth: string;
  rows: JvceaCryptoRow[];
  /** 取得した PDF の実体 (ルール6: Notion 一次データへの実体アップロード用) */
  pdfBytes: Uint8Array;
  /** 取得元 PDF の URL (来歴用、月ごとに変わる) */
  pdfUrl: string;
}

/**
 * 統計情報ページから最新の累積 PDF の URL を解決し、実際に取得・解析する。
 * JPX 系取得元と同様、1 回の実行で「一覧ページ 1 回 + PDF 1 回」の計 2 リクエスト
 * のみに抑える (高頻度アクセスを避ける)。
 *
 * @throws HTTP エラー、PDF 解析失敗、または統計情報ページの示す最新月が
 *   PDF 本文中に見つからない場合 (URL とファイル内容の不整合)
 */
export async function fetchJvceaCrypto(): Promise<JvceaCryptoData> {
  const { pdfUrl, latestMonth } = await fetchJvceaCryptoLatestInfo();
  const res = await fetch(pdfUrl, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`JVCEA 会員統計 PDF HTTP エラー: ${res.status} ${res.statusText} (${pdfUrl})`);
  }
  const pdfBytes = new Uint8Array(await res.arrayBuffer());
  const pdf = await getDocumentProxy(pdfBytes);
  const { text } = await extractText(pdf, { mergePages: false });
  const rows = parseJvceaCryptoText(text);
  if (!rows.some((r) => r.period === latestMonth)) {
    throw new Error(
      `JVCEA 会員統計: 統計情報ページが示す最新月 ${latestMonth} の行が PDF 本文に` +
        "見つかりません (URL とファイル内容の不整合の可能性)。"
    );
  }
  return { latestMonth, rows, pdfBytes, pdfUrl };
}

// ---------------------------------------------------------------------------
// (4) 指標定義
// ---------------------------------------------------------------------------

/** 資金フロー計画書 (docs/moneyflow.md 予定) が定める指標分類の語彙。 */
export type MoneyflowFlowType =
  | "net_flow"
  | "gross_turnover"
  | "holdings_stock"
  | "positions"
  | "fund_flow"
  | "estimated"
  | "price_only";

export interface MoneyflowIndicatorDef {
  key: string;
  displayName: string;
  /** この指標が支える要件 (計画書の R1〜R4) */
  requirements: string[];
  flowType: MoneyflowFlowType;
  /** 何を測るか (正確な定義。噛み砕きと引き換えに誤らないこと) */
  measures: string;
  /** 平易な日本語 1〜3 文 + 具体例 (ルール7の粒度に合わせる) */
  plainDescription: string;
  unit: string;
  sourceUrl: string;
  usageTerms: string;
  frequency: string;
  limitations: string;
}

const JVCEA_SOURCE_URL = STATISTICS_INFO_URL;
const JVCEA_USAGE_TERMS =
  "JVCEA サイト利用規約に商用利用可否の明記なし (2026-09-27 調査時点 unknown)。" +
  "本プロジェクトは個人利用・非公開の範囲に限定する運用のため追加の許諾確認は" +
  "行っていないが、公開・商用転用する場合は JVCEA へ利用可否を確認すること。";
const JVCEA_LIMITATIONS_COMMON =
  "会員 (登録暗号資産交換業者) の合算値であり、個社別の内訳は非公表。" +
  "一部会員の都合により当該会員のデータを除いた月がある (脚注記載)。" +
  "他の交換業者等への取次ぎを行った利用者取引分を含むため、最終投資家ベースの" +
  "実額より大きく出うる (取引高の二重計上の可能性)。";

export const JVCEA_CRYPTO_INDICATORS: MoneyflowIndicatorDef[] = [
  {
    key: "jvcea_crypto_spot_turnover_jpy",
    displayName: "暗号資産 現物取引高（月間）",
    requirements: ["R3"],
    flowType: "gross_turnover",
    measures:
      "国内の暗号資産交換業者 (JVCEA会員) 合算の、現物取引 (暗号資産の現物売買) の" +
      "月間取引金額 (円建て)。買い方向・売り方向を合算した総取引額 (グロス) であり、" +
      "資金の純増減 (買い越し/売り越し) を表すものではない。",
    plainDescription:
      "1か月の間に、暗号資産取引所で現物 (実物のビットコインなど) がいくら分売買" +
      "されたかの合計額。売った分も買った分も両方足すので、「増えた/減った」の意味" +
      "にはならない (例: 2026年7月は約6,742億円=674,240百万円)。",
    unit: "百万円",
    sourceUrl: JVCEA_SOURCE_URL,
    usageTerms: JVCEA_USAGE_TERMS,
    frequency: "月次",
    limitations: JVCEA_LIMITATIONS_COMMON,
  },
  {
    key: "jvcea_crypto_margin_turnover_jpy",
    displayName: "暗号資産 証拠金取引高（月間）",
    requirements: ["R3"],
    flowType: "gross_turnover",
    measures:
      "JVCEA会員合算の、証拠金取引 (レバレッジをかけた暗号資産取引) の月間取引金額" +
      "(円建て、買い方向・売り方向の合算=グロス)。",
    plainDescription:
      "1か月の間に、証拠金取引 (レバレッジをかけた取引) でいくら分売買されたかの" +
      "合計額。現物取引高と同じく総額(グロス)で、純粋な資金の増減ではない。",
    unit: "百万円",
    sourceUrl: JVCEA_SOURCE_URL,
    usageTerms: JVCEA_USAGE_TERMS,
    frequency: "月次",
    limitations: JVCEA_LIMITATIONS_COMMON,
  },
  {
    key: "jvcea_crypto_deposits_crypto_jpy",
    displayName: "暗号資産 預り資産残高（暗号資産、月末）",
    requirements: ["R3"],
    flowType: "holdings_stock",
    measures:
      "月末時点でJVCEA会員に利用者が預託している暗号資産の評価額 (円建て、残高=ストック)。" +
      "時価評価額であり、価格変動によっても増減するため、資金の入出金だけを表す" +
      "指標ではない。",
    plainDescription:
      "月末時点で、みんなが暗号資産取引所に預けている暗号資産(コイン)の合計金額。" +
      "コインの値段が上がっただけでも増えるので、「新しくお金が入ってきた」とは" +
      "限らない (残高であって入出金額ではない)。",
    unit: "百万円",
    sourceUrl: JVCEA_SOURCE_URL,
    usageTerms: JVCEA_USAGE_TERMS,
    frequency: "月次",
    limitations:
      JVCEA_LIMITATIONS_COMMON +
      " 価格変動と資金の入出金を切り分けた「推定純増減」は本指標には含まれない" +
      "(別途、時価データとの突合が必要)。",
  },
  {
    key: "jvcea_crypto_deposits_cash_jpy",
    displayName: "暗号資産 預り資産残高（金銭等、月末）",
    requirements: ["R3"],
    flowType: "holdings_stock",
    measures: "月末時点でJVCEA会員に利用者が預託している金銭等 (日本円など) の残高。",
    plainDescription:
      "月末時点で、みんなが暗号資産取引所に預けている日本円などの現金の合計額。",
    unit: "百万円",
    sourceUrl: JVCEA_SOURCE_URL,
    usageTerms: JVCEA_USAGE_TERMS,
    frequency: "月次",
    limitations: JVCEA_LIMITATIONS_COMMON,
  },
  {
    key: "jvcea_crypto_deposits_total_jpy",
    displayName: "暗号資産 預り資産残高（合計、月末）",
    requirements: ["R3"],
    flowType: "holdings_stock",
    measures: "月末時点の利用者預託金残高の合計 (暗号資産+金銭等、円建て)。",
    plainDescription: "暗号資産と現金、両方合わせて取引所に預けている資産の合計額。",
    unit: "百万円",
    sourceUrl: JVCEA_SOURCE_URL,
    usageTerms: JVCEA_USAGE_TERMS,
    frequency: "月次",
    limitations: JVCEA_LIMITATIONS_COMMON,
  },
  {
    key: "jvcea_crypto_deposits_margin_jpy",
    displayName: "暗号資産 預り資産残高（うち証拠金、月末）",
    requirements: ["R3"],
    flowType: "holdings_stock",
    measures: "利用者預託金残高のうち、証拠金取引の担保に充当されている金額 (全体の内数)。",
    plainDescription: "預けている資産のうち、レバレッジ取引の担保として使われている分。",
    unit: "百万円",
    sourceUrl: JVCEA_SOURCE_URL,
    usageTerms: JVCEA_USAGE_TERMS,
    frequency: "月次",
    limitations: JVCEA_LIMITATIONS_COMMON,
  },
  {
    key: "jvcea_crypto_margin_position_sell_jpy",
    displayName: "暗号資産 証拠金取引建玉（売建、月末）",
    requirements: ["R3"],
    flowType: "positions",
    measures:
      "月末時点でJVCEA会員合算の証拠金取引における未決済ポジション (建玉) のうち" +
      "売建 (ショート) の評価額。",
    plainDescription:
      "証拠金取引で、まだ決済していない「売り」の持ち高(ポジション)の評価額。" +
      "下落を見込んだ持ち高の大きさの目安。",
    unit: "百万円",
    sourceUrl: JVCEA_SOURCE_URL,
    usageTerms: JVCEA_USAGE_TERMS,
    frequency: "月次",
    limitations: JVCEA_LIMITATIONS_COMMON,
  },
  {
    key: "jvcea_crypto_margin_position_buy_jpy",
    displayName: "暗号資産 証拠金取引建玉（買建、月末）",
    requirements: ["R3"],
    flowType: "positions",
    measures:
      "月末時点でJVCEA会員合算の証拠金取引における未決済ポジション (建玉) のうち" +
      "買建 (ロング) の評価額。",
    plainDescription:
      "証拠金取引で、まだ決済していない「買い」の持ち高(ポジション)の評価額。" +
      "上昇を見込んだ持ち高の大きさの目安。",
    unit: "百万円",
    sourceUrl: JVCEA_SOURCE_URL,
    usageTerms: JVCEA_USAGE_TERMS,
    frequency: "月次",
    limitations: JVCEA_LIMITATIONS_COMMON,
  },
  {
    key: "jvcea_crypto_margin_position_total_jpy",
    displayName: "暗号資産 証拠金取引建玉（合計、月末）",
    requirements: ["R3"],
    flowType: "positions",
    measures: "月末時点の証拠金取引建玉残高の合計 (売建+買建、評価額)。",
    plainDescription:
      "証拠金取引の「売り」と「買い」の持ち高を合わせた合計評価額。市場全体の" +
      "レバレッジ利用度合いの目安。",
    unit: "百万円",
    sourceUrl: JVCEA_SOURCE_URL,
    usageTerms: JVCEA_USAGE_TERMS,
    frequency: "月次",
    limitations: JVCEA_LIMITATIONS_COMMON,
  },
  {
    key: "jvcea_crypto_accounts_total_established",
    displayName: "暗号資産 利用者口座数（全体・設定口座、月末）",
    requirements: ["R3"],
    flowType: "holdings_stock",
    measures:
      "月末時点でJVCEA会員合算の、これまでに開設された利用者口座の累計数 (全体)。" +
      "解約されても数は減らない累計値。",
    plainDescription: "これまでに開設された口座の累計数。途中でやめても数は減らない。",
    unit: "口座",
    sourceUrl: JVCEA_SOURCE_URL,
    usageTerms: JVCEA_USAGE_TERMS,
    frequency: "月次",
    limitations: JVCEA_LIMITATIONS_COMMON,
  },
  {
    key: "jvcea_crypto_accounts_total_active",
    displayName: "暗号資産 利用者口座数（全体・稼働口座、月末）",
    requirements: ["R3"],
    flowType: "holdings_stock",
    measures: "当月に取引が行われた口座、または残高を有する口座の数 (全体)。",
    plainDescription: "その月に実際に取引したか、残高が残っている口座の数。",
    unit: "口座",
    sourceUrl: JVCEA_SOURCE_URL,
    usageTerms: JVCEA_USAGE_TERMS,
    frequency: "月次",
    limitations: JVCEA_LIMITATIONS_COMMON,
  },
  {
    key: "jvcea_crypto_accounts_margin_established",
    displayName: "暗号資産 利用者口座数（うち証拠金取引・設定口座、月末）",
    requirements: ["R3"],
    flowType: "holdings_stock",
    measures:
      "全体の設定口座数のうち、証拠金取引を行う口座の累計数 (内数。現物取引・" +
      "証拠金取引共用口座も含む)。",
    plainDescription: "開設された口座のうち、証拠金取引(レバレッジ取引)ができる口座の数。",
    unit: "口座",
    sourceUrl: JVCEA_SOURCE_URL,
    usageTerms: JVCEA_USAGE_TERMS,
    frequency: "月次",
    limitations: JVCEA_LIMITATIONS_COMMON,
  },
  {
    key: "jvcea_crypto_accounts_margin_active",
    displayName: "暗号資産 利用者口座数（うち証拠金取引・稼働口座、月末）",
    requirements: ["R3"],
    flowType: "holdings_stock",
    measures: "全体の稼働口座数のうち、当月に証拠金取引を行った、または残高を有する口座の数。",
    plainDescription: "その月に証拠金取引(レバレッジ取引)を実際に使った口座の数。",
    unit: "口座",
    sourceUrl: JVCEA_SOURCE_URL,
    usageTerms: JVCEA_USAGE_TERMS,
    frequency: "月次",
    limitations: JVCEA_LIMITATIONS_COMMON,
  },
];

// ---------------------------------------------------------------------------
// 観測ログ (縦長) への変換
// ---------------------------------------------------------------------------

export interface MoneyflowObservation {
  /** 対象期間 (YYYY-MM) */
  period: string;
  /** JVCEA_CRYPTO_INDICATORS の key と対応 */
  indicatorKey: string;
  /** 区分 (資産クラス等)。この取得元は銘柄別内訳を持たないため一定値 */
  category: string;
  value: number;
  unit: string;
  /** 近似値か。このソースは JVCEA 公表値をそのまま用いるため常に false */
  isApproximate: boolean;
  /** 推定値か。価格変動除去等のモデル推定はここでは行わないため常に false */
  isEstimated: boolean;
}

/** 観測ログの「区分」列に使う値 (この取得元は資産クラス=暗号資産の単一区分)。 */
export const JVCEA_CRYPTO_CATEGORY = "資産クラス｜暗号資産";

/**
 * 1 か月分の行を、観測ログ (縦長) の入力レコード群に変換する純関数。
 * 数量列 (単位混在で指標化しない、ファイル冒頭のコメント参照) は含めない。
 */
export function jvceaCryptoRowToObservations(row: JvceaCryptoRow): MoneyflowObservation[] {
  const base = {
    period: row.period,
    category: JVCEA_CRYPTO_CATEGORY,
    isApproximate: false,
    isEstimated: false,
  };
  return [
    { ...base, indicatorKey: "jvcea_crypto_spot_turnover_jpy", value: row.spotTurnoverJpy, unit: "百万円" },
    { ...base, indicatorKey: "jvcea_crypto_margin_turnover_jpy", value: row.marginTurnoverJpy, unit: "百万円" },
    { ...base, indicatorKey: "jvcea_crypto_deposits_crypto_jpy", value: row.depositsCryptoJpy, unit: "百万円" },
    { ...base, indicatorKey: "jvcea_crypto_deposits_cash_jpy", value: row.depositsCashJpy, unit: "百万円" },
    { ...base, indicatorKey: "jvcea_crypto_deposits_total_jpy", value: row.depositsTotalJpy, unit: "百万円" },
    { ...base, indicatorKey: "jvcea_crypto_deposits_margin_jpy", value: row.depositsMarginJpy, unit: "百万円" },
    {
      ...base,
      indicatorKey: "jvcea_crypto_margin_position_sell_jpy",
      value: row.marginPositionSellJpy,
      unit: "百万円",
    },
    {
      ...base,
      indicatorKey: "jvcea_crypto_margin_position_buy_jpy",
      value: row.marginPositionBuyJpy,
      unit: "百万円",
    },
    {
      ...base,
      indicatorKey: "jvcea_crypto_margin_position_total_jpy",
      value: row.marginPositionTotalJpy,
      unit: "百万円",
    },
    {
      ...base,
      indicatorKey: "jvcea_crypto_accounts_total_established",
      value: row.accountsTotalEstablished,
      unit: "口座",
    },
    {
      ...base,
      indicatorKey: "jvcea_crypto_accounts_total_active",
      value: row.accountsTotalActive,
      unit: "口座",
    },
    {
      ...base,
      indicatorKey: "jvcea_crypto_accounts_margin_established",
      value: row.accountsMarginEstablished,
      unit: "口座",
    },
    {
      ...base,
      indicatorKey: "jvcea_crypto_accounts_margin_active",
      value: row.accountsMarginActive,
      unit: "口座",
    },
  ];
}

// ---------------------------------------------------------------------------
// ルール6: Notion 一次データ記録の入力を組み立てる純関数 (記録の実行自体はしない)
// ---------------------------------------------------------------------------

/**
 * 統合担当が `recordPrimaryData()` (src/shared/notion-archive/archive.ts) を
 * 呼ぶ際の入力を組み立てる純関数。本ファイルは Notion への書込を行わない。
 *
 * 冪等キーは月次 (累積ファイルが指す最新月単位)。ファイル自体は毎月differentな
 * URL に置き換わる累積表だが、アーカイブの単位は「その月の版」で十分。
 */
export function jvceaCryptoArchiveInput(data: JvceaCryptoData): {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
} {
  return {
    service: "moneyflow",
    key: `jvcea-crypto-${data.latestMonth}`,
    source: data.pdfUrl,
    metadata: {
      latestMonth: data.latestMonth,
      rowCount: data.rows.length,
      bytes: data.pdfBytes.byteLength,
    },
    files: [
      {
        bytes: data.pdfBytes,
        filename: `jvcea-crypto-${data.latestMonth}.pdf`,
        contentType: "application/pdf",
      },
    ],
  };
}
