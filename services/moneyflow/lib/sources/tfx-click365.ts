/**
 * 東京金融取引所 (TFX) 「くりっく３６５」(取引所為替証拠金取引) /
 * 「くりっく株３６５」(取引所株価指数証拠金取引) — 月次出来高・建玉。
 *
 * ソース (固定 URL、月替わりの度に一覧ページの表示が最新化される):
 *   - くりっく３６５:   https://www.tfx.co.jp/historical/fx/transit_fx.html
 *   - くりっく株３６５: https://www.tfx.co.jp/historical/cfd/transit_cfd.html
 *
 * 各ページは静的 HTML の <table> が 4 つ、常に次の順不同の組み合わせで並ぶ
 * (2026-09-27 実測。本パーサは表の並び順ではなく「1日平均行の有無」×
 * 「期間ラベルが月次か年次か」の組み合わせで表を識別するため、並び順が
 * 変わっても壊れない):
 *   1. 月次出来高 (直近7ヶ月分、通貨ペア/銘柄ごとに「合計」行 + その次に
 *      「(1日平均)」行が続く2行1組)
 *   2. 年次出来高 (直近3年分、同じ2行1組の形式)
 *   3. 月末建玉 (直近7ヶ月分、通貨ペア/銘柄ごとに1行のみ、1日平均なし)
 *   4. 年末建玉 (直近3年分、同じ1行のみの形式)
 *
 * 利用条件 (要問い合わせ。2026-09-27 に両ページの原文を確認):
 *   - 本ページが属する「ＴＦＸ ヒストリカルデータベース」
 *     (https://www.tfx.co.jp/historical/) の「ご利用にあたっての注意」は
 *     「データベースに関する著作権は TFX にある」「データベースのご利用は無料で
 *     自由にご活用いただけます」と書く。
 *   - サイト全体の免責事項 (https://www.tfx.co.jp/disclaimer/) は「当サイトの
 *     一部又は全部を無断で転用・複製することはできません」と書く。
 *   - 公開の場での再配布 (転載) や商用利用の可否を明記した条項は無い。
 * よって TFX に個別確認するまでは JPX と同様に **非公開の範囲に限る**
 * (`LICENSE_TAG = "personal-only"`。計画時の調査では「商用利用不可」扱い)。
 * 公開 Web サービス上での二次配布や商用データセットとしての提供、取得した
 * HTML の公開リポジトリへの commit は、TFX への個別確認なしに行わないこと。
 */

// ブラウザ相当 UA。services/vwap-analysis/lib/margin.ts, src/shared/jpx/sectors.ts
// と同じ値を使う (JPX 系サイトが要求する「ブラウザ相当 UA」の実測済みの値を
// 使い回す方針。現時点でこの値を再輸出する共有定数モジュールは存在しないため、
// 値そのものを合わせている — 将来 Phase 0 で共有定数が用意されたら差し替える)。
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * 公開の場での再配布・商用利用の可否が明記されておらず、サイト全体の免責事項が
 * 無断の転用・複製を禁じているため、TFX に確認するまでは非公開の範囲に限る。
 */
export const LICENSE_TAG = "personal-only";

export type TfxMarket = "click365_fx" | "clickkabu365_cfd";

export const TFX_CLICK365_FX_URL =
  "https://www.tfx.co.jp/historical/fx/transit_fx.html";
export const TFX_CLICKKABU365_CFD_URL =
  "https://www.tfx.co.jp/historical/cfd/transit_cfd.html";

/**
 * (1) 最新データの URL を解決する。
 *
 * 両ページとも URL は固定 (月ごとにファイル名が変わる JPX PDF 等とは違い、
 * ページ自体が最新の直近7ヶ月分+3年分に自動更新される) ため、「解決」は
 * 定数の対応付けのみで完結する。
 */
export function resolveTfxClick365Url(market: TfxMarket): string {
  switch (market) {
    case "click365_fx":
      return TFX_CLICK365_FX_URL;
    case "clickkabu365_cfd":
      return TFX_CLICKKABU365_CFD_URL;
    default: {
      // 網羅性チェック (ルール2: 未知の市場種別を黙って握りつぶさない)。
      const exhaustive: never = market;
      throw new Error(`未知の TfxMarket: ${String(exhaustive)}`);
    }
  }
}

