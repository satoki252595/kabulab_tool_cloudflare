/**
 * 要約取込の原子適用: 同一銘柄の要約・推定値・利回り・スコアの全 UPDATE を
 * D1 REST `{batch}` 1 リクエストに束ねる (銘柄単位の原子単位)。
 *
 * 背景: 従来の `--apply` は要約書き込み→利回り再計算→スコア更新を逐次リクエストで
 * 送っていたため、途中で中断すると銘柄内に部分状態が残った (再実行の冪等で回復は
 * するが、通常呼び出し自体が原子ではなかった)。sqlite-proxy は `db.batch()` 非対応
 * のため、D1 REST の `{batch}` envelope を直接送る (`createD1HttpBatchSender`)。
 * BEGIN/COMMIT は送らない (D1 REST が受け付けないため)。
 *
 * 原子性の単位は銘柄: 1 銘柄の全 UPDATE が 1 リクエスト。銘柄間の失敗は止めて
 * 同引数の再実行で回復する (適用済み銘柄は無変更・冪等)。
 */
import type { D1BatchStatement } from "../../../src/shared/db/d1-http-client.js";
import { INSTRUMENT_TYPE_EQUITY } from "../../../src/shared/jpx/instrument-type.js";
import { buildBenefitUpdateStatements, type PlannedUpdate } from "./summary-import.js";
import {
  buildYieldScoreStatements,
  type YieldInputs,
  type YieldRecomputePlan,
} from "./recompute-yields.js";

/**
 * 同銘柄ガード batch の先頭 preflight が検証する projection preimage
 * (計画に使う列の射影。行の全集合 × 列の射影であり、全列の full ではない)。
 *
 * REST batch は changes() 0 を放置すると部分適用になるため、batch 内の
 * 先頭文で「射影列が計画時と 1 列も違わない」ことを SQL エラー化する
 * (不一致 → `json('')` が throw → batch 全体 rollback)。
 * 通常 import と ABC (A+C 統合) の両経路がこの同一 builder を使う。
 *
 * 射影に含まれない列 (preflight は見ない): 優待 genre_id/created_at、
 * 財務 eps/bps/roa/market_cap/ma_5/ma_75、スコア scored_at/yutai_months/
 * yutai_genre_ids、親 core の code/is_active 以外 (instrument_type は
 * equity 述語でのみ確認)。全列が必要な CAS は complement 文を同 batch に
 * 足すこと (全列 preimage はこの builder の責務外)。
 */
export type StockBenefitPreimage = {
  id: number;
  stockId: number;
  minShares: number;
  recordMonth: number;
  description: string;
  shortSummary: string | null;
  estimatedValue: number | null;
  estimateValueSource: string | null;
  /** 更新時刻 (unix 秒)。 */
  updatedAt: number;
};

export type StockPreimage = {
  stockId: number;
  /**
   * 親銘柄の同一性 (銘柄 ID・コード・active)。付け替え・凍結破りを
   * preflight で止める。snapshot 時に行が無ければ STOP する
   * (null 許容にしない。ガードを縮めないため)。
   * 区分 (`instrument_type`) の値は保持しない (personal-only)。
   * preflight は値 CAS (id・コード・active) に加え、正常適格の述語
   * (`activeEquityCondition()` と等価。値は bind) を要求する。
   * 非 active・非 equity の銘柄は preimage の値にかかわらず落ちる。
   */
  parent: { code: string; isActive: boolean };
  /** 同銘柄の優待行の全集合 (行の追加・削除を検知。列は下の射影のみ。genre_id/created_at は見ない)。 */
  benefits: StockBenefitPreimage[];
  /**
   * 財務行 (利回り・スコア計算の入力 + 行の同一性)。行が無ければ null。
   * スコア計算 (`scoreStock`) が読む 8 列も全て保持する。`fetched_at`
   * だけでは月次 writer 以外の書き換え (8 列の部分更新) を検知できないため、
   * 代理にしない (実際に計算に使う列をそのまま比べる)。
   */
  financial: {
    yutaiYield: number | null;
    dataDate: string;
    price: number | null;
    per: number | null;
    pbr: number | null;
    dividendYield: number | null;
    roe: number | null;
    ma25: number | null;
    rsi14: number | null;
    macd: number | null;
    macdSignal: number | null;
    fetchedAt: number;
  } | null;
  /** スコア行。行が無ければ null。 */
  scores: {
    fundamentalScore: number;
    technicalScore: number;
    totalScore: number;
  } | null;
};

