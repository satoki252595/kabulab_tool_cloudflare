import { Hono } from "hono";
import { z } from "../../../../src/shared/zod-mini.js";
import { zValidator } from "@hono/zod-validator";
import { createDb } from "../db/client.js";
import { BASE_PATH } from "../../base-path.js";
import {
  searchStocks,
  getOrderTrendByCode,
  screenOrderGrowth,
  listSectorsWithOrders,
  type ScreenOpts,
} from "../services/order-query.js";
import {
  getOverseasTrendByCode,
  screenOverseasGrowth,
  listSectorsWithOverseas,
  REGION_BUCKETS,
  type ScreenOpts as OverseasScreenOpts,
} from "../services/overseas-query.js";
import { overseasScreeningPage } from "../views/overseas-screening.js";
import { homePage } from "../views/home.js";
import { stockDetailPage } from "../views/stock-detail.js";
import { screeningPage } from "../views/screening.js";
import { layout } from "../views/layout.js";
import { STOCK_CODE_ERROR } from "../../../../src/shared/jpx/stock-code.js";
import { stockCodeSchema } from "../../../../src/shared/jpx/stock-code-schema.js";

/**
 * SSR ルーター。データは Cloudflare D1 バインディング `c.env.DB` から取得する
 * （ADR-0001: Neon 廃止）。検索ヒット 0 件は「該当なし」を正直に返す
 * （架空候補を作らない・ルール1）。
 */
type Bindings = { DB: D1Database };
export const pagesRoute = new Hono<{ Bindings: Bindings }>();

const emptyToUndef = z.transform<unknown, unknown>((v) =>
  v === "" ? undefined : v
);

const homeQuery = z.object({
  q: z.pipe(emptyToUndef, z.optional(z.string())),
  focus: z.optional(z.string()),
});

// EDINET 由来のみの公開面 (L-62)。facts は日次取込でしか更新されないため、
// 一覧/ホームは 5 分・詳細は 1 分エッジ/ブラウザにキャッシュさせ D1 読取を抑える。
// /screening-overseas の 30 分 (SCREEN_CACHE) は重い全件走査の既存判断で残す。
const LIST_CACHE = "public, max-age=300";
const DETAIL_CACHE = "public, max-age=60";

pagesRoute.get("/", zValidator("query", homeQuery), async (c) => {
  const { q } = c.req.valid("query");
  c.header("Cache-Control", LIST_CACHE);
  if (q === undefined) {
    return c.html(homePage({ query: "", results: null }));
  }
  const db = createDb(c.env.DB);
  const results = await searchStocks(db, q);
  return c.html(homePage({ query: q, results }));
});

// ---- 受注成長性スクリーニング ----
const numOpt = z.pipe(
  z.transform<unknown, unknown>((v) =>
    v === "" || v === undefined ? undefined : v
  ),
  z.optional(z.coerce.number())
);
const screenQuery = z.object({
  // metric は UI から並び替え選択を撤去したため、内部的にも "orders" 固定。
  // 旧 URL `?metric=backlog` は "orders" に正規化する（移行期間終了。
  // 廃止通知シムは K1c で削除）。
  metric: z.pipe(
    z.prefault(z.enum(["orders", "backlog"]), "orders"),
    z.transform(() => "orders" as const)
  ),
  minYears: z.pipe(
    z.transform<unknown, unknown>((v) =>
      v === "" || v === undefined ? 3 : v
    ),
    z.coerce.number().check(z.int(), z.minimum(2), z.maximum(5))
  ),
  // 受注高 / 受注残高 を独立に条件化 (ユーザ要件: 同時にスクリーニング)。
  minOrdersCagrPct: numOpt,
  minBacklogCagrPct: numOpt,
  sector: z.pipe(emptyToUndef, z.optional(z.string())),
  // ファンダ絞り込み (共有 core.stock_financials)。結果表には出さず
  // 条件としてのみ使う。未入力 = 解除 (undefined)。
  minOpMarginPct: numOpt,
  minMarketCapOku: numOpt,
  maxMarketCapOku: numOpt,
  maxPer: numOpt,
  minRoePct: numOpt,
  minDivYieldPct: numOpt,
  limit: z.pipe(
    z.transform<unknown, unknown>((v) =>
      v === "" || v === undefined ? 100 : v
    ),
    z.coerce.number().check(z.int(), z.minimum(1), z.maximum(500))
  ),
});

