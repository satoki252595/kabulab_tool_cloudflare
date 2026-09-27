/**
 * 取得元: 日本証券業協会 (JSDA) の公社債統計。
 *
 * moneyflow「資金フロー」計画 (R2: 株以外の上場・公募金融商品) のうち
 * 「公社債の発行・償還」を担当する。当初のタスク定義には「公社債投資家別
 * 売買高（月次 xlsx）」も含まれていたが、実地確認 (2026-09-27) の結果、
 * 以下が判明した。
 *
 * ## 実地確認で判明した事実 (ルール1: 架空値を混ぜない)
 *
 * (A) 公社債発行額・償還額 — 生きている
 *   https://www.jsda.or.jp/shiryoshitsu/toukei/hakkou/index.html を実際に
 *   取得 (2026-09-27、HTTP 200) すると、"公社債発行額・償還額（2026年7月分
 *   更新）"（掲載日：2026.9.10）へのリンク (hakkougakushoukanngaku.xlsx) が
 *   確認できた。月次で現在も更新が続いている。
 *
 * (B) 公社債投資家別売買高 — 2018年6月に公表体系が変わり、この名前では
 *     終了している
 *   https://www.jsda.or.jp/shiryoshitsu/toukei/toushika/index.html を実際に
 *   取得 (2026-09-27、HTTP 200) すると、実データの .xls ファイル
 *   (koushasai1804.xls / koushasaiichiran.xls) と「国債投資家別売買高」ページ
 *   の「最終更新日」が全て 2018.5.21 だった (解説 PDF 等の付随資料は
 *   2015.8.20 / 2016.3.22 でさらに古い)。ページ本文には
 *   「公社債店頭取引に係る発表様式の再編等について」という説明があり、
 *   平成30年6月発表分(平成30年5月取引分)から発表様式が再編され、
 *     ① 公社債店頭売買高 (投資家部門別の内訳なし。公社債種類別のみ)
 *        /shiryoshitsu/toukei/tentoubaibai/index.html
 *     ② 投資家別条件付売買(現先)月末残高 (投資家部門別だが「現先」の
 *        月末残高。現物の売買高そのものではない)
 *        /shiryoshitsu/toukei/jyouken/index.html
 *   の2系列に分かれたことが明記されている。つまり「投資家部門別 × 現物
 *   売買高」という元の粒度は、今日ではどちらの後継ページにも存在しない。
 *   2018年5月で止まった数値を「今月のデータ」として扱うのはルール1違反、
 *   後継URLへ黙って読み替えるのはルール2違反になるため、本モジュールは
 *   `investorTurnoverStatus()` で「終了している」という事実そのものを型で
 *   返す (呼び出し側が後継統計を別途評価する判断材料にする)。
 *
 * ## このモジュールが提供するもの
 *   1. `resolveLatestIssuanceRedemption()` — 一覧ページから最新ファイルの
 *      URL・対象月・掲載日を解決する (実ページ HTML で検証済み)。
 *   2. `parseIssuanceRedemptionWorkbook()` — 取得した xlsx から型付き
 *      レコードを返す純関数パーサ。
 *   3. `issuanceRedemptionPublicationStatus()` / `investorTurnoverStatus()`
 *      — 期間の「まだ公表されていない」判定と、(B)の「終了している」判定。
 *   4. `JSDA_BONDS_INDICATORS` — 指標定義 (キー・要件・何を測るか・出典・
 *      利用条件・頻度・限界)。
 *   5. `toIssuanceRedemptionObservations()` — 観測ログ用の縦長レコードへの
 *      変換。
 *
 * ## 取得のふるまい (ルール2)
 * JSDA は Retry-After を返さない 429 (nginx `limit_req` 相当) を頻発させる
 * ことを実地検証で確認した — 60秒→120秒→240秒 (計7分) の通常バックオフでは
 * 解消せず、ブラウザ相当ヘッダを足しても・Anthropic の別経路 (WebFetch) から
 * 叩いても同じ 429 が返った。10分待ってからの再試行でようやく 200 が返り、
 * xlsx 実体を取得できた (フィクスチャはこの実体そのもの)。ブロックが長時間
 * 続きうる前提で、既定のバックオフは長め・少回数にし、使い切ったら「今日は
 * 取得できなかった」を明示的に throw する (呼び出し側 = 統合スクリプトが
 * 翌日の cron 実行へ持ち越す設計を前提。無効値で埋めて続行しない)。
 */