/**
 * 利回り再計算と同じ読み (`fetchYieldInputs` の結果) から preimage を切る。
 * ガードの snapshot は計画の計算入力と同一読取でなければならない
 * (別 fresh 読みの代用は drift の見逃しになる)。
 */
export function snapshotStockPreimages(
  inputs: YieldInputs,
  stockIds: readonly number[]
): Map<number, StockPreimage> {
  const out = new Map<number, StockPreimage>();
  for (const stockId of [...new Set(stockIds)]) {
    const fin = inputs.prices.get(stockId);
    const scoreInput = inputs.scoreInputs.get(stockId);
    if (fin && !scoreInput) {
      throw new Error(
        `銘柄 ${stockId} の財務行はあるのにスコア入力がありません (ガードを縮めない)`
      );
    }
    const parent = inputs.parents.get(stockId);
    if (!parent) {
      throw new Error(
        `銘柄 ${stockId} の親銘柄行 (core_stocks) がありません (ガードを縮めない。missing STOP)`
      );
    }
    out.set(stockId, {
      stockId,
      parent: { code: parent.code, isActive: parent.isActive },
      benefits: (inputs.benefits.get(stockId) ?? [])
        .map((b) => ({
          id: b.rowId,
          stockId,
          minShares: b.minShares,
          recordMonth: b.recordMonth,
          description: b.description,
          shortSummary: b.shortSummary,
          estimatedValue: b.estimatedValue,
          estimateValueSource: b.estimateValueSource,
          updatedAt: b.updatedAt,
        }))
        .sort((a, b) => a.id - b.id),
      financial:
        fin && scoreInput
          ? {
              yutaiYield: fin.yutaiYield,
              dataDate: fin.dataDate,
              price: fin.price,
              // scoreStock に渡すのと同一オブジェクトの値をそのまま保持する。
              per: scoreInput.per,
              pbr: scoreInput.pbr,
              dividendYield: scoreInput.dividendYield,
              roe: scoreInput.roe,
              ma25: scoreInput.ma25,
              rsi14: scoreInput.rsi14,
              macd: scoreInput.macd,
              macdSignal: scoreInput.macdSignal,
              fetchedAt: fin.fetchedAt,
            }
          : null,
      scores: inputs.scores.get(stockId) ?? null,
    });
  }
  return out;
}

/**
 * 検証 (plan 作成) 時に読んだ対象優待行のタプル。適用時の再読と突き合わせ、
 * 検証→再読の間に変わっていたら batch を 1 送信もせず STOP する。
 * 再読を「正しい新 preimage」に採用すると、検証後の改変を旧 task plan で
 * 上書きできるため、ガードは一致した入力 snapshot の側に置く。
 * 通常 import と ABC (A+C 統合) の両経路がこの同一境界を通る
 * (/tmp だけのガードは不可)。
 */
export type VerifiedBenefitTuple = {
  id: number;
  stockId: number;
  stockCode: string;
  minShares: number;
  recordMonth: number;
  description: string;
  shortSummary: string | null;
  estimatedValue: number | null;
  estimateValueSource: string | null;
  /** 更新時刻 (unix 秒)。 */
  updatedAt: number;
};

const VERIFIED_BENEFIT_COLUMNS = [
  "stockId",
  "minShares",
  "recordMonth",
  "description",
  "shortSummary",
  "estimatedValue",
  "estimateValueSource",
  "updatedAt",
] as const;

/**
 * 検証時タプルと適用時の再読 (`fetchYieldInputs` の benefits) が対象の全行で
 * 一致することを確認する (純関数)。銘柄コードの対応も検証時の task 側と
 * 要求する (再読の id→銘柄の引き直しだけでは、行の銘柄付け替えを見逃す)。
 * 不一致が 1 行でもあれば throw し、呼び出し側は batch を作らず送らず STOP
 * する (ドリフト行の除外はしない)。値は出さず id・銘柄・列名だけ出す。
 */