export interface TfxClick365FetchResult {
  market: TfxMarket;
  url: string;
  html: string;
  /** 取得時刻 (ISO8601)。ページ自体に更新日時の記載がないため取得側で記録する。 */
  fetchedAt: string;
}

/**
 * (1) 最新ページを取得する。1 回の呼び出しで対象市場のページに 1 回だけ
 * アクセスする (JPX 系と同様、高頻度アクセスへの配慮)。
 *
 * @throws HTTP エラー時
 */
export async function fetchTfxClick365Page(
  market: TfxMarket
): Promise<TfxClick365FetchResult> {
  const url = resolveTfxClick365Url(market);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(
      `TFX ${market} 取得失敗: HTTP ${res.status} ${res.statusText} (${url})`
    );
  }
  const html = await res.text();
  return { market, url, html, fetchedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// (2) 純関数パーサ
// ---------------------------------------------------------------------------

export type TfxPeriodKind = "month" | "year";

/**
 * 通貨ペア/銘柄 × 期間 1 セル分の出来高。
 *
 * - `total` が `undefined` のセルは「原資料が空欄」= その通貨ペア/銘柄が
 *   その期間にまだ上場していなかった(取扱いがなかった)ことを示す実際の
 *   欠損であり、0 で埋めない (ルール2)。
 * - `dailyAvg` は `total` があるときのみ意味を持つ。原資料が `(-)`
 *   と表示する行 (1日あたり1枚未満に丸めると0になるほど少ないという
 *   趣旨の表示。実測で `total` が空欄の期間にも `(-)` が出ることがあり、
 *   その場合は「真の値が不明」ではなく「そもそもデータがない」なので
 *   `total` が `undefined` なら `dailyAvg` も必ず `undefined` にする) は
 *   正確な数値が非開示のため `null` とし、0 で埋めない。
 */
export interface TfxVolumeCell {
  instrument: string;
  period: string;
  periodKind: TfxPeriodKind;
  total: number | undefined;
  dailyAvg: number | null | undefined;
}

/** 通貨ペア/銘柄 × 期間 1 セル分の建玉 (ストック指標。1日平均の概念はない)。 */
export interface TfxOpenInterestCell {
  instrument: string;
  period: string;
  periodKind: TfxPeriodKind;
  value: number | undefined;
}

export interface TfxClick365Data {
  market: TfxMarket;
  marketLabel: string;
  sourceUrl: string;
  fetchedAt: string;
  /** 単位は原資料表記の通り「枚」で固定。 */
  unit: "枚";
  monthlyVolume: TfxVolumeCell[];
  annualVolume: TfxVolumeCell[];
  monthEndOpenInterest: TfxOpenInterestCell[];
  yearEndOpenInterest: TfxOpenInterestCell[];
}

/** セル内で復号してよい名前付き文字参照 (これ以外が出たら様式変更として throw する)。 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * セル内の文字参照を復号する。未知の名前付き参照 (例 `&reg;`) は、そのまま
 * 区分名 (通貨ペア/銘柄名) に混ぜると別の区分として黙って記録されてしまう
 * ため throw する (ルール2)。
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, ref: string) => {
    if (ref.startsWith("#x") || ref.startsWith("#X")) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith("#")) return String.fromCodePoint(parseInt(ref.slice(1), 10));
    const decoded = NAMED_ENTITIES[ref];
    if (decoded === undefined) {
      throw new Error(`TFX: 表のセルに未対応の文字参照があります: "${whole}"`);
    }
    return decoded;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

interface RawCell {
  tag: "th" | "td";
  attrs: string;
  text: string;
}

interface RawRow {
  cells: RawCell[];
}

function parseRows(tableHtml: string): RawRow[] {
  const rows: RawRow[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(tableHtml))) {
    const cells: RawCell[] = [];
    const cellRe = /<(th|td)([^>]*)>([\s\S]*?)<\/\1>/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[1]!))) {
      cells.push({
        tag: cellMatch[1] as "th" | "td",
        attrs: cellMatch[2]!,
        text: stripTags(cellMatch[3]!),
      });
    }
    if (cells.length > 0) rows.push({ cells });
  }
  return rows;
}

/** "2026.08" → "2026-08" (月次)。想定外の形式は throw する。 */
function normalizeMonthPeriod(label: string): string {
  const m = /^(\d{4})\.(\d{1,2})$/.exec(label);
  if (!m) {
    throw new Error(`TFX: 月次期間ラベルの形式が想定外です: "${label}"`);
  }
  const month = Number(m[2]);
  if (month < 1 || month > 12) {
    throw new Error(`TFX: 月次期間ラベルの月が不正です: "${label}"`);
  }
  return `${m[1]}-${m[2]!.padStart(2, "0")}`;
}

/** "2025" → "2025" (年次、4桁数字であることのみ検証)。 */
function normalizeYearPeriod(label: string): string {
  if (!/^\d{4}$/.test(label)) {
    throw new Error(`TFX: 年次期間ラベルの形式が想定外です: "${label}"`);
  }
  return label;
}

/** 出来高/建玉セルの数値表記 ("1,234" 等) を int に変換する。空欄は呼び出し側で処理する。 */
function parseCount(raw: string): number {
  if (!/^[\d,]+$/.test(raw)) {
    throw new Error(`TFX: 数量セルの形式が想定外です: "${raw}"`);
  }
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) {
    throw new Error(`TFX: 数量セルを数値変換できません: "${raw}"`);
  }
  return n;
}

