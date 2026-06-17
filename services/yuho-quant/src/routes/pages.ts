import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { createDb } from "../db/client.js";
import { yuhoEnv } from "../env.js";
import { BASE_PATH } from "../../base-path.js";
import {
  searchStocks,
  getOrderTrendByCode,
  screenOrderGrowth,
  listSectorsWithOrders,
  type ScreenOpts,
} from "../services/order-query.js";
import { homePage } from "../views/home.js";
import { stockDetailPage } from "../views/stock-detail.js";
import { screeningPage } from "../views/screening.js";
import { layout } from "../views/layout.js";
import { STOCK_CODE_ERROR } from "../../../../src/shared/jpx/stock-code.js";
import { stockCodeSchema } from "../../../../src/shared/jpx/stock-code-schema.js";

/**
 * SSR ルーター。DATABASE_URL は型付きアクセサ経由でのみ取得 (ルール3)。
 * 検索ヒット 0 件は「該当なし」を正直に返す (架空候補を作らない・ルール1)。
 */
export const pagesRoute = new Hono();

const homeQuery = z.object({
  q: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  focus: z.string().optional(),
});

pagesRoute.get("/", zValidator("query", homeQuery), async (c) => {
  const { q } = c.req.valid("query");
  if (q === undefined) {
    return c.html(homePage({ query: "", results: null }));
  }
  const db = createDb(yuhoEnv.DATABASE_URL());
  const results = await searchStocks(db, q);
  return c.html(homePage({ query: q, results }));
});

// ---- 受注成長性スクリーニング ----
const numOpt = z.preprocess(
  (v) => (v === "" || v === undefined ? undefined : v),
  z.coerce.number().optional()
);
const screenQuery = z.object({
  // metric は UI から並び替え選択を撤去したため、内部的にも "orders" 固定。
  // 旧 URL `?metric=backlog` は detectDeprecatedParams() で通知の上、ここで
  // "orders" に正規化する (ルール2: 黙ったフォールバック禁止 — 廃止通知あり)。
  metric: z
    .enum(["orders", "backlog"])
    .default("orders")
    .transform(() => "orders" as const),
  minYears: z.preprocess(
    (v) => (v === "" || v === undefined ? 3 : v),
    z.coerce.number().int().min(2).max(5)
  ),
  // 受注高 / 受注残高 を独立に条件化 (ユーザ要件: 同時にスクリーニング)。
  minOrdersCagrPct: numOpt,
  minBacklogCagrPct: numOpt,
  sector: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().optional()
  ),
  // ファンダ絞り込み (共有 core.stock_financials)。結果表には出さず
  // 条件としてのみ使う。未入力 = 解除 (undefined)。
  minOpMarginPct: numOpt,
  minMarketCapOku: numOpt,
  maxMarketCapOku: numOpt,
  maxPer: numOpt,
  minRoePct: numOpt,
  minDivYieldPct: numOpt,
  limit: z.preprocess(
    (v) => (v === "" || v === undefined ? 100 : v),
    z.coerce.number().int().min(1).max(500)
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

/**
 * 廃止された旧 URL パラメータ (受注高/受注残高 独立4条件化に伴い、
 * 単一指標の minCagrPct / minLatestOku は分割された) を**サイレントに
 * 黙殺せず**、ユーザに「廃止された / 何に置き換わったか」を必ず通知する
 * (ルール2: 黙ったフォールバック禁止の境界対応)。zod は unknown key を
 * 既定で strip するため、raw query から先に検出する。
 */
const DEPRECATED_PARAM_RENAMES: Record<string, string> = {
  minCagrPct: "minOrdersCagrPct / minBacklogCagrPct (受注高・受注残高を独立に指定)",
  minLatestOku: "廃止 (規模条件は撤去。年率下限と時価総額レンジで代替してください)",
  minLatestOrdersOku: "廃止 (規模条件は撤去。年率下限と時価総額レンジで代替してください)",
  minLatestBacklogOku: "廃止 (規模条件は撤去。年率下限と時価総額レンジで代替してください)",
};
/**
 * metric=backlog の URL 廃止判定。`metric` パラメータ自体は内部で
 * "orders" 固定 (default) として残しているが、UI から並び替え選択を
 * 撤去したため、旧ブックマーク `?metric=backlog` は黙って吸収せず
 * 利用者に廃止を通知する (ルール2: 黙ったフォールバック禁止)。
 * "orders" 指定は冗長だが破綻ではないので通知対象外とする。
 */
function detectDeprecatedParams(raw: Record<string, string | string[]>): string[] {
  // c.req.query() は単値のみ返す (queries() を使えば配列)。将来 queries()
  // へ差し替えても誤検出しないよう配列分岐も保持する。
  const present = (v: string | string[] | undefined): boolean => {
    if (v === undefined) return false;
    if (Array.isArray(v)) return v.some((s) => s !== "");
    return v !== "";
  };
  const out = Object.keys(DEPRECATED_PARAM_RENAMES)
    .filter((k) => present(raw[k]))
    .map((k) => `${k} → ${DEPRECATED_PARAM_RENAMES[k]}`);
  const metricRaw = raw["metric"];
  const metricVal = Array.isArray(metricRaw) ? metricRaw[0] : metricRaw;
  if (metricVal === "backlog") {
    out.push(
      "metric=backlog → 廃止 (並び替え UI は撤去され、結果は常に受注高 年率の降順で表示されます)"
    );
  }
  return out;
}

pagesRoute.get(
  "/screening",
  zValidator("query", screenQuery),
  async (c) => {
    const opts = toScreenOpts(c.req.valid("query"));
    const deprecated = detectDeprecatedParams(c.req.query());
    const db = createDb(yuhoEnv.DATABASE_URL());
    const [rows, sectors] = await Promise.all([
      screenOrderGrowth(db, opts),
      listSectorsWithOrders(db),
    ]);
    return c.html(screeningPage({ opts, sectors, rows, deprecated }));
  }
);

pagesRoute.get(
  "/api/screening",
  zValidator("query", screenQuery),
  async (c) => {
    const opts = toScreenOpts(c.req.valid("query"));
    const db = createDb(yuhoEnv.DATABASE_URL());
    const rows = await screenOrderGrowth(db, opts);
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
    const db = createDb(yuhoEnv.DATABASE_URL());
    const trend = await getOrderTrendByCode(db, code);
    if (!trend) {
      return c.html(
        ...noticePage(
          "銘柄が見つかりません",
          `証券コード ${code} の上場銘柄は見つかりませんでした。`,
          404
        )
      );
    }
    return c.html(stockDetailPage(trend));
  }
);

// JSON API (機械可読。フロント以外からの利用・検証用)
pagesRoute.get(
  "/api/trend/:code",
  zValidator("param", codeParam),
  async (c) => {
    const { code } = c.req.valid("param");
    const db = createDb(yuhoEnv.DATABASE_URL());
    const trend = await getOrderTrendByCode(db, code);
    if (!trend) return c.json({ error: "stock not found" }, 404);
    return c.json(trend);
  }
);
