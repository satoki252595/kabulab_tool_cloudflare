/**
 * JPX 公式 HTML 表の厳密パース共通部品 (Issue #196)。
 *
 * 依存ゼロ (stdlib のみ)。HTML パーサライブラリは使わない。
 * EDINET 側の汎用 grid (`services/yuho-quant/.../html-table.ts`) との
 * 共通化は検討済み: あちらは不正 span を 1 補完する寛容実装で、
 * こちらは未知を throw する厳密実装が必要なため意味が合わない。
 * cellText/extractTables の流儀 (タグ→空白・実体解決・入れ子対応) は
 * 踏襲し、NFC 正規化と RawCell (原文保持) だけ JPX 要件で拡張した。
 * EDINET 側の挙動変更はない。
 */
import type {} from "node:util";
import { parseStockCode } from "./stock-code.js";

export type RawCell = {
  /** 正規化セル文 (タグ除去・実体解決・NFC・空白潰し)。 */
  text: string;
  /** セル内 HTML 原文 (リンク優先抽出など構造参照用)。 */
  html: string;
};

export type RawTable = {
  /** slice 位置 (0-based。選択時は疎になる)。 */
  tableIndex: number;
  /** table 開始タグのバイトオフセット (年見出しとの対応付け用)。 */
  startIndex: number;
  /** thead 行群 (thead が無ければ空。推測で補わない)。 */
  head: RawCell[][];
  /** tbody 行群 (tbody が無ければ thead 外の全行)。 */
  body: RawCell[][];
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) =>
      String.fromCodePoint(Number.parseInt(h, 16))
    )
    .replace(/&#([0-9]+);/g, (_, d: string) =>
      String.fromCodePoint(Number.parseInt(d, 10))
    )
    .replace(/&([a-zA-Z]+);/g, (m, n: string) => NAMED_ENTITIES[n] ?? m);
}

/**
 * セル内 HTML → 比較可能な文。タグは空白に置換 (語の癒着防止)・
 * 実体解決・NFC・空白潰し・trim。
 */
export function cellText(cellHtml: string): string {
  return decodeEntities(cellHtml.replace(/<[^>]*>/g, " "))
    .normalize("NFC")
    .replace(/[\s\u00a0]+/g, " ")
    .trim();
}

/**
 * span 属性の厳密読み。属性欠落だけが規定値 1。属性が存在すれば
 * 値全体が正整数でなければ throw (`rowspan="x"` も `rowspan="2junk"` も NG)。
 */