import * as XLSX from "xlsx";

/** ブラウザ相当 UA。JPX (`services/vwap-analysis/lib/margin.ts`) と同じ文字列を使う。 */
export const JSDA_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export const JSDA_HAKKOU_PAGE_URL =
  "https://www.jsda.or.jp/shiryoshitsu/toukei/hakkou/index.html";
export const JSDA_TOUSHIKA_PAGE_URL =
  "https://www.jsda.or.jp/shiryoshitsu/toukei/toushika/index.html";
/** 実地確認 (2026-09-27) で判明した (B) の後継ページ。実ファイルは未取得。 */
export const JSDA_TENTOUBAIBAI_PAGE_URL =
  "https://www.jsda.or.jp/shiryoshitsu/toukei/tentoubaibai/index.html";
export const JSDA_JYOUKEN_PAGE_URL =
  "https://www.jsda.or.jp/shiryoshitsu/toukei/jyouken/index.html";

/**
 * 429 の長時間ブロックを前提にした長めのバックオフ (ミリ秒)。
 * Notion クライアント (`notion-archive/client.ts`) の上限 30 秒より意図的に
 * 長い — 実測で 60/120/240 秒バックオフしても解消しなかったため。
 */
export const JSDA_BACKOFF_MS = [30_000, 90_000, 240_000];

/** JSDA からの取得を長めのバックオフで再試行する。恒久失敗 (404 等) は即 throw。 */
export async function fetchFromJsda(
  url: string,
  init: RequestInit,
  label: string,
  backoffMs: number[] = JSDA_BACKOFF_MS
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    // 429/5xx は一過性として再試行。それ以外 (404 等) は様式変更等の恒久
    // 失敗の疑いが強いので、リトライで直る見込みが薄く即 throw する。
    if (res.status !== 429 && res.status < 500) {
      throw new Error(
        `JSDA ${label}: HTTP ${res.status} ${res.statusText} (${url})`
      );
    }
    if (attempt >= backoffMs.length) {
      throw new Error(
        `JSDA ${label}: ${backoffMs.length} 回のバックオフ (合計 ${
          backoffMs.reduce((a, b) => a + b, 0) / 1000
        } 秒) 後も HTTP ${res.status} (${url})。JSDA は Retry-After を返さない` +
          `ことが多く、ブロックが長時間続く場合がある。今回は取得を諦め、次回の` +
          `スケジュール実行に委ねる (欠損は欠損のまま扱い、無効値で埋めない)。`
      );
    }
    // Retry-After は「秒数 (非負整数)」形式のときだけ採用する。Number() は
    // 空文字を 0、"-30" を負数として通してしまい、待たずに即再試行して
    // バックオフ回数を数ミリ秒で使い切る (レート制限中の JSDA を連打する)。
    // HTTP-date 形式・空・負数などは解釈せず、予定どおりのバックオフで待つ。
    const header = res.headers.get("Retry-After")?.trim();
    const waitMs =
      header !== undefined && /^\d+$/.test(header)
        ? Number(header) * 1000 + 500
        : backoffMs[attempt];
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

// ---------------------------------------------------------------------------
// (A) 公社債発行額・償還額
// ---------------------------------------------------------------------------

export interface JsdaIssuanceRedemptionLatest {
  /** 対象月 (YYYY-MM)。ファイル内表記「YYYY年M月分更新」を正規化した値。 */
  periodMonth: string;
  /** JSDA 掲載日 (YYYY-MM-DD)。ページ表記「YYYY.M.D」を正規化した値。 */
  publishedOn: string;
  /** 実ファイルの絶対 URL (相対 href をページ URL基準で解決済み) */
  fileUrl: string;
  /** href に書かれたファイル名そのまま (Notion アーカイブのファイル名に使う) */
  filename: string;
}

// 実ページ (2026-09-27 取得, fixtures/jsda-hakkou-index-2026-09-27.html) の
// 該当行を最小限一般化した正規表現。年月・掲載日の部分だけを可変にする。
// リンク終端から掲載日までの間は別の <a> をまたがない — 最新リンク自体の
// 掲載日表記が消えた場合に、後続の旧ファイル (2019年3月分まで等) の掲載日を
// 最新ファイルの掲載日として黙って借用しないため (ルール2)。
const HAKKOU_LINK_RE =
  /<a href="([^"]+\.xlsx)">\s*<span[^>]*>\s*公社債発行額・償還額（(\d{4})年(\d{1,2})月分更新）\s*<\/span>\s*<\/a>(?:(?!<a\s)[\s\S]){0,300}?（掲載日：(\d{4})\.(\d{1,2})\.(\d{1,2})）/;

