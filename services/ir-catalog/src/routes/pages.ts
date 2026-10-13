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
import { listPageFiles, type PageFileRef } from "../../../../src/shared/notion-archive/index.js";
import { notionRequest } from "../../../../src/shared/notion-archive/client.js";
import { downloadPdf, fetchOfficialPdf, officialPdfId, validateArchivedPdfProvenance,
  type ArchivedPdfProvenance, type PdfAttempt, type PdfDownload } from "../services/official-pdf.js";

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
 * 開示資料ファイルプロキシ。TDnet 原本の保持日数は固定ではない
 * (2026-10-08 実測: 公開後 37 日は残存、41 日は 404)。本サービスは Notion
 * 子DB に物理アップロードした PDF を保管しており、その signed URL は ~1h で
 * 失効するが Notion ページ取得の度に新規発行される。クリック時に毎回
 * 最新の URL を取得する。PDF と上限を検査し、返す実bytesの SHA を
 * X-IR-* provenanceへ束縛する。Notion→catalog原本→同社・同公式PDF名の
 * JPX原本の順で取得し、全経路失敗は理由を構造化して502で返す。
 */
const tdnetIdParam = z.object({
  tdnetId: z.string().check(z.regex(/^\d+$/)),
});

function pdfUnavailable(
  identity: { tdnetId: string; companyCode: string; publishedAt: string },
  attempts: PdfAttempt[], status: "unavailable" | "transient", error = "ir_pdf_unavailable", archiveCatalogId?: string
): Response {
  const retrievedAt = new Date().toISOString();
  const headers: Record<string, string> = { "X-IR-Provenance-Schema": "ir-pdf-provenance-v1", "X-IR-Catalog-ID": identity.tdnetId,
    "X-IR-Company-Code": identity.companyCode, "X-IR-Published-At": identity.publishedAt,
    "X-IR-Retrieved-At": retrievedAt, "X-IR-Status": status, "X-IR-Attempts": JSON.stringify(attempts) };
  if (archiveCatalogId !== undefined) headers["X-IR-Archive-Catalog-ID"] = archiveCatalogId;
  return Response.json({ schema: "ir-pdf-provenance-v1", error, status,
    tdnetId: identity.tdnetId, companyCode: identity.companyCode, publishedAt: identity.publishedAt, retrievedAt, attempts,
    ...(archiveCatalogId === undefined ? {} : { archiveCatalogId }) }, { status: 502, headers });
}

