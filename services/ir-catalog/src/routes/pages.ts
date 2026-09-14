import { Hono } from "hono";
import { z } from "../../../../src/shared/zod-mini.js";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { BASE_PATH } from "../../base-path.js";
import {
  searchStocks,
  getStockTimeline,
  recentHighSignal,
} from "../services/query.js";
import { homePage } from "../views/home.js";
import { stockDetailPage } from "../views/stock-detail.js";
import { signalsPage } from "../views/signals.js";
import { stockCodeSchema } from "../../../../src/shared/jpx/stock-code-schema.js";
import { STOCK_CODE_ERROR } from "../../../../src/shared/jpx/stock-code.js";
import { layout } from "../views/layout.js";
import { disclosures } from "../db/schema.js";
import { fetchPageFileUrl } from "../../../../src/shared/notion-archive/index.js";

/**
 * SSR ルーター。データは Cloudflare D1 バインディング `c.env.DB` から取得する
 * （ADR-0001: Neon 廃止）。検索ヒット 0 件は「該当なし」を正直に返す。
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

pagesRoute.get("/", zValidator("query", homeQuery), async (c) => {
  const { q } = c.req.valid("query");
  const db = createDb(c.env.DB);
  const recent = await recentHighSignal(db, 25);
  if (q === undefined) {
    return c.html(homePage({ query: "", results: null, recent }));
  }
  const results = await searchStocks(db, q);
  return c.html(homePage({ query: q, results, recent }));
});

pagesRoute.get("/signals", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await recentHighSignal(db, 100);
  return c.html(signalsPage(rows));
});

// URL は証券コード (ティッカー)。内部 serial id を URL に出さない。
// 数字 4 桁 (例: 7011) と JPX 英数字コード (例: 130A) の両方を受理する
// (TDnet 取込側 companyCodeToTicker も英数字コードを通すため整合させる)。
const codeParam = z.object({ code: stockCodeSchema });
const monthsQuery = z.object({
  months: z.pipe(
    z.transform<unknown, unknown>((v) =>
      v === "" || v === undefined ? 24 : v
    ),
    z.coerce.number().check(z.int(), z.minimum(1), z.maximum(1200))
  ),
  tag: z.pipe(emptyToUndef, z.optional(z.string())),
});

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
  zValidator("query", monthsQuery),
  async (c) => {
    const { code } = c.req.valid("param");
    const { months, tag } = c.req.valid("query");
    const db = createDb(c.env.DB);
    const tl = await getStockTimeline(db, code, months, tag ?? null);
    if (!tl) {
      return c.html(
        ...noticePage(
          "銘柄が見つかりません",
          `証券コード ${code} の上場銘柄は見つかりませんでした。`,
          404
        )
      );
    }
    return c.html(stockDetailPage(tl));
  }
);

/**
 * 開示資料ファイルプロキシ。TDnet (release.tdnet.info) は PDF を ~31日 で
 * purge するため `document_url` は失効する。本サービスは Notion 子DB に
 * 物理アップロードした PDF を保管しており、その signed URL は ~1h で
 * 失効するが Notion ページ取得の度に新規発行される。クリック時に毎回
 * 最新の URL を取得し、**そのバイト列をストリーミングで 200 として
 * 返す** (URL バーを kabulab ドメインに保ち、共有時の URL も永続有効に
 * する)。Notion 取得失敗時は TDnet 原本にフォールバック (≤31日生存)、
 * 両方失敗なら 502 を正直に返す (捏造しない — ルール1/2)。
 */
const tdnetIdParam = z.object({
  tdnetId: z.string().check(z.regex(/^\d+$/)),
});