export function assertVerifiedBenefitsMatch(input: {
  verified: ReadonlyMap<number, VerifiedBenefitTuple>;
  targetIds: readonly number[];
  reread: YieldInputs["benefits"];
  codeOf: (stockId: number) => string;
}): void {
  const rereadById = new Map<number, { stockId: number } & Record<string, unknown>>();
  for (const [stockId, rows] of input.reread) {
    for (const r of rows) rereadById.set(r.rowId, { ...r, stockId });
  }
  for (const id of [...new Set(input.targetIds)]) {
    const v = input.verified.get(id);
    if (!v) {
      throw new Error(
        `優待行 ${id} の検証時タプルがありません (呼び出し契約違反: 対象の全タプルを渡すこと)`
      );
    }
    const r = rereadById.get(id);
    if (!r) {
      throw new Error(`優待行 ${id} (${v.stockCode}) が検証時から消えました (適用せず STOP)`);
    }
    const changed: string[] = [];
    for (const col of VERIFIED_BENEFIT_COLUMNS) {
      if (r[col] !== v[col]) changed.push(col);
    }
    if (changed.length > 0) {
      throw new Error(
        `優待行 ${id} (${v.stockCode}) が検証後に変わりました [${changed.join(", ")}] (適用せず STOP)`
      );
    }
    const actualCode = input.codeOf(r.stockId);
    if (actualCode !== v.stockCode) {
      throw new Error(
        `優待行 ${id} の銘柄が検証時 ${v.stockCode} から ${actualCode} に変わりました (適用せず STOP)`
      );
    }
  }
}

/**
 * 1 銘柄の projection preimage 検証文を作る (純関数・副作用なし)。
 *
 * 仕組み: snapshot 全体を 1 bound JSON で渡し (`$.benefits` 配列 +
 * `$.financial` + `$.scores`)、`json_each` CTE で期待集合を起こして現行と
 * 突き合わせる。優待行は件数 + 双方向 EXCEPT (NULL は集合意味で等価。
 * 追加・削除も検知)。財務・スコアは行の有無 + 射影列の NULL-safe (`IS`) 照合
 * (全列ではない。財務は利回り・日付・株価 + スコア計算の実入力 8 列 + 取得時刻)。
 * 1 列でも違えば `json('')` が throw し、D1 REST batch 全体が rollback する
 * (SQLite 公式: 不正 JSON への `json()` はエラー)。
 * bind は snapshot JSON 1 + stockId 5 の計 6 (D1 上限 100/文に収まる)。
 */
