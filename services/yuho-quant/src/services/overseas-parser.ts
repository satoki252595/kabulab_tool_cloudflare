/**
 * 有価証券報告書から「海外売上高（地域別売上高）」を構造化する決定論的パーサ。
 *
 * 実データ調査 (tmp/probe-overseas.ts, EDINET 実有報) の結果、海外（地域別）
 * 売上の開示は概ね次の系統に集約される。どれにも確信を持って当てはまらない
 * 表は **でっち上げず** status で明示する (CLAUDE.md ルール1/2)。
 *
 *  GEO_ROWS — 地域=行 (現行・新収益認識基準の主流):
 *    「主たる地域市場」「地域ごとの情報」「地域別」見出しの下に、行ラベルが
 *    地域 (日本/本邦・アジア・北米・欧州・中国・その他…) の表。値列は
 *      - 合計列 (報告セグメント×地域 マトリクスの「合計/連結財務諸表計上額」)
 *      - 当期列 (前期/当期の2年表)
 *      - 単一数値列
 *    のいずれか。総額は「外部顧客への売上高/顧客との契約から生じる収益/合計」
 *    行。例: S100W16I, S100W0UT, S100W179。
 *
 *  GEO_COLS — 地域=列:
 *    ヘッダに地域 (日本/本邦 + 海外地域) が並び、「外部顧客への売上高(or 営業
 *    収益/合計)」行が地域別の値、「連結/合計」列が総額。例: S100W20H(任天堂),
 *    S100Y8NY(トヨタ・営業収益建て), S100W1Q5。
 *
 * いずれも **海外売上高 = 開示された海外地域行(列)の合計**、比率 = 海外売上高 /
 * 連結売上高。地域別内訳は副次情報 (詳細表示用)。
 *
 * 注: 旧基準の「海外売上高」注記 (海外地域別 [金額,割合%]) は新収益認識基準への
 * 移行で現行有報からはほぼ消滅しており (調査した実有報 280 件で 0 件)、実 fixture
 * で固定できないため本パーサは対象外とする (ルール: fixture 無しの推測実装はしない)。
 *
 * 正しい列/行を選べたかは「地域行の合計 ≈ 開示された集計行」で検証し、
 * 一致しなければ却下する (誤読を数値化しない = ルール1/2)。「うち、米国」等の
 * 内訳行や「その他の収益」は地域に含めない (二重計上・非地域分の混入を避ける)。
 *
 * EDINET 由来の汎用ユーティリティ (ZIP 展開・HTML テーブル化・数値正規化) は
 * 受注パーサ (order-parser) と同じ `./edinet/*` を共用する。本ファイルは海外
 * 売上高 固有の構造化のみを担い、受注と同じ有報 1 通から並行して構造化される。
 */
import { unzip } from "./edinet/zip.js";
import {
  tableToGridExpanded,
  parseJpNumber,
  unitToYenFactor,
} from "./edinet/html-table.js";

export type RegionKind = "domestic" | "overseas" | "overseas_total" | "total";

export interface OverseasFact {
  /** 表記そのままの地域名 (例: "本邦", "アジア", "北米", "海外売上高合計", "連結売上高") */
  regionName: string;
  regionKind: RegionKind;
  /** 売上高 (表の単位のまま。欠損は null = 0 で埋めない) */
  salesAmount: number | null;
  /** 連結売上高に占める割合 (%)。開示があるときのみ。無ければ null */
  ratioPct: number | null;
  /** 金額単位ラベル (例: "百万円") */
  unitLabel: string;
  /** 単位 → 円 への倍率 */
  unitYenFactor: number;
  /** この行が属する会計期末 YYYY-MM-DD */
  fiscalYearEnd: string;
  /** 連結=true / 個別=false / 判定不能=null (推測しない) */
  isConsolidated: boolean | null;
}

export type OverseasParseStatus =
  | "ok_geo_rows"
  | "ok_geo_cols"
  | "geo_present_unstructured"
  | "no_overseas_table";

export interface OverseasExtraction {
  status: OverseasParseStatus;
  facts: OverseasFact[];
  honbunFile: string | null;
  tablesScanned: number;
}

/**
 * 海外（地域別）売上 開示の有無を判定する語 (CSV 事前判定・本文選択で共用)。
 * これは「重い XBRL を落とすか / どの本文を見るか」のゲートに過ぎず、実際の
 * 構造化は後段の厳密分類で確信が持てた表だけ行う (ルール1/2)。
 */
export const RX_OVERSEAS_KEYWORD =
  /海外売上高|海外売上収益|海外への売上|地域ごとの情報|主たる地域市場|所在地別|仕向地別|地域別.{0,4}(売上|収益|情報)|国又は地域|本邦/;

/** 海外地域 (本邦/日本 以外) を表す語 */
const RX_OVERSEAS_REGION =
  /北米|南米|中南米|北中米|中米|米州|米大陸|アメリカ大陸|米国|アメリカ|欧州|ヨーロッパ|欧米|アジア|オセアニア|大洋州|アフリカ|中近東|中東|中国|中華圏|香港|韓国|台湾|タイ|ベトナム|インド|インドネシア|シンガポール|フィリピン|マレーシア|ドイツ|英国|フランス|イタリア|スペイン|オランダ|メキシコ|ブラジル|カナダ|豪州|オーストラリア|海外/;
/** 国内を表す語 (これに完全一致する行/列が domestic) */
const RX_DOMESTIC = /^(日本|本邦|国内|日本国内|わが国|我が国)$/;
/** 集計行/列 (地域ではない)。営業収益建て(トヨタ等の地域別営業概況)も含む */
const RX_AGGREGATE =
  /^(外部顧客への売上高|外部顧客に対する売上高|外部顧客への売上収益|外部顧客に対する売上収益|外部顧客への営業収益|外部顧客に対する営業収益|顧客との契約から生じる収益|売上高合計|売上収益合計|営業収益合計|営業収益|合計|総合計|総計|計|連結|連結売上高|連結計|連結財務諸表計上額)$/;
