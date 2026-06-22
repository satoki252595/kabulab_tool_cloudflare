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
 * 005 yuho-quant の実装を再利用する (重複を作らない)。海外売上高 固有の構造化
 * のみ本ファイルが担う。
 */
import { unzip } from "../../../yuho-quant/src/services/edinet/zip.js";
import {
  tableToGridExpanded,
  parseJpNumber,
  unitToYenFactor,
} from "../../../yuho-quant/src/services/edinet/html-table.js";

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
  /北米|南米|中南米|北中米|中米|米州|米大陸|アメリカ大陸|米国|アメリカ|欧州|ヨーロッパ|欧米|アジア|オセアニア|大洋州|アフリカ|中東|中国|中華圏|香港|韓国|台湾|タイ|ベトナム|インド|インドネシア|シンガポール|フィリピン|マレーシア|ドイツ|英国|フランス|イタリア|スペイン|オランダ|メキシコ|ブラジル|カナダ|豪州|オーストラリア|海外/;
/** 国内を表す語 (これに完全一致する行/列が domestic) */
const RX_DOMESTIC = /^(日本|本邦|国内|日本国内|わが国|我が国)$/;
/** 集計行/列 (地域ではない)。営業収益建て(トヨタ等の地域別営業概況)も含む */
const RX_AGGREGATE =
  /^(外部顧客への売上高|外部顧客に対する売上高|外部顧客への売上収益|外部顧客に対する売上収益|外部顧客への営業収益|外部顧客に対する営業収益|顧客との契約から生じる収益|売上高合計|売上収益合計|営業収益合計|営業収益|合計|総合計|総計|計|連結|連結売上高|連結計|連結財務諸表計上額)$/;
/** 「その他」系 (地域ブロック内なら overseas, 収益/事業文脈なら除外) */
const RX_OTHER_REGIONISH = /^(その他|その他の地域|その他地域|その他海外|外国|諸外国|直接輸出|輸出)$/;

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

  // 行ラベルの地域分類
  const roles = gridX.map((r) => classifyRegion(r[0] ?? ""));
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

  let domesticSum = 0;
  let regionSum = 0;
  // 集計行 (顧客との契約から生じる収益 / 外部顧客への売上高 / 合計 / 連結) を
  // すべて控える。地域行は「顧客との契約」水準で按分され、「外部顧客への売上高」
  // はそれに非地域分の『その他の収益』を足した広い総額になることがあるため、
  // 検証は「地域合計がいずれかの集計行と一致するか」で行う。
  const aggregates: Array<{ label: string; value: number }> = [];
  const facts: OverseasFact[] = [];
  const consolidated = detectConsolidated(gridX.flat().join(" "));

  for (let i = firstNum; i < gridX.length; i++) {
    const row = gridX[i];
    if (row.length <= vc) continue;
    const role = classifyRegion(row[0] ?? "");
    const v = parseJpNumber(row[vc] ?? "");
    if (role === "aggregate") {
      if (v !== null && /外部顧客|顧客との契約|合計|連結/.test(norm(row[0]))) {
        aggregates.push({ label: norm(row[0]), value: v });
      }
      continue;
    }
    if (role !== "domestic" && role !== "overseas") continue;
    if (v === null) continue;
    if (!Number.isInteger(v)) return null; // 小数 = % 列誤認 → 却下
    const name = cleanLabel(row[0] ?? "");
    if (name === "") continue;
    if (role === "domestic") domesticSum += v;
    regionSum += v;
    facts.push({
      regionName: name,
      regionKind: role,
      salesAmount: v,
      ratioPct: null,
      unitLabel: unit.label,
      unitYenFactor: unit.factor,
      fiscalYearEnd,
      isConsolidated: consolidated,
    });
  }

  if (facts.length < 2 || domesticSum <= 0) return null;
  // 検証: 集計行が開示されているなら、地域合計が **いずれかの集計行** と一致する
  // こと (= 正しい列を読み地域を取りこぼしていない)。一致が無ければ誤読として却下。
  const matched = aggregates.find((a) => totalsConsistent(regionSum, a.value));
  if (aggregates.length > 0 && !matched) return null;
  // 分母 (連結売上高): 実際の総売上 = 外部顧客への売上高 を最優先。無ければ
  // 連結/合計、無ければ一致した集計、無ければ地域合計。
  const total =
    aggregates.find((a) => /外部顧客/.test(a.label))?.value ??
    aggregates.find((a) => /連結|合計/.test(a.label))?.value ??
    matched?.value ??
    regionSum;
  // 海外売上高 = 開示された海外地域行の合計 (= regionSum − 国内)。total − 国内に
  // すると「その他の収益」等の非地域分を海外に混入させるため使わない (ルール1)。
  const overseasTotal = regionSum - domesticSum;
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
  const facts: OverseasFact[] = [];
  let domesticSum = 0;
  let regionSum = 0;
  const EXCL = /調整額?|セグメント間|内部|消去|割合|％|%/;
  for (let ci = 0; ci < width; ci++) {
    if (ci === totalCol) continue;
    const role = colRole[ci];
    if (role !== "domestic" && role !== "overseas") continue;
    const h = norm(gridX[headerIdx][ci] ?? "");
    if (EXCL.test(h)) continue;
    const v = parseJpNumber(gridX[valueRow][ci] ?? "");
    if (v === null) continue;
    if (!Number.isInteger(v)) return null;
    if (role === "domestic") domesticSum += v;
    regionSum += v;
    facts.push({
      regionName: cleanLabel(gridX[headerIdx][ci] ?? ""),
      regionKind: role,
      salesAmount: v,
      ratioPct: null,
      unitLabel: unit.label,
      unitYenFactor: unit.factor,
      fiscalYearEnd,
      isConsolidated: consolidated,
    });
  }
  if (facts.length < 2 || domesticSum <= 0) return null;

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