/** 一覧ページ HTML から最新ファイルの URL・対象月・掲載日を解決する純関数。 */
export function parseHakkouIndexHtml(
  html: string,
  pageUrl: string = JSDA_HAKKOU_PAGE_URL
): JsdaIssuanceRedemptionLatest {
  const m = html.match(HAKKOU_LINK_RE);
  if (!m) {
    throw new Error(
      "JSDA 公社債発行額・償還額: 一覧ページの様式が変わり、最新ファイルへの" +
        "リンクを認識できません。パーサ (HAKKOU_LINK_RE) の見直しが必要です。"
    );
  }
  const [, href, year, month, py, pm, pd] = m;
  const fileUrl = new URL(href, pageUrl).toString();
  return {
    periodMonth: `${year}-${month.padStart(2, "0")}`,
    publishedOn: `${py}-${pm.padStart(2, "0")}-${pd.padStart(2, "0")}`,
    fileUrl,
    filename: href,
  };
}

/** 一覧ページを取得し、最新ファイルの所在を解決する。 */
export async function resolveLatestIssuanceRedemption(): Promise<JsdaIssuanceRedemptionLatest> {
  const res = await fetchFromJsda(
    JSDA_HAKKOU_PAGE_URL,
    { headers: { "User-Agent": JSDA_UA } },
    "公社債発行額・償還額 一覧ページ"
  );
  return parseHakkouIndexHtml(await res.text());
}

/** 公社債種類 (国債/地方債/普通社債 等) 別の発行額・償還額 1 行。 */
export interface JsdaBondFlowRow {
  /** 公社債種類 (シート/表の見出しそのまま。正準化はしない = ルール1) */
  bondType: string;
  /** 発行額 (円)。シート内で検出した単位表記 (円/千円/百万円/億円) を円に換算済み。 */
  issuance: number;
  /** 償還額 (円)。同上。 */
  redemption: number;
}

/** シートの単位表記 → 円への倍率。検出できない単位は捏造を避けるため throw する。 */
const UNIT_MULTIPLIERS: Record<string, number> = {
  円: 1,
  千円: 1_000,
  百万円: 1_000_000,
  億円: 100_000_000,
};

/**
 * グリッド中から「単位：百万円」等の表記を探し、円への倍率を返す。
 *
 * 発行額・償還額は 2019年4月分より一般債がほふり統計ベースに切り替わり
 * 「単位が千円から百万円に変更」されたことが判明している (取得元インベントリ
 * より)。単位を決め打ちせず毎回シート自身から読み取ることで、将来また単位が
 * 変わっても無効な換算で数値を捏造しない (ルール1/ルール2)。
 */
function detectUnitMultiplier(grid: unknown[][]): { label: string; multiplier: number } {
  for (const row of grid) {
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      const m = String(cell).match(/単位[:：]?\s*(円|千円|百万円|億円)/);
      if (m) {
        const label = m[1]!;
        return { label, multiplier: UNIT_MULTIPLIERS[label]! };
      }
    }
  }
  throw new Error(
    "JSDA 公社債発行額・償還額 xlsx: 単位(円/千円/百万円/億円)の表記が見つかりません。" +
      "単位を決め打ちして円に換算すると値を捏造することになるため、明示的に失敗させます。"
  );
}