/** 「その他」系 (地域ブロック内なら overseas, 収益/事業文脈なら除外) */
const RX_OTHER_REGIONISH = /^(その他|その他の地域|その他地域|その他海外|外国|諸外国|直接輸出|輸出)$/;
/**
 * 実績系の表題語。見出し window (表直前400字→末尾160字) は表題そのものではなく
 * 前表の説明文を含み得るため、単純な含有ではなく **最寄り (最後) の表題語** で
 * 判定する (例: 「生産実績と同様、販売実績は…」と書かれた販売表を誤って落とさない)。
 */
const RX_RESULT_CAPTION = /(生産実績|販売実績|受注実績)/g;
/**
 * 生産実績表か (生産高は売上高ではないので候補にしない)。S100OE0P 等 (5013) で
 * 実証: セグメント別の生産実績表と販売実績表が同点で並び、文書順のタイブレークで
 * 生産実績表が勝って生産高を海外売上高として誤採用していた。最寄り表題語が
 * 生産実績のときだけ落とし、「生産、受注及び販売の状況」のような節見出し
 * (実績つき表題語なし) や販売実績表には発火しない。
 */
function isProductionTable(heading: string): boolean {
  let last: string | null = null;
  for (const m of heading.matchAll(RX_RESULT_CAPTION)) last = m[1];
  return last === "生産実績";
}

function norm(s: string): string {
  return s.replace(/[\s\u3000]/g, "");
}

/** 全角数字 ０-９ を半角へ */
function toHalfWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (d) =>
    String.fromCharCode(d.charCodeAt(0) - 0xfee0)
  );
}

function detectUnitOrNull(
  text: string
): { label: string; factor: number } | null {
  for (const u of ["百万円", "千円", "億円", "円"]) {
    if (text.includes(u)) return { label: u, factor: unitToYenFactor(u) };
  }
  return null;
}

function detectConsolidated(headerText: string): boolean | null {
  if (/連結/.test(headerText)) return true;
  if (/事業年度/.test(headerText) && !/連結/.test(headerText)) return false;
  return null;
}

/** 末尾の単位括弧 ((百万円) 等) と注番号を除いた表示用ラベル */
function cleanLabel(name: string): string {
  return name
    .replace(/[（(](?:単位[:：]?)?(?:百万円|千円|億円|円)[)）]?\s*$/u, "")
    .replace(/[（(]注[）)0-9]*\s*$/u, "")
    .replace(/[\s\u3000]+/g, "")
    .trim();
}

type RegionRole = "domestic" | "overseas" | "aggregate" | "other";

function classifyRegion(rawLabel: string): RegionRole {
  const s = cleanLabel(rawLabel);
  if (s === "") return "other";
  // 「(南北アメリカの)うち、米国」等の内訳行は親地域の一部 = 二重計上回避で除外
  if (/うち/.test(s)) return "other";
  if (RX_DOMESTIC.test(s)) return "domestic";
  // 「その他の収益」等は集計でも地域でもない → other (除外)
  if (/^その他の収益$/.test(s)) return "other";
  if (RX_AGGREGATE.test(s)) return "aggregate";
  if (RX_OTHER_REGIONISH.test(s)) return "overseas"; // 暫定。ブロック検証で確定
  if (RX_OVERSEAS_REGION.test(s)) return "overseas";
  return "other";
}

/** 地域行の合計と開示総額の整合チェック (1% 許容: 丸め差のみ通す) */
function totalsConsistent(regionSum: number, disclosedTotal: number): boolean {
  if (disclosedTotal <= 0) return false;
  return Math.abs(regionSum - disclosedTotal) <= disclosedTotal * 0.01;
}

/** 製品/用途・非売上 metric の section 標識 (この section の行は売上 block ではない) */
const RX_NON_SALES_SECTION = /営業利益|用途別|財又はサービス/;
/** 小計行 (block 終端。小計は全体集計ではないので集計検証には使わない) */
const RX_SHOKEI = /小計/;
/** 消去/調整行 (地域計に加算して block 合計と照合する) */
const RX_ELIMINATION = /消去/;
/** 地域×項目 対の metric 区分 (売上高行だけ読む。利益行は混ぜない) */
const RX_SALES_METRIC = /売上高|売上収益|営業収益/;
const RX_PROFIT_METRIC = /営業利益|事業利益/;

type MetricKind = "sales" | "profit" | null;

/** col1 の metric 区分。売上高系/営業利益系のどちらでもなければ null */
function metricOf(sub: string): MetricKind {
  const n = norm(sub);
  if (RX_SALES_METRIC.test(n)) return "sales";
  if (RX_PROFIT_METRIC.test(n)) return "profit";
  return null;
}

/**
 * section 見出し行か。col0 が地域でも集計でもなく、行全体に数値が無い行。
 * 例: 売上高 / 営業利益・損失(△) / 主たる地域市場 / 用途別の販売。
 */
function sectionLabelOf(row: string[]): string | null {
  if (classifyRegion(row[0] ?? "") !== "other") return null;
  const name = cleanLabel(row[0] ?? "");
  if (name === "") return null;
  if (row.some((c) => parseJpNumber(c) !== null)) return null;
  return name;
}

/**
 * 同一表から同一地域名が複数値で出ていないか。全取込経路 (ingest.ts /
 * backfill-overseas.ts / backfill-missing-docs.ts) は (会計期末, 地域名) の
 * 先頭採用で重複を落とすため、重複があると集計が dedup 前の水増し合計で確定し、
 * 保存後に地域計≠合計の乖離を生む (aggregate-before-dedup。S100J2E7 で実証)。
 * 同一表内の重複地域名は 2 次元表 (地域×品目等) を単一値列で読んだ曖昧さの
 * 徴候であり、捏造補正も任意合算もせず表ごと却下する (ルール1/2)。
 */
