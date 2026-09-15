/**
 * 有価証券報告書から「受注高 / 受注残高」をセグメント別 + 全社合計で
 * 構造化する決定論的パーサ。
 *
 * 調査（削除済みの一時スクリプト data-scripts/investigate*.ts と tmp/）で
 * 実データを精査した結果、
 * 受注の開示は概ね次の 2 パターンに集約される。どちらにも確信を持って
 * 当てはまらない表は **でっち上げず** status で明示する (CLAUDE.md ルール1/2)。
 *
 *  Pattern A (製造・重工・機械・電機の受注生産):
 *    見出しに「受注高」と「受注残高(or 期末受注残高)」を持つセグメント表。
 *    例 7011/7012/7013 — [セグメント, 受注高, 前期比%, 受注残高, 前期比%]。
 *    当該有報の当期 (連結) 1 期分のスナップショット。
 *
 *  Pattern B (建設業の完成工事):
 *    見出しに「当期受注高」と「期末繰越高」を持つ 期別×種類別 の表。
 *    例 1812 — 当期受注高=受注高, 期末繰越高=受注残高 相当。前事業年度 +
 *    当事業年度 の 2 期分を含む。
 *
 * 入力は書類取得 API type=1 (XBRL) の ZIP。受注表は本文 iXBRL
 * (XBRL/PublicDoc/..._honbun_jpcrp030000-asr-..._ixbrl.htm) の <table> にある。
 */
import { unzip } from "./zip.js";
import {
  extractTables,
  tableToGrid,
  tableToGridExpanded,
  parseJpNumber,
  unitToYenFactor,
} from "./html-table.js";

export type SegmentKind = "segment" | "subtotal" | "total" | "elimination";

export interface OrderFact {
  /** 表記そのままのセグメント名 (例: "エナジー", "建築工事", "合計") */
  segmentName: string;
  segmentKind: SegmentKind;
  /** 受注高 (表の単位のまま。欠損は null = 0 で埋めない) */
  ordersReceived: number | null;
  /** 受注残高 / 期末繰越高 (表の単位のまま。欠損は null) */
  orderBacklog: number | null;
  /** 金額単位ラベル (例: "百万円") */
  unitLabel: string;
  /** 単位 → 円 への倍率 */
  unitYenFactor: number;
  /** この行が属する会計期末 YYYY-MM-DD */
  fiscalYearEnd: string;
  /** 連結=true / 個別=false / 判定不能=null (推測しない) */
  isConsolidated: boolean | null;
}

export type ParseStatus =
  | "ok_pattern_a"
  | "ok_pattern_b"
  | "ok_pattern_c"
  | "ok_total_only"
  | "orders_only"
  | "table_unrecognized"
  | "no_order_table";

export interface OrderExtraction {
  status: ParseStatus;
  facts: OrderFact[];
  honbunFile: string | null;
  tablesScanned: number;
}

/**
 * 受注開示の有無を判定する語 (CSV 事前判定・対象表抽出で共用)。
 * 建設業は会社により列名が揺れる (鹿島=当期受注高/期末繰越高,
 * 清水=当期受注(契約)高/次期繰越高 等) ため広めに取る。これは
 * 「重い XBRL を落とすか / どの表を見るか」のゲートに過ぎず、実際の
 * 構造化は後段の厳密分類で確信が持てた表だけ行う (ルール1/2)。
 */
export const RX_ORDER_KEYWORD =
  /受注高|受注残高|受注実績|当期受注|受注\(契約\)高|受注（契約）高|繰越工事高|期末繰越高|次期繰越高|受注工事高/;
const RX_ORDERS_COL = /受注高/;
const RX_BACKLOG_COL = /受注残高|期末受注残高/;
/** 建設業 完成工事表の受注列: 当期受注高 / 当期 受注(契約)高 等 */
const RX_CONSTRUCTION = /当期.{0,2}受注(\(契約\)|（契約）)?.{0,2}高/;
/** 建設業 完成工事表の残高列: 期末繰越高 / 次期繰越高 */
const RX_CONSTRUCTION_BACKLOG = /(期末|次期).{0,2}繰越高/;