/** "(1,234)" → 1234 / "(-)" → null (丸めて1枚未満、正確な値は非開示)。 */
function parseDailyAvgCell(raw: string): number | null {
  if (raw === "(-)") return null;
  const m = /^\(([\d,]+)\)$/.exec(raw);
  if (!m) {
    throw new Error(`TFX: 1日平均セルの形式が想定外です: "${raw}"`);
  }
  return parseCount(m[1]!);
}

interface ParsedTable {
  marketLabel: string;
  periodKind: TfxPeriodKind;
  periods: string[];
  hasDailyAvg: boolean;
  /** instrument → period → cell (volume) */
  volumeRows: Array<{ instrument: string; totals: (string | null)[]; avgs: (string | null)[] | null }>;
}

function parseOneTable(tableHtml: string): ParsedTable {
  const rows = parseRows(tableHtml);
  if (rows.length < 2) {
    throw new Error("TFX: 表のヘッダ行が見つかりません (想定外の HTML 構造)");
  }

  // 1行目: 隅の空セル (rowspan) + colspan 付きの市場ラベル th。
  const headerRow1 = rows[0]!;
  const labelCell = headerRow1.cells.find((c) => /colspan/.test(c.attrs));
  if (!labelCell || headerRow1.cells.some((c) => c.tag !== "th")) {
    throw new Error("TFX: 市場ラベル行の形式が想定外です");
  }
  const marketLabel = labelCell.text;

  // 2行目: 期間見出し (すべて th、colspan なし)。
  const headerRow2 = rows[1]!;
  if (headerRow2.cells.length === 0 || headerRow2.cells.some((c) => c.tag !== "th" || /colspan/.test(c.attrs))) {
    throw new Error("TFX: 期間見出し行の形式が想定外です");
  }
  const periodLabels = headerRow2.cells.map((c) => c.text);
  const isMonthly = periodLabels.every((l) => /^\d{4}\.\d{1,2}$/.test(l));
  const isYearly = periodLabels.every((l) => /^\d{4}$/.test(l));
  if (!isMonthly && !isYearly) {
    throw new Error(
      `TFX: 期間見出しの形式が月次・年次のいずれにも一致しません: ${JSON.stringify(periodLabels)}`
    );
  }
  const periodKind: TfxPeriodKind = isMonthly ? "month" : "year";
  const periods = periodLabels.map((l) =>
    periodKind === "month" ? normalizeMonthPeriod(l) : normalizeYearPeriod(l)
  );
  const periodCount = periods.length;

  // 3行目以降: 商品行 (th ラベル + td 総数) が続き、直後に「全セル td」の
  // 平均行が続くかどうかで、この表が出来高表(1日平均あり)か建玉表かを判定する。
  const dataRows = rows.slice(2);
  const volumeRows: ParsedTable["volumeRows"] = [];
  let hasDailyAvgDetected: boolean | null = null;

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]!;
    const [first, ...rest] = row.cells;
    if (!first || first.tag !== "th") {
      throw new Error("TFX: 商品行の先頭セルが th ではありません (想定外の構造)");
    }
    if (rest.length !== periodCount) {
      throw new Error(
        `TFX: 商品行「${first.text}」の値セル数 (${rest.length}) が期間数 (${periodCount}) と一致しません`
      );
    }
    const totals = rest.map((c) => (c.text === "" ? null : c.text));

    // 次の行を覗き見て、平均行 (全セル td・同数) かどうかを判定する。
    const next = dataRows[i + 1];
    const nextIsAvgRow =
      !!next &&
      next.cells.length === periodCount &&
      next.cells.every((c) => c.tag === "td");
    if (hasDailyAvgDetected === null) hasDailyAvgDetected = nextIsAvgRow;
    if (hasDailyAvgDetected !== nextIsAvgRow) {
      throw new Error(
        `TFX: 商品行「${first.text}」で1日平均行の有無が表内で一貫していません`
      );
    }

    let avgs: (string | null)[] | null = null;
    if (nextIsAvgRow) {
      avgs = next!.cells.map((c) => (c.text === "" ? null : c.text));
      i += 1; // 平均行を消費
    }
    volumeRows.push({ instrument: first.text, totals, avgs });
  }

  if (volumeRows.length === 0) {
    throw new Error("TFX: 商品行が1件も取れませんでした (想定外の HTML 構造)");
  }

  return {
    marketLabel,
    periodKind,
    periods,
    hasDailyAvg: hasDailyAvgDetected === true,
    volumeRows,
  };
}