function hasDuplicateRegionNames(facts: OverseasFact[]): boolean {
  const seen = new Set<string>();
  for (const f of facts) {
    if (f.regionKind !== "domestic" && f.regionKind !== "overseas") continue;
    if (seen.has(f.regionName)) return true;
    seen.add(f.regionName);
  }
  return false;
}

interface Honbun {
  name: string;
  html: string;
}

function pickHonbunHtml(entries: Map<string, Buffer>): Honbun | null {
  const names = [...entries.keys()];
  const honbun = names.filter(
    (n) =>
      /PublicDoc\//i.test(n) &&
      /honbun/i.test(n) &&
      /jpcrp030000-asr/i.test(n) &&
      /\.html?$/i.test(n)
  );
  const pubHtml = names.filter(
    (n) => /PublicDoc\//i.test(n) && /\.html?$/i.test(n)
  );
  const list = honbun.length > 0 ? honbun : pubHtml;
  if (list.length === 0) return null;
  // 海外/地域 開示語を含む本文を優先
  for (const n of list) {
    const html = entries.get(n)!.toString("utf8");
    if (RX_OVERSEAS_KEYWORD.test(html)) return { name: n, html };
  }
  return { name: list[0], html: entries.get(list[0])!.toString("utf8") };
}

// ---------------------------------------------------------------------------
// 値列の選定 (地域=行 のとき)
// ---------------------------------------------------------------------------

interface ColPick {
  col: number;
  /** この値列が「総額(合計/連結)」を表すか (=地域行の値がセグメント横断合計) */
  isAggregateCol: boolean;
}

function buildColHeader(headerRows: string[][], width: number): string[] {
  const colHeader: string[] = [];
  for (let ci = 0; ci < width; ci++) {
    colHeader[ci] = norm(headerRows.map((r) => r[ci] ?? "").join(""));
  }
  return colHeader;
}

/**
 * 地域=行 の値列を決める。優先: 合計/連結列 → 当期列 → 単一数値列。
 * 確信が持てない (候補が複数/0) ときは null。
 */
function pickValueColForRows(
  colHeader: string[],
  dataRows: string[][],
  reportYear: number
): ColPick | null {
  const width = colHeader.length;
  const EXCL = /調整額?|セグメント間|内部売上|内部取引|消去|前年比|増減|構成比|割合|％|%/;

  // 1) 合計/連結 列
  const aggCols: number[] = [];
  for (let ci = 0; ci < width; ci++) {
    const h = colHeader[ci];
    if (EXCL.test(h)) continue;
    if (/合計$|^合計|連結財務諸表計上額|^連結$|連結計上額/.test(h)) aggCols.push(ci);
  }
  if (aggCols.length === 1) return { col: aggCols[0], isAggregateCol: true };

  // 2) 当期 (報告対象年) 列。前期列が併記される 2 年表向け。
  const curCols: number[] = [];
  for (let ci = 0; ci < width; ci++) {
    const h = toHalfWidthDigits(colHeader[ci]);
    if (EXCL.test(h)) continue;
    if (
      /当連結会計年度|当事業年度|当期|当中間/.test(h) ||
      new RegExp(`${reportYear}年`).test(h)
    ) {
      curCols.push(ci);
    }
  }
  if (curCols.length === 1) return { col: curCols[0], isAggregateCol: false };

  // 3) 単一数値列 (地域行に数値がある列が 1 本だけ)
  const regionRows = dataRows.filter(
    (r) => classifyRegion(r[0] ?? "") === "domestic" || classifyRegion(r[0] ?? "") === "overseas"
  );
  if (regionRows.length === 0) return null;
  const numericCols: number[] = [];
  for (let ci = 1; ci < width; ci++) {
    if (EXCL.test(colHeader[ci])) continue;
    const n = regionRows.filter((r) => parseJpNumber(r[ci] ?? "") !== null).length;
    if (n >= Math.max(2, Math.ceil(regionRows.length / 2))) numericCols.push(ci);
  }
  if (numericCols.length === 1) return { col: numericCols[0], isAggregateCol: false };
  return null;
}

// ---------------------------------------------------------------------------
// GEO_ROWS: 地域 = 行
// ---------------------------------------------------------------------------