function pickHonbunHtml(entries: Map<string, Buffer>): {
  name: string;
  html: string;
} | null {
  const names = [...entries.keys()];
  // 本文 iXBRL を最優先。無ければ PublicDoc 配下の htm を全て候補に。
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
  // 受注キーワードを含む htm を選ぶ
  for (const n of list) {
    const html = entries.get(n)!.toString("utf8");
    if (RX_ORDER_KEYWORD.test(html)) return { name: n, html };
  }
  return { name: list[0], html: entries.get(list[0])!.toString("utf8") };
}

function classifyRow(label: string): SegmentKind {
  const s = label.replace(/[\s\u3000]/g, "");
  if (/(全社又は消去|全社・消去|調整額|内部取引消去|消去又は全社|セグメント間)/.test(s)) {
    return "elimination";
  }
  // 末尾が「合計」= 全社合計 (報告セグメント合計/工事合計/総合計 等を含む)。
  // 「会計」(U+4F1A) とは別字なので /合計$/ で誤検出しない。
  if (/合計$/.test(s)) return "total";
  if (/(報告セグメント計|セグメント計|^計$|小計)/.test(s)) return "subtotal";
  return "segment";
}

function detectConsolidated(headerText: string): boolean | null {
  if (/連結/.test(headerText)) return true;
  if (/事業年度/.test(headerText) && !/連結/.test(headerText)) return false;
  return null;
}

function detectUnit(text: string): { label: string; factor: number } {
  for (const u of ["百万円", "千円", "億円", "円"]) {
    if (text.includes(u)) return { label: u, factor: unitToYenFactor(u) };
  }
  // ルール2: 単位不明は throw (推測で円換算しない)
  throw new Error("受注表の金額単位が判定できません (百万円/千円/億円/円 いずれも無し)");
}

/** 末尾の単位括弧 (（百万円）/(千円) 等) を除いた表示用ラベル */
function stripUnitSuffix(name: string): string {
  return name
    .replace(/[（(](?:百万円|千円|億円|円)[)）]\s*$/u, "")
    .replace(/[\s\u3000]+$/u, "")
    .trim();
}

/** 単位を grid 全体テキストから検出。無ければ null (throw しない) */
function detectUnitOrNull(
  text: string
): { label: string; factor: number } | null {
  for (const u of ["百万円", "千円", "億円", "円"]) {
    if (text.includes(u)) return { label: u, factor: unitToYenFactor(u) };
  }
  return null;
}

/**
 * Pattern A: 受注高 + 受注残高 セグメント表 (展開グリッド版)。
 *
 * colspan/rowspan を展開した grid で、各列の見出しを縦に結合して
 * 受注高列・受注残高列を特定する。これにより
 *  - 単行ヘッダ (7012/7013/7883/6360)
 *  - 2 行ヘッダ (受注高/受注残高 が金額・前年比に分岐: 6776/7949/7011)
 *  - 単位がセグメント名側にある表 (6306/6360)
 * を統一的に扱う。確信が持てない表は数値を作らず null (ルール1/2)。
 */
