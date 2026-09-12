/**
 * 母集団 (core_stocks) 同期オーケストレータ（Cloudflare D1 / Node 取込版） — ADR-0001。
 *
 * JPX 公式 data_j.xlsx の東証内国株 (プライム/スタンダード/グロース) のうち
 * 共有4文字コード契約に合う ~3,700 銘柄を
 * core_stocks に upsert する。これにより日次/月次 sync・001/003/004 の母集団が
 * 「優待縛り ~1,600」から「東証内国普通株」へ拡張される。
 *
 * 書き込みは Node から D1 REST API 経由 (createD1HttpDb)。D1 はバインディング
 * 経由でのみ触れるが、JPX XLS のパースは Node 専用 (zip/xls) なので取込は Node 側。
 *
 * 設計:
 *   - is_yutai は触らない (otakara の優待スクレイパーが writer)
 *   - 対象外化は **raw JPX (全行)** に code が無いもの、または共有4文字コード契約
 *     の対象外になったものだけに限定する。
 *     これにより優待 REIT 等 (内国普通株フィルタ外だが JPX には掲載) を
 *     誤って inactivate しない
 *
 * CLAUDE.md フォールバック禁止: JPX の件数不足・既存母集団からの異常縮小は
 * 書き込み前に throw し、大量 inactivate を防ぐ。
 *
 * 実行:
 *   pnpm sync:universe              (CLI / scripts/sync/universe.ts)
 *   月次 cron は sync:universe の後に sync:monthly:core を呼ぶ
 */

import { sql, inArray, eq } from "drizzle-orm";
import { createD1HttpDb } from "../shared/db/d1-http-client.js";

import * as coreSchema from "../../services/rsi-screening/src/db/core-schema.js";
import {
  downloadJpxListing,
  isListedEquity,
  type JpxRow,
} from "../shared/jpx/sectors.js";
import { isValidStockCode } from "../shared/jpx/stock-code.js";

type Db = ReturnType<typeof createUniverseDb>;

/**
 * core_stocks への書き込みに必要なメソッドのみを要求する構造的な型。
 * 月次/日次 sync は別スキーマ generic の db を持つため Pick で受け口を広げる。
 */
type CoreWriterDb = Pick<Db, "insert" | "select" | "update">;

/**
 * upsert の bind 上限 (D1: 100/文) 対策チャンク。core_stocks は upsert で
 * 6 列 (code/name/market/sector/is_active/is_yutai既定値) を bind するので
 * 16 行/文 (96 bind) に抑える。
 */
const UPSERT_CHUNK = 16;
/** inactivate の IN リスト bind 上限対策チャンク (1 列 × N 値、80 < 100)。 */
const INACT_CHUNK = 80;
/**
 * ガード(a) の下限。**`rawCount` は data_j の全行数**で、ETF/ETN・REIT・PRO Market・
 * 外国株の行も、5 文字の種類株の行も含む (`isListedEquity` も 4 文字コード契約も
 * 通す**前**の値。sectors.ts が落とすのは「コード列がそもそも数値でも文字列でも
 * ない行」だけ)。2026-06-30 版は 4,437 件。
 *
 * ここに内国株だけに絞った件数を渡すと、この下限は「非株式行の欠落・列崩れの
 * 検知器」として機能しなくなる (ETF/REIT が丸ごと消えても 4,000 を割らない)。
 * 母集団の絞り込みは equityCount 側の責務。
 */
const MIN_JPX_ROWS = 4_000;
/** 2026-06-30版は内国株式3,716件・4文字対象3,709件。部分取得を拒否する下限。 */
const MIN_EQUITY_ROWS = 3_000;
/**
 * ガード(c)。JPX 側の対象株が既存母集団の 98% を下回る入力を拒否する。
 * 分母は「既存 active のうち内国普通株」で、`instrument_type` が未充填なら
 * 従来の active 全体へ縮退する (coverageDenominator)。
 */
const MIN_EXISTING_COVERAGE = 0.98;
/** 1 run で既存activeの2%超を対象外化する入力は mutation 前に拒否する。 */
const MAX_DEACTIVATION_RATIO = 0.02;