function tryGeoRows(
  gridX: string[][],
  fiscalYearEnd: string,
  heading: string
): OverseasFact[] | null {
  const flat = gridX.map((r) => r.join("")).join("");
  // 単位は表外の見出し ((単位：百万円) 等) に書かれることが多い → heading も見る
  const unit = detectUnitOrNull(flat) ?? detectUnitOrNull(heading);
  if (!unit) return null;

  // section 分割: 非売上 section (製品/用途・営業利益) の行範囲を除外し、残りを
  // 売上 block 候補として読む。小計行が残れば block 合算 (B1) を試みる。
  const labelIdx: Array<{ idx: number; marked: boolean }> = [];
  gridX.forEach((row, idx) => {
    const label = sectionLabelOf(row);
    if (label !== null) {
      labelIdx.push({ idx, marked: RX_NON_SALES_SECTION.test(norm(label)) });
    }
  });
  const excluded = new Set<number>();
  labelIdx.forEach((l, li) => {
    if (!l.marked) return;
    const end = li + 1 < labelIdx.length ? labelIdx[li + 1].idx : gridX.length;
    for (let i = l.idx; i < end; i++) excluded.add(i);
  });

  // 行ラベルの地域分類 (除外範囲は other 扱い)
  const roles = gridX.map((r, i) =>
    excluded.has(i) ? "other" : classifyRegion(r[0] ?? "")
  );
  const hasDomestic = roles.includes("domestic");
  const overseasCount = roles.filter((x) => x === "overseas").length;
  if (!hasDomestic || overseasCount < 1) return null;

  // ヘッダ境界 = 最初に数値セルを持つ行。これより上が列見出し。
  // 「収益分解」表は (主要な財/サービス ブロック) + (主たる地域市場 ブロック) が
  // 同じ列見出し (報告セグメント + 合計) を共有して縦に積まれるため、最初の地域行
  // ではなく最初の数値行を境界にしないと、製品ブロックの数値が見出しを汚す。
  const firstNum = gridX.findIndex(
    (r) => r.slice(1).some((c) => parseJpNumber(c) !== null)
  );
  if (firstNum < 0) return null;
  const headerRows = gridX.slice(0, firstNum);
  const width = Math.max(...gridX.map((r) => r.length));
  const colHeader = buildColHeader(headerRows, width);
  const reportYear = Number(fiscalYearEnd.slice(0, 4));

  const pick = pickValueColForRows(colHeader, gridX.slice(firstNum), reportYear);
  if (!pick) return null;
  const vc = pick.col;

  // 集計行 (顧客との契約から生じる収益 / 外部顧客への売上高 / 合計 / 連結 / 計) を
  // すべて控える。地域行は「顧客との契約」水準で按分され、「外部顧客への売上高」
  // はそれに非地域分の『その他の収益』を足した広い総額になることがあるため、
  // 検証は「地域合計がいずれかの集計行と一致するか」で行う。
  const aggregates: Array<{ label: string; value: number }> = [];
  const consolidated = detectConsolidated(gridX.flat().join(" "));
  interface Entry {
    idx: number;
    role: "domestic" | "overseas";
    name: string;
    /** 曖昧さ解消列 (col1)。2-D 製品軸・階層子ラベル・metric 区分に使う */
    sub: string;
    value: number;
  }
  const entries: Entry[] = [];
  const shokei: Array<{ idx: number; value: number }> = [];
  let elimSum = 0;
  let hasBusinessRows = false;

  for (let i = firstNum; i < gridX.length; i++) {
    if (excluded.has(i)) continue;
    const row = gridX[i];
    if (row.length <= vc) continue;
    const role = roles[i];
    const v = parseJpNumber(row[vc] ?? "");
    const normLabel = norm(row[0] ?? "");
    // 非地域の実数行 (事業セグメント等) の有無。P-metric で集計行がない表の
    // total 欠損判定に使う (地域外の売上がある表で地域計を総額にしない)。
    if (role === "other" && v !== null && !RX_ELIMINATION.test(normLabel)) {
      hasBusinessRows = true;
    }
    if (RX_SHOKEI.test(normLabel)) {
      // 小計の値が読めない block 構成は検証不能 → 却下 (fail-closed)
      if (v === null || !Number.isInteger(v)) return null;
      shokei.push({ idx: i, value: v });
      continue;
    }
    if (role === "aggregate") {
      if (
        v !== null &&
        /外部顧客|顧客との契約|合計|連結|^計$/.test(normLabel)
      ) {
        aggregates.push({ label: normLabel, value: v });
      }
      continue;
    }
    if (RX_ELIMINATION.test(normLabel)) {
      if (v !== null) elimSum += v;
      continue;
    }
    if (role !== "domestic" && role !== "overseas") continue;
    if (v === null) continue;
    if (!Number.isInteger(v)) return null; // 小数 = % 列誤認 → 却下
    const name = cleanLabel(row[0] ?? "");
    if (name === "") continue;
    entries.push({ idx: i, role, name, sub: row[1] ?? "", value: v });
  }

  if (shokei.length > 0) {
    return finishShokeiBlocks(
      entries,
      shokei,
      aggregates,
      unit,
      fiscalYearEnd,
      consolidated
    );
  }

  // 重複地域名の解決: metric 対・2-D 製品軸・階層ラベルのいずれかで証明できなければ
  // 曖昧表として却下 (aggregate-before-dedup の防止。#150 の guard を弱めない)。
  let useEntries = entries;
  let metricPruned = false;
  const entryNames = entries.map((e) => e.name);
  if (new Set(entryNames).size !== entryNames.length) {
    if (elimSum !== 0) return null; // 消去つき重複は未証明の組合せ → 却下
    const resolved = resolveDupEntries(entries, aggregates);
    if (!resolved) return null;
    useEntries = resolved.entries;
    metricPruned = resolved.metricPruned;
  }

  const facts: OverseasFact[] = useEntries.map((e) => ({
    regionName: e.name,
    regionKind: e.role,
    salesAmount: e.value,
    ratioPct: null,
    unitLabel: unit.label,
    unitYenFactor: unit.factor,
    fiscalYearEnd,
    isConsolidated: consolidated,
  }));
  let domesticSum = 0;
  let regionSum = 0;
  for (const e of useEntries) {
    if (e.role === "domestic") domesticSum += e.value;
    regionSum += e.value;
  }

  if (facts.length < 2 || domesticSum <= 0) return null;
  // 同一表内の重複地域名は曖昧表 (aggregate-before-dedup の原因) として却下
  if (hasDuplicateRegionNames(facts)) return null;
  // 検証: 集計行が開示されているなら、地域合計 (+消去) が **いずれかの集計行** と
  // 一致すること (= 正しい列・正しい block を読み地域を取りこぼしていない)。
  // 一致が無ければ誤読として却下。
  const adjustedSum = regionSum + elimSum;
  const matched = aggregates.find((a) => totalsConsistent(adjustedSum, a.value));
  if (aggregates.length > 0 && !matched) return null;
  // 分母 (連結売上高): 実際の総売上 = 外部顧客への売上高 を最優先。無ければ
  // 連結/合計、無ければ一致した集計、無ければ地域合計。ただし metric 除去後の
  // 残りに非地域の実数行 (事業セグメント等) があり集計行がない表は、地域計が
  // 会社全体を表さないため total を欠損にする (捏造しない。S100VI7V で実証)。
  const total =
    aggregates.find((a) => /外部顧客/.test(a.label))?.value ??
    aggregates.find((a) => /連結|合計/.test(a.label))?.value ??
    matched?.value ??
    (metricPruned && hasBusinessRows ? null : regionSum);
  // 海外売上高 = 開示された海外地域行の合計 (= regionSum − 国内)。total − 国内に
  // すると「その他の収益」等の非地域分を海外に混入させるため使わない (ルール1)。
  const overseasTotal = regionSum - domesticSum;
  if (overseasTotal <= 0) return null;
  if (total !== null && total < adjustedSum * 0.99) return null;

  facts.push({
    regionName: "海外売上高",
    regionKind: "overseas_total",
    salesAmount: overseasTotal,
    ratioPct:
      total !== null && total > 0
        ? +((overseasTotal / total) * 100).toFixed(1)
        : null,
    unitLabel: unit.label,
    unitYenFactor: unit.factor,
    fiscalYearEnd,
    isConsolidated: consolidated,
  });
  facts.push({
    regionName: "連結売上高",
    regionKind: "total",
    salesAmount: total,
    ratioPct: null,
    unitLabel: unit.label,
    unitYenFactor: unit.factor,
    fiscalYearEnd,
    isConsolidated: consolidated,
  });
  return facts;
}

