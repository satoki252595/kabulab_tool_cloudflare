/**
 * iXBRL の HTML テーブルを「セル文字列の 2 次元配列」に変換する低水準ユーティリティ。
 *
 * iXBRL は <table> が入れ子になることがあり、非貪欲な正規表現では途中で
 * 千切れる。深さを数えて <table> の対応を取る。inline XBRL タグ
 * (<ix:nonFraction> 等) はテキストだけ残して除去する。
 *
 * 数値の正規化 (CLAUDE.md ルール2 準拠):
 *   - "1,234" → 1234 / "△1,234"・"▲1,234"・"-1,234" → -1234
 *   - "―" "－" "-" "" や非数値 → null (0 で埋めない = 欠損は欠損のまま)
 */

const ENTITY: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function unescapeHtml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&[a-zA-Z#0-9]+;/g, (m) => ENTITY[m] ?? m);
}

/** タグを全除去しテキストだけ取り出して空白を畳む (改行は空白に) */
function cellText(html: string): string {
  const noTags = html.replace(/<[^>]+>/g, " ");
  return unescapeHtml(noTags).replace(/[\s\u3000]+/g, " ").trim();
}

/** 文書中の <table>...</table> を入れ子対応で全件抜き出す (外側の table 単位) */
export function extractTables(html: string): string[] {
  const tables: string[] = [];
  const re = /<\/?table\b[^>]*>/gi;
  let depth = 0;
  let start = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const isClose = m[0][1] === "/";
    if (!isClose) {
      if (depth === 0) start = m.index;
      depth++;
    } else {
      depth--;
      if (depth === 0 && start >= 0) {
        tables.push(html.slice(start, re.lastIndex));
        start = -1;
      }
      if (depth < 0) depth = 0; // 壊れた HTML 防御 (ここでは throw しない: 別 table は救う)
    }
  }
  return tables;
}

/**
 * 1 つの <table> を行 × セルのテキスト配列へ。colspan/rowspan は展開せず
 * セルをそのまま並べる (本パーサは「見出しセルの語」と「行頭ラベル + 数値列」
 * しか見ないため、複雑な結合は分類で吸収する)。
 */
export function tableToGrid(tableHtml: string): string[][] {
  const grid: string[][] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(tableHtml)) !== null) {
    const cells: string[] = [];
    const cellRe = /<(t[dh])\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(r[1])) !== null) {
      cells.push(cellText(c[2]));
    }
    if (cells.length > 0) grid.push(cells);
  }
  return grid;
}

function attrInt(tag: string, name: string): number {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, "i"));
  const n = m ? parseInt(m[1], 10) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * colspan / rowspan を展開して長方形グリッドにする。多段ヘッダ (有報の
 * 完成工事高表など) で見出しとデータ列を正しく対応させるために使う。
 * 結合セルはテキストを全展開先に複製する (見出し語の被覆判定に必要)。
 */
export function tableToGridExpanded(tableHtml: string): string[][] {
  const rowsHtml: string[] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(tableHtml)) !== null) rowsHtml.push(r[1]);

  const grid: string[][] = [];
  // 列 → 残り行数 / テキストの繰越 (rowspan)
  const carry = new Map<number, { text: string; left: number }>();

  for (let ri = 0; ri < rowsHtml.length; ri++) {
    const out: string[] = [];
    let col = 0;
    const occupied = (ci: number) => carry.has(ci) && carry.get(ci)!.left > 0;

    const cellRe = /<(t[dh])\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let cc: RegExpExecArray | null;
    while ((cc = cellRe.exec(rowsHtml[ri])) !== null) {
      while (occupied(col)) {
        out[col] = carry.get(col)!.text;
        carry.get(col)!.left--;
        col++;
      }
      const text = cellText(cc[3]);
      const cspan = attrInt(cc[2], "colspan");
      const rspan = attrInt(cc[2], "rowspan");
      for (let k = 0; k < cspan; k++) {
        out[col] = text;
        if (rspan > 1) carry.set(col, { text, left: rspan - 1 });
        col++;
      }
    }
    // 行末に残る繰越列を埋める
    let maxCarry = -1;
    for (const ci of carry.keys()) if (carry.get(ci)!.left > 0) maxCarry = Math.max(maxCarry, ci);
    while (col <= maxCarry) {
      if (occupied(col)) {
        out[col] = carry.get(col)!.text;
        carry.get(col)!.left--;
      }
      col++;
    }
    if (out.length > 0) grid.push(Array.from(out, (x) => x ?? ""));
  }
  return grid;
}

/**
 * 日本語の金額文字列を数値へ。欠損・記号のみは null (ルール2: 0 で埋めない)。
 * 戻り値の単位は入力のまま (百万円表記ならその数値)。
 */
export function parseJpNumber(raw: string): number | null {
  const s = raw.replace(/[\s\u3000]/g, "");
  if (s === "" || s === "―" || s === "－" || s === "-" || s === "—" || s === "−") {
    return null;
  }
  const neg = /^[△▲−-]/.test(s);
  const digits = s.replace(/[△▲＋+−\-,，]/g, "");
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** 単位文字列 → 円への倍率。未知単位は throw (ルール2: 推測で埋めない)。 */
export function unitToYenFactor(unitLabel: string): number {
  const u = unitLabel.replace(/[\s\u3000\uFF08\uFF09()]/g, "");
  if (u.includes("百万円")) return 1_000_000;
  if (u.includes("千円")) return 1_000;
  if (u.includes("億円")) return 100_000_000;
  if (u.includes("円")) return 1;
  throw new Error(`未知の金額単位です: "${unitLabel}"`);
}
