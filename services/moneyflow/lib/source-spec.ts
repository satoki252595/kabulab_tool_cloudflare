/**
 * moneyflow (008) 取得元アダプタの共通契約 (Phase 2〜5 統合で導入)。
 *
 * 各取得元モジュール (`services/moneyflow/lib/sources/<key>.ts`) は取得・解析・
 * 独自の指標定義を持つ。それを Phase 1 の Notion 3 DB (指標定義/観測ログ/取込ログ)
 * と「一次データ｜moneyflow」へつなぐのがアダプタ
 * (`services/moneyflow/lib/adapters/<key>.ts`) で、この型に揃える。
 *
 * 取込の流れ (実装は `scripts/moneyflow/lib/run-spec.ts`):
 *   1. `resolve()` で「今回の対象バッチの冪等キー」を軽く決める (一覧ページ等)
 *   2. 既に一次データとして保管済みなら、保管済みファイルから `toObservations()`
 *      で観測行を作り直し、最後の行が観測ログにあれば「取込済み」としてスキップ
 *      (取得元への再アクセスはしない)。無ければ全行を upsert し直す
 *   3. 未保管なら `fetch()` で本体ファイルを取り、`recordPrimaryData()` で
 *      実体アップロードしてから観測行を upsert する (ルール6)
 *
 * `toObservations()` は **key とファイルのバイト列だけ** から観測行を作る純関数に
 * する (保管済みファイルからの再解析でも同じ結果になるように。一覧ページ等の
 * 取得時メタデータに依存させない)。
 */
import type {
  IndicatorDefInput,
  MoneyflowCategoryKind,
  MoneyflowMeasureKind,
  MoneyflowUnit,
  ObservationInput,
  PrimaryFile,
} from "../../../src/shared/notion-archive/index.js";
import { observationKey } from "../../../src/shared/notion-archive/index.js";

/** 観測ログ 1 行の下書き (Notion 側のページ ID 以外すべて)。 */
export type ObservationDraft = Omit<ObservationInput, "indicatorPageId" | "primaryDataPageId">;

/** 一次データ 1 レコード分の取得結果 (= `recordPrimaryData()` の入力の素)。 */
export interface FetchedBatch {
  /** 冪等キー。`resolve()` が返したキーと一致しなければならない。 */
  key: string;
  /** 取得元の説明 (URL 等)。`recordPrimaryData({ source })` へ渡す。 */
  source: string;
  /** 取得時メタデータ (一覧ページで見た公表日・URL 等)。Notion にそのまま保存する。 */
  metadata: Record<string, unknown>;
  /** 取得した実体ファイル (1 件以上)。API 応答 JSON/CSV もファイルとして保管する。 */
  files: PrimaryFile[];
}

/** 解析に使うファイル (取得直後の `PrimaryFile`、または Notion 保管済みの再取得分)。 */
export type SpecFile = Pick<PrimaryFile, "filename" | "bytes">;

export interface ResolvedBatch {
  /** 今回の対象バッチの冪等キー。 */
  key: string;
  /** 本体を取得する (resolve 時点で取得済みならそれを返してよい)。 */
  fetch(): Promise<FetchedBatch>;
}

export interface MoneyflowSourceSpec {
  /** `--only=` に指定する取得元名 (例: "jpx-investor-equity-weekly")。 */
  name: string;
  /** この取得元が観測ログへ書く指標 (「資金フロー｜指標定義」へ同期する)。 */
  indicators: readonly IndicatorDefInput[];
  /** 今回の対象バッチを決める。dryRun=true は解決時の原本保管も送信しない。 */
  resolve(now: Date, dryRun?: boolean): Promise<ResolvedBatch>;
  /** key とファイルのバイト列から観測行を作る純関数。 */
  toObservations(input: { key: string; files: readonly SpecFile[] }): ObservationDraft[];
}