/**
 * (2) HTML から型付きレコードを返す純関数パーサ。様式が想定と違えば throw する。
 */
export function parseTfxClick365Html(
  html: string,
  market: TfxMarket,
  sourceUrl: string,
  fetchedAt: string
): TfxClick365Data {
  const tableHtmls = html.match(/<table[\s\S]*?<\/table>/g);
  if (!tableHtmls || tableHtmls.length !== 4) {
    throw new Error(
      `TFX ${market}: <table> が4つ想定 (月次出来高/年次出来高/月末建玉/年末建玉) ですが ${tableHtmls?.length ?? 0} 件でした`
    );
  }

  // 単位は各表の下の注記 (出来高表は「※ ( )1日平均 / 単位：枚」、建玉表は「単位：枚」。
  // 原文の区切りの空白は全角) にしか書かれていない。`unit: "枚"` を黙って決め打ち
  // しないよう、4表ぶんの注記がすべて「枚」であることを確かめる (単位が変われば桁や
  // 意味を取り違えるため throw — ルール2)。
  const unitNotes = [...html.matchAll(/単位：([^<\s]+)/g)].map((m) => m[1]!);
  if (unitNotes.length !== 4 || unitNotes.some((u) => u !== "枚")) {
    throw new Error(
      `TFX ${market}: 単位の注記が4表ぶん「枚」であることを確認できません: ${JSON.stringify(unitNotes)}`
    );
  }

  const parsed = tableHtmls.map(parseOneTable);

  const monthlyVolumeTable = parsed.filter((t) => t.hasDailyAvg && t.periodKind === "month");
  const annualVolumeTable = parsed.filter((t) => t.hasDailyAvg && t.periodKind === "year");
  const monthEndOiTable = parsed.filter((t) => !t.hasDailyAvg && t.periodKind === "month");
  const yearEndOiTable = parsed.filter((t) => !t.hasDailyAvg && t.periodKind === "year");

  if (
    monthlyVolumeTable.length !== 1 ||
    annualVolumeTable.length !== 1 ||
    monthEndOiTable.length !== 1 ||
    yearEndOiTable.length !== 1
  ) {
    throw new Error(
      `TFX ${market}: 4表の内訳 (月次出来高/年次出来高/月末建玉/年末建玉) が想定と一致しません ` +
        `(月次出来高=${monthlyVolumeTable.length}, 年次出来高=${annualVolumeTable.length}, ` +
        `月末建玉=${monthEndOiTable.length}, 年末建玉=${yearEndOiTable.length})`
    );
  }

  const marketLabel = monthlyVolumeTable[0]!.marketLabel;

  function toVolumeCells(table: ParsedTable): TfxVolumeCell[] {
    const cells: TfxVolumeCell[] = [];
    for (const row of table.volumeRows) {
      for (let idx = 0; idx < table.periods.length; idx++) {
        const period = table.periods[idx]!;
        const rawTotal = row.totals[idx]!;
        const total = rawTotal === null ? undefined : parseCount(rawTotal);
        if (!row.avgs) {
          throw new Error(`TFX: 出来高表の「${row.instrument}」に1日平均行がありません (想定外の構造)`);
        }
        const rawAvg = row.avgs[idx]!;
        let dailyAvg: number | null | undefined;
        if (total === undefined) {
          // 原資料が空欄 = 未上場/未取扱い。1日平均側は実測で空欄か "(-)" のみで、
          // 「真の値が不明」ではなく「データそのものがない」ので undefined にする。
          // 合計が空欄なのに1日平均に数値がある組み合わせは実ファイルに無く、
          // 黙って捨てると公表値を失うため throw する (ルール2)。
          if (rawAvg !== null && rawAvg !== "(-)") {
            throw new Error(
              `TFX: 「${row.instrument}」${period} は出来高が空欄なのに1日平均が "${rawAvg}" です (想定外の組み合わせ)`
            );
          }
          dailyAvg = undefined;
        } else {
          // 出来高があるのに1日平均が空欄の組み合わせは実ファイルに無い。黙って
          // undefined (欠測) にすると様式変更に気付けないため throw する (ルール2)。
          if (rawAvg === null) {
            throw new Error(
              `TFX: 「${row.instrument}」${period} は出来高 ${rawTotal} があるのに1日平均が空欄です (想定外の組み合わせ)`
            );
          }
          dailyAvg = parseDailyAvgCell(rawAvg);
        }
        cells.push({ instrument: row.instrument, period, periodKind: table.periodKind, total, dailyAvg });
      }
    }
    return cells;
  }

  function toOiCells(table: ParsedTable): TfxOpenInterestCell[] {
    const cells: TfxOpenInterestCell[] = [];
    for (const row of table.volumeRows) {
      for (let idx = 0; idx < table.periods.length; idx++) {
        const period = table.periods[idx]!;
        const rawTotal = row.totals[idx]!;
        const value = rawTotal === null ? undefined : parseCount(rawTotal);
        cells.push({ instrument: row.instrument, period, periodKind: table.periodKind, value });
      }
    }
    return cells;
  }

  return {
    market,
    marketLabel,
    sourceUrl,
    fetchedAt,
    unit: "枚",
    monthlyVolume: toVolumeCells(monthlyVolumeTable[0]!),
    annualVolume: toVolumeCells(annualVolumeTable[0]!),
    monthEndOpenInterest: toOiCells(monthEndOiTable[0]!),
    yearEndOpenInterest: toOiCells(yearEndOiTable[0]!),
  };
}

