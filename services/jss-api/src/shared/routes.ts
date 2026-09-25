import { Hono } from "hono";

import { envelope, errorBody } from "./envelope";
import { isPublishableInFull, redactColumns } from "./license";
import {
  OHLCV_CACHE_TTL_SECS,
  fetchAdjustedOhlcvCached,
} from "./ohlcv-cache";
import type { AnyEnv, PrivateEnv } from "./types";

/** D1 の COUNT 等で 1 行だけ欲しいときの薄いヘルパ。 */
async function first<T>(stmt: D1PreparedStatement): Promise<T | null> {
  return (await stmt.first<T>()) ?? null;
}

const MAX_LIMIT = 500;

export function parseLimit(raw: string | undefined, fallback = 100, max = MAX_LIMIT): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/**
 * 1回の MCP 呼び出しで受ける銘柄コードの上限。
 *
 * D1 は1クエリ100バインド変数までなので (memory: d1-bound-param-limit)、
 * `code IN (?, ?, ...)` に codes をそのまま展開しても安全な余裕を持たせる。
 */
export const MAX_BATCH_CODES = 50;

/**
 * 需給・OHLCV と違い、銘柄テクニカル・バリュエーションは複数銘柄をまとめて
 * 引きたい呼び手 (kabulab スキル等) が多いため、MCP 側だけ codes[] を受ける。
 * 空・上限超過・不正コード混入は早期に throw する (ルール2: 無効値で埋めて続行しない)。
 */
export function parseCodes(raw: unknown, max = MAX_BATCH_CODES): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("codes は1件以上の銘柄コード配列で指定する");
  }
  if (raw.length > max) {
    throw new Error(`codes は最大 ${max} 件まで`);
  }
  const codes = raw.map((c) => String(c));
  for (const code of codes) {
    if (!isValidCode(code)) throw new Error(`銘柄コードは4桁: ${code}`);
  }
  return codes;
}

/**
 * 4文字の銘柄コードだけ受ける。索引が効かない述語を外から作らせない。
 *
 * パターンは銘柄コード契約の正準形 (docs/CONTRACTS.md 不変条件9)。
 * `services/jss-api/` は別言語・別ビルドなので `contracts/stock_code.py` を
 * import できないため、**共有テストベクタの `canonical_regex` と一致しているか**を
 * `services/jss-api/test/stock-code-contract.test.ts` が固定している。
 *
 * 以前は `/^[0-9A-Z]{4}$/` で、1-3 桁目の英字 (`A130` / `ABCD`) まで通していた。
 * JPX の付番体系に無い形なので、索引は引けても必ず 0 件になる述語を公開 API が
 * 受けていたことになる。正準形へ寄せて 400 で返す。
 *
 * 正規化 (小文字化・全角半角) は**しない**: URL パスをそのままキャッシュキー・
 * D1 述語に使う面なので、表記揺れを吸収すると同じ銘柄に複数の URL ができる。
 */
export function isValidCode(code: string): boolean {
  return /^[0-9]{3}[0-9A-Z]$/.test(code);
}

/** `code IN (?, ?, ...)` のプレースホルダを codes.length 個作る。 */
function inPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * 旧 Notion「②株価テクニカル」の代替。`swing_stock_indicators` を
 * `core_stocks.code` で引く。1銘柄1行 upsert なので、行があれば最新断面。
 *
 * 見つからなかった code は結果に含めない（呼び出し側が `not_found` として
 * 明示する。未知コードか、コードは実在するが未計算かは区別しない — どちらも
 * 「今この時点で技術指標を返せない」という点では同じ事実）。
 */
export async function fetchIndicatorsByCodes(
  db: D1Database,
  codes: string[],
): Promise<Record<string, unknown>[]> {
  const { results } = await db.prepare(
    "SELECT s.code, s.name, i.latest_close, i.latest_volume, i.latest_date, i.pct_change_1d," +
      " i.sma_5, i.sma_20, i.sma_25, i.sma_60, i.sma_75," +
      " i.rsi_14, i.macd, i.macd_signal, i.macd_hist," +
      " i.atr_14, i.atr_pct, i.volume_ratio, i.avg_turnover_20d," +
      " i.range_20d_high, i.range_20d_low, i.range_width, i.computed_at" +
      " FROM swing_stock_indicators i JOIN core_stocks s ON s.id = i.stock_id" +
      ` WHERE s.code IN (${inPlaceholders(codes.length)}) ORDER BY s.code`,
  ).bind(...codes).all<Record<string, unknown>>();
  return results;
}