/**
 * `core_stocks.instrument_type` の内国普通株を表す語彙。ガード(c) の分母の
 * 絞り込み条件 `is_active = 1 AND instrument_type = 'equity'` と、
 * stockStock 側の充填で**同じ文字列**を使う
 * (`src/jp_stock_pipeline/cloud_store/universe_guards.py`)。
 *
 * 充填の述語をずらしてはいけない。(c) の分子は `isListedEquity` (「内国株式」かつ
 * プライム|スタンダード|グロース かつ 4 文字コード) を通った件数なので、分母を
 * `instrument_type='equity'` で数えるなら充填も同じ述語でなければならない。
 * たとえば PRO Market の内国株を `equity` に入れると分母が分子より構造的に
 * 大きくなり、(c) が恒久的に 98% を割る。
 */
export const INSTRUMENT_TYPE_EQUITY = "equity";

/**
 * 「`instrument_type` の充填が済んでいる」と見なす equity 件数の下限。
 * **新しい数字は発明していない**: (b) が「内国株式が 3,000 件未満の入力は部分取得
 * として拒否する」と既に宣言しているので、`core_stocks` 側の内国普通株が 3,000 件を
 * 割っているなら母集団が壊れているか充填が途中で止まっているかのどちらかしかない。
 *
 * この下限が無いと **(c) が黙って空虚になる** (assertUniverseCoverage の docstring)。
 */
const MIN_BACKFILLED_EQUITY_ROWS = MIN_EQUITY_ROWS;

export interface UniverseSyncResult {
  /** JPX ファイル内の基準日 (YYYY-MM-DD) */
  sourceAsOf: string;
  /** data_j.xlsx の全行数 */
  jpxRows: number;
  /** 内国普通株 (sync 対象) 件数 */
  equities: number;
  /** core_stocks に upsert した件数 */
  upserted: number;
  /** raw JPX 不在またはコード契約対象外として inactive にした件数 */
  deactivated: number;
}

export function createUniverseDb() {
  // createD1HttpDb は core_* スキーマを自動登録するので追加スキーマは不要。
  return createD1HttpDb({});
}

/**
 * equity の分母を信用してよいか。(c) の縮退と (d2) の評価が**同じ述語**を使う。
 *
 * ここを「`null`/`0` 以外なら信用する」にすると、充填が途中で止まった状態で
 * (c) が空虚になり (d2) が誤発火する (assertUniverseCoverage の docstring)。
 */
export function instrumentTypeBackfilled(
  existingEquityActiveCount: number | null | undefined
): boolean {
  return (
    existingEquityActiveCount !== null &&
    existingEquityActiveCount !== undefined &&
    existingEquityActiveCount >= MIN_BACKFILLED_EQUITY_ROWS
  );
}

/**
 * (c) の分母と、それを選んだ理由のラベルを返す。
 *
 * ラベルはエラーメッセージへ入れる。「0.833 で落ちた」だけを見せられても、分母が
 * equity なのか active 全体なのか (= 充填漏れなのか本当の被覆不足なのか) が読めず、
 * 対処が分かれてしまう。
 */
export function coverageDenominator(
  existingActiveCount: number,
  existingEquityActiveCount: number | null | undefined
): { value: number; label: string } {
  if (existingEquityActiveCount === null || existingEquityActiveCount === undefined) {
    return { value: existingActiveCount, label: "active 全体／instrument_type 未観測" };
  }
  if (existingEquityActiveCount <= 0) {
    // 列はあるが全 NULL (2026-09-12 時点の本番 core_stocks はこの状態)。
    // 従来の分母へ縮退する。fail-closed。
    return { value: existingActiveCount, label: "active 全体／instrument_type 未充填" };
  }
  if (!instrumentTypeBackfilled(existingEquityActiveCount)) {
    // 充填が途中で止まっている。この分母を使うと (c) が空虚になるので、
    // 0 件とまったく同じに扱う (縮退先は従来の分母 = fail-closed)。
    return {
      value: existingActiveCount,
      label:
        `active 全体／instrument_type 部分充填 (equity ${existingEquityActiveCount} 件` +
        ` < 下限 ${MIN_BACKFILLED_EQUITY_ROWS} 件)`,
    };
  }
  return {
    value: existingEquityActiveCount,
    label: `active かつ ${INSTRUMENT_TYPE_EQUITY}`,
  };
}