/** 取得 + パースをまとめて行う。 */
export async function fetchAndParseTfxClick365(market: TfxMarket): Promise<TfxClick365Data> {
  const { url, html, fetchedAt } = await fetchTfxClick365Page(market);
  return parseTfxClick365Html(html, market, url, fetchedAt);
}

// ---------------------------------------------------------------------------
// (3) 期間の判定・「まだ公表されていない」の判定
// ---------------------------------------------------------------------------

/**
 * 与えた期間が、取得済みデータ (`cells`) の中に実在するかどうかを返す。
 *
 * サイト自体に「最終更新日」の記載がなく、月次更新のタイミングも未確認
 * (latency: unknown) なため、「calendar 上そろそろ公表されているはず」と
 * 推測するのではなく、**実際に取得した表に載っているかどうか**だけを
 * 正とする (ルール2: 憶測で決めない)。
 */
export function isTfxPeriodPublished(
  period: string,
  cells: ReadonlyArray<{ period: string }>
): boolean {
  return cells.some((c) => c.period === period);
}

/** 取得済みデータに含まれる期間の一覧 (昇順・重複なし)。 */
export function tfxAvailablePeriods(cells: ReadonlyArray<{ period: string }>): string[] {
  return [...new Set(cells.map((c) => c.period))].sort();
}

/** 取得済みデータの中で最新の期間。1件も無ければ throw する。 */
export function latestTfxPublishedPeriod(cells: ReadonlyArray<{ period: string }>): string {
  const periods = tfxAvailablePeriods(cells);
  const last = periods.at(-1);
  if (last === undefined) {
    throw new Error("TFX: 期間が1件も取得できていません (空データ)");
  }
  return last;
}