function tryPatternA(
  gridX: string[][],
  fiscalYearEnd: string
): OrderFact[] | null {
  const flat = gridX.map((r) => r.join("")).join("");
  if (!RX_ORDERS_COL.test(flat) || !RX_BACKLOG_COL.test(flat)) return null;

  // データ行 = 行頭が非数値ラベル かつ 数値セルが 2 つ以上
  const firstData = gridX.findIndex(
    (row) =>
      row.length >= 3 &&
      (row[0] ?? "").replace(/[\s\u3000]/g, "") !== "" &&
      parseJpNumber(row[0]) === null &&
      row.slice(1).filter((c) => parseJpNumber(c) !== null).length >= 2
  );
  if (firstData < 1) return null;
  const headerRows = gridX.slice(0, firstData);
  const dataRows = gridX.slice(firstData);
  const width = Math.max(...gridX.map((r) => r.length));

  // 各列の見出し = ヘッダ各行の同列セルを縦結合 (空白除去)
  const colHeader: string[] = [];
  for (let ci = 0; ci < width; ci++) {
    colHeader[ci] = headerRows
      .map((r) => r[ci] ?? "")
      .join("")
      .replace(/[\s\u3000]/g, "");
  }
  const EXCLUDE =
    /比|増減|前年|前期|前連結|前事業|前中間|売上|営業損益|生産|販売|累計/;
  const orderCands = colHeader
    .map((h, i) => ({ h, i }))
    .filter((x) => RX_ORDERS_COL.test(x.h) && !EXCLUDE.test(x.h));
  const backlogCands = colHeader
    .map((h, i) => ({ h, i }))
    .filter((x) => RX_BACKLOG_COL.test(x.h) && !EXCLUDE.test(x.h));
  // 受注高/受注残高 の金額列候補が複数 = 数量列併記等で曖昧 → 捏造せず却下
  if (orderCands.length !== 1 || backlogCands.length !== 1) return null;
  const ordersCol = orderCands[0].i;
  const backlogCol = backlogCands[0].i;
  if (ordersCol === backlogCol) return null;

  const unit = detectUnitOrNull(flat);
  if (!unit) return null; // 単位不明は確信なし → 未対応 (捏造しない)
  const consolidated = detectConsolidated(gridX.flat().join(" "));

  const facts: OrderFact[] = [];
  for (const row of dataRows) {
    if (row.length <= Math.max(ordersCol, backlogCol)) continue;
    const rawName = (row[0] ?? "").trim();
    if (rawName === "" || parseJpNumber(rawName) !== null) continue;
    const name = stripUnitSuffix(rawName);
    if (name === "") continue;
    facts.push({
      segmentName: name,
      segmentKind: classifyRow(name),
      ordersReceived: parseJpNumber(row[ordersCol]),
      orderBacklog: parseJpNumber(row[backlogCol]),
      unitLabel: unit.label,
      unitYenFactor: unit.factor,
      fiscalYearEnd,
      isConsolidated: consolidated,
    });
  }
  if (!facts.some((f) => f.ordersReceived !== null || f.orderBacklog !== null)) {
    return null;
  }

  // --- 厳格バリデーション (誤判定の表は数値を作らず却下: ルール1/2) ---
  const segs = facts.filter((f) => f.segmentKind === "segment");
  if (segs.length === 0) return null;

  // (a) セグメント名が数値/括弧のみ = ラベル列ずれ → 却下
  const numericNameRe = /^[（(]?[△▲+-]?[\d,]+(\.\d+)?[）)]?$/;
  if (
    segs.some((f) =>
      numericNameRe.test(f.segmentName.replace(/[\s\u3000]/g, ""))
    )
  ) {
    return null;
  }
  // (b) 同一セグメント名の重複 = 地域別×製品 等の多段表 → 却下
  const segNames = segs.map((f) => f.segmentName);
  if (new Set(segNames).size !== segNames.length) return null;

  // (c) 受注高/受注残高 は整数で開示。小数 = % 列誤認 → 却下
  const vals = facts.flatMap((f) =>
    [f.ordersReceived, f.orderBacklog].filter((v): v is number => v !== null)
  );
  if (vals.length === 0 || vals.some((v) => !Number.isInteger(v))) return null;

  // (d) 集計行は任意。合計行が無いセグメント表 (例 3076/9698 = 計/合計を
  //     印字しない) も、(a)(b)(c) を通った時点で正規表とみなし採用する
  //     (会社全体は合算で捏造しない=screen側で total 無しは除外)。
  //     'total' が無く集計行が 1 つだけなら (例 7883「計」のみ) それを総計に
  //     昇格。集計行が複数で 'total' 無し = 総計が曖昧 → 昇格しない。
  const agg = facts.filter(
    (f) => f.segmentKind === "total" || f.segmentKind === "subtotal"
  );
  if (!facts.some((f) => f.segmentKind === "total") && agg.length === 1) {
    agg[0].segmentKind = "total";
  }

  return facts;
}

/** 全角数字 ０-９ を半角へ (有報の和暦/西暦表記は全角混在) */
function toHalfWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (d) =>
    String.fromCharCode(d.charCodeAt(0) - 0xfee0)
  );
}