/** (c)(d2) の分母・分子に使う `instrument_type` 由来の件数。 */
export interface UniverseEquityCounts {
  /**
   * `is_active = 1 AND instrument_type = 'equity'` の行数。(c) の分母および
   * (d2) の分母。`null`/`undefined`／`0`／`MIN_BACKFILLED_EQUITY_ROWS` 未満は
   * 「未観測・未充填・部分充填」で、(c) は従来の分母へ縮退し (d2) は評価しない。
   * `existingActiveCount` を超える値は拒否する。
   */
  existingEquityActiveCount?: number | null;
  /**
   * 対象外化候補のうち `instrument_type = 'equity'` の件数。(d2) の分子。
   * 省略・`null` なら (d2) は評価しない。
   */
  pendingDeactivationEquityCount?: number | null;
}

/**
 * 部分取得・パース崩れによる大量対象外化を mutation 前に拒否する。
 *
 * 4 条件。(a)(b)(c) は「未満で失敗」、(d1)(d2) は「超過で失敗」。境界値ちょうどは通る。
 * (c)(d1)(d2) は `existingActiveCount === 0` のとき丸ごとスキップされる — 0 除算
 * 避けではなく**初回 seed を通すための意図的な穴**なので、そのまま保つ。
 *
 * stockStock 側 (`src/jp_stock_pipeline/cloud_store/universe_guards.py`、PR #36) と
 * **1:1 で同じ条件・同じ分母**にしてある。実際に月次で throw するのはこちら側なので、
 * 揃えないと移行 P4b (母集団 +725 行) で母集団同期が恒久的に止まる。
 *
 * ## (c) の分母を equity に絞る理由
 *
 * 元の実装は (c)(d) の分母をどちらも `is_active=1` の全件にしていた。P4b で
 * ETF/ETN/PRO/外国株が +725 行入って active が 4,440 になると、(c) は
 * **3,700/4,440 = 0.833 < 0.98 で毎月 throw** する。分子 `equityCount` は
 * `isListedEquity` を通った内国普通株しか数えないのに分母だけが全銘柄種別を数えて
 * いるせいで、**母集団を広げるほど比率が下がる**という壊れ方をする。
 *
 * ## (d) を (d1)/(d2) に割る理由
 *
 * (d) の分子 `pendingDeactivationCount` は active **全件**から算出される
 * (`shouldDeactivateUniverseCode` は data_j の全行集合と突き合わせるので ETF や
 * REIT の上場廃止も候補に入る)。ここで (d) の分母だけを equity に絞ると
 * **分子 ⊄ 分母**になり、「守っている母集団に対する割合」という意味が消える
 * (極端には比率が 1 を超える)。よって分子と分母の母集団を必ず揃える:
 *
 * - (d1) = 分子・分母とも active 全体 (元の実装のまま)。銘柄種別を問わない
 *   大量対象外化 (ETF が一斉に消える事故) を拾う
 * - (d2) = 分子・分母とも equity。P4b 後に内国普通株の対象外化の実効上限が
 *   74 件 → 88 件へ自動的に緩むのを塞ぐ。対象外化の候補は実質すべて内国普通株
 *   なので、(d1) だけだと防御が弱くなる一方になる
 *
 * ## `instrument_type` が未充填・部分充填のとき
 *
 * 2026-09-12 時点の本番 `core_stocks` は P4a の列追加だけが済んでおり
 * `instrument_type` は全行 NULL。この状態で equity に絞ると分子ではなく**分母が 0**
 * になる。また充填は 3,818 行への UPDATE をチャンクで回す別フェーズなので、D1 の
 * レート制限やタイムアウトで**途中終了しうる**。
 *
 * `0` だけを未充填として扱うと、部分充填で穴が開く。equity 件数が 500 のまま
 * P4b を通した場合:
 *
 * - **(c) は fail-open**: 3,100/500 = 6.2 なので 0.98 を割らない。本当の被覆率は
 *   3,100/4,440 = 0.698 で、部分取得された data_j を素通しする
 * - **(d2) は fail-closed だが誤発火**: 11/500 = 2.2% で止まる。実母集団に対しては
 *   11/3,700 = 0.3% で、これは消したはずの「毎月 throw する」の再来
 *
 * → `MIN_BACKFILLED_EQUITY_ROWS` を下回る equity 件数は `0` と同じ扱いにし、
 * (c) は従来の分母へ縮退 (P4b 後なら 0.833 で発火 = fail-closed)、(d2) は
 * 評価しない (誤発火させない)。どちらも `instrumentTypeBackfilled()` という
 * 1 つの述語から出す。
 */