/**
 * B1: 小計終端の複数 block (収益 category 別など) を合算する。各 block が自小計と
 * 一致し、かつ小計の合計が grand 集計 (開示総額) と一致するときだけ、地域ごとに
 * block 間合算する (S100QIEX で実証: 小計A 2112769 + 小計B 377295 = 外部顧客
 * 2490064)。検証に1つでも失敗したら null (捏造合算しない)。
 */
function finishShokeiBlocks(
  entries: Array<{ idx: number; role: "domestic" | "overseas"; name: string; value: number }>,
  shokei: Array<{ idx: number; value: number }>,
  aggregates: Array<{ label: string; value: number }>,
  unit: { label: string; factor: number },
  fiscalYearEnd: string,
  consolidated: boolean | null
): OverseasFact[] | null {
  const bounds = shokei.map((s) => s.idx).sort((a, b) => a - b);
  // 最終小計より後の地域行は所属 block 不明 → 却下
  if (entries.some((e) => e.idx > bounds[bounds.length - 1])) return null;
  let prev = -1;
  const groups = new Map<string, { kind: "domestic" | "overseas"; sum: number }>();
  for (const s of shokei) {
    const block = entries.filter((e) => e.idx > prev && e.idx < s.idx);
    prev = s.idx;
    // 同一 block 内の重複地域名は 2-D 等の未証明構造 → 却下
    const blockNames = block.map((e) => e.name);
    if (new Set(blockNames).size !== blockNames.length) return null;
    const blockSum = block.reduce((a, e) => a + e.value, 0);
    if (!totalsConsistent(blockSum, s.value)) return null;
    for (const e of block) {
      const g = groups.get(e.name);
      if (g && g.kind !== e.role) return null; // block 間で内外区分が矛盾 → 却下
      if (g) g.sum += e.value;
      else groups.set(e.name, { kind: e.role, sum: e.value });
    }
  }
  // grand: 小計の合計が開示総額のいずれかと一致すること (総額の捏造なし)
  const grandSum = shokei.reduce((a, s) => a + s.value, 0);
  const grand = aggregates.find((a) => totalsConsistent(grandSum, a.value));
  if (!grand) return null;

  let domesticSum = 0;
  let regionSum = 0;
  const facts: OverseasFact[] = [...groups].map(([name, g]) => {
    if (g.kind === "domestic") domesticSum += g.sum;
    regionSum += g.sum;
    return {
      regionName: name,
      regionKind: g.kind,
      salesAmount: g.sum,
      ratioPct: null as number | null,
      unitLabel: unit.label,
      unitYenFactor: unit.factor,
      fiscalYearEnd,
      isConsolidated: consolidated,
    };
  });
  if (facts.length < 2 || domesticSum <= 0) return null;
  if (hasDuplicateRegionNames(facts)) return null;
  const overseasTotal = regionSum - domesticSum;
  const total = grand.value;
  if (overseasTotal <= 0 || total < regionSum * 0.99) return null;

  facts.push({
    regionName: "海外売上高",
    regionKind: "overseas_total",
    salesAmount: overseasTotal,
    ratioPct: total > 0 ? +((overseasTotal / total) * 100).toFixed(1) : null,
    unitLabel: unit.label,
    unitYenFactor: unit.factor,
    fiscalYearEnd,
    isConsolidated: consolidated,
  });
  facts.push({
    regionName: "連結売上高",
    regionKind: "total",
    salesAmount: total,
    ratioPct: null,
    unitLabel: unit.label,
    unitYenFactor: unit.factor,
    fiscalYearEnd,
    isConsolidated: consolidated,
  });
  return facts;
}

interface DupEntry {
  idx: number;
  role: "domestic" | "overseas";
  name: string;
  sub: string;
  value: number;
}

/**
 * 重複地域名の解決。col1 (sub) の形で以下を区別し、証明できる形だけ entries を
 * 正規化する。どれにも当てはまらなければ null (曖昧表として却下)。
 * - P-metric: sub が売上高/営業利益の対 → 売上高行だけ残す (S100VI7V で実証)
 * - P-2D: sub が品目ラベル (非地域・非集計・非数値・非 metric・非空・(地域, sub)
 *   一意) → 地域ごとに合算し、合算が開示集計と一致すること (S100J2E7 で実証)
 * - P-hier: sub が子地域ラベル (一意) → 子ラベルで読替え、leaf 合計が開示集計と
 *   一致すること (S100OJV9 で実証)
 */