function toScreenOpts(q: z.infer<typeof screenQuery>): ScreenOpts {
  return {
    metric: q.metric,
    minYears: q.minYears,
    minOrdersCagrPct: q.minOrdersCagrPct,
    minBacklogCagrPct: q.minBacklogCagrPct,
    sector: q.sector,
    minOpMarginPct: q.minOpMarginPct,
    minMarketCapOku: q.minMarketCapOku,
    maxMarketCapOku: q.maxMarketCapOku,
    maxPer: q.maxPer,
    minRoePct: q.minRoePct,
    minDivYieldPct: q.minDivYieldPct,
    limit: q.limit,
  };
}

pagesRoute.get(
  "/screening",
  zValidator("query", screenQuery),
  async (c) => {
    const opts = toScreenOpts(c.req.valid("query"));
    const db = createDb(c.env.DB);
    const [rows, sectors] = await Promise.all([
      screenOrderGrowth(db, opts),
      listSectorsWithOrders(db),
    ]);
    c.header("Cache-Control", LIST_CACHE);
    return c.html(screeningPage({ opts, sectors, rows }));
  }
);

pagesRoute.get(
  "/api/screening",
  zValidator("query", screenQuery),
  async (c) => {
    const opts = toScreenOpts(c.req.valid("query"));
    const db = createDb(c.env.DB);
    const rows = await screenOrderGrowth(db, opts);
    c.header("Cache-Control", LIST_CACHE);
    return c.json({ opts, count: rows.length, rows });
  }
);

// ---- 海外売上高比率スクリーニング (同一サービスの第2指標) ----
const overseasScreenQuery = z.object({
  minYears: z.pipe(
    z.transform<unknown, unknown>((v) =>
      v === "" || v === undefined ? 3 : v
    ),
    z.coerce.number().check(z.int(), z.minimum(2), z.maximum(5))
  ),
  minOverseasRatioPct: numOpt,
  maxOverseasRatioPct: numOpt,
  minOverseasCagrPct: numOpt,
  // 地域別絞り込み (REGION_BUCKETS の key)。空文字→未指定。不正値は 422 で弾く。
  region: z.pipe(
    emptyToUndef,
    z.optional(z.enum(Object.keys(REGION_BUCKETS) as [string, ...string[]]))
  ),
  minRegionRatioPct: numOpt,
  maxRegionRatioPct: numOpt,
  sector: z.pipe(emptyToUndef, z.optional(z.string())),
  minOpMarginPct: numOpt,
  minMarketCapOku: numOpt,
  maxMarketCapOku: numOpt,
  maxPer: numOpt,
  minRoePct: numOpt,
  minDivYieldPct: numOpt,
  limit: z.pipe(
    z.transform<unknown, unknown>((v) =>
      v === "" || v === undefined ? 100 : v
    ),
    z.coerce.number().check(z.int(), z.minimum(1), z.maximum(500))
  ),
});

function toOverseasScreenOpts(
  q: z.infer<typeof overseasScreenQuery>
): OverseasScreenOpts {
  return {
    minYears: q.minYears,
    minOverseasRatioPct: q.minOverseasRatioPct,
    maxOverseasRatioPct: q.maxOverseasRatioPct,
    minOverseasCagrPct: q.minOverseasCagrPct,
    region: q.region,
    minRegionRatioPct: q.minRegionRatioPct,
    maxRegionRatioPct: q.maxRegionRatioPct,
    sector: q.sector,
    minOpMarginPct: q.minOpMarginPct,
    minMarketCapOku: q.minMarketCapOku,
    maxMarketCapOku: q.maxMarketCapOku,
    maxPer: q.maxPer,
    minRoePct: q.minRoePct,
    minDivYieldPct: q.minDivYieldPct,
    limit: q.limit,
  };
}