export function assertUniverseCoverage(
  rawCount: number,
  equityCount: number,
  existingActiveCount: number,
  pendingDeactivationCount: number,
  equityCounts: UniverseEquityCounts = {}
): void {
  const { existingEquityActiveCount, pendingDeactivationEquityCount } = equityCounts;

  // equity active ⊆ active なので超過は構造的にありえない。引数の取り違えか
  // SELECT の失敗で、その値を分母に使うと (c)(d2) の意味が丸ごと変わる。先に止める。
  if (
    existingEquityActiveCount !== null &&
    existingEquityActiveCount !== undefined &&
    existingEquityActiveCount > existingActiveCount
  ) {
    throw new Error(
      `ガード(前提): active かつ ${INSTRUMENT_TYPE_EQUITY} が ${existingEquityActiveCount} 件で` +
        ` active 全体 ${existingActiveCount} 件を超えています。部分集合なのでありえません。` +
        " 引数の取り違えか SELECT の失敗を疑ってください。"
    );
  }
  if (rawCount < MIN_JPX_ROWS) {
    throw new Error(
      `JPX listing が ${rawCount} 件で安全下限 ${MIN_JPX_ROWS} 件未満です。` +
        " data_j.xlsx の部分取得・列形式変更を疑ってください。"
    );
  }
  if (equityCount < MIN_EQUITY_ROWS) {
    throw new Error(
      `JPX 対象株が ${equityCount} 件で安全下限 ${MIN_EQUITY_ROWS} 件未満です。` +
        " data_j.xlsx の部分取得・列形式変更を疑ってください。"
    );
  }
  const denominator = coverageDenominator(
    existingActiveCount,
    existingEquityActiveCount
  );
  if (
    denominator.value > 0 &&
    equityCount / denominator.value < MIN_EXISTING_COVERAGE
  ) {
    throw new Error(
      `JPX 対象株 ${equityCount} 件が既存 ${denominator.value} 件 ` +
        `(${denominator.label}) の ${(MIN_EXISTING_COVERAGE * 100).toFixed(0)}% 未満です。` +
        " 大量対象外化を防ぐため同期を中止します。"
    );
  }
  // (d1) 分子が全銘柄種別なので分母も active 全体で据え置く。
  if (
    existingActiveCount > 0 &&
    pendingDeactivationCount / existingActiveCount > MAX_DEACTIVATION_RATIO
  ) {
    throw new Error(
      `対象外化候補 ${pendingDeactivationCount} 件が既存 active ${existingActiveCount} 件の ` +
        `${(MAX_DEACTIVATION_RATIO * 100).toFixed(0)}% を超えています。` +
        " JPX 入力または市場スコープを確認してください。"
    );
  }
  // (d2) equity の分子を equity の分母で見る。信用できない分母では評価しない。
  if (
    pendingDeactivationEquityCount !== null &&
    pendingDeactivationEquityCount !== undefined &&
    instrumentTypeBackfilled(existingEquityActiveCount) &&
    existingEquityActiveCount !== null &&
    existingEquityActiveCount !== undefined &&
    pendingDeactivationEquityCount / existingEquityActiveCount >
      MAX_DEACTIVATION_RATIO
  ) {
    throw new Error(
      `内国普通株の対象外化候補 ${pendingDeactivationEquityCount} 件が既存 active かつ ` +
        `${INSTRUMENT_TYPE_EQUITY} ${existingEquityActiveCount} 件の ` +
        `${(MAX_DEACTIVATION_RATIO * 100).toFixed(0)}% を超えています。` +
        " JPX 入力または市場スコープを確認してください。"
    );
  }
}

/** universe のスコープから外す条件を一箇所に固定する。 */
export function shouldDeactivateUniverseCode(
  code: string,
  rawCodes: ReadonlySet<string>
): boolean {
  return !rawCodes.has(code) || !isValidStockCode(code);
}

