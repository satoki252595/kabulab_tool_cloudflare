/**
 * JPX 東証 33 業種区分の正準リスト (moneyflow 用)。
 *
 * `core_stocks.sector` (JPX data_j.xlsx の「33業種区分」列) と同じ表記に揃える
 * (src/shared/jpx/sectors.ts はこの値をそのまま `sector` へ書いている)。
 * 出典: JPX「株式時価総額 (Market Capitalization by Industry Sector)」月次 PDF
 * (https://www.jpx.co.jp/markets/statistics-equities/misc/07.html、2026年8月分
 * PDF より実測。プライム市場のみの内訳で 33 業種が揃う)。
 *
 * `jpx-sector-marketcap.ts` / `jpx-short-selling.ts` は、PDF から抽出した業種名が
 * この 33 件と完全一致すること (欠落・増加が無いこと) を検証してから使う。
 * 一致しない場合は JPX 側の様式変更を疑い throw する (推測でマッピングしない — ルール2)。
 */
export const JPX_33_SECTORS: readonly string[] = [
  "水産・農林業",
  "鉱業",
  "建設業",
  "食料品",
  "繊維製品",
  "パルプ・紙",
  "化学",
  "医薬品",
  "石油・石炭製品",
  "ゴム製品",
  "ガラス・土石製品",
  "鉄鋼",
  "非鉄金属",
  "金属製品",
  "機械",
  "電気機器",
  "輸送用機器",
  "精密機器",
  "その他製品",
  "電気・ガス業",
  "陸運業",
  "海運業",
  "空運業",
  "倉庫・運輸関連業",
  "情報・通信業",
  "卸売業",
  "小売業",
  "銀行業",
  "証券、商品先物取引業",
  "保険業",
  "その他金融業",
  "不動産業",
  "サービス業",
];

/**
 * `core_stocks.sector` が NULL の銘柄をまとめる区分ラベル (`moneyflow-sector.ts`
 * が使う)。JPX 側に無い架空の業種名で埋めるフォールバックではなく、「業種未設定」
 * という区分そのものを明示するラベル。Notion「区分」select 列の選択肢としても
 * `MONEYFLOW_SECTOR_CATEGORY_OPTIONS` 経由で事前登録し、
 * `buildMissingPatch`/`SELECT_OPTIONS_CUMULATIVE_MAX` の管理下に置く
 * (自動生成された未登録の select 値として上限チェックを迂回させない)。
 */
export const MONEYFLOW_UNCLASSIFIED_SECTOR = "未分類";

/**
 * `ensureObservationsDb()` の「区分」列に事前登録する選択肢一覧。
 * JPX 33 業種 + `MONEYFLOW_UNCLASSIFIED_SECTOR`。`JPX_33_SECTORS` 自体は
 * PDF パーサの様式検証 (`assertExactly33Sectors`、必ず33件ぴったり) に使うため
 * 33件のまま保つ (ここに混ぜない)。
 */
export const MONEYFLOW_SECTOR_CATEGORY_OPTIONS: readonly string[] = [
  ...JPX_33_SECTORS,
  MONEYFLOW_UNCLASSIFIED_SECTOR,
];

/**
 * 抽出済みの業種名配列が `JPX_33_SECTORS` と過不足なく一致するか検証する。
 * 順序は問わない (PDF レイアウトの行順は将来変わりうるため、集合として比較する)。
 *
 * @throws 33 件ぴったりでない、または集合が一致しない場合 (様式変更の疑い)。
 */
export function assertExactly33Sectors(names: readonly string[], context: string): void {
  if (names.length !== 33) {
    throw new Error(
      `${context}: 業種数が 33 件ではありません (実際 ${names.length} 件)。JPX 側の様式変更を疑ってください。`
    );
  }
  const want = new Set(JPX_33_SECTORS);
  const got = new Set(names);
  const missing = [...want].filter((n) => !got.has(n));
  const extra = [...got].filter((n) => !want.has(n));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${context}: 業種名が正準リストと一致しません。` +
        `不足: [${missing.join(", ")}] 想定外: [${extra.join(", ")}]。` +
        `JPX 側の業種名表記が変わっていないか確認してください。`
    );
  }
}