function attrInt(tag: string, name: string, context: string): number {
  if (!new RegExp(`\\b${name}\\s*=`, "i").test(tag)) return 1;
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']?([^\\s"'/>]+)`, "i"));
  const rawValue = m?.[1] ?? "";
  if (!/^[0-9]+$/.test(rawValue)) {
    throw new Error(`${context}: 不正 span 属性 ${name}="${rawValue}"`);
  }
  const n = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`${context}: 不正 span 属性 ${name}="${rawValue}"`);
  }
  return n;
}

type SpanCell = {
  cell: RawCell;
  colspan: number;
  rowspan: number;
};

/**
 * 行群を rowspan/colspan 展開して長方形グリッドにする (厳密版)。
 * 不正 span (0/非数値/重なり/はみ出し) は推測せず throw する。
 * 結合セルは全展開先へ複製する。
 */
export function expandGrid(
  rowsHtml: string[],
  context: string
): RawCell[][] {
  const parsed: SpanCell[][] = rowsHtml.map((rowHtml, ri) => {
    const cells: SpanCell[] = [];
    const cellRe = /<(t[dh])\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(rowHtml)) !== null) {
      const tag = c[2] ?? "";
      const inner = c[3] ?? "";
      const cellCtx = `${context} row ${ri}`;
      const colspan = attrInt(tag, "colspan", cellCtx);
      const rowspan = attrInt(tag, "rowspan", cellCtx);
      cells.push({
        cell: { text: cellText(inner), html: inner },
        colspan,
        rowspan,
      });
    }
    return cells;
  });

  const grid: RawCell[][] = [];
  const carry = new Map<number, { cell: RawCell; left: number }>();
  for (let ri = 0; ri < parsed.length; ri++) {
    const out: RawCell[] = [];
    let col = 0;
    const row = parsed[ri] as SpanCell[];
    for (const span of row) {
      while (carry.has(col) && (carry.get(col) as { left: number }).left > 0) {
        const held = carry.get(col) as { cell: RawCell; left: number };
        out[col] = held.cell;
        held.left--;
        col++;
      }
      for (let k = 0; k < span.colspan; k++) {
        // colspan が未消費 carry を跨いで上書きする前に検出する。
        const crossing = carry.get(col);
        if (out[col] !== undefined || (crossing !== undefined && crossing.left > 0)) {
          throw new Error(
            `${context}: span 重なり (row ${ri} col ${col})`
          );
        }
        out[col] = span.cell;
        if (span.rowspan > 1) {
          carry.set(col, { cell: span.cell, left: span.rowspan - 1 });
        }
        col++;
      }
    }
    let maxCarry = -1;
    for (const [ci, held] of carry) {
      if (held.left > 0) maxCarry = Math.max(maxCarry, ci);
    }
    while (col <= maxCarry) {
      const held = carry.get(col);
      if (held && held.left > 0) {
        out[col] = held.cell;
        held.left--;
      }
      col++;
    }
    if (out.some((cell) => cell !== undefined)) {
      const finished = Array.from({ length: out.length }, (_, i) => {
        const cell = out[i];
        if (cell === undefined) {
          throw new Error(`${context}: 展開欠落 (row ${ri} col ${i})`);
        }
        return cell;
      });
      const expected =
        grid.length > 0 ? (grid[0] as RawCell[]).length : finished.length;
      if (finished.length !== expected) {
        throw new Error(
          `${context}: 行幅不一致 (row ${ri} 幅=${finished.length} 期待=${expected})`
        );
      }
      grid.push(finished);
    }
  }
  for (const [ci, held] of carry) {
    if (held.left > 0) {
      throw new Error(
        `${context}: 未消費 rowspan が表末端を超過 (col ${ci} 残り ${held.left})`
      );
    }
  }
  return grid;
}

function splitRows(sectionHtml: string): string[] {
  const rows: string[] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(sectionHtml)) !== null) rows.push(r[1] ?? "");
  return rows;
}

/**
 * 行内セルを span 解釈なしで割る (pre-expansion 選択用)。
 * 選択は完全一致のみ。span の有無は問わない (展開時に厳密検証する)。
 */
function splitRowCells(rowHtml: string): string[] {
  const texts: string[] = [];
  const cellRe = /<(t[dh])\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let c: RegExpExecArray | null;
  while ((c = cellRe.exec(rowHtml)) !== null) {
    texts.push(cellText(c[3] ?? ""));
  }
  return texts;
}

/**
 * 文書中の <table> を入れ子対応で抜き、thead/tbody 別に展開する。
 * thead も tbody も無い表は head=[]・body=全行 (記録上区別する。推測しない)。
 * selectHeader 指定時は展開前に exact header 行を持つ表だけを選ぶ
 * (無関係レイアウト表の ragged で dedicated 抽出が死なないため)。
 * 選ばれた表の span/長方形展開は厳密なまま (catch/skip しない)。
 * 未指定の caller は従来通り全表を厳密展開する。
 */
export function extractTables(
  html: string,
  opts?: { selectHeader?: readonly string[] }
): RawTable[] {
  const tables: RawTable[] = [];
  const re = /<\/?table\b[^>]*>/gi;
  let depth = 0;
  let start = -1;
  let m: RegExpExecArray | null;
  const slices: Array<{ start: number; html: string }> = [];
  while ((m = re.exec(html)) !== null) {
    const isClose = m[0][1] === "/";
    if (!isClose) {
      if (depth === 0) start = m.index;
      depth++;
    } else {
      depth--;
      if (depth === 0 && start >= 0) {
        slices.push({ start, html: html.slice(start, re.lastIndex) });
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  for (let si = 0; si < slices.length; si++) {
    const slice = slices[si] as { start: number; html: string };
    const headSections: string[] = [];
    const bodySections: string[] = [];
    const headRe = /<thead\b[^>]*>([\s\S]*?)<\/thead\s*>/gi;
    const bodyRe = /<tbody\b[^>]*>([\s\S]*?)<\/tbody\s*>/gi;
    let h: RegExpExecArray | null;
    let b: RegExpExecArray | null;
    while ((h = headRe.exec(slice.html)) !== null) headSections.push(h[1] ?? "");
    while ((b = bodyRe.exec(slice.html)) !== null) bodySections.push(b[1] ?? "");
    // thead/tbody の外に直接ぶら下がる tr (断片) は拾わない。構造不明は別途 throw。
    const headRows = headSections.flatMap(splitRows);
    const bodyRows =
      bodySections.length > 0
        ? bodySections.flatMap(splitRows)
        : headSections.length > 0
          ? []
          : splitRows(
              slice.html
                .replace(/<thead\b[^>]*>[\s\S]*?<\/thead\s*>/gi, "")
                .replace(/<tbody\b[^>]*>[\s\S]*?<\/tbody\s*>/gi, "")
            );
    const want = opts?.selectHeader;
    if (want !== undefined) {
      let hit = false;
      for (const rowHtml of [...headRows, ...bodyRows]) {
        const texts = splitRowCells(rowHtml);
        if (
          texts.length === want.length &&
          texts.every((t, i) => t === want[i])
        ) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
    }
    const context = `table#${si}`;
    tables.push({
      tableIndex: si,
      startIndex: slice.start,
      head: expandGrid(headRows, `${context}/thead`),
      body: expandGrid(bodyRows, `${context}/tbody`),
    });
  }
  return tables;
}