/**
 * 取得済み JPX 行から core_stocks を東証内国普通株へ同期する。
 *
 * @param db      core スキーマに書ける drizzle クライアント
 * @param jpxRows downloadJpxListing() の戻り (raw 全行を渡すこと)
 */
export async function seedUniverse(
  db: CoreWriterDb,
  jpxRows: JpxRow[]
): Promise<UniverseSyncResult> {
  if (jpxRows.length === 0) {
    throw new Error("JPX listing が 0 行。data_j.xlsx の取得を確認してください。");
  }
  const equities = jpxRows.filter(isListedEquity);
  const sourceDates = new Set(jpxRows.map((row) => row.asOf));
  if (sourceDates.size !== 1) {
    throw new Error(
      `JPX listing の基準日が一意ではありません: ${[...sourceDates].join(", ")}`
    );
  }
  const sourceAsOf = jpxRows[0].asOf;
  const rawCodes = new Set(jpxRows.map((r) => r.code));
  // ガード(c)(d2) が要る `instrument_type` 由来の件数は、この既存 SELECT に
  // **相乗りさせて** JS 側で数える。列を 1 つ射影に足しても走査する行は同じで、
  // 別に `SELECT COUNT(*) ... WHERE instrument_type='equity'` を撃つと
  // そのぶん rows_read (D1 の課金単位) が増える。増やさないのが要件。
  const existing = await db
    .select({
      id: coreSchema.stocks.id,
      code: coreSchema.stocks.code,
      instrumentType: coreSchema.stocks.instrumentType,
    })
    .from(coreSchema.stocks)
    .where(eq(coreSchema.stocks.isActive, true));
  const pendingDeactivation = existing.filter((s) =>
    shouldDeactivateUniverseCode(s.code, rawCodes)
  );
  const deactivatedIds = pendingDeactivation.map((s) => s.id);
  const isEquityRow = (s: { instrumentType: string | null }): boolean =>
    s.instrumentType === INSTRUMENT_TYPE_EQUITY;
  assertUniverseCoverage(
    jpxRows.length,
    equities.length,
    existing.length,
    deactivatedIds.length,
    {
      // 全行 NULL の遷移期はここが 0 になり、(c) は従来の分母へ縮退して
      // (d2) は評価されない (assertUniverseCoverage の docstring)。
      existingEquityActiveCount: existing.filter(isEquityRow).length,
      pendingDeactivationEquityCount: pendingDeactivation.filter(isEquityRow).length,
    }
  );

  // --- 内国普通株を upsert (is_yutai は触らない) ---
  let upserted = 0;
  for (let i = 0; i < equities.length; i += UPSERT_CHUNK) {
    const slice = equities.slice(i, i + UPSERT_CHUNK);
    await db
      .insert(coreSchema.stocks)
      .values(
        slice.map((r) => ({
          code: r.code,
          name: r.name,
          market: r.marketCategory,
          sector: r.sector33,
          isActive: true,
        }))
      )
      .onConflictDoUpdate({
        target: coreSchema.stocks.code,
        set: {
          name: sql`excluded.name`,
          market: sql`excluded.market`,
          sector: sql`excluded.sector`,
          isActive: sql`1`,
          updatedAt: sql`(unixepoch())`,
        },
      });
    upserted += slice.length;
  }

  // --- 対象外化: raw JPX 不在、または共有4文字コード契約の対象外 ---
  // 5桁種類株は Yahoo 自体に存在しても全サービスのコード契約外なので、
  // 過去runでactive化済みの行もここで明示的に外す。
  for (let i = 0; i < deactivatedIds.length; i += INACT_CHUNK) {
    await db
      .update(coreSchema.stocks)
      .set({ isActive: false, updatedAt: sql`(unixepoch())` })
      .where(
        inArray(
          coreSchema.stocks.id,
          deactivatedIds.slice(i, i + INACT_CHUNK)
        )
      );
  }

  return {
    sourceAsOf,
    jpxRows: jpxRows.length,
    equities: equities.length,
    upserted,
    deactivated: deactivatedIds.length,
  };
}

/** CLI / 単独実行用: JPX を DL してから seed する */
export async function runUniverseSync(
  db: CoreWriterDb
): Promise<UniverseSyncResult> {
  const jpxRows = await downloadJpxListing();
  return seedUniverse(db, jpxRows);
}