/**
 * 参照日時点 (日本時間の暦) で「本来この月次バッチが対象にすべき暦月」(前月) を
 * YYYY-MM で返す。
 *
 * これは純粋なカレンダー計算であり、「TFX が実際にその月を公表済みか」の
 * 判定ではない (それは `isTfxPeriodPublished` が実データで行う)。呼び出し側は
 * 必ず両方を組み合わせ、「対象月が実データに無ければ取込をスキップする」形で
 * 使うこと (公表タイミングを憶測で決め打ちしない)。
 */
export function expectedMonthlyPeriod(referenceDate: Date): string {
  const jst = toJstCalendar(referenceDate);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth(); // 0-11, 前月 = m (0-indexed で今月は m+1)
  const prevMonthIndex = m === 0 ? 11 : m - 1;
  const prevYear = m === 0 ? y - 1 : y;
  return `${prevYear}-${String(prevMonthIndex + 1).padStart(2, "0")}`;
}

/** 参照日時点 (日本時間の暦) で「本来この年次バッチが対象にすべき年」(前年) を YYYY で返す。 */
export function expectedAnnualPeriod(referenceDate: Date): string {
  return String(toJstCalendar(referenceDate).getUTCFullYear() - 1);
}

/**
 * TFX は日本の取引所で、月・年の区切りは日本時間 (UTC+9、夏時間なし)。
 * UTC の暦のまま判定すると、日本時間の月初 0:00〜8:59 に「前々月」を返して
 * しまうため、+9 時間ずらした Date の UTC 成分を日本時間の暦として読む。
 */