export function buildStockPreflightStatement(snapshot: StockPreimage): D1BatchStatement {
  const sql = [
    "-- preflight: 同銘柄の projection preimage (射影) が計画時と一致しなければ SQL エラーで batch 全体 rollback",
    "WITH snap(j) AS (VALUES (?)),",
    "exp_ben(id, stock_id, min_shares, record_month, description, short_summary, estimated_value, estimate_value_source, updated_at) AS (",
    "  SELECT json_extract(value, '$.id'), json_extract(value, '$.stockId'), json_extract(value, '$.minShares'), json_extract(value, '$.recordMonth'), json_extract(value, '$.description'), json_extract(value, '$.shortSummary'), json_extract(value, '$.estimatedValue'), json_extract(value, '$.estimateValueSource'), json_extract(value, '$.updatedAt') FROM json_each(json_extract((SELECT j FROM snap), '$.benefits'))",
    "),",
    "act_ben(id, stock_id, min_shares, record_month, description, short_summary, estimated_value, estimate_value_source, updated_at) AS (",
    "  SELECT id, stock_id, min_shares, record_month, description, short_summary, estimated_value, estimate_value_source, updated_at FROM yutai_benefits WHERE stock_id = ?",
    "),",
    "fin_ok(ok) AS (",
    "  SELECT CASE WHEN json_extract((SELECT j FROM snap), '$.financial') IS NULL THEN (SELECT count(*) = 0 FROM otakara_stock_financials WHERE stock_id = ?) ELSE EXISTS (SELECT 1 FROM otakara_stock_financials WHERE stock_id = ? AND yutai_yield IS json_extract((SELECT j FROM snap), '$.financial.yutaiYield') AND data_date IS json_extract((SELECT j FROM snap), '$.financial.dataDate') AND price IS json_extract((SELECT j FROM snap), '$.financial.price') AND per IS json_extract((SELECT j FROM snap), '$.financial.per') AND pbr IS json_extract((SELECT j FROM snap), '$.financial.pbr') AND dividend_yield IS json_extract((SELECT j FROM snap), '$.financial.dividendYield') AND roe IS json_extract((SELECT j FROM snap), '$.financial.roe') AND ma_25 IS json_extract((SELECT j FROM snap), '$.financial.ma25') AND rsi_14 IS json_extract((SELECT j FROM snap), '$.financial.rsi14') AND macd IS json_extract((SELECT j FROM snap), '$.financial.macd') AND macd_signal IS json_extract((SELECT j FROM snap), '$.financial.macdSignal') AND fetched_at IS json_extract((SELECT j FROM snap), '$.financial.fetchedAt')) END",
    "),",
    "sco_ok(ok) AS (",
    "  SELECT CASE WHEN json_extract((SELECT j FROM snap), '$.scores') IS NULL THEN (SELECT count(*) = 0 FROM otakara_stock_scores WHERE stock_id = ?) ELSE EXISTS (SELECT 1 FROM otakara_stock_scores WHERE stock_id = ? AND fundamental_score IS json_extract((SELECT j FROM snap), '$.scores.fundamentalScore') AND technical_score IS json_extract((SELECT j FROM snap), '$.scores.technicalScore') AND total_score IS json_extract((SELECT j FROM snap), '$.scores.totalScore')) END",
    "),",
    "par_ok(ok) AS (",
    // 親は値 CAS (id・コード・active) + 正常適格の述語で確認する。
    // 区分の値は select せず `activeEquityCondition()` と等価の述語
    // (is_active = 1 AND instrument_type = 'equity'。値は bind) で確認する
    // (personal-only。ライセンス D-13-6。等価性はテストで固定)。
    // 非 active・非 equity の銘柄は preimage の値にかかわらず落ちる
    // (凍結行への適用を境界で止める。fail-closed)。
    "  SELECT EXISTS (SELECT 1 FROM core_stocks WHERE id = ? AND code IS json_extract((SELECT j FROM snap), '$.parent.code') AND is_active IS json_extract((SELECT j FROM snap), '$.parent.isActive') AND is_active IS 1 AND instrument_type IS ?)",
    ")",
    "SELECT json(CASE WHEN (SELECT count(*) FROM act_ben) = (SELECT count(*) FROM exp_ben) AND NOT EXISTS (SELECT * FROM act_ben EXCEPT SELECT * FROM exp_ben) AND NOT EXISTS (SELECT * FROM exp_ben EXCEPT SELECT * FROM act_ben) AND (SELECT ok FROM fin_ok) AND (SELECT ok FROM sco_ok) AND (SELECT ok FROM par_ok) THEN 'null' ELSE '' END)",
  ].join("\n");
  const sid = snapshot.stockId;
  return { sql, params: [JSON.stringify(snapshot), sid, sid, sid, sid, sid, sid, INSTRUMENT_TYPE_EQUITY] };
}

/** batch 1 件分の送信口。本番は `createD1HttpBatchSender()`、テストでは差し替える。 */
export type AtomicBatchSender = (
  statements: readonly D1BatchStatement[]
) => Promise<void>;

/** 1 銘柄分の batch (1 リクエストで送る文の束)。 */
export type StockBatch = {
  stockId: number;
  statements: D1BatchStatement[];
  /**
   * 呼び出し側の種別つき完了キー (例: `atr:291`)。再送・再開の完了記録に
   * 使う。銘柄 ID だけをキーにすると同一銘柄の別種別 batch を落とす
   * (市場36復元で実検出・重複送信0で修正)。キーを付ける場合は全 batch に
   * 付け、`applyAtomicBatches` が重複を投げる。
   */
  key?: string;
};

/**
 * 銘柄単位の batch 計画 (副作用なし・決定的な順序)。
 * 非空 batch の先頭に必ず preflight 文を置く (preimage 不一致は
 * SQL エラー → batch 全体 rollback。ドリフト行の除外はしない。
 * 不一致の銘柄は batch を作らず止めるため、呼び出し側で除外せず STOP する)。
 * 要約の文を先に、利回り・スコアの文を後に並べる (従来の逐次順序と同じ)。
 * `stockOfBenefit` で解決できない優待行・preimage が無い銘柄があれば
 * 書く前に throw する (黙って落とさない)。
 * 文が 0 件の銘柄は含めない (再実行で 0 件・冪等)。
 */