/** PDF を upstream から取得しストリーミング 200 で返す。失敗なら null */
async function streamPdf(
  upstreamUrl: string,
  filename: string,
  label: string
): Promise<Response | null> {
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(upstreamUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "User-Agent":
          "kabulab-ir-catalog/1.0 (+https://kabulab.vercel.app)",
      },
    });
  } catch (e) {
    console.error(
      `[ir-catalog file-proxy] upstream fetch fail (${label}) after ${Date.now() - t0}ms: ${(e as Error).message}`
    );
    return null;
  }
  const ttfbMs = Date.now() - t0;
  if (!res.ok || !res.body) {
    console.warn(
      `[ir-catalog file-proxy] upstream ${label} status=${res.status} ttfb=${ttfbMs}ms`
    );
    return null;
  }
  console.info(
    `[ir-catalog file-proxy] upstream ${label} ttfb=${ttfbMs}ms status=${res.status} cl=${res.headers.get("content-length") ?? "?"}`
  );
  const ct = res.headers.get("content-type") ?? "application/pdf";
  const cl = res.headers.get("content-length");
  // RFC 5987 で日本語ファイル名を安全に伝える。ASCII フォールバック併記
  const asciiName = filename.replace(/[^\x20-\x7e]/g, "_") || "ir.pdf";
  const headers: Record<string, string> = {
    "Content-Type": ct,
    "Content-Disposition": `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    // signed URL は ~1h で失効する性質上、短めキャッシュに留める
    "Cache-Control": "private, max-age=300",
  };
  if (cl) headers["Content-Length"] = cl;
  return new Response(res.body, { status: 200, headers });
}

pagesRoute.get(
  "/file/:tdnetId",
  zValidator("param", tdnetIdParam, (result, c) => {
    if (!result.success) {
      return c.json({ error: "invalid tdnetId" }, 400);
    }
  }),
  async (c) => {
    const reqStart = Date.now();
    const { tdnetId } = c.req.valid("param");

    const tDbStart = Date.now();
    const db = createDb(c.env.DB);
    const rows = await db
      .select({
        notionPageId: disclosures.notionPageId,
        documentUrl: disclosures.documentUrl,
      })
      .from(disclosures)
      .where(eq(disclosures.tdnetId, tdnetId))
      .limit(1);
    const dbMs = Date.now() - tDbStart;
    if (rows.length === 0) {
      console.info(
        `[ir-catalog file-proxy] not-found tdnetId=${tdnetId} db=${dbMs}ms`
      );
      return c.json({ error: "disclosure not found" }, 404);
    }
    const r = rows[0];
    console.info(
      `[ir-catalog file-proxy] start tdnetId=${tdnetId} db=${dbMs}ms hasNotion=${!!r.notionPageId}`
    );

    // 1) Notion ホスト PDF をストリーミング (主経路)
    if (r.notionPageId) {
      const tNotionStart = Date.now();
      let f: { url: string; name: string } | null = null;
      try {
        f = await fetchPageFileUrl(r.notionPageId, "IR資料");
      } catch (e) {
        console.error(
          `[ir-catalog file-proxy] Notion 取得失敗 tdnetId=${tdnetId} pageId=${r.notionPageId} after ${Date.now() - tNotionStart}ms: ${(e as Error).message}`
        );
      }
      const notionMs = Date.now() - tNotionStart;
      if (f) {
        console.info(
          `[ir-catalog file-proxy] notion-resolved tdnetId=${tdnetId} notion=${notionMs}ms name=${f.name}`
        );
        const resp = await streamPdf(f.url, f.name, `notion:${tdnetId}`);
        if (resp) {
          console.info(
            `[ir-catalog file-proxy] OK tdnetId=${tdnetId} path=notion total=${Date.now() - reqStart}ms (db=${dbMs}ms notion=${notionMs}ms)`
          );
          return resp;
        }
      } else {
        console.warn(
          `[ir-catalog file-proxy] notion-no-file tdnetId=${tdnetId} notion=${notionMs}ms`
        );
      }
    }

    // 2) フォールバック: TDnet 原本 (≤31日なら生存)
    const fallbackName = `tdnet-${tdnetId}.pdf`;
    const fb = await streamPdf(
      r.documentUrl,
      fallbackName,
      `tdnet:${tdnetId}`
    );
    if (fb) {
      console.info(
        `[ir-catalog file-proxy] OK tdnetId=${tdnetId} path=tdnet-fallback total=${Date.now() - reqStart}ms`
      );
      return fb;
    }

    // 3) 両経路失敗 (TDnet purge 済+Notion未投入 / 上限超過 等)。捏造で
    //    隠さず 502 で返す (URL自体は ${BASE_PATH}/file/<id> のまま)
    console.error(
      `[ir-catalog file-proxy] FAIL tdnetId=${tdnetId} total=${Date.now() - reqStart}ms`
    );
    return c.json(
      {
        error:
          "PDF を取得できませんでした (Notion 未投入かつ TDnet 原本も期限切れ/取得失敗)",
        tdnetId,
      },
      502
    );
  }
);

// JSON API (機械可読・検証用)
pagesRoute.get(
  "/api/stock/:code",
  zValidator("param", codeParam),
  zValidator("query", monthsQuery),
  async (c) => {
    const { code } = c.req.valid("param");
    const { months, tag } = c.req.valid("query");
    const db = createDb(c.env.DB);
    const tl = await getStockTimeline(db, code, months, tag ?? null);
    if (!tl) return c.json({ error: "stock not found" }, 404);
    return c.json(tl);
  }
);