function shiftFiscalYear(iso: string, deltaYears: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y + deltaYears}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Pattern B: 建設業 完成工事 (期別×種類別, 当期受注高/期末繰越高) */
function tryPatternB(
  grid: string[][],
  fiscalYearEnd: string
): OrderFact[] | null {
  const flat = grid.map((r) => r.join(" ")).join(" ");
  if (!RX_CONSTRUCTION.test(flat) || !RX_CONSTRUCTION_BACKLOG.test(flat)) {
    return null;
  }
  const headerIdx = grid.findIndex(
    (r) => r.some((c) => RX_CONSTRUCTION.test(c)) && r.some((c) => RX_CONSTRUCTION_BACKLOG.test(c))
  );
  if (headerIdx < 0) return null;
  const header = grid[headerIdx];

  // 見出しの数値列 (期首繰越高/当期受注高/計/当期売上高/期末繰越高 等) の並び
  // 数値列 = 金額単位付き見出しセル。会社で列名が揺れる (清水=
  // 当期受注(契約)高/次期繰越高, 鹿島=当期受注高/期末繰越高) ため
  // 「単位付き列」で K を決め、受注/残高はその相対位置で取る (決定論的)。
  const numericHeaders = header.filter((c) => /百万円|千円|億円/.test(c));
  const ordersPos = numericHeaders.findIndex((c) => RX_CONSTRUCTION.test(c));
  const backlogPos = numericHeaders.findIndex((c) => RX_CONSTRUCTION_BACKLOG.test(c));
  if (ordersPos < 0 || backlogPos < 0 || numericHeaders.length < 2) return null;
  const K = numericHeaders.length;

  const unit = detectUnit(header.join(" "));
  const consolidated = detectConsolidated(grid.flat().join(" "));

  const facts: OrderFact[] = [];
  let curFiscal = fiscalYearEnd;
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i];
    const joined = row.join("").replace(/[\s\u3000]/g, "");
    // 期の確定: 「至YYYY年M月D日」があれば会計期末を直接読む (清水=
    // 第NNN期+自至日付, 鹿島=前/当事業年度ラベル の両方に対応)。
    const toDate = toHalfWidthDigits(joined).match(
      /至(\d{4})年(\d{1,2})月(\d{1,2})日/
    );
    if (toDate) {
      curFiscal = `${toDate[1]}-${toDate[2].padStart(2, "0")}-${toDate[3].padStart(2, "0")}`;
    } else if (/前事業年度|前連結会計年度/.test(joined)) {
      curFiscal = shiftFiscalYear(fiscalYearEnd, -1);
    } else if (/当事業年度|当連結会計年度/.test(joined)) {
      curFiscal = fiscalYearEnd;
    }
    // 末尾 K 個の数値セルを値とみなし、その直前セルを種類別ラベルとする
    const nums = row
      .map((c, idx) => ({ idx, v: parseJpNumber(c) }))
      .filter((x) => x.v !== null);
    if (nums.length < K) continue;
    const tail = nums.slice(-K);
    const firstValIdx = tail[0].idx;
    if (firstValIdx < 1) continue;
    const label = row[firstValIdx - 1];
    if (label === "" || parseJpNumber(label) !== null) continue;
    facts.push({
      segmentName: label,
      segmentKind: classifyRow(label),
      ordersReceived: tail[ordersPos].v,
      orderBacklog: tail[backlogPos].v,
      unitLabel: unit.label,
      unitYenFactor: unit.factor,
      fiscalYearEnd: curFiscal,
      isConsolidated: consolidated,
    });
  }
  if (facts.length === 0) return null;
  return facts;
}

// Pattern C: 設備/建設業の「完成工事高 区分別」表 (例 1736 オーテック)。
// 区分(新設/既設/保守/工事合計 等) × [期首繰越工事高, 当期受注工事高, 計,
// 当期完成工事高, 期末繰越工事高(=手持工事高), %, うち施工高, 当期施工高]。
// 多段ヘッダ + 年度別に別テーブル。当期受注工事高=受注高,
// 期末繰越工事高(手持工事高)=受注残高相当。Pattern B の 当期受注高/期末
// 繰越高 とは列名 (工事 が入る) で別物なので衝突しない。
const RX_C_ORDERS = /当期.{0,3}受注.{0,4}工事高/;
const RX_C_BACKLOG = /(期末|次期).{0,3}繰越工事高|期末.{0,3}手持工事高/;