export function planAtomicBatches(input: {
  updates: readonly PlannedUpdate[];
  yieldPlan: YieldRecomputePlan;
  stockOfBenefit: (benefitId: number) => number | undefined;
  /** 同銘柄の projection preimage (必須。計算入力と同一読取の snapshot)。 */
  preimages: ReadonlyMap<number, StockPreimage>;
}): StockBatch[] {
  const benefitByStock = new Map<number, D1BatchStatement[]>();
  for (const u of input.updates) {
    const idsByStock = new Map<number, number[]>();
    for (const id of u.ids) {
      const stockId = input.stockOfBenefit(id);
      if (stockId === undefined) {
        throw new Error(
          `優待行 ${id} の銘柄が今の D1 から引けません (taskId=${u.taskId}。再取得と並行した疑い)`
        );
      }
      // 同値省略: preimage の 3 実値と完全一致する ID は文を作らない。
      // preimage/ID の欠落は黙殺せず投げる (ガードを縮めない)。
      // 要約・推定値・出典の 3 列だけを比べる (掲載文 description は
      // ABC 更新の対象外のため持ち込まない)。
      const preimage = input.preimages.get(stockId);
      if (!preimage) {
        throw new Error(
          `銘柄 ${stockId} の preimage がありません (ガード無しの batch は作らない)`
        );
      }
      const row = preimage.benefits.find((b) => b.id === id);
      if (!row) {
        throw new Error(
          `優待行 ${id} (taskId=${u.taskId}) が銘柄 ${stockId} の preimage にありません (同値判定不能のため STOP)`
        );
      }
      const same =
        row.shortSummary === u.shortSummary &&
        row.estimatedValue === u.estimatedValue &&
        row.estimateValueSource === u.estimateValueSource;
      if (same) continue;
      const list = idsByStock.get(stockId);
      if (list) list.push(id);
      else idsByStock.set(stockId, [id]);
    }
    for (const [stockId, ids] of [...idsByStock].sort((a, b) => a[0] - b[0])) {
      const list = benefitByStock.get(stockId);
      const stmts = buildBenefitUpdateStatements(ids, u);
      if (list) list.push(...stmts);
      else benefitByStock.set(stockId, stmts);
    }
  }
  const yieldByStock = new Map<number, D1BatchStatement[]>();
  for (const e of input.yieldPlan.entries) {
    const stmts = buildYieldScoreStatements(e);
    if (stmts.length > 0) yieldByStock.set(e.stockId, stmts);
  }
  const stockIds = new Set([...benefitByStock.keys(), ...yieldByStock.keys()]);
  return [...stockIds]
    .sort((a, b) => a - b)
    .map((stockId) => ({
      stockId,
      statements: [...(benefitByStock.get(stockId) ?? []), ...(yieldByStock.get(stockId) ?? [])],
    }))
    .filter((b) => b.statements.length > 0)
    .map((b) => {
      const snap = input.preimages.get(b.stockId);
      if (!snap) {
        throw new Error(
          `銘柄 ${b.stockId} の preimage がありません (ガード無しの batch は作らない)`
        );
      }
      return { stockId: b.stockId, statements: [buildStockPreflightStatement(snap), ...b.statements] };
    });
}

/**
 * 銘柄単位の batch を 1 銘柄 1 リクエストで送る。失敗時は throw をそのまま返し、
 * 後続の銘柄には触らない (適用済み・未適用の境界は同引数の再実行で回復する)。
 */
export async function applyAtomicBatches(
  sender: AtomicBatchSender,
  batches: readonly StockBatch[]
): Promise<{ stocks: number; statements: number }> {
  const keys = batches.map((b) => b.key);
  if (keys.some((k) => k !== undefined)) {
    const missing = batches.filter((b) => b.key === undefined).map((b) => b.stockId);
    if (missing.length > 0) {
      throw new Error(`StockBatch.key の付け忘れ (stocks: ${missing.join(",")})。付ける場合は全 batch に付けること`);
    }
    const seen = new Set<string>();
    for (const k of keys as string[]) {
      if (seen.has(k)) throw new Error(`StockBatch.key の重複: ${k} (同一銘柄の別種別 batch が落ちる。再開キーは種別つきにすること)`);
      seen.add(k);
    }
  }
  let statements = 0;
  for (const b of batches) {
    await sender(b.statements);
    statements += b.statements.length;
  }
  return { stocks: batches.length, statements };
}