export interface JsdaIssuanceRedemptionData extends JsdaIssuanceRedemptionLatest {
  rows: JsdaBondFlowRow[];
  /** 取得した xlsx の実体 (ルール6: Notion 一次データへの実体アップロード用) */
  bytes: Uint8Array;
}

/**
 * 実ファイルの構造 (2026-09-27 に実際に取得した
 * fixtures/jsda-hakkou-2026-07.xlsx で確認済み。CLAUDE.md ルール1: 架空の
 * 構造を書かない)。
 *
 *   - ワークブックはシート 1 枚 = 公社債 1 種類 (「合計（Total）」「国債
 *     （JGB）」「地方債」「政保債」「財投機関債等」「普通社債」
 *     「資産担保型社債」「転換社債（CB）」「金融債」「非居住者債」の10枚)。
 *     「種類」を表す列は無い — シート名そのものが区分になる。
 *   - 各シートは横に複数ブロック (その種類の合計 / 内訳) が並ぶワイド表で、
 *     2行目 (0始まり) がブロック見出し行 (「発 行 額\nIssue」「償還額内訳
 *     \nRedemption」「合計(b)\nTotal」等)、3行目が列見出し行 (「金額(a)
 *     \nAmount of Issued」等)。最左のブロックがその種類全体の合計であり、
 *     これだけを読む。
 *   - ブロック幅は一定ではない。「転換社債（CB）」「非居住者債」シートは
 *     「転換額」列が挟まるため合計(b)列が1つ右にずれる (発行額(a)列は
 *     全シートで列2固定)。よって列位置を決め打ちにせず、2行目で「合計(b)」を、
 *     3行目で「金額(a)」を含むセルを探して列位置を決める。
 *     (実データでの裏取り: 9種類の発行額の合計が「合計（Total）」シートの
 *     発行額と一致し、償還額も同様に一致することを 2026年7月分で確認した。
 *     2026-09-27 の再検証で、2019.04〜2026.07 の全88か月×10シートの
 *     発行額・償還額を openpyxl で独立に読んだ値とも全て一致した。)
 *   - 行は「【年中】」(年次)・「【月中】」(月次) の順に並び、月次行のラベルは
 *     "YYYY.MM" (例 "2026.07")。ファイルは将来月のラベル行もあらかじめ
 *     用意されており、値セルが空文字か "0" かはシートによって不統一
 *     (「国債」は空文字、「金融債」「非居住者債」「合計」は "0" を先埋め
 *     している実測差異あり)。この不統一のため、値の有無から「まだ公表
 *     されていない」を判定するのは信頼できない — その判定は
 *     `issuanceRedemptionPublicationStatus()` (一覧ページの掲載日) の専任
 *     とし、本パーサは「呼び出し側がすでに公表済みと確認した対象月」だけを
 *     受け取る前提で、値が読めなければ様式相違として throw する (ルール2)。
 *
 * @throws シート構成・見出し・対象月の行が想定と異なる場合。無効値で埋めて
 *   続行しない。
 */