function classifyConstructionRow(label: string): SegmentKind {
  const s = label.replace(/[\s\u3000]/g, "");
  if (/^(工事)?合計$|^総合計$/.test(s)) return "total";
  if (/計$/.test(s)) return "subtotal";
  return "segment";
}

/**
 * Pattern C を 1 テーブル分パースする。会計期末は呼び出し側がテーブル
 * 出現順 (前事業年度→当事業年度) から確定して渡す。確信が持てなければ
 * null を返し数値を作らない (ルール1/2)。
 */
function tryPatternC(
  grid: string[][],
  fiscalYearEnd: string
): OrderFact[] | null {
  const flat = grid.map((r) => r.join("")).join("");
  if (!RX_C_ORDERS.test(flat) || !RX_C_BACKLOG.test(flat)) return null;

  const firstData = grid.findIndex(
    (row) =>
      row.length >= 4 &&
      parseJpNumber(row[0]) === null &&
      row[0].replace(/[\s\u3000]/g, "") !== "" &&
      !/工事高|繰越|受注|施工|区分|（千円）|\(千円\)/.test(row[0]) &&
      row.slice(1).filter((c) => parseJpNumber(c) !== null).length >= 3
  );
  if (firstData < 1) return null;

  const headerRows = grid.slice(0, firstData);
  const width = Math.max(...grid.map((r) => r.length));
  const colHeader: string[] = [];
  for (let ci = 0; ci < width; ci++) {
    colHeader[ci] = headerRows
      .map((r) => r[ci] ?? "")
      .join("")
      .replace(/[\s\u3000]/g, "");
  }

  const colReceived = colHeader.findIndex(
    (h) => RX_C_ORDERS.test(h) && !/繰越|完成|施工/.test(h)
  );
  // 期末繰越工事高(=手持工事高) の「うち施工高」「(％)」でない総額列
  const colBacklog = colHeader.findIndex(
    (h) =>
      RX_C_BACKLOG.test(h) &&
      !/うち施工高|施工高/.test(h) &&
      !/[%％]/.test(h) &&
      !/当期受注|完成/.test(h)
  );
  if (colReceived < 0 || colBacklog < 0) return null;

  const unit = detectUnit(headerRows.flat().join(" "));

  const facts: OrderFact[] = [];
  for (let i = firstData; i < grid.length; i++) {
    const row = grid[i];
    const name = (row[0] ?? "").trim();
    if (name === "" || parseJpNumber(name) !== null) continue;
    if (row.length <= Math.max(colReceived, colBacklog)) continue;
    const o = parseJpNumber(row[colReceived]);
    const b = parseJpNumber(row[colBacklog]);
    if (o === null && b === null) continue;
    facts.push({
      segmentName: name,
      segmentKind: classifyConstructionRow(name),
      ordersReceived: o,
      orderBacklog: b,
      unitLabel: unit.label,
      unitYenFactor: unit.factor,
      fiscalYearEnd,
      isConsolidated: detectConsolidated(grid.flat().join(" ")),
    });
  }

  // 厳格バリデーション (ルール1/2: 確信なき表は数値を作らない)
  const segs = facts.filter((f) => f.segmentKind === "segment");
  if (segs.length === 0) return null;
  const numericName = /^[（(]?[△▲+-]?[\d,]+(\.\d+)?[）)]?$/;
  if (segs.some((f) => numericName.test(f.segmentName.replace(/[\s\u3000]/g, "")))) {
    return null;
  }
  const names = segs.map((f) => f.segmentName);
  if (new Set(names).size !== names.length) return null;
  const vals = facts.flatMap((f) =>
    [f.ordersReceived, f.orderBacklog].filter((v): v is number => v !== null)
  );
  if (vals.length === 0 || vals.some((v) => !Number.isInteger(v))) return null;
  if (!facts.some((f) => f.segmentKind === "total")) return null;
  return facts;
}