/** Signed attachment URLs stay private; the response binds public provenance to these exact bytes. */
function pdfResponse(
  pdf: Extract<PdfDownload, { status: "available" }>,
  filename: string,
  provenance: { tdnetId: string; companyCode: string; publishedAt: string;
    source: string; sourceUrl: string; documentId: string | null; attempts: PdfAttempt[];
    archiveProvenance?: ArchivedPdfProvenance }
): Response {
  const source = new URL(provenance.sourceUrl);
  if (source.protocol !== "https:" || source.username || source.password || source.port || source.search || source.hash
      || (provenance.source !== "notion_archive"
          && (!["webapi.yanoshin.jp", "release.tdnet.info", "www2.jpx.co.jp"].includes(source.hostname)
              || source.hostname === "www2.jpx.co.jp" && (provenance.documentId === null
                  || source.pathname !== `/disc/${provenance.companyCode}/${provenance.documentId}.pdf`)
              || source.hostname === "release.tdnet.info" && provenance.documentId === null))) {
    return pdfUnavailable(provenance, [...provenance.attempts, { source: provenance.source, code: "source_invalid" }],
      "unavailable", "ir_pdf_source_invalid");
  }
  // RFC 5987 で日本語ファイル名を安全に伝える。ASCII フォールバック併記
  const asciiName = filename.replace(/[^\x20-\x7e]/g, "_") || "ir.pdf";
  const headers: Record<string, string> = {
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    // signed URL は ~1h で失効する性質上、短めキャッシュに留める
    "Cache-Control": "private, max-age=300",
    "Content-Length": String(pdf.bytes.byteLength),
    "X-IR-Provenance-Schema": "ir-pdf-provenance-v1",
    "X-IR-Catalog-ID": provenance.tdnetId,
    "X-IR-Company-Code": provenance.companyCode,
    "X-IR-Published-At": provenance.publishedAt,
    "X-IR-Retrieved-At": pdf.retrievedAt,
    "X-IR-Source": provenance.source,
    "X-IR-Source-URL": provenance.sourceUrl,
    "X-IR-PDF-SHA256": pdf.sha256,
    "X-IR-PDF-Bytes": String(pdf.bytes.byteLength),
    "X-IR-Attempts": JSON.stringify(provenance.attempts),
  };
  if (provenance.documentId !== null) headers["X-IR-Official-Document-ID"] = provenance.documentId;
  if (provenance.archiveProvenance !== undefined) headers["X-IR-Archive-Provenance"] = JSON.stringify(provenance.archiveProvenance);
  return new Response(pdf.bytes, { status: 200, headers });
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
        companyCode: disclosures.companyCode,
        pubdate: disclosures.pubdate,
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
    const attempts: PdfAttempt[] = [];
    const identity = { tdnetId, companyCode: r.companyCode, publishedAt: r.pubdate.toISOString() };
    console.info(
      `[ir-catalog file-proxy] start tdnetId=${tdnetId} db=${dbMs}ms hasNotion=${!!r.notionPageId}`
    );

    // 1) Notion ホスト PDF (主経路)
    if (r.notionPageId) {
      const tNotionStart = Date.now();
      let files: PageFileRef[] = [];
      let lookupFailed = false;
      try {
        files = await listPageFiles(r.notionPageId, "IR資料");
      } catch {
        lookupFailed = true;
        console.error(
          `[ir-catalog file-proxy] Notion 取得失敗 tdnetId=${tdnetId} after ${Date.now() - tNotionStart}ms`
        );
      }
      const notionMs = Date.now() - tNotionStart;
      if (!lookupFailed && files.length === 1 && files[0].kind === "file") {
        const f = files[0];
        console.info(
          `[ir-catalog file-proxy] notion-resolved tdnetId=${tdnetId} notion=${notionMs}ms name=${f.name}`
        );
        const pdf = await downloadPdf(f.url, 20_000);
        if (pdf.status === "available") {
          let archiveProvenance: ArchivedPdfProvenance | undefined;
          let page: { properties: Record<string, { type: string; rich_text?: Array<{ plain_text: string }> }> };
          try {
            page = await notionRequest<typeof page>("GET", `/pages/${r.notionPageId}`);
          } catch {
            return pdfUnavailable(identity, [{ source: "notion_archive", code: "archive_lookup_failed" }], "transient");
          }
          try {
            const saved = page.properties["IR取得来歴"];
            if (saved !== undefined) {
              if (saved.type !== "rich_text" || !Array.isArray(saved.rich_text) || saved.rich_text.length > 1
                  || saved.rich_text.some((part) => typeof part.plain_text !== "string" || part.plain_text.length > 1900)) {
                throw new Error("archive_provenance_invalid");
              }
              const text = saved.rich_text.map((part) => part.plain_text).join("");
              if (text.length > 0) {
                const reported: unknown = JSON.parse(text);
                if (typeof reported === "object" && reported !== null && "catalogId" in reported
                    && typeof reported.catalogId === "string" && /^\d{1,64}$/.test(reported.catalogId)
                    && reported.catalogId !== tdnetId) {
                  // A title/pubdate alias is not proof that a corrected disclosure has the same PDF version.
                  validateArchivedPdfProvenance(text, { ...identity, tdnetId: reported.catalogId }, pdf);
                  return pdfUnavailable(identity, [{ source: "notion_archive", code: "archive_catalog_alias" }],
                    "unavailable", "ir_pdf_catalog_alias_unverified", reported.catalogId);
                }
                archiveProvenance = validateArchivedPdfProvenance(text, identity, pdf);
              }
            }
          } catch {
            return pdfUnavailable(identity, [{ source: "notion_archive", code: "archive_provenance_invalid" }], "unavailable");
          }
          console.info(
            `[ir-catalog file-proxy] OK tdnetId=${tdnetId} path=notion total=${Date.now() - reqStart}ms (db=${dbMs}ms notion=${notionMs}ms)`
          );
          return pdfResponse(pdf, f.name, { ...identity, source: "notion_archive",
            sourceUrl: new URL(c.req.url).origin + BASE_PATH + "/file/" + tdnetId,
            documentId: archiveProvenance === undefined ? officialPdfId(r.documentUrl) : archiveProvenance.officialDocumentId,
            attempts, archiveProvenance });
        }
        attempts.push({ source: "notion_archive", code: pdf.code, httpStatus: pdf.httpStatus });
      } else {
        attempts.push({ source: "notion_archive", code: lookupFailed ? "archive_lookup_failed"
          : files.length === 0 ? "attachment_unavailable" : "archive_not_hosted_single" });
        console.warn(
          `[ir-catalog file-proxy] notion-no-file tdnetId=${tdnetId} notion=${notionMs}ms`
        );
      }
    } else {
      attempts.push({ source: "notion_archive", code: "archive_reference_missing" });
    }

    // 2) フォールバック: D1 に入っている原本 URL (yanoshin → TDnet)
    const pdf = await fetchOfficialPdf(r.documentUrl, r.companyCode, 20_000);
    attempts.push(...pdf.attempts);
    if (pdf.status === "available") {
      console.info(
        `[ir-catalog file-proxy] OK tdnetId=${tdnetId} path=${pdf.source} total=${Date.now() - reqStart}ms`
      );
      return pdfResponse(pdf, `tdnet-${tdnetId}.pdf`, { ...identity, source: pdf.source,
        sourceUrl: pdf.resolvedUrl, documentId: officialPdfId(pdf.resolvedUrl), attempts });
    }

    // 3) 両経路失敗 (TDnet purge 済+Notion未投入 / 上限超過 等)。捏造で
    //    隠さず 502 で返す (URL自体は ${BASE_PATH}/file/<id> のまま)
    console.error(
      `[ir-catalog file-proxy] FAIL tdnetId=${tdnetId} total=${Date.now() - reqStart}ms`
    );
    const status = pdf.status === "transient" || attempts.some((attempt) =>
      ["archive_lookup_failed", "network_or_timeout", "body_read_failed"].includes(attempt.code)
      || attempt.httpStatus === 429 || attempt.httpStatus !== undefined && attempt.httpStatus >= 500)
      ? "transient" : "unavailable";
    return pdfUnavailable(identity, attempts, status);
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