// スクリーニングは全銘柄の facts を走査する重いクエリ。facts は日次取込でしか
// 更新されないため、エッジ/ブラウザに 30 分キャッシュさせ D1 読取を抑える。
const SCREEN_CACHE = "public, max-age=1800";

pagesRoute.get(
  "/screening-overseas",
  zValidator("query", overseasScreenQuery),
  async (c) => {
    const opts = toOverseasScreenOpts(c.req.valid("query"));
    const db = createDb(c.env.DB);
    const [rows, sectors] = await Promise.all([
      screenOverseasGrowth(db, opts),
      listSectorsWithOverseas(db),
    ]);
    c.header("Cache-Control", SCREEN_CACHE);
    return c.html(overseasScreeningPage({ opts, sectors, rows }));
  }
);

pagesRoute.get(
  "/api/screening-overseas",
  zValidator("query", overseasScreenQuery),
  async (c) => {
    const opts = toOverseasScreenOpts(c.req.valid("query"));
    const db = createDb(c.env.DB);
    const rows = await screenOverseasGrowth(db, opts);
    c.header("Cache-Control", SCREEN_CACHE);
    return c.json({ opts, count: rows.length, rows });
  }
);

// URL は証券コード (ティッカー) で受ける。内部 serial id を URL に
// 出すと「数字＝ティッカー」と誤認され別銘柄が表示されるため (バグ修正)。
// 数字 4 桁 (例: 7011) と JPX 英数字コード (例: 130A) の両方を受理し、
// 正規化・形式判定は共有ヘルパ (src/shared/jpx) に集約する。
const codeParam = z.object({ code: stockCodeSchema });

/** 検索へ戻る導線付きの通知ページ (袋小路にしない) */
function noticePage(title: string, message: string, status: 404 | 422) {
  return [
    layout(
      title,
      `<div class="container"><div class="notice"><strong>${message}</strong></div>
       <p style="margin:20px 0"><a href="${BASE_PATH}/">← 検索に戻る</a></p></div>`,
      "search"
    ),
    status,
  ] as const;
}

// 形式不正のコード手打ち/旧 id ブックマークは zValidator の素の 422 で
// 袋小路になるため、SSR では分かりやすい通知ページに差し替える。
pagesRoute.get(
  "/stock/:code",
  zValidator("param", codeParam, (result, c) => {
    if (!result.success) {
      return c.html(
        ...noticePage(
          "証券コードが不正です",
          STOCK_CODE_ERROR,
          422
        )
      );
    }
  }),
  async (c) => {
    const { code } = c.req.valid("param");
    const db = createDb(c.env.DB);
    // 受注 + 海外売上 の両トレンドを 1 ページに並べる (同じ有報由来)。
    const [trend, overseasTrend] = await Promise.all([
      getOrderTrendByCode(db, code),
      getOverseasTrendByCode(db, code),
    ]);
    if (!trend) {
      return c.html(
        ...noticePage(
          "銘柄が見つかりません",
          `証券コード ${code} の上場銘柄は見つかりませんでした。`,
          404
        )
      );
    }
    c.header("Cache-Control", DETAIL_CACHE);
    return c.html(stockDetailPage(trend, overseasTrend));
  }
);

// JSON API (機械可読。フロント以外からの利用・検証用)
pagesRoute.get(
  "/api/trend/:code",
  zValidator("param", codeParam),
  async (c) => {
    const { code } = c.req.valid("param");
    const db = createDb(c.env.DB);
    const trend = await getOrderTrendByCode(db, code);
    if (!trend) return c.json({ error: "stock not found" }, 404);
    c.header("Cache-Control", DETAIL_CACHE);
    return c.json(trend);
  }
);