/**
 * 旧 Notion「②株価テクニカル」のバリュエーション欄の代替。
 * `otakara_stock_financials` を `core_stocks.code` で引く。
 */
export async function fetchValuationByCodes(
  db: D1Database,
  codes: string[],
): Promise<Record<string, unknown>[]> {
  const { results } = await db.prepare(
    "SELECT s.code, s.name, f.price, f.per, f.pbr, f.dividend_yield, f.eps, f.bps," +
      " f.roe, f.roa, f.market_cap, f.data_date, f.fetched_at" +
      " FROM otakara_stock_financials f JOIN core_stocks s ON s.id = f.stock_id" +
      ` WHERE s.code IN (${inPlaceholders(codes.length)}) ORDER BY s.code`,
  ).bind(...codes).all<Record<string, unknown>>();
  return results;
}

/**
 * 旧 Notion「⑦収集ジョブログ」の鮮度ガード用途の代替。
 * `jss_job_runs` を job_name ごとに最新1件へ畳んで返す
 * (`/v1/meta/jobs` は履歴の直近N件で、頻度の高いジョブが少ないジョブの
 * 最新行を limit の外へ押し出しうるため、鮮度確認には向かない)。
 */
export async function fetchLatestJobRuns(
  db: D1Database,
  jobName: string | null,
): Promise<Record<string, unknown>[]> {
  const stmt = jobName
    ? db.prepare(
        "SELECT job_name, status, processed, failed, run_url, duration_secs, finished_at" +
          " FROM jss_job_runs WHERE id IN (SELECT MAX(id) FROM jss_job_runs" +
          " WHERE job_name = ? GROUP BY job_name) ORDER BY job_name",
      ).bind(jobName)
    : db.prepare(
        "SELECT job_name, status, processed, failed, run_url, duration_secs, finished_at" +
          " FROM jss_job_runs WHERE id IN (SELECT MAX(id) FROM jss_job_runs" +
          " GROUP BY job_name) ORDER BY job_name",
      );
  const { results } = await stmt.all<Record<string, unknown>>();
  return results;
}

/**
 * 公開面・内部面で共通のルート。
 * surface に応じてライセンスフィルタの強さだけが変わる。
 */