function toJstCalendar(referenceDate: Date): Date {
  return new Date(referenceDate.getTime() + 9 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// (4) 指標定義
// ---------------------------------------------------------------------------

/** 資金フロー観測ログが表現する「何を測るか」の種別 (計画書 共通語彙)。 */
export type MoneyflowMeasureKind =
  | "net_flow"
  | "gross_turnover"
  | "holdings_stock"
  | "positions"
  | "fund_flow"
  | "estimated"
  | "price_only";

export interface MoneyflowMetricDefinition {
  key: string;
  displayName: string;
  measures: MoneyflowMeasureKind;
  /** 平易な説明 (投資初心者向け、具体例つき)。 */
  description: string;
  /** 財務的に正確な定義。 */
  definition: string;
  unit: string;
  sourceUrl: string;
  /** 利用条件 (二次利用・商用可否)。 */
  usageTerms: string;
  frequency: string;
  limitations: string;
  requirements: string[];
}

function metricsForMarket(market: TfxMarket): MoneyflowMetricDefinition[] {
  const isFx = market === "click365_fx";
  const marketNameJa = isFx ? "取引所為替証拠金取引「くりっく３６５」" : "取引所株価指数証拠金取引「くりっく株３６５」";
  // 説明文の例で使う商品の呼び名 (CFD 側で「取引所FX」と書かない)。
  const productNoun = isFx ? "取引所FX" : "取引所CFD";
  const prefix = isFx ? "tfx-click365-fx" : "tfx-clickkabu365-cfd";
  const sourceUrl = isFx ? TFX_CLICK365_FX_URL : TFX_CLICKKABU365_CFD_URL;
  const unitJa = "枚";
  const usageTerms =
    "本ページが属する TFX ヒストリカルデータベース (https://www.tfx.co.jp/historical/) の注意書きは" +
    "「著作権は TFX にある」「利用は無料で自由に活用できる」とし、サイト全体の免責事項" +
    " (https://www.tfx.co.jp/disclaimer/) は「当サイトの一部又は全部を無断で転用・複製することは" +
    "できません」とする。公開の場での再配布(転載)や商用利用の可否は明記されていないため、TFX に" +
    "個別確認するまでは非公開の範囲に限る (license_tag=personal-only)。";
  const instrumentLabel = isFx ? "通貨ペア" : "銘柄";
  // 1枚の大きさ(取引単位)が商品ごとに違うことを示す例。名前に付く語だけから言える範囲に留める。
  const lotSizeExample = isFx
    ? "名前に「ラージ」と付く通貨ペアは通常の通貨ペアより1枚が大きい"
    : "名前に「マイクロ」と付く銘柄は通常の銘柄より1枚が小さい";
  // 1日平均の分母 (営業日数) が商品ごとに違う理由。実ファイルの「出来高÷1日平均」で
  // 確認できたものだけを書く (FX は月次ではどの通貨ペアも同じ日数で、年次で途中上場の
  // 通貨ペアだけ短い。CFD は欧州指数が現地の祝日の月に短く、年次は上場後の日数)。
  const daysDifferReason = isFx
    ? "期間の途中で上場した通貨ペアは上場後の営業日数で割られるため"
    : "海外市場の祝日に休む銘柄や、期間の途中で上場した銘柄があるため";
  const lotSizeLimitation =
    `1枚あたりの取引単位は${instrumentLabel}ごとに異なる(例: ${lotSizeExample})ため、` +
    `異なる${instrumentLabel}の枚数を足したり比べたりしても取引金額の大小にはならない。`;

  return [
    {
      key: `${prefix}-turnover`,
      displayName: `${marketNameJa} ${instrumentLabel}別 月次/年次出来高`,
      measures: "gross_turnover",
      description:
        `月間(または年間)に取引所で成立した取引の数量(枚数)の合計。買いか売りか、新しく始める` +
        `取引か手じまい(決済)の取引かを区別せずに足し合わせた「総取引量」で、「どれだけ活発に` +
        `取引されたか」を示す。買いから売りを差し引いた「正味でどれだけ資金が入ってきたか」` +
        `ではない。例: ある${instrumentLabel}の月間出来高が前の月の2倍になったら、その` +
        `${instrumentLabel}の${productNoun}の売り買いがその月に活発になったことを示す` +
        `(資金が2倍流れ込んだという意味ではない)。`,
      definition:
        `TFX(東京金融取引所)が運営する${marketNameJa}における、${instrumentLabel}別の` +
        `月間/年間の取引数量(約定した数量、単位:枚)。新規の建て(買い・売り)と決済(反対売買)の` +
        `区別なく約定数量を合計した総量(gross_turnover)であり、買いと売りを差し引きした` +
        `ネットの資金流入出(net_flow)を表す指標ではない。`,
      unit: unitJa,
      sourceUrl,
      usageTerms,
      frequency: "月次(直近7ヶ月分)・年次(直近3年分)がページ表示。長期系列化には継続取得が必須。",
      limitations:
        "出来高は買い・売りの向きを示さない総量指標。" +
        lotSizeLimitation +
        "新規上場した通貨ペア/銘柄は上場前の期間が欠測(0ではなく「データなし」)になる。" +
        "ページ表示は直近分のみのため、蓄積は毎月/毎年の取得の積み重ねに依存する。" +
        "latency(月次更新タイミング)は未確認。",
      requirements: ["R3"],
    },
    {
      key: `${prefix}-turnover-daily-avg`,
      displayName: `${marketNameJa} ${instrumentLabel}別 1日平均出来高`,
      measures: "gross_turnover",
      description:
        `月間(または年間)の出来高を、その${instrumentLabel}が取引された営業日数で割った` +
        `「1日あたりの平均的な取引量」。原資料が「(-)」と表示するものは、1日平均が1枚に満たず` +
        `整数に丸めると0になるほど少ないという意味で、正確な数値は開示されていない` +
        `(観測ログには0として記録せず、行を作らない)。`,
      definition:
        `${marketNameJa}における、${instrumentLabel}別の月間/年間出来高を営業日数で割った` +
        `1営業日あたりの平均(単位:枚/日、整数に丸めた値)。原資料が直接開示する値であり、` +
        `当ライブラリで計算した値ではない。割る営業日数は${instrumentLabel}ごとに異なることがある` +
        `(${daysDifferReason})。`,
      unit: `${unitJa}/日`,
      sourceUrl,
      usageTerms,
      frequency: "月次(直近7ヶ月分)・年次(直近3年分)がページ表示。",
      limitations:
        "「(-)」表示(1日平均が1枚未満で0に丸められるもの)は正確な値が非開示のため観測ログに" +
        "計上しない。" +
        lotSizeLimitation +
        "新規上場前の期間は欠測。",
      requirements: ["R3"],
    },
    {
      key: `${prefix}-open-interest`,
      displayName: `${marketNameJa} ${instrumentLabel}別 月末/年末建玉`,
      measures: "positions",
      description:
        `月末(または年末)時点で、まだ決済されずに残っている取引の数量(建玉、単位:枚)。` +
        `「その月・年にどれだけ資金が入ったか(フロー)」ではなく、「その時点でどれだけの` +
        `取引が持たれたままになっているか」というストック(残高)を示す。前の期間より増えて` +
        `いれば新しく始めた取引が手じまい(決済)を上回った、減っていれば手じまいの方が` +
        `多かったことを表すが、買いと売りのどちらに傾いているか(相場の強気・弱気)は` +
        `この数字からは分からない。`,
      definition:
        `TFX(東京金融取引所)が運営する${marketNameJa}における、${instrumentLabel}別の` +
        `月末/年末時点の建玉数量(未決済の取引の数量、単位:枚)。ストック指標であり、` +
        `買建玉・売建玉の内訳や投資部門別(誰が持っているか)の内訳はこの表では公表されない` +
        `(holdings_stock に近いが厳密には未決済契約数=positions)。`,
      unit: unitJa,
      sourceUrl,
      usageTerms,
      frequency: "月次(直近7ヶ月分)・年次(直近3年分)がページ表示。",
      limitations:
        "建玉の増減は新規の建てと決済(反対売買)の差であり、買い・売りどちらの建玉が多いかも、" +
        "誰が(投資部門別)持っているかも分からない。" +
        lotSizeLimitation +
        "新規上場前の期間は欠測(0ではなく「データなし」)。",
      requirements: ["R3"],
    },
  ];
}

export const TFX_CLICK365_METRICS: MoneyflowMetricDefinition[] = [
  ...metricsForMarket("click365_fx"),
  ...metricsForMarket("clickkabu365_cfd"),
];

// ---------------------------------------------------------------------------
// 縦長の観測ログレコードへの変換 (期間・指標キー・区分・値・単位・近似/推定)
// ---------------------------------------------------------------------------

export interface MoneyflowObservation {
  metricKey: string;
  period: string;
  periodKind: TfxPeriodKind;
  /** 区分 (この取得元では通貨ペア/銘柄名)。 */
  category: string;
  value: number;
  unit: string;
  /** 近似値か (この取得元の出来高・建玉は TFX 公表値そのものなので常に false)。 */
  isApproximate: boolean;
  /** 推定値か (同上、常に false。実測値のみを縦持ちにする)。 */
  isEstimated: boolean;
  sourceUrl: string;
}

/**
 * (5) パース結果を「期間・指標キー・区分・値・単位・近似か・推定か」の
 * 縦長レコードに変換する。値が欠測 (`undefined`/`null`) の組み合わせは
 * 行を作らない(0で埋めない。ルール2)。
 */
export function toMoneyflowObservations(data: TfxClick365Data): MoneyflowObservation[] {
  const isFx = data.market === "click365_fx";
  const prefix = isFx ? "tfx-click365-fx" : "tfx-clickkabu365-cfd";
  const turnoverKey = `${prefix}-turnover`;
  const turnoverAvgKey = `${prefix}-turnover-daily-avg`;
  const oiKey = `${prefix}-open-interest`;

  const observations: MoneyflowObservation[] = [];

  function pushVolume(cells: TfxVolumeCell[]) {
    for (const cell of cells) {
      if (cell.total !== undefined) {
        observations.push({
          metricKey: turnoverKey,
          period: cell.period,
          periodKind: cell.periodKind,
          category: cell.instrument,
          value: cell.total,
          unit: data.unit,
          isApproximate: false,
          isEstimated: false,
          sourceUrl: data.sourceUrl,
        });
      }
      if (cell.dailyAvg !== undefined && cell.dailyAvg !== null) {
        observations.push({
          metricKey: turnoverAvgKey,
          period: cell.period,
          periodKind: cell.periodKind,
          category: cell.instrument,
          value: cell.dailyAvg,
          unit: `${data.unit}/日`,
          isApproximate: false,
          isEstimated: false,
          sourceUrl: data.sourceUrl,
        });
      }
    }
  }

  function pushOi(cells: TfxOpenInterestCell[]) {
    for (const cell of cells) {
      if (cell.value !== undefined) {
        observations.push({
          metricKey: oiKey,
          period: cell.period,
          periodKind: cell.periodKind,
          category: cell.instrument,
          value: cell.value,
          unit: data.unit,
          isApproximate: false,
          isEstimated: false,
          sourceUrl: data.sourceUrl,
        });
      }
    }
  }

  pushVolume(data.monthlyVolume);
  pushVolume(data.annualVolume);
  pushOi(data.monthEndOpenInterest);
  pushOi(data.yearEndOpenInterest);

  return observations;
}