export function parseIssuanceRedemptionWorkbook(
  bytes: Uint8Array,
  targetMonth: string
): Pick<JsdaIssuanceRedemptionData, "rows"> {
  const m = targetMonth.match(/^(\d{4})-(\d{2})$/);
  if (!m) {
    throw new Error(`targetMonth は YYYY-MM 形式で指定してください: ${targetMonth}`);
  }
  const rowLabel = `${m[1]}.${m[2]}`;

  const workbook = XLSX.read(bytes, { type: "array" });
  if (workbook.SheetNames.length === 0) {
    throw new Error("JSDA 公社債発行額・償還額 xlsx: シートが 0 枚です。");
  }

  const toNumber = (v: unknown): number | null => {
    const s = String(v).replace(/,/g, "").replace(/△/g, "-").trim();
    if (s === "" || s === "-") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  const rows: JsdaBondFlowRow[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]!;
    const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      raw: false,
    });

    const { multiplier } = detectUnitMultiplier(grid);

    const groupHeaderRow = grid[2];
    const subHeaderRow = grid[3];
    if (!groupHeaderRow || !subHeaderRow) {
      throw new Error(
        `JSDA 公社債発行額・償還額 xlsx (シート「${sheetName}」): 見出し行 (3〜4行目) が見つかりません。`
      );
    }
    const issuanceCol = subHeaderRow.findIndex((c) => String(c).includes("金額(a)"));
    const redemptionCol = groupHeaderRow.findIndex((c) => String(c).includes("合計(b)"));
    if (issuanceCol === -1 || redemptionCol === -1) {
      throw new Error(
        `JSDA 公社債発行額・償還額 xlsx (シート「${sheetName}」): 「金額(a)」` +
          `(発行額) または「合計(b)」(償還額) の列見出しが見つかりません。` +
          `様式が変わった可能性があります。`
      );
    }

    const rowIdx = grid.findIndex((r) => String(r[0]).trim() === rowLabel);
    if (rowIdx === -1) {
      throw new Error(
        `JSDA 公社債発行額・償還額 xlsx (シート「${sheetName}」): 対象月 ${rowLabel} の行が` +
          `見つかりません。`
      );
    }
    const targetRow = grid[rowIdx]!;
    const issuanceRaw = toNumber(targetRow[issuanceCol]);
    const redemptionRaw = toNumber(targetRow[redemptionCol]);
    if (issuanceRaw === null || redemptionRaw === null) {
      throw new Error(
        `JSDA 公社債発行額・償還額 xlsx (シート「${sheetName}」): 対象月 ${rowLabel} の値が` +
          `空です。issuanceRedemptionPublicationStatus() で公表済みと確認した月だけを渡して` +
          `ください (欠損を 0 で埋めない)。`
      );
    }
    rows.push({
      bondType: sheetName,
      issuance: issuanceRaw * multiplier,
      redemption: redemptionRaw * multiplier,
    });
  }
  return { rows };
}