export function mountCommon(app: Hono<{ Bindings: AnyEnv }>) {
  app.get("/v1/meta/licenses", (c) =>
    c.json(
      envelope({
        "commercial-ok": "商用・再配布可（出典記載が条件）",
        "factual-cite": "事実データの抽出利用可。原文は内部保管のみ",
        "personal-only": "私的利用限定。公開・商用組込は不可",
      }),
    ),
  );

  app.get("/v1/meta/freshness", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT dataset, store, location, latest_data_date, row_or_object_count," +
        " bytes, license_tag, updated_at FROM jss_dataset_freshness ORDER BY dataset",
    ).all<Record<string, unknown>>();
    const rows = c.env.SURFACE === "public"
      ? results.filter((r) => String(r.license_tag ?? "") !== "personal-only")
      : results;
    return c.json(envelope(rows, { licenses: rows.map((r) => String(r.license_tag ?? "")) }));
  });

  app.get("/v1/meta/jobs", async (c) => {
    const limit = parseLimit(c.req.query("limit"), 50);
    const jobName = c.req.query("job_name");
    const stmt = jobName
      ? c.env.DB.prepare(
          "SELECT job_name, status, processed, failed, run_url, duration_secs, finished_at" +
            " FROM jss_job_runs WHERE job_name = ? ORDER BY finished_at DESC LIMIT ?",
        ).bind(jobName, limit)
      : c.env.DB.prepare(
          "SELECT job_name, status, processed, failed, run_url, duration_secs, finished_at" +
            " FROM jss_job_runs ORDER BY finished_at DESC LIMIT ?",
        ).bind(limit);
    const { results } = await stmt.all<Record<string, unknown>>();
    return c.json(envelope(results));
  });

  // `/v1/xbrl/elements` (jss_xbrl_elements) は 2026-09-25 に削除した。
  // jss_xbrl_documents / jss_xbrl_elements は本番 0 行・writer 不在のまま
  // 退役させた (pipeline/src/jp_stock_pipeline/cloud_store/schema.py 参照)。
  // 物理 DROP は別途手順で本番へ流す。

  // ⑤原本のメタ。公開面は commercial-ok の行だけ返す。
  // メタだけでも日証金 CSV や JPX PDF の所在が漏れるため「メタは全行公開可」としない。
  app.get("/v1/files/:sha256", async (c) => {
    const sha = c.req.param("sha256");
    if (!/^[0-9a-f]{64}$/.test(sha)) {
      return c.json(errorBody("sha256 は 64 桁の16進数", "invalid_sha256"), 400);
    }
    const row = await first<Record<string, unknown>>(
      c.env.DB.prepare(
        "SELECT sha256, r2_bucket, r2_key, derived_key, derived_ext, source, datatype," +
          " scope, doc_id, code, data_date, ext, size_bytes, license_tag, convert_status" +
          " FROM jss_raw_files WHERE sha256 = ?",
      ).bind(sha),
    );
    if (!row) return c.json(errorBody("見つからない", "not_found"), 404);
    const tag = String(row.license_tag ?? "");
    if (c.env.SURFACE === "public" && !isPublishableInFull(tag)) {
      return c.json(errorBody("この原本は公開面では返せない", "restricted"), 403);
    }
    return c.json(envelope(row, { sources: [String(row.source ?? "")], licenses: [tag] }));
  });

  app.get("/v1/files/:sha256/content", async (c) => {
    const sha = c.req.param("sha256");
    if (!/^[0-9a-f]{64}$/.test(sha)) {
      return c.json(errorBody("sha256 は 64 桁の16進数", "invalid_sha256"), 400);
    }
    const row = await first<Record<string, unknown>>(
      c.env.DB.prepare(
        "SELECT r2_bucket, r2_key, derived_key, license_tag, ext FROM jss_raw_files WHERE sha256 = ?",
      ).bind(sha),
    );
    if (!row) return c.json(errorBody("見つからない", "not_found"), 404);
    const tag = String(row.license_tag ?? "");
    if (c.env.SURFACE === "public" && !isPublishableInFull(tag)) {
      return c.json(errorBody("この原本は公開面では返せない", "restricted"), 403);
    }
    const useDerived = c.req.query("derived") === "1";
    const key = String((useDerived ? row.derived_key : row.r2_key) ?? "");
    if (!key) return c.json(errorBody("その形式は存在しない", "not_found"), 404);
    // 原本は jp-stock-raw にしか無い。SUPPLY を参照しないので公開面でも安全。
    const object = await c.env.RAW.get(key);
    if (!object) return c.json(errorBody("R2 に実体が無い", "not_found"), 404);
    return new Response(object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
        // 原本キーは SHA256 入りの immutable なので恒久キャッシュしてよい。
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });

  app.get("/health", (c) => c.json({ ok: true, surface: c.env.SURFACE }));
  app.notFound((c) => c.json(errorBody("そのパスは無い", "not_found"), 404));
}