/**
 * 全社合計のみ抽出フォールバック (Pattern A/B/C で構造化できない表向け)。
 *
 * 2 階層セグメント (地域×製品 等) や 数量×金額併記の受注表は per-segment
 * 構造化を捏造リスクで却下する (ルール1/2) が、開示済みの「合計/総合計」
 * (無ければ唯一の「計/報告セグメント計」) 行は実値であり会社全体の
 * 受注高/受注残高として確実に取得できる。ユーザ要件「会社全体でOK」。
 *
 * 確信が持てない場合 (受注/残高列が一意に定まらない・合計行が0/複数・
 * 単位不明・非整数) は null を返し数値を作らない。
 */
function tryOrderTotalOnly(
  gridX: string[][],
  fiscalYearEnd: string
): OrderFact[] | null {
  const flat = gridX.map((r) => r.join("")).join("");
  if (!RX_ORDERS_COL.test(flat)) return null;

  const firstData = gridX.findIndex(
    (row) =>
      row.length >= 3 &&
      (row[0] ?? "").replace(/[\s\u3000]/g, "") !== "" &&
      parseJpNumber(row[0]) === null &&
      row.slice(1).filter((c) => parseJpNumber(c) !== null).length >= 2
  );
  if (firstData < 1) return null;
  const headerRows = gridX.slice(0, firstData);
  const width = Math.max(...gridX.map((r) => r.length));
  const colHeader: string[] = [];
  for (let ci = 0; ci < width; ci++) {
    colHeader[ci] = headerRows
      .map((r) => r[ci] ?? "")
      .join("")
      .replace(/[\s\u3000]/g, "");
  }
  // 受注/残高の「金額」列を一意に決める。比率/前年/数量(トン/屯) は除外。
  const EXC = /比|増減|前年|前期|前連結|前事業|前中間|売上|営業損益|生産|販売|累計|構成|数量|トン|屯/;
  const pick = (re: RegExp): number => {
    const cs = colHeader
      .map((h, i) => ({ h, i }))
      .filter((x) => re.test(x.h) && !EXC.test(x.h));
    if (cs.length === 1) return cs[0].i;
    const amt = cs.filter((x) => /金額|百万円|千円|億円|円/.test(x.h));
    return amt.length === 1 ? amt[0].i : -1;
  };
  const ordersCol = pick(/受注高|当期.{0,2}受注(\(契約\)|（契約）)?.{0,2}高/);
  const backlogCol = pick(
    /受注残高|期末受注残高|(次期|期末).{0,3}繰越.{0,2}(工事)?高|手持.{0,2}高/
  );
  if (ordersCol < 0) return null;

  const unit = detectUnitOrNull(flat);
  if (!unit) return null;

  // 合計/総合計 行を最優先。無ければ唯一の 計/報告セグメント計 を採用。
  const dataRows = gridX.slice(firstData);
  const labelOf = (row: string[]) =>
    stripUnitSuffix((row[0] ?? "").trim()).replace(/[\s\u3000]/g, "");
  const goukei = dataRows.filter((r) => /^(合計|総合計)$/.test(labelOf(r)));
  let chosen: string[] | null = null;
  if (goukei.length === 1) chosen = goukei[0];
  else if (goukei.length === 0) {
    const kei = dataRows.filter((r) =>
      /^(計|報告セグメント計|報告セグメント合計)$/.test(labelOf(r))
    );
    if (kei.length === 1) chosen = kei[0];
  }
  if (!chosen) return null; // 合計行が 0 / 複数 → 曖昧, 作らない

  const o = parseJpNumber(chosen[ordersCol]);
  const b = backlogCol >= 0 ? parseJpNumber(chosen[backlogCol]) : null;
  if (o === null && b === null) return null;
  if (o !== null && !Number.isInteger(o)) return null;
  if (b !== null && !Number.isInteger(b)) return null;

  return [
    {
      segmentName: labelOf(chosen) || "合計",
      segmentKind: "total",
      ordersReceived: o,
      orderBacklog: b,
      unitLabel: unit.label,
      unitYenFactor: unit.factor,
      fiscalYearEnd,
      isConsolidated: detectConsolidated(gridX.flat().join(" ")),
    },
  ];
}