/** 一覧ページ解決 → xlsx 取得 → 最新月のパースまでを一気に行う。 */
export async function fetchIssuanceRedemption(): Promise<JsdaIssuanceRedemptionData> {
  const latest = await resolveLatestIssuanceRedemption();
  const res = await fetchFromJsda(
    latest.fileUrl,
    {
      headers: {
        "User-Agent": JSDA_UA,
        Accept:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,*/*",
      },
    },
    "公社債発行額・償還額 xlsx"
  );
  const bytes = new Uint8Array(await res.arrayBuffer());
  const { rows } = parseIssuanceRedemptionWorkbook(bytes, latest.periodMonth);
  return { ...latest, rows, bytes };
}

/**
 * ルール6: Notion 一次データ記録の入力を組み立てる純関数 (実際の記録は
 * 統合スクリプト側が `recordPrimaryData()` を呼ぶ。ここでは呼ばない)。
 */
export function issuanceRedemptionArchiveInput(data: JsdaIssuanceRedemptionData): {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
} {
  return {
    service: "moneyflow",
    key: `jsda-bond-issuance-redemption-${data.periodMonth}`,
    source: data.fileUrl,
    metadata: {
      periodMonth: data.periodMonth,
      publishedOn: data.publishedOn,
      rowCount: data.rows.length,
      bytes: data.bytes.byteLength,
    },
    files: [
      {
        bytes: data.bytes,
        filename: `jsda-hakkou-${data.periodMonth}.xlsx`,
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 期間・「まだ公表されていない」判定
// ---------------------------------------------------------------------------

export type MoneyflowPeriodGranularity = "week" | "month" | "quarter" | "year";

export type JsdaPublicationStatus =
  | {
      kind: "published";
      period: string;
      /** 最新月そのものを問い合わせた場合だけ実際の掲載日を返す。過去月は
       *  ページから個別の掲載日が取れないため undefined (捏造しない)。 */
      publishedOn: string | undefined;
    }
  | {
      kind: "not_yet_published";
      expectedPeriod: string;
      reason: string;
    };

const YYYY_MM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 発行額・償還額について、対象月 (YYYY-MM) が公表済みかを判定する。
 * 比較は "YYYY-MM" の辞書式順序で正しく機能する (ゼロ埋め済みの場合に限る
 * ため、形式が違う値は判定せずに throw する — "2026-1" を "2026-07" と辞書式
 * 比較すると「未公表」と誤判定するため)。
 */
export function issuanceRedemptionPublicationStatus(
  latest: Pick<JsdaIssuanceRedemptionLatest, "periodMonth" | "publishedOn">,
  targetMonth: string
): JsdaPublicationStatus {
  for (const [name, v] of [
    ["targetMonth", targetMonth],
    ["latest.periodMonth", latest.periodMonth],
  ] as const) {
    if (!YYYY_MM_RE.test(v)) {
      throw new Error(`${name} は YYYY-MM 形式 (月は01〜12) で指定してください: ${v}`);
    }
  }
  if (targetMonth > latest.periodMonth) {
    return {
      kind: "not_yet_published",
      expectedPeriod: targetMonth,
      reason:
        `最新の掲載は ${latest.periodMonth} 分 (掲載日 ${latest.publishedOn})。` +
        `要求された ${targetMonth} 分はまだ公表されていない。`,
    };
  }
  return {
    kind: "published",
    period: targetMonth,
    publishedOn: targetMonth === latest.periodMonth ? latest.publishedOn : undefined,
  };
}

// ---------------------------------------------------------------------------
// (B) 公社債投資家別売買高 — 終了判定
// ---------------------------------------------------------------------------

export interface JsdaDiscontinuedStatistic {
  kind: "discontinued";
  /**
   * 掲載されている実データ (.xls) ファイルの「最終更新日」の最大値
   * (ページ表記のまま)。解説 PDF 等の付随資料の「最終更新日」は対象外
   * (それらは統計データそのものの更新日ではないため混ぜない)。
   */
  lastUpdatedOn: string;
  reason: string;
  successors: Array<{ label: string; url: string }>;
}

const REORG_MARKER = "発表様式の再編等について";

/**
 * (B) の一覧ページ HTML が「発表様式の再編で終了した」ことを実際に述べて
 * いるかを検証したうえで、終了状態を型で返す純関数。
 *
 * @throws 再編の記載が見当たらない場合 (ページが復活・更新された可能性が
 *   あるため、実データとして扱えるか目視確認を促す)。
 */
export function investorTurnoverStatus(
  html: string,
  pageUrl: string = JSDA_TOUSHIKA_PAGE_URL
): JsdaDiscontinuedStatistic {
  if (!html.includes(REORG_MARKER)) {
    throw new Error(
      "JSDA 公社債投資家別売買高: 想定していた「発表様式の再編等について」の" +
        "記載が見当たりません。ページが更新され、投資家部門別の売買高が" +
        "復活した可能性があるため、このモジュールを直す前に目視確認してください。"
    );
  }
  // ページ内には解説 PDF (files/tkb*.pdf 等) の「最終更新日」も同じ表記で
  // 混在する (実データ確認: 2015.8.20 / 2016.3.22 の PDF が、2018.5.21 の
  // 実データ xls と並んでいる)。ここで追跡したいのは「統計の実データ
  // (.xls) ファイルが最後に更新された日」なので、.xls へのリンクに紐づく
  // 「最終更新日」だけを対象にする — 解説 PDF が将来更新されても、統計本体の
  // 更新日として誤って拾わないようにする (ルール2: 無関係な値を混ぜない)。
  // .xls リンクから日付までの間は別の <a> をまたがない — .xls 側に日付が
  // 無いとき、直後に並ぶ解説 PDF リンクの日付を借用しないため。
  const updatedDates = [
    ...html.matchAll(
      /<a href="[^"]+\.xls"[^>]*>(?:(?!<a\s)[\s\S]){0,200}?最終更新日[：:]\s*(\d{4})\.(\d{1,2})\.(\d{1,2})/g
    ),
  ].map((m) => ({
    label: `${m[1]!}.${m[2]!}.${m[3]!}`,
    // 表記は "2018.5.21" のようにゼロ埋めされないため、文字列の辞書式順序で
    // 比べると "2018.5.21" > "2018.12.3" と誤る。年月日を数値にして比べる。
    ordinal: Number(m[1]) * 10_000 + Number(m[2]) * 100 + Number(m[3]),
  }));
  if (updatedDates.length === 0) {
    throw new Error(
      "JSDA 公社債投資家別売買高: 実データ(.xls)ファイルに紐づく「最終更新日」の" +
        "記載を認識できません。"
    );
  }
  const lastUpdatedOn = updatedDates.reduce((a, b) => (b.ordinal > a.ordinal ? b : a)).label;

  const successors: Array<{ label: string; url: string }> = [];
  const succRe =
    /<a href="([^"]+)">([^<]*(?:公社債店頭売買高|投資家別条件付売買[^<]*)[^<]*)<\/a>/g;
  for (const m of html.matchAll(succRe)) {
    const [, href, label] = m;
    successors.push({ label: label!.trim(), url: new URL(href!, pageUrl).toString() });
  }
  if (successors.length === 0) {
    throw new Error(
      "JSDA 公社債投資家別売買高: 後継統計(公社債店頭売買高/投資家別条件付" +
        "売買)へのリンクを認識できません。"
    );
  }

  return {
    kind: "discontinued",
    lastUpdatedOn,
    reason:
      "平成30年6月発表分(平成30年5月取引分)から公社債店頭取引に係る発表様式が" +
      "再編され、投資家部門別の「売買高」統計はこの形では終了した。現物の" +
      "売買高は投資家部門別の内訳を失い(①)、投資家部門別の内訳が残るのは" +
      "現先(レポ)の月末残高のみ(②)になった。",
    successors,
  };
}

// ---------------------------------------------------------------------------
// 指標定義 (キー・要件・何を測るか・出典・利用条件・頻度・限界)
//
// 「発行額は払込日ベース、償還額は償還日ベースで集計」という前提は、JSDA の
// 解説資料 (https://www.jsda.or.jp/shiryoshitsu/toukei/hakkou/files/hako.pdf
// 、2026-09-27 に取得・目視確認) の「＜作成方法・集計基準＞」に明記されている
// ことを直接確認済み (初回実装時は JSDA 側の 429 で確認できていなかった)。
// ---------------------------------------------------------------------------

export type MoneyflowMeasureKind =
  | "net_flow"
  | "gross_turnover"
  | "holdings_stock"
  | "positions"
  | "fund_flow"
  | "estimated"
  | "price_only";

export interface MoneyflowIndicatorDef {
  key: string;
  label: string;
  /** 計画書の要件番号 (例: "R2") */
  requirements: string[];
  measureKind: MoneyflowMeasureKind;
  /** 平易な説明 + 財務的に正確な定義 (CLAUDE.md ルール7 相当の粒度) */
  description: string;
  unit: string;
  sourceUrl: string;
  usageTerms: string;
  frequency: string;
  limitations: string;
}

const JSDA_USAGE_TERMS =
  "無料で誰でも閲覧・ダウンロードできる (ログイン不要)。ただし高頻度アクセスは" +
  "サーバ側のレート制限 (429, Retry-After なし) が実際に発生することを確認済み" +
  "— 平日1回程度の低頻度アクセスに限る。商用の二次利用可否は JSDA サイト上で" +
  "明記が確認できず (unknown)。kabulab は既存の JPX 由来データと同様、個人利用・" +
  "非公開の範囲に限定して扱う。";

export const JSDA_BONDS_INDICATORS: MoneyflowIndicatorDef[] = [
  {
    key: "jsda_bond_issuance",
    label: "公社債発行額",
    requirements: ["R2"],
    measureKind: "gross_turnover",
    description:
      "その月に払込みが行われた公社債(国債・地方債・政府保証債・財投機関債・" +
      "普通社債・CB・金融債等)の新規発行額。株式以外の債券市場に新しく供給" +
      "された「器」の大きさを表すグロスの量であり、買い越し/売り越しのような" +
      "需給の純額(ネットフロー)ではない。例: ある月に国債が10兆円発行された" +
      "としても、それがすべて誰かの新規の買いになったとは限らない(借換債の" +
      "ような既発債の償還と抱き合わせの場合を含む)。",
    unit: "円",
    sourceUrl: JSDA_HAKKOU_PAGE_URL,
    usageTerms: JSDA_USAGE_TERMS,
    frequency: "月次 (対象月の翌々月上旬ごろに掲載。実測: 2026年7月分 → 掲載日2026-09-10)",
    limitations:
      "払込日ベースの月次合計のみで日次内訳はない。一般債(国債以外)は2019年4月" +
      "分より証券保管振替機構(ほふり)の統計を基に作成する方式に変わっており、" +
      "単位も千円→百万円に変更されているため、それ以前の系列と単純接続すると" +
      "見かけ上の断層が生じる。",
  },
  {
    key: "jsda_bond_redemption",
    label: "公社債償還額",
    requirements: ["R2"],
    measureKind: "gross_turnover",
    description:
      "その月に発行体側の事由(満期償還・定時償還・繰上償還・買入消却)により" +
      "減少した、または株式への転換により消滅した公社債の金額。発行額と対で" +
      "見ることで、その月に市場に出入りした債券の量を比較できる(発行額が" +
      "償還額を上回れば残高は増える方向、下回れば減る方向)。これも需給の" +
      "純額ではなく、償還・転換という契約上のイベントに基づくグロスの量。" +
      "注意: 転換社債(CB)・非居住者債では、この金額に株式への転換額(社債が" +
      "転換され消滅した金額)も合算されており、必ずしも「償還期日到来による" +
      "現金償還」だけを表す値ではない(実データ例: 2026年7月分の転換社債(CB)は" +
      "満期償還額・定時償還額・買入消却額が全て0円で、償還額600百万円の全額が" +
      "転換によるものだった)。",
    unit: "円",
    sourceUrl: JSDA_HAKKOU_PAGE_URL,
    usageTerms: JSDA_USAGE_TERMS,
    frequency: "月次 (発行額と同一ファイル・同一タイミング)",
    limitations:
      "償還日ベースの月次合計のみ。満期償還・定時償還・繰上償還・買入消却・" +
      "(転換社債(CB)・非居住者債における)転換による減少の内訳までは、この" +
      "合計値からは分からない(原本xlsxには内訳列があるが本パーサは合計(b)列" +
      "のみを抽出する)。",
  },
];

// ---------------------------------------------------------------------------
// 観測ログ用の縦長レコードへの変換
// ---------------------------------------------------------------------------

export interface MoneyflowObservation {
  period: string;
  periodGranularity: MoneyflowPeriodGranularity;
  indicatorKey: string;
  /** 区分 (ここでは公社債種類。例: "国債", "地方債", "普通社債") */
  segment: string;
  segmentKind: "bond_type";
  value: number;
  unit: string;
  isApproximate: boolean;
  isEstimated: boolean;
}

/** 公社債種類別の発行額・償還額を、観測ログ用の縦長レコードへ変換する純関数。 */
export function toIssuanceRedemptionObservations(
  data: Pick<JsdaIssuanceRedemptionData, "periodMonth" | "rows">
): MoneyflowObservation[] {
  const out: MoneyflowObservation[] = [];
  for (const row of data.rows) {
    out.push({
      period: data.periodMonth,
      periodGranularity: "month",
      indicatorKey: "jsda_bond_issuance",
      segment: row.bondType,
      segmentKind: "bond_type",
      value: row.issuance,
      unit: "円",
      isApproximate: false,
      isEstimated: false,
    });
    out.push({
      period: data.periodMonth,
      periodGranularity: "month",
      indicatorKey: "jsda_bond_redemption",
      segment: row.bondType,
      segmentKind: "bond_type",
      value: row.redemption,
      unit: "円",
      isApproximate: false,
      isEstimated: false,
    });
  }
  return out;
}