/**
 * 会社名セル: 最初の非空リンク文を優先 (画像リンク等の殻だけなら全文)。
 * delisted/new-listings/transfers 共通。
 */
export function companyNameFromCell(cell: RawCell): string {
  const linkRe = /<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(cell.html)) !== null) {
    const text = cellText(m[1] ?? "");
    if (text.length > 0) return text;
  }
  return cell.text;
}

/** 実在日付チェック (2026/02/30 等を弾く)。 */
export function isRealDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return false;
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `YYYY/M/D` → `YYYY-MM-DD`。非形式・非実在日は null。 */
export function parseSlashDate(text: string): string | null {
  const m = text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!isRealDate(y, mo, d)) return null;
  return `${m[1]}-${pad2(mo)}-${pad2(d)}`;
}

/** `YYYY-MM-DD` → 同形 (実在日検証つき)。非形式・非実在日は null。 */
export function parseIsoDate(text: string): string | null {
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!isRealDate(y, mo, d)) return null;
  return text;
}

/** 年月日の厳密パース (slash・ISO のみ。年月日漢字表記は証拠が出るまで非対応)。 */
export function parseStrictDate(text: string): string | null {
  return parseSlashDate(text) ?? parseIsoDate(text);
}

/**
 * 公式表のコードセル → 正準ティッカー。
 * 既存の正準 helper (A130/1A30 等を拒否) に寄せ、JPX 未割当の 0000 も拒否する。
 * 不正は null でなく throw (公式表の列崩れは黙殺しない)。
 */
export function parseOfficialCode(text: string, context: string): string {
  const code = parseStockCode(text);
  if (code === null || code === "0000") {
    throw new Error(`${context}: コード不正 (${JSON.stringify(text)})`);
  }
  return code;
}

/** ページ <title> が期待断片を含むこと (別制度ページの取り違え防止)。 */
export function assertPageTitle(
  html: string,
  fragment: string,
  label: string
): void {
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = m?.[1] !== undefined ? cellText(m[1]) : "";
  if (!title.includes(fragment)) {
    throw new Error(
      `${label}: <title> 不一致 (期待に ${JSON.stringify(fragment)} を含む。実=${JSON.stringify(title)})`
    );
  }
}

export type BackNumber = {
  /** 唯一の selected 年 (宣言被覆年)。 */
  coveredYear: string;
  /** 既知アーカイブ (未取得。HOLD 時の具体 URL として報告する)。 */
  archives: { year: string; path: string }[];
};

/**
 * `select.backnumber` の唯一の selected option から宣言被覆年を取る。
 * 唯一性・`20YY年` 形式・value==取得源泉パスを検証する。
 * 行データの年 (2027/03/01 等の未来イベント含む) は被覆の証拠にしない。
 */