function resolveDupEntries(
  entries: DupEntry[],
  aggregates: Array<{ label: string; value: number }>
): { entries: DupEntry[]; metricPruned: boolean } | null {
  // P-metric: 全行の sub が metric 対で、売上/利益の両方があれば利益行を除く
  const metrics = entries.map((e) => metricOf(e.sub));
  if (
    metrics.every((m) => m !== null) &&
    metrics.includes("sales") &&
    metrics.includes("profit")
  ) {
    const kept = entries.filter((_, i) => metrics[i] === "sales");
    const names = kept.map((e) => e.name);
    if (new Set(names).size !== names.length) return null;
    return { entries: kept, metricPruned: true };
  }
  // P-2D: sub が品目ラベル → 地域ごとに合算
  const subRoles = entries.map((e) => classifyRegion(e.sub));
  const pairs = entries.map((e) => `${e.name}|${e.sub}`);
  const pairsUnique = new Set(pairs).size === pairs.length;
  const isProduct2D =
    pairsUnique &&
    entries.every(
      (e, i) =>
        cleanLabel(e.sub) !== "" &&
        parseJpNumber(e.sub) === null &&
        subRoles[i] !== "domestic" &&
        subRoles[i] !== "overseas" &&
        subRoles[i] !== "aggregate" &&
        metricOf(e.sub) === null
    );
  if (isProduct2D) {
    const groups = new Map<
      string,
      { kind: "domestic" | "overseas"; sum: number; idx: number }
    >();
    for (const e of entries) {
      const g = groups.get(e.name);
      if (g) g.sum += e.value;
      else groups.set(e.name, { kind: e.role, sum: e.value, idx: e.idx });
    }
    const groupedSum = [...groups.values()].reduce((a, g) => a + g.sum, 0);
    // 分割の証明: 合算が開示集計のいずれかと一致すること
    if (!aggregates.some((a) => totalsConsistent(groupedSum, a.value))) {
      return null;
    }
    return {
      entries: [...groups].map(([name, g]) => ({
        idx: g.idx,
        role: g.kind,
        name,
        sub: "",
        value: g.sum,
      })),
      metricPruned: false,
    };
  }
  // P-hier: sub が子地域ラベル (一意) → 子ラベルで読替え
  const isHier =
    pairsUnique &&
    subRoles.every((r) => r === "domestic" || r === "overseas") &&
    new Set(entries.map((e) => cleanLabel(e.sub))).size === entries.length;
  if (isHier) {
    const leaf = entries.map((e) => ({
      idx: e.idx,
      role: (classifyRegion(e.sub) === "domestic"
        ? "domestic"
        : "overseas") as "domestic" | "overseas",
      name: cleanLabel(e.sub),
      sub: "",
      value: e.value,
    }));
    if (leaf.some((e) => e.name === "")) return null;
    const leafSum = leaf.reduce((a, e) => a + e.value, 0);
    if (!aggregates.some((a) => totalsConsistent(leafSum, a.value))) return null;
    return { entries: leaf, metricPruned: false };
  }
  return null;
}

// ---------------------------------------------------------------------------
// GEO_COLS: 地域 = 列
// ---------------------------------------------------------------------------

function tryGeoCols(
  gridX: string[][],
  fiscalYearEnd: string,
  heading: string
): OverseasFact[] | null {
  const flat = gridX.map((r) => r.join("")).join("");
  const unit = detectUnitOrNull(flat) ?? detectUnitOrNull(heading);
  if (!unit) return null;
  const width = Math.max(...gridX.map((r) => r.length));

  // 地域名を含むヘッダ行を探す (日本/本邦 列 + 海外地域 列)
  let headerIdx = -1;
  let colRole: RegionRole[] = [];
  for (let ri = 0; ri < Math.min(gridX.length, 6); ri++) {
    const roles = gridX[ri].map((c) => classifyRegion(c));
    const dom = roles.filter((x) => x === "domestic").length;
    const ovs = roles.filter((x) => x === "overseas").length;
    if (dom >= 1 && ovs >= 1) {
      headerIdx = ri;
      colRole = roles;
      break;
    }
  }
  if (headerIdx < 0) return null;

  // 総額列 (連結/合計) を特定
  let totalCol = -1;
  for (let ci = 0; ci < width; ci++) {
    const h = norm(gridX[headerIdx][ci] ?? "");
    if (/連結財務諸表計上額|^連結$|^合計$|連結計上額/.test(h)) totalCol = ci;
  }

  // 値行 = 「外部顧客への売上高 / 外部顧客に対する売上高 / 売上高 / 合計」行
  let valueRow = -1;
  for (let i = headerIdx + 1; i < gridX.length; i++) {
    const lbl = norm(gridX[i][0] ?? "");
    if (/外部顧客への(売上高|売上収益|営業収益)|外部顧客に対する(売上高|売上収益|営業収益)/.test(lbl)) {
      valueRow = i;
      break;
    }
  }
  if (valueRow < 0) {
    for (let i = headerIdx + 1; i < gridX.length; i++) {
      const lbl = norm(gridX[i][0] ?? "");
      if (/^(売上高|売上収益|営業収益|合計|計)$/.test(lbl)) {
        valueRow = i;
        break;
      }
    }
  }
  if (valueRow < 0) return null;

  const consolidated = detectConsolidated(gridX.flat().join(" "));
  const EXCL = /調整額?|セグメント間|内部|消去|割合|％|%/;
  interface Col {
    index: number;
    name: string;
    kind: "domestic" | "overseas";
    value: number | null;
  }
  const cols: Col[] = [];
  for (let ci = 0; ci < width; ci++) {
    if (ci === totalCol) continue;
    const role = colRole[ci];
    if (role !== "domestic" && role !== "overseas") continue;
    const h = norm(gridX[headerIdx][ci] ?? "");
    if (EXCL.test(h)) continue;
    const v = parseJpNumber(gridX[valueRow][ci] ?? "");
    if (v !== null && !Number.isInteger(v)) return null;
    cols.push({
      index: ci,
      name: cleanLabel(gridX[headerIdx][ci] ?? ""),
      kind: role,
      value: v,
    });
  }
  // P-hier-cols: 親ラベル重複は子階層 (次行) で grouping する。複数列の親は
  // 子が非空・非数値・群内一意のときだけ合算できる (S100DDYF/S100Y53G で実証)。
  // 証明できなければ曖昧表として却下。
  let useCols = cols.filter((c) => c.value !== null);
  const colNames = cols.map((c) => c.name);
  if (new Set(colNames).size !== colNames.length) {
    const child = gridX[headerIdx + 1];
    if (!child || totalCol < 0) return null;
    const counts = new Map<string, number>();
    for (const c of cols) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    const groups = new Map<
      string,
      { kind: "domestic" | "overseas"; sum: number; n: number; subs: string[] }
    >();
    for (const c of cols) {
      const rawSub = child[c.index] ?? "";
      if (EXCL.test(norm(rawSub))) continue; // 子が調整額等 → leaf 除外
      const sub = cleanLabel(rawSub);
      if ((counts.get(c.name) ?? 0) > 1) {
        if (
          sub === "" ||
          parseJpNumber(rawSub) !== null ||
          (groups.get(c.name)?.subs.includes(sub) ?? false)
        ) {
          return null;
        }
      }
      const g = groups.get(c.name);
      if (g) {
        if (c.value !== null) {
          g.sum += c.value;
          g.n++;
        }
        g.subs.push(sub);
      } else {
        groups.set(c.name, {
          kind: c.kind,
          sum: c.value ?? 0,
          n: c.value !== null ? 1 : 0,
          subs: [sub],
        });
      }
    }
    // 全 leaf 欠損の親は落とす (0 で埋めない。検証が守る)
    useCols = [...groups]
      .filter(([, g]) => g.n > 0)
      .map(([name, g]) => ({
        index: -1,
        name,
        kind: g.kind,
        value: g.sum as number | null,
      }));
  }
  const facts: OverseasFact[] = [];
  let domesticSum = 0;
  let regionSum = 0;
  for (const c of useCols) {
    const v = c.value;
    if (v === null) continue;
    if (c.kind === "domestic") domesticSum += v;
    regionSum += v;
    facts.push({
      regionName: c.name,
      regionKind: c.kind,
      salesAmount: v,
      ratioPct: null,
      unitLabel: unit.label,
      unitYenFactor: unit.factor,
      fiscalYearEnd,
      isConsolidated: consolidated,
    });
  }
  if (facts.length < 2 || domesticSum <= 0) return null;
  // 同一表内の重複地域名は曖昧表 (aggregate-before-dedup の原因) として却下
  if (hasDuplicateRegionNames(facts)) return null;

  const disclosedTotal =
    totalCol >= 0 ? parseJpNumber(gridX[valueRow][totalCol] ?? "") : null;
  const total = disclosedTotal ?? regionSum;
  if (disclosedTotal !== null && !totalsConsistent(regionSum, disclosedTotal)) {
    return null;
  }
  // 海外売上高 = 開示された海外地域列の合計 (= regionSum − 国内)。
  const overseasTotal = regionSum - domesticSum;
  if (overseasTotal <= 0) return null;

  facts.push({
    regionName: "海外売上高",
    regionKind: "overseas_total",
    salesAmount: overseasTotal,
    ratioPct: total > 0 ? +((overseasTotal / total) * 100).toFixed(1) : null,
    unitLabel: unit.label,
    unitYenFactor: unit.factor,
    fiscalYearEnd,
    isConsolidated: consolidated,
  });
  facts.push({
    regionName: "連結売上高",
    regionKind: "total",
    salesAmount: total,
    ratioPct: null,
    unitLabel: unit.label,
    unitYenFactor: unit.factor,
    fiscalYearEnd,
    isConsolidated: consolidated,
  });
  return facts;
}