/** 内部面のみ。personal-only を含む。 */
export function mountPrivate(app: Hono<{ Bindings: PrivateEnv }>) {
  app.get("/v1/supply/latest", async (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const dataType = c.req.query("data_type");
    const stmt = dataType
      ? c.env.DB.prepare(
          "SELECT code, data_type, data_date, loan_bal, stock_bal, ratio, turn_days," +
            " r2_key, license_tag FROM jss_supply_latest WHERE data_type = ?" +
            " ORDER BY code LIMIT ?",
        ).bind(dataType, limit)
      : c.env.DB.prepare(
          "SELECT code, data_type, data_date, loan_bal, stock_bal, ratio, turn_days," +
            " r2_key, license_tag FROM jss_supply_latest ORDER BY code, data_type LIMIT ?",
        ).bind(limit);
    const { results } = await stmt.all<Record<string, unknown>>();
    return c.json(envelope(results, { sources: ["日証金"], licenses: ["personal-only"] }));
  });

  app.get("/v1/supply/:code", async (c) => {
    const code = c.req.param("code");
    if (!isValidCode(code)) {
      return c.json(errorBody("銘柄コードは4桁", "invalid_code"), 400);
    }
    const object = await c.env.SUPPLY.get(`supply/${code}.json`);
    if (!object) return c.json(errorBody("見つからない", "not_found"), 404);
    const payload = (await object.json()) as Record<string, unknown>;
    const series = (payload.series ?? {}) as Record<string, Array<Record<string, unknown>>>;
    const wanted = c.req.query("series");
    const from = c.req.query("from");
    const to = c.req.query("to");
    const filtered: Record<string, Array<Record<string, unknown>>> = {};
    for (const [name, points] of Object.entries(series)) {
      if (wanted && name !== wanted) continue;
      filtered[name] = points.filter((p) => {
        const d = String(p.d ?? "");
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
      });
    }
    return c.json(
      envelope({ code, updated: payload.updated, series: filtered }, {
        sources: ["日証金"],
        licenses: ["personal-only"],
      }),
    );
  });

  // 日足 OHLCV（全系列調整済み）。Yahoo 由来＝personal-only のため内部面のみ。
  // 10年分 ≈ 2500 バーのため上限は 3000。from/to は YYYY-MM-DD のみ受け、
  // 書式違いは索引に載らない述語になるので 400 で拒否する。
  app.get("/v1/ohlcv/:code", async (c) => {
    const code = c.req.param("code");
    if (!isValidCode(code)) {
      return c.json(errorBody("銘柄コードは4桁", "invalid_code"), 400);
    }
    const from = c.req.query("from") || undefined;
    const to = c.req.query("to") || undefined;
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if ((from && !dateRe.test(from)) || (to && !dateRe.test(to))) {
      return c.json(errorBody("from/to は YYYY-MM-DD", "invalid_range"), 400);
    }
    const limit = parseLimit(c.req.query("limit"), 250, 3000);
    const { result, hit } = await fetchAdjustedOhlcvCached(c.env.DB, code, {
      from,
      to,
      limit,
    });
    if (!result) return c.json(errorBody("見つからない", "not_found"), 404);
    c.header("X-Cache", hit ? "HIT" : "MISS");
    c.header("Cache-Control", `private, max-age=${OHLCV_CACHE_TTL_SECS}`);
    return c.json(
      envelope(result, { sources: ["Yahoo"], licenses: ["personal-only"] }),
    );
  });

  // 旧 Notion「②株価テクニカル」の代替。Yahoo 由来＝personal-only のため内部面のみ。
  app.get("/v1/indicators/:code", async (c) => {
    const code = c.req.param("code");
    if (!isValidCode(code)) {
      return c.json(errorBody("銘柄コードは4桁", "invalid_code"), 400);
    }
    const [row] = await fetchIndicatorsByCodes(c.env.DB, [code]);
    if (!row) return c.json(errorBody("見つからない（未知コード、または未計算）", "not_found"), 404);
    return c.json(envelope(row, { sources: ["Yahoo"], licenses: ["personal-only"] }));
  });

  // 旧 Notion「②株価テクニカル」のバリュエーション欄の代替。
  app.get("/v1/valuation/:code", async (c) => {
    const code = c.req.param("code");
    if (!isValidCode(code)) {
      return c.json(errorBody("銘柄コードは4桁", "invalid_code"), 400);
    }
    const [row] = await fetchValuationByCodes(c.env.DB, [code]);
    if (!row) return c.json(errorBody("見つからない（未知コード、または未取得）", "not_found"), 404);
    return c.json(envelope(row, { sources: ["Yahoo"], licenses: ["personal-only"] }));
  });

  app.get("/v1/yutai/:code", async (c) => {
    const code = c.req.param("code");
    if (!isValidCode(code)) {
      return c.json(errorBody("銘柄コードは4桁", "invalid_code"), 400);
    }
    // みんかぶ掲載文の列は SELECT しない（規約上、取得も公開も不可）。
    const { results } = await c.env.DB.prepare(
      "SELECT b.genre_id, b.min_shares, b.record_month FROM yutai_benefits b" +
        " JOIN core_stocks s ON s.id = b.stock_id WHERE s.code = ? LIMIT 50",
    ).bind(code).all<Record<string, unknown>>();
    return c.json(envelope(results.map((r) => redactColumns("yutai_benefits", r))));
  });
}