export function extractBackNumber(
  html: string,
  sourcePath: string,
  label: string
): BackNumber {
  const selects: string[] = [];
  const selRe =
    /<select\b([^>]*)>([\s\S]*?)<\/select\s*>/gi;
  let s: RegExpExecArray | null;
  while ((s = selRe.exec(html)) !== null) {
    if (/\bclass\s*=\s*["'][^"']*\bbacknumber\b[^"']*["']/i.test(s[1] ?? "")) {
      selects.push(s[2] ?? "");
    }
  }
  if (selects.length !== 1 || selects[0] === undefined) {
    throw new Error(
      `${label}: select.backnumber が ${selects.length} 個 (期待 1)`
    );
  }
  const archives: { year: string; path: string }[] = [];
  const selected: { year: string; path: string }[] = [];
  const optRe = /<option\b([^>]*)>([\s\S]*?)<\/option\s*>/gi;
  let o: RegExpExecArray | null;
  while ((o = optRe.exec(selects[0])) !== null) {
    const attrs = o[1] ?? "";
    const yearText = cellText(o[2] ?? "");
    const ym = yearText.match(/^(20\d{2})年$/);
    const vm = attrs.match(/\bvalue\s*=\s*["']([^"']+)["']/i);
    if (ym?.[1] === undefined || vm?.[1] === undefined) {
      throw new Error(
        `${label}: backnumber option の形式不正 (${JSON.stringify(yearText)})`
      );
    }
    archives.push({ year: ym[1], path: vm[1] });
    if (/\bselected\b/i.test(attrs)) {
      selected.push({ year: ym[1], path: vm[1] });
    }
  }
  if (selected.length !== 1 || selected[0] === undefined) {
    throw new Error(
      `${label}: selected option が ${selected.length} 個 (期待 1)`
    );
  }
  if (selected[0].path !== sourcePath) {
    throw new Error(
      `${label}: selected value と源泉の不一致 (selected=${selected[0].path} 源泉=${sourcePath})`
    );
  }
  return { coveredYear: selected[0].year, archives };
}

/**
 * 要求年窓 ⊆ 宣言被覆年。不足は HOLD として throw (推測で埋めない)。
 * 既知アーカイブの具体パスを添えて Root へ報告可能にする。
 */
export function assertCoveredYears(
  backNumber: BackNumber,
  yearWindow: readonly string[],
  label: string
): void {
  const missing = yearWindow.filter((y) => y !== backNumber.coveredYear);
  if (missing.length > 0) {
    const known = backNumber.archives
      .map((a) => `${a.year}:${a.path}`)
      .join(" ");
    throw new Error(
      `${label}: HOLD 年被覆不足 (要求=[${yearWindow.join(",")}] 宣言=[${backNumber.coveredYear}] 既知アーカイブ=[${known}])`
    );
  }
}

/**
 * 被覆に要求する年の集合。(baseAsOf, eligibilityAsOf] に実際に含む日付の年。
 * baseAsOf が 12/31 なら前年は要求しない。baseAsOf=null (初回 bootstrap) は
 * 要求年を eligibility 年のみにし、呼び出し側が bootstrapPartial を記録する。
 */
export function requiredCoverageYears(
  baseAsOf: string | null,
  eligibilityAsOf: string
): { years: string[]; bootstrapPartial: boolean } {
  const toY = eligibilityAsOf.slice(0, 4);
  if (baseAsOf === null) return { years: [toY], bootstrapPartial: true };
  const from = new Date(`${baseAsOf}T00:00:00Z`).getTime();
  const to = new Date(`${eligibilityAsOf}T00:00:00Z`).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new Error(
      `被覆窓不正: (${baseAsOf}, ${eligibilityAsOf}]`
    );
  }
  if (to - from > 366 * 86_400_000) {
    throw new Error(`被覆窓超過 (>366日): (${baseAsOf}, ${eligibilityAsOf}]`);
  }
  const years = new Set<string>();
  for (let t = from + 86_400_000; t <= to; t += 86_400_000) {
    years.add(new Date(t).toISOString().slice(0, 4));
  }
  return { years: [...years].sort(), bootstrapPartial: false };
}