/**
 * 保存前検証 (ingest + 全 backfill caller の共通境界)。parser 出力を保存してよい
 * 集合か検査し、違反があれば throw する。caller は先頭行 dedup で回復させず、
 * 例外時は parse_error + facts 空で保存する (欠損は欠損のまま)。
 * - (会計期末, 地域名) の重複なし
 * - 単位・会計期末・連結区分の混在なし
 * - 海外売上高 = 海外地域行の合計 (完全分解の一致要求)
 * - 連結売上高 (開示あり) は地域合計を下回らない。開示なし (9147 系) は
 *   total 欠損を許す (捏造しない)
 * - 比率は両非欠損のとき海外/連結から再計算一致
 * - 地域行なしの集計のみ/空集合は検証対象外 (pass)。未構造化の空保存は通す。
 */
export function validateOverseasSaveSet(facts: OverseasFact[]): void {
  const keys = facts.map((f) => `${f.fiscalYearEnd} ${f.regionName}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error("保存集合に重複地域があります。");
  }
  if (new Set(facts.map((f) => f.unitYenFactor)).size > 1) {
    throw new Error("保存集合に単位の混在があります。");
  }
  if (new Set(facts.map((f) => f.fiscalYearEnd)).size > 1) {
    throw new Error("保存集合に会計期末の混在があります。");
  }
  if (new Set(facts.map((f) => String(f.isConsolidated))).size > 1) {
    throw new Error("保存集合に連結区分の混在があります。");
  }
  const regions = facts.filter(
    (f) => f.regionKind === "domestic" || f.regionKind === "overseas"
  );
  if (regions.length === 0) return; // 集計のみ/空集合は対象外
  if (regions.some((f) => f.salesAmount === null)) {
    throw new Error("保存集合に欠損の地域売上があります。");
  }
  let domesticSum = 0;
  let overseasSum = 0;
  for (const f of regions) {
    if (f.regionKind === "domestic") domesticSum += f.salesAmount as number;
    else overseasSum += f.salesAmount as number;
  }
  const regionSum = domesticSum + overseasSum;
  const ot = facts.find((f) => f.regionKind === "overseas_total");
  const total = facts.find((f) => f.regionKind === "total");
  if (!ot || ot.salesAmount === null || ot.salesAmount !== overseasSum) {
    throw new Error("保存集合の海外売上高が地域合計と一致しません。");
  }
  if (total && total.salesAmount !== null && total.salesAmount < regionSum * 0.99) {
    throw new Error("保存集合の連結売上高が地域合計を下回ります。");
  }
  const ratio =
    total && total.salesAmount !== null && total.salesAmount > 0
      ? +((overseasSum / total.salesAmount) * 100).toFixed(1)
      : null;
  if (ot.ratioPct !== ratio) {
    throw new Error("保存集合の比率が再計算と一致しません。");
  }
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

/**
 * 位置情報つきで <table> を **全ネスト階層** で抜き出し、直前テキスト(見出し)も
 * 拾う。iXBRL の地域別売上表は外側のレイアウト表に **入れ子** で埋まっている
 * ことが多く (実有報で確認)、外側だけ見ると巨大ラッパに埋もれて構造化できない。
 * スタックで開始タグを積み、閉じタグで対応を取り、各階層の table を **内側から
 * 順に** 返す (より具体的な内側の表を先に試す)。見出しは各 table の開始直前
 * テキストから取る (内側の表ではセルの見出しになることもある)。
 */
function tablesWithHeading(
  html: string
): Array<{ table: string; heading: string; start: number }> {
  const out: Array<{ table: string; heading: string; start: number }> = [];
  const re = /<\/?table\b[^>]*>/gi;
  const stack: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[0][1] === "/") {
      const start = stack.pop();
      if (start === undefined) continue; // 壊れた HTML 防御
      const table = html.slice(start, re.lastIndex);
      const before = html.slice(Math.max(0, start - 400), start);
      const heading = before
        .replace(/<[^>]+>/g, " ")
        .replace(/&[a-zA-Z#0-9]+;/g, " ")
        .replace(/[\s\u3000]+/g, " ")
        .trim()
        .slice(-160);
      out.push({ table, heading, start });
    } else {
      stack.push(m.index);
    }
  }
  return out;
}

/**
 * 同一有報に地域別売上の表は複数ある (連結/個別・前期/当期・収益分解/セグメント
 * 情報)。最初に当たった表ではなく、**当期・連結・地域注記** に最も近い候補を
 * 選ぶための採点。誤った表 (個別・前期) の値を出さないための要 (ルール1)。
 */
function scoreCandidate(
  heading: string,
  flat: string,
  _status: OverseasParseStatus
): number {
  const ctx = heading + " " + flat;
  const hasCurrent = /当連結会計年度|当事業年度|当期/.test(ctx);
  const hasPrior = /前連結会計年度|前事業年度|前期/.test(ctx);
  let s = 0;
  if (/連結/.test(ctx)) s += 6;
  if (/個別|単体/.test(ctx) && !/連結/.test(ctx)) s -= 4;
  if (hasCurrent) s += 4;
  if (hasPrior && !hasCurrent) s -= 6; // 前期のみ = 旧年度の表
  if (/地域ごとの情報|地域別|主たる地域市場|所在地別/.test(ctx)) s += 3;
  if (/外部顧客/.test(flat)) s += 2;
  return s;
}

/**
 * type=1 ZIP から海外（地域別）売上を構造化する。確信が持てない表は status で
 * 明示し数値を捏造しない (ルール1/2)。
 */
export function parseOverseasData(
  zipBuf: Buffer,
  reportPeriodEnd: string
): OverseasExtraction {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportPeriodEnd)) {
    throw new Error(`reportPeriodEnd 形式が不正: ${reportPeriodEnd}`);
  }
  const entries = unzip(zipBuf);
  const picked = pickHonbunHtml(entries);
  if (!picked) {
    return {
      status: "no_overseas_table",
      facts: [],
      honbunFile: null,
      tablesScanned: 0,
    };
  }
  const r = parseOverseasHtml(picked.html, reportPeriodEnd);
  return { ...r, honbunFile: picked.name };
}

/**
 * 本文 iXBRL の HTML 文字列から海外（地域別）売上を構造化する。
 * テストは公開済み有報の実テーブル fixture をここへ直接食わせる。
 */
export function parseOverseasHtml(
  html: string,
  reportPeriodEnd: string
): Omit<OverseasExtraction, "honbunFile"> {
  const tables = tablesWithHeading(html);
  let tablesScanned = 0;
  let sawGeoSignal = false;

  interface Cand {
    status: OverseasParseStatus;
    facts: OverseasFact[];
    score: number;
    start: number;
  }
  const candidates: Cand[] = [];

  for (const { table, heading, start } of tables) {
    const grid = tableToGridExpanded(table);
    if (grid.length < 2) continue;
    const flat = grid.map((r) => r.join("")).join("");
    // 生産実績表は売上高の開示ではないので候補にしない (監査の取りこぼし集計にも
    // 入れない = sawGeoSignal を立てない。販売実績表など正規の売上表は別 fixture で固定)。
    if (isProductionTable(heading)) continue;
    const regionish =
      RX_OVERSEAS_REGION.test(flat) || /本邦|日本|海外売上高/.test(flat);
    if (!regionish) continue;
    tablesScanned++;

    let cand: { status: OverseasParseStatus; facts: OverseasFact[] } | null =
      null;
    {
      const rows = tryGeoRows(grid, reportPeriodEnd, heading);
      if (rows) cand = { status: "ok_geo_rows", facts: rows };
    }
    if (!cand) {
      const cols = tryGeoCols(grid, reportPeriodEnd, heading);
      if (cols) cand = { status: "ok_geo_cols", facts: cols };
    }
    if (cand) {
      candidates.push({
        ...cand,
        score: scoreCandidate(heading, flat, cand.status),
        start,
      });
    } else if (/日本|本邦/.test(flat) && RX_OVERSEAS_REGION.test(flat)) {
      // 日本(本邦) + 海外地域 + 数値 はあるが構造化できなかった → 取りこぼし候補
      sawGeoSignal = true;
    }
  }

  if (candidates.length > 0) {
    // 当期・連結・地域注記に最も近い候補を採用。同点は文書の早い方 (連結注記は
    // 個別注記より前に出る) を優先する。
    candidates.sort((a, b) => b.score - a.score || a.start - b.start);
    const best = candidates[0];
    return { status: best.status, facts: best.facts, tablesScanned };
  }

  return {
    status: sawGeoSignal ? "geo_present_unstructured" : "no_overseas_table",
    facts: [],
    tablesScanned,
  };
}