/** ファイル名で 1 件を取り出す (無い・複数あるなら throw — 取り違えて解析しない)。 */
export function requireSpecFile(files: readonly SpecFile[], predicate: (filename: string) => boolean, what: string): SpecFile {
  const hits = files.filter((f) => predicate(f.filename));
  if (hits.length !== 1) {
    throw new Error(
      `${what}: 該当ファイルが ${hits.length} 件です (1 件であるべき)。ファイル一覧: ${files.map((f) => f.filename).join(", ")}`
    );
  }
  return hits[0] as SpecFile;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UNITS: readonly MoneyflowUnit[] = ["円", "米ドル", "株", "枚", "口座", "比率", "%ポイント", "ポイント", "件", "社"];
const CATEGORY_KINDS: readonly MoneyflowCategoryKind[] = [
  "業種",
  "投資部門",
  "資産クラス",
  "国地域",
  "市場",
  "通貨",
  "商品",
  "全体",
];
const MEASURE_KINDS: readonly MoneyflowMeasureKind[] = ["実測", "推定"];

/**
 * 観測行の下書きを検証する (純関数)。Notion へ書く前に必ず通す。
 *   - 指標キーがこの取得元の指標定義に含まれる
 *   - 冪等キー (observationKey。従来 `期間|指標|区分` / 新内訳ありは7セグメント) が
 *     重複しない (重複すると後の行が前の行を黙って上書きする)
 *   - 値が有限数、日付が YYYY-MM-DD で開始<=終了、単位・区分種別・実測推定が既知の値
 *   - 新内訳の設定時は公表日が YYYY-MM-DD・階層が非負整数・内訳文字列が非空
 *   - 1 行以上ある (0 行のバッチは様式変更等の異常なので成功扱いにしない)
 *
 * @throws 上記に反する行が 1 件でもあれば、全違反をまとめて throw する。
 */
export function validateDrafts(
  specName: string,
  drafts: readonly ObservationDraft[],
  indicators: readonly IndicatorDefInput[]
): void {
  const problems: string[] = [];
  if (drafts.length === 0) problems.push("観測行が 0 件です");
  const indicatorKeys = new Set(indicators.map((i) => i.key));
  const seen = new Set<string>();
  drafts.forEach((d, i) => {
    const where = `#${i} (${d.period}|${d.indicatorKey}|${d.category})`;
    if (!indicatorKeys.has(d.indicatorKey)) problems.push(`${where}: 指標定義に無い指標キー`);
    const key = observationKey(d);
    if (seen.has(key)) problems.push(`${where}: 冪等キーが重複`);
    seen.add(key);
    for (const [name, v] of [
      ["市場区分", d.marketSegment],
      ["投資部門", d.investorCategory],
      ["取引種別", d.tradeType],
      ["親区分", d.parentCategory],
    ] as const) {
      if (v !== undefined && v !== null && v.trim() === "") {
        problems.push(`${where}: ${name}が空文字 (未設定は null にする)`);
      }
    }
    if (d.categoryLevel !== undefined && d.categoryLevel !== null) {
      if (!Number.isInteger(d.categoryLevel) || d.categoryLevel < 0) {
        problems.push(`${where}: 区分階層が非負整数でない (${d.categoryLevel})`);
      }
    }
    if (d.publicationDate !== undefined && d.publicationDate !== null) {
      if (!DATE_RE.test(d.publicationDate)) {
        problems.push(`${where}: 公表日が YYYY-MM-DD でない (${d.publicationDate})`);
      }
    }
    if (d.period.trim() === "") problems.push(`${where}: 期間が空`);
    if (d.category.trim() === "") problems.push(`${where}: 区分が空`);
    if (!Number.isFinite(d.value)) problems.push(`${where}: 値が有限数でない (${d.value})`);
    if (d.changeFromPrev !== null && !Number.isFinite(d.changeFromPrev)) {
      problems.push(`${where}: 前期比が有限数でない (${d.changeFromPrev})`);
    }
    if (d.periodStart === null || d.periodEnd === null) {
      if (!(d.periodStart === null && d.periodEnd === null &&
          /^\d{4}-(0[1-9]|1[0-2])$/.test(d.period) &&
          indicators.some((indicator) => indicator.key === d.indicatorKey && indicator.frequency === "月次"))) {
        problems.push(`${where}: 期間日付の欠損は年月が確定した月次の両端nullのみ許可します`);
      }
    } else if (!DATE_RE.test(d.periodStart) || !DATE_RE.test(d.periodEnd)) {
      problems.push(`${where}: 期間開始/終了が YYYY-MM-DD でない (${d.periodStart}〜${d.periodEnd})`);
    } else if (d.periodStart > d.periodEnd) {
      problems.push(`${where}: 期間開始 ${d.periodStart} が期間終了 ${d.periodEnd} より後`);
    }
    if (!UNITS.includes(d.unit)) problems.push(`${where}: 未知の単位 ${d.unit}`);
    if (!CATEGORY_KINDS.includes(d.categoryKind)) problems.push(`${where}: 未知の区分種別 ${d.categoryKind}`);
    if (!MEASURE_KINDS.includes(d.measureKind)) problems.push(`${where}: 未知の実測推定 ${d.measureKind}`);
  });
  if (problems.length > 0) {
    const head = problems.slice(0, 20).join("\n  ");
    const more = problems.length > 20 ? `\n  …ほか ${problems.length - 20} 件` : "";
    throw new Error(`[${specName}] 観測行の検証に失敗しました (${problems.length} 件):\n  ${head}${more}`);
  }
}

/**
 * 月の初日と末日 (YYYY-MM-DD) を返す。`yyyyMm` は "YYYY-MM"。
 * @throws 形式が違う・月が 1〜12 でない場合。
 */
export function monthRange(yyyyMm: string): { start: string; end: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(yyyyMm);
  if (!m) throw new Error(`monthRange: YYYY-MM ではありません: ${yyyyMm}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`monthRange: 月が不正です: ${yyyyMm}`);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${m[1]}-${m[2]}-01`, end: `${m[1]}-${m[2]}-${String(last).padStart(2, "0")}` };
}

/**
 * 四半期 (1〜4) の初日と末日 (暦年ベース。1Q=1〜3月) を返す。
 * @throws 四半期が 1〜4 でない場合。
 */
export function quarterRange(year: number, quarter: number): { start: string; end: string } {
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    throw new Error(`quarterRange: 四半期が不正です: ${year}Q${quarter}`);
  }
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const s = monthRange(`${year}-${String(startMonth).padStart(2, "0")}`);
  const e = monthRange(`${year}-${String(endMonth).padStart(2, "0")}`);
  return { start: s.start, end: e.end };
}