/**
 * type=1 ZIP から受注高/受注残高を構造化する。確信が持てない表は
 * status で明示し、数値を捏造しない (ルール1/2)。
 *
 * @param zipBuf      書類取得 API type=1 (XBRL) の ZIP
 * @param reportPeriodEnd 当該有報の会計期末 YYYY-MM-DD (EDINET periodEnd)
 */
export function parseOrderData(
  zipBuf: Buffer,
  reportPeriodEnd: string
): OrderExtraction {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportPeriodEnd)) {
    throw new Error(`reportPeriodEnd 形式が不正: ${reportPeriodEnd}`);
  }
  const entries = unzip(zipBuf);
  const picked = pickHonbunHtml(entries);
  if (!picked) {
    return { status: "no_order_table", facts: [], honbunFile: null, tablesScanned: 0 };
  }
  const r = parseOrderHtml(picked.html, reportPeriodEnd);
  return { ...r, honbunFile: picked.name };
}

/**
 * 本文 iXBRL の HTML 文字列から受注を構造化する (ZIP 展開を切り離した本体)。
 * テストは公開済み有報の実テーブル fixture をここへ直接食わせる。
 */
export function parseOrderHtml(
  html: string,
  reportPeriodEnd: string
): Omit<OrderExtraction, "honbunFile"> {
  const tables = extractTables(html).filter((t) => RX_ORDER_KEYWORD.test(t));
  if (tables.length === 0) {
    return { status: "no_order_table", facts: [], tablesScanned: 0 };
  }

  let sawOrdersOnly = false;
  for (const t of tables) {
    const grid = tableToGrid(t);
    if (grid.length < 2) continue;

    // Pattern A は colspan/rowspan 展開グリッドで列を特定する
    // (2 行ヘッダ・単位がラベル側 等の取りこぼし回収)
    const a = tryPatternA(tableToGridExpanded(t), reportPeriodEnd);
    if (a) {
      return { status: "ok_pattern_a", facts: a, tablesScanned: tables.length };
    }
    const b = tryPatternB(grid, reportPeriodEnd);
    if (b) {
      return { status: "ok_pattern_b", facts: b, tablesScanned: tables.length };
    }
    const flat = grid.map((row) => row.join(" ")).join(" ");
    if (RX_ORDERS_COL.test(flat) && !RX_BACKLOG_COL.test(flat)) {
      sawOrdersOnly = true;
    }
  }

  // Pattern C: 設備/建設「完成工事高 区分別」(年度別に別テーブル)。
  // 出現順 = 前事業年度 → 当事業年度。最後のテーブルが当該有報の会計期末、
  // それ以前は 1 年ずつ過去。全 C テーブルが確信を持ってパースできた場合のみ
  // ok_pattern_c とする (一部でも不確実なら数値を作らない: ルール1/2)。
  const cGrids = tables
    .map((t) => tableToGridExpanded(t))
    .filter((g) => g.length >= 2 && tryPatternC(g, reportPeriodEnd) !== null);
  if (cGrids.length > 0) {
    const facts: OrderFact[] = [];
    let ok = true;
    cGrids.forEach((g, idx) => {
      const fy = shiftFiscalYear(reportPeriodEnd, -(cGrids.length - 1 - idx));
      const f = tryPatternC(g, fy);
      if (!f) ok = false;
      else facts.push(...f);
    });
    if (ok && facts.length > 0) {
      return { status: "ok_pattern_c", facts, tablesScanned: tables.length };
    }
  }

  // 全社合計のみフォールバック (A/B/C 不可の 2 階層/数量金額表)。
  // 単一年テーブルのみ対象 (合計行が複数=多期は曖昧として作らない)。
  for (const t of tables) {
    const gx = tableToGridExpanded(t);
    if (gx.length < 3) continue;
    const to = tryOrderTotalOnly(gx, reportPeriodEnd);
    if (to) {
      return {
        status: "ok_total_only",
        facts: to,
        tablesScanned: tables.length,
      };
    }
  }

  return {
    status: sawOrdersOnly ? "orders_only" : "table_unrecognized",
    facts: [],
    tablesScanned: tables.length,
  };
}
