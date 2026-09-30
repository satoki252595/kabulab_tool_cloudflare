/**
 * IPO bridge 5-URL capture (手動実行・PREP)。
 *
 * Root official research の concrete bridge を一次取得する最小 runner。
 * 対象は pinned 5 URL のみ (追加 URL なし)。各 URL 1 GET・manual・
 * retry 0・予約→durable persist (wx0600+fsync)→判定の順・safe HTTP meta・
 * actual clock。予算は BUDGET 定数で固定し upfront + 送信時に強制する。
 *
 * preflight (GET 前・全 local): JPX 保存 HTML の full-SHA + 行 host 検証、
 * ledger R1/R2/R3 識別子 (code5/ISIN/rawSha) の存在検証、09/30 CSV ZIP
 * の full-SHA + 3 E 行 (listed/sector 有無) 抽出。policy は観測値から
 * 導出する (定数で既検証を主張しない)。
 *
 * 保管: HTML 8 (raw+meta ×4) + PDF raw+meta + inner manifest の 11 件を
 * 1 immutable ZIP (Nix Python stdlib) にし、共有 logical record 1 件
 * force:false で記録。readback は unique exact + 全 ZIP SHA/length +
 * inner 11 key + 全 SHA を ORIGINAL local manifest と照合する。
 * archive unknown は STOP (再送なし)。
 *
 * 識別子は取得 bytes からのみ読む。PDF は full raw SHA を FIRST に
 * 確定し、pdftotext -layout 抽出 text で Ecode AND 法人番号 (corpID。
 * 値は preflight CSV 行の観測値) の両方を要求する。各一致は page/
 * locator + 近傍 context (issuer 連結用) を proof として manifest に
 * 残す (bare binary OR・二 token の存在のみでは bridge しない)。
 * Ecode/corpID 欠落は HOLD。ticker-only は bridge しない。
 * sector は 09/30 CSV 行のみ (本 runner は触らない)。E42099 の非上場は
 * distinct に保ち TSE で override しない。HOLD は次 URL を提案しない。
 *
 * env は typed canonical (notionEnv) のみ。dotenv は読まない。
 * live 実行は `--execute` が無いと起動しない。Root review 境界までは
 * 実行しない (offline 実装 + テストのみ)。
 */
import { sha256HexBytes } from "../../src/shared/sha256.js";
import {
  findBackupChildByTitle,
  queryUniqueRow,
} from "../../src/shared/notion-archive/archive.js";
import {
  listPageFiles,
  recordPrimaryData,
  verifyArchivedAttachments,
} from "../../src/shared/notion-archive/index.js";
import { NotionUnknownResultError } from "../../src/shared/notion-archive/client.js";
import { notionEnv } from "../../src/shared/notion-archive/env.js";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SERVICE = "universe";
const DB_TITLE = "一次データ｜universe";

/** 固定予算。upfront + 送信時の両方で強制する。 */
export const BUDGET = { maxTargets: 5, getsPerUrl: 1, maxGets: 5 } as const;

/** fixed pins (full SHA。preflight で実 bytes と照合する)。 */
export const JPX_HTML_SHA256 =
  "70c27b36577fd591310b72f1ceea459c5e467016ba0f612c5855a632df638fc8";
export const CODELIST_ZIP_SHA256 =
  "f7f1d42f8f5732265cc241a9689f6e35f483593327f6250ec3aa30ec8bb53816";
export const CSV_ASOF = "2026-09-30";

/** pinned 5 URL (exact。一文字でも違えば拒否する)。 */
export interface BridgeTarget {
  url: string;
  host: string;
  slug: string;
  kind: "notice" | "stock" | "pdf";
  ticker: "622A" | "627A" | "646A";
  edinet: string;
  /** HTML: bytes 内に必須の literal (全件)。PDF: 未使用。 */
  expectLiterals: string[];
  /** PDF: 抽出 text 内に必須の Ecode (corpID との AND が bridge 条件)。 */
  pdfEcode?: string;
  /** PDF: 補強記録のみの ticker (単独では不足。bridge 条件に使わない)。 */
  pdfTicker?: string;
}

export const PINNED_TARGETS: readonly BridgeTarget[] = [
  {
    url: "https://www.tecraft.co.jp/ir/notice/",
    host: "www.tecraft.co.jp",
    slug: "622A-notice",
    kind: "notice",
    ticker: "622A",
    edinet: "E42099",
    expectLiterals: ["E42099"],
  },
  {
    url: "https://www.tecraft.co.jp/ir/stock/",
    host: "www.tecraft.co.jp",
    slug: "622A-stock",
    kind: "stock",
    ticker: "622A",
    edinet: "E42099",
    expectLiterals: ["622A"],
  },
  {
    url: "https://akippa.co.jp/ir/notice/",
    host: "akippa.co.jp",
    slug: "627A-notice",
    kind: "notice",
    ticker: "627A",
    edinet: "E38412",
    expectLiterals: ["E38412"],
  },
  {
    url: "https://akippa.co.jp/ir/stock/",
    host: "akippa.co.jp",
    slug: "627A-stock",
    kind: "stock",
    ticker: "627A",
    edinet: "E38412",
    expectLiterals: ["627A"],
  },
  {
    url: "https://www.crasus.co.jp/content/files/IR/2026/20260929-Securitiesreport-1s.pdf",
    host: "www.crasus.co.jp",
    slug: "646A-securitiesreport",
    kind: "pdf",
    ticker: "646A",
    edinet: "E42126",
    expectLiterals: [],
    pdfEcode: "E42126",
    pdfTicker: "646A",
  },
];

export type PolicyDecision =
  | { kind: "hold-listed-conflict"; edinet: string; csvListed: string }
  | { kind: "bridge-gated"; edinet: string; csvListed: string }
  | { kind: "hold-bridge-failed"; edinet: string; csvListed: string }
  | { kind: "hold-identifier-absence"; edinet: string; csvListed: string };

/**
 * source 固有 policy。csvListed は観測値 (定数ではない)。
 * 非上場は distinct HOLD (TSE で override しない)。
 */
export function policyFor(
  ticker: "622A" | "627A" | "646A",
  edinet: string,
  csvListed: string,
  bridgeOk: boolean
): PolicyDecision {
  if (csvListed !== "上場") {
    return { kind: "hold-listed-conflict", edinet, csvListed };
  }
  if (bridgeOk) return { kind: "bridge-gated", edinet, csvListed };
  return ticker === "646A"
    ? { kind: "hold-identifier-absence", edinet, csvListed }
    : { kind: "hold-bridge-failed", edinet, csvListed };
}

/** HTTP meta に残す header allowlist (小文字)。secret 系は載せない。 */
const HEADER_ALLOWLIST = new Set(["content-type", "content-length", "last-modified", "etag"]);
const HEADER_DENY = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authenticate",
  "proxy-authorization",
  "www-authenticate",
]);

export interface PreflightInputs {
  jpxHtmlPath: string;
  jpxSha256: string;
  ledgerPath: string;
  codelistZipPath: string;
  codelistSha256: string;
}

export interface CaptureDeps {
  fetchFn: typeof fetch;
  record: typeof recordPrimaryData;
  findDb: typeof findBackupChildByTitle;
  queryUnique: typeof queryUniqueRow;
  /** PDF text 抽出。tool 不在は throw、抽出失敗は null。 */
  extractPdfText: (pdfPath: string) => string | null;
  fsRoot: string;
  clock: () => Date;
  preflight: PreflightInputs;
}

export interface CsvRowFact {
  listed: string;
  seccode: string;
  sectorPresent: boolean;
  corpnum: string | null;
}

export interface TargetOutcome {
  slug: string;
  url: string;
  status: number;
  bytes: number;
  sha256: string;
  literalOk: boolean;
  detail: string | null;
  held: string | null;
  /** PDF のみ: page/locator + 近傍 context の抽出 proof。HTML は null。 */
  proof: PdfProof | null;
}

/** PDF 識別子の page/locator + 近傍 context (issuer 連結用)。 */
export interface PdfIdHit {
  id: string;
  page: number;
  line: number;
  context: string[];
}

export interface PdfProof {
  extracted: boolean;
  rawSha256: string;
  hits: PdfIdHit[];
  counts: Record<string, number>;
  truncated: boolean;
}

/**
 * pdftotext -layout 出力から識別子の page/locator + 近傍 context を集める。
 * page 区切りは \f (pdftotext 既定)。id 毎に先頭 capPerId 件まで保持し、
 * 超過分は counts のみ残す (manifest 膨張防止)。
 */
export function locatePdfIds(
  text: string,
  ids: string[],
  rawSha256: string,
  window = 2,
  capPerId = 10
): PdfProof {
  const hits: PdfIdHit[] = [];
  const counts: Record<string, number> = {};
  const kept: Record<string, number> = {};
  for (const id of ids) {
    counts[id] = 0;
    kept[id] = 0;
  }
  let truncated = false;
  const pages = text.split("\f");
  pages.forEach((p, pi) => {
    const lines = p.split("\n");
    lines.forEach((ln, li) => {
      for (const id of ids) {
        if (id === "" || !ln.includes(id)) continue;
        counts[id] = (counts[id] as number) + 1;
        if ((kept[id] as number) >= capPerId) {
          truncated = true;
          continue;
        }
        kept[id] = (kept[id] as number) + 1;
        hits.push({
          id,
          page: pi + 1,
          line: li + 1,
          context: lines.slice(Math.max(0, li - window), li + window + 1),
        });
      }
    });
  });
  return { extracted: true, rawSha256, hits, counts, truncated };
}

export interface BridgeReport {
  key: string;
  pageId: string | null;
  verified: boolean;
  outcomes: TargetOutcome[];
  mutualLinks: { pair: string; ok: boolean }[];
  policy: Record<string, PolicyDecision>;
  preflight: {
    jpxHosts: Record<string, string>;
    ledger: Record<string, { code5: string; isin: string; listingDate: string }>;
    csvRows: Record<string, CsvRowFact>;
  };
  holds: string[];
  nextUrls: string[];
  /** forwards marked pre-send (attempt evidence in attempts.log). */
  sends: number;
  /** responses received (receipt evidence persisted). */
  responses: number;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** 世代 key 導出式: `ipo-bridge-{YYYYMMDD}-{sha12(正準 manifest-minus-key)}`。 */
export async function derivationKeyAsync(
  dateYYYYMMDD: string,
  manifestMinusKey: unknown
): Promise<string> {
  const canonical = new TextEncoder().encode(stableStringify(manifestMinusKey));
  const sha = await sha256HexBytes(canonical);
  return `ipo-bridge-${dateYYYYMMDD}-${sha.slice(0, 12)}`;
}

/** href 値の集合を HTML bytes から抜く。 */
export function extractHrefs(htmlBytes: Uint8Array): Set<string> {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(htmlBytes);
  const out = new Set<string>();
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return out;
}

/**
 * href を source URL 基準で解決し、期待 URL と突合する。
 * 相対 href も正規解決する。origin 小文字正規化 + path exact。
 */
export function hrefMatchesSource(href: string, sourceUrl: string, expectedUrl: string): boolean {
  let got: URL;
  try {
    got = new URL(href, sourceUrl);
  } catch {
    return false;
  }
  const want = new URL(expectedUrl);
  return got.origin === want.origin && got.pathname === want.pathname;
}

function YYYYMMDD(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

const ZIP_BRIDGE = fileURLToPath(new URL("./ipo-zip-bridge.py", import.meta.url));

/** Nix Python stdlib の最小 bridge を呼ぶ。非 0 は STOP。 */
function zipBridge(args: string[]): Uint8Array {
  try {
    return execFileSync("python3", [ZIP_BRIDGE, ...args], { maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const err = (e as { stderr?: unknown; message?: string }).stderr ?? (e as Error).message;
    throw new Error(`capture STOP: zip bridge 失敗: ${String(err).slice(0, 200)}`);
  }
}

async function writeExclusive(path: string, data: Uint8Array | string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  try {
    await writeFile(path, data, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`capture STOP: 既存証拠あり (上書きしない path=${path})`);
    }
    throw e;
  }
}

/** JPX 保存 HTML から ticker 行の自社 host を抜く (jpx/youtube 除外)。 */
function jpxRowHosts(html: string, ticker: string): Set<string> {
  const i = html.indexOf(ticker);
  if (i < 0) return new Set();
  const row = html.slice(Math.max(0, html.lastIndexOf("<tr", i)), html.indexOf("</tr>", i));
  const out = new Set<string>();
  for (const m of row.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
    try {
      const host = new URL(m[1]).host;
      if (!host.includes("jpx.co.jp") && !host.includes("youtu")) out.add(host);
    } catch {
      /* 不正 href は無視 */
    }
  }
  return out;
}

export async function runBridgeCapture(
  deps: CaptureDeps,
  targets: readonly BridgeTarget[] = PINNED_TARGETS
): Promise<BridgeReport> {
  const { mkdir, readFile, readdir, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { openSync, writeSync, fsyncSync, closeSync } = await import("node:fs");

  // upfront: 予算 + pinned + 一意性 (送信前に確定させる)。
  if (targets.length === 0 || targets.length > BUDGET.maxTargets) {
    throw new Error(`capture STOP: target 件数が予算外 (1-${BUDGET.maxTargets}): ${targets.length}`);
  }
  const pinnedUrls = new Set(PINNED_TARGETS.map((t) => t.url));
  const seen = new Set<string>();
  for (const t of targets) {
    if (!pinnedUrls.has(t.url)) {
      throw new Error(`capture STOP: 対象外 URL (pinned 5 以外は送らない) ${t.url}`);
    }
    if (seen.has(t.url)) throw new Error(`capture STOP: URL 重複 ${t.url}`);
    seen.add(t.url);
    if (new URL(t.url).host !== t.host) {
      throw new Error(`capture STOP: pinned host 不一致 ${t.url}`);
    }
  }

  // preflight (全 local。GET 前)。定数で既検証を主張しない。
  const jpxRaw = await readFile(deps.preflight.jpxHtmlPath).catch((e: Error) => {
    throw new Error(`capture STOP: JPX HTML を読めない: ${e.message}`);
  });
  const jpxHtml = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(jpxRaw));
  const jpxSha = await sha256HexBytes(new Uint8Array(jpxRaw));
  if (jpxSha !== deps.preflight.jpxSha256) {
    throw new Error("capture STOP: JPX HTML の full-SHA 不一致 (保存物と違う)");
  }
  const jpxHosts: Record<string, string> = {};
  for (const t of targets) {
    const hosts = jpxRowHosts(jpxHtml, t.ticker);
    if (t.kind === "pdf") continue; // PDF の origin 照合は下の host 一致で行う
    if (!hosts.has(t.host)) {
      throw new Error(`capture STOP: JPX 行に公式 origin なし ${t.ticker} (GET 前)`);
    }
    jpxHosts[t.ticker] = t.host;
  }
  // PDF の origin も保存 JPX 行で照合する (646A 行の自社 host)。
  {
    const hosts = jpxRowHosts(jpxHtml, "646A");
    const pdf = targets.find((t) => t.kind === "pdf");
    if (pdf && !hosts.has(pdf.host)) {
      throw new Error("capture STOP: JPX 行に PDF 公式 origin なし 646A (GET 前)");
    }
    if (pdf) jpxHosts["646A"] = pdf.host;
  }
  const ledgerRaw = await readFile(deps.preflight.ledgerPath).catch((e: Error) => {
    throw new Error(`capture STOP: ledger を読めない: ${e.message}`);
  });
  const ledger = JSON.parse(new TextDecoder().decode(new Uint8Array(ledgerRaw))) as {
    entries?: { code?: unknown; code5?: unknown; isin?: unknown; listingDate?: unknown; rawSha?: unknown }[];
  };
  const ledgerPins: Record<string, { code5: string; isin: string; listingDate: string }> = {};
  for (const ticker of ["622A", "627A", "646A"] as const) {
    const e = (ledger.entries ?? []).find((x) => x.code === ticker);
    const rawSha = e?.rawSha as Record<string, unknown> | undefined;
    const hex64 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
    if (
      typeof e?.code5 !== "string" ||
      typeof e?.isin !== "string" ||
      typeof e?.listingDate !== "string" ||
      !hex64(rawSha?.["r1"]) ||
      !hex64(rawSha?.["r2"]) ||
      !hex64(rawSha?.["r3"])
    ) {
      throw new Error(`capture STOP: ledger R1/R2/R3 識別子なし ${ticker} (GET 前)`);
    }
    ledgerPins[ticker] = { code5: e.code5, isin: e.isin, listingDate: e.listingDate };
  }
  const codelistZipBytes = await readFile(deps.preflight.codelistZipPath).catch((e: Error) => {
    throw new Error(`capture STOP: CSV ZIP を読めない: ${e.message}`);
  });
  if ((await sha256HexBytes(new Uint8Array(codelistZipBytes))) !== deps.preflight.codelistSha256) {
    throw new Error("capture STOP: CSV ZIP の full-SHA 不一致 (保存物と違う)");
  }
  const csvRowsRaw = JSON.parse(
    new TextDecoder().decode(zipBridge(["codelist-rows", "--zip", deps.preflight.codelistZipPath]))
  ) as { rows: Record<string, CsvRowFact> };
  const csvRows: Record<string, CsvRowFact> = {};
  for (const [ticker, edinet] of [["622A", "E42099"], ["627A", "E38412"], ["646A", "E42126"]] as const) {
    const r = csvRowsRaw.rows[edinet];
    if (
      !r ||
      typeof r.listed !== "string" ||
      typeof r.seccode !== "string" ||
      typeof r.sectorPresent !== "boolean" ||
      !(typeof r.corpnum === "string" || r.corpnum === null)
    ) {
      throw new Error(`capture STOP: CSV に ${edinet} 行なし (GET 前)`);
    }
    csvRows[ticker] = r;
  }
  // code pins: 実行物自体の full-SHA (pure preflight。prefix 主張なし)。
  const selfBytes = await readFile(fileURLToPath(import.meta.url));
  const bridgeBytes = await readFile(ZIP_BRIDGE);
  const codePins = {
    runner: await sha256HexBytes(new Uint8Array(selfBytes)),
    bridge: await sha256HexBytes(new Uint8Array(bridgeBytes)),
    ledger: await sha256HexBytes(new Uint8Array(ledgerRaw)),
    jpxHtml: jpxSha,
    codelistZip: deps.preflight.codelistSha256,
  };

  // fresh dir + attempt 予約 (wx0600 + fsync)。GET の前に確定させる。
  let fresh = true;
  try {
    const st = await stat(deps.fsRoot);
    if (!st.isDirectory()) throw new Error(`capture STOP: fsRoot が dir ではない ${deps.fsRoot}`);
    fresh = (await readdir(deps.fsRoot)).length === 0;
  } catch (e) {
    if ((e as Error).message.startsWith("capture STOP")) throw e;
    fresh = true;
  }
  if (!fresh) throw new Error(`capture STOP: 非 fresh dir (送信前に停止) ${deps.fsRoot}`);
  await mkdir(deps.fsRoot, { recursive: true });
  const started = deps.clock();
  {
    const fd = openSync(join(deps.fsRoot, "attempt.json"), "wx", 0o600);
    try {
      writeSync(
        fd,
        JSON.stringify(
          {
            attempt: "ipo-bridge-capture",
            startedAt: started.toISOString(),
            urls: targets.map((t) => t.url),
            jpxSha256: jpxSha,
            codelistSha256: deps.preflight.codelistSha256,
          },
          null,
          1
        )
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const dfd = openSync(deps.fsRoot, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  }

  // 各 URL 1 GET・manual・retry 0。順序固定。送信 cap 強制。
  const raws = new Map<string, Uint8Array>();
  const metas: { slug: string; meta: Record<string, unknown> }[] = [];
  const outcomes: TargetOutcome[] = [];
  const fetched = new Set<string>();
  let sends = 0;
  for (const t of targets) {
    if (fetched.has(t.url)) throw new Error(`capture STOP: URL 二重送信 ${t.url}`);
    if (sends >= BUDGET.maxGets) throw new Error("capture STOP: 送信 cap 超過 (再送なし)");
    const requestedAt = deps.clock().toISOString();
    let res: Response;
    try {
      res = await deps.fetchFn(t.url, { method: "GET", redirect: "manual" });
    } catch (e) {
      throw new Error(`capture STOP: GET 失敗 ${t.url}: ${(e as Error).message}`);
    }
    fetched.add(t.url);
    sends++;
    const completedAt = deps.clock().toISOString();
    const bytes = new Uint8Array(await res.arrayBuffer());
    const finalUrl = res.url;
    if (!finalUrl) throw new Error(`capture STOP: finalURL なし ${t.url} (代替なし)`);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      const low = k.toLowerCase();
      if (HEADER_DENY.has(low)) return;
      if (HEADER_ALLOWLIST.has(low)) headers[low] = v;
    });
    const sha = await sha256HexBytes(bytes);
    const meta = {
      url: t.url,
      host: t.host,
      finalUrl,
      status: res.status,
      requestedAt,
      completedAt,
      bytes: bytes.length,
      sha256: sha,
      headers,
    };
    // durable-before: 判定より先に persist する (非 200 の body/meta も残す)。
    await writeExclusive(join(deps.fsRoot, `${t.slug}.raw`), bytes);
    await writeExclusive(
      join(deps.fsRoot, `${t.slug}.meta.json`),
      new TextEncoder().encode(JSON.stringify(meta, null, 1))
    );
    if (res.status !== 200) {
      throw new Error(`capture STOP: ${t.url} status=${res.status} (追従・再送なし。証拠は保存済み)`);
    }
    raws.set(t.slug, bytes);
    metas.push({ slug: t.slug, meta });
    if (t.kind === "pdf") {
      let text: string | null;
      try {
        text = deps.extractPdfText(join(deps.fsRoot, `${t.slug}.raw`));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error("capture STOP: pdftotext 不在 (Nix poppler 追加が Root 承認待ち)");
        }
        throw e;
      }
      // full raw SHA は persist 済み・判定より先に確定 (FIRST)。
      const corpId = csvRows["646A"].corpnum;
      const proof: PdfProof =
        text !== null
          ? locatePdfIds(
              text,
              [t.pdfEcode as string, t.pdfTicker as string, ...(corpId ? [corpId] : [])],
              sha
            )
          : { extracted: false, rawSha256: sha, hits: [], counts: {}, truncated: false };
      const hasEcode = (proof.counts[t.pdfEcode as string] ?? 0) > 0;
      const hasCorp = corpId !== null && (proof.counts[corpId] ?? 0) > 0;
      const hasTicker = (proof.counts[t.pdfTicker as string] ?? 0) > 0;
      // bridge: Ecode AND corpID (page/locator + 近傍 context proof 付き)。
      // bare binary OR なし。ticker-only は bridge しない。
      const pdfBridge = hasEcode && hasCorp;
      outcomes.push({
        slug: t.slug,
        url: t.url,
        status: res.status,
        bytes: bytes.length,
        sha256: sha,
        literalOk: pdfBridge,
        detail: `raw:${sha},ecode:${hasEcode},corpid:${hasCorp},ticker:${hasTicker},extracted:${text !== null}`,
        held: pdfBridge ? null : !hasEcode ? "identifier-absence:ecode" : "identifier-absence:corpid",
        proof,
      });
    } else {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const literalOk = t.expectLiterals.every((lit) => text.includes(lit));
      outcomes.push({
        slug: t.slug,
        url: t.url,
        status: res.status,
        bytes: bytes.length,
        sha256: sha,
        literalOk,
        detail: null,
        held: literalOk ? null : `literal-missing:${t.expectLiterals.join("|")}`,
        proof: null,
      });
    }
  }

  // mutual links (HTML 対。相対 href は source 基準で正規解決する)。
  // raw 欠落は空 bytes 代用せず HOLD する。
  const mutualLinks: { pair: string; ok: boolean }[] = [];
  const holds: string[] = [];
  const htmlByTicker = new Map<string, { notice?: BridgeTarget; stock?: BridgeTarget }>();
  for (const t of targets) {
    if (t.kind === "pdf") continue;
    const g = htmlByTicker.get(t.ticker) ?? {};
    g[t.kind] = t;
    htmlByTicker.set(t.ticker, g);
  }
  for (const [ticker, g] of htmlByTicker) {
    let ok = false;
    if (g.notice && g.stock) {
      const rawN = raws.get(g.notice.slug);
      const rawS = raws.get(g.stock.slug);
      if (rawN && rawS) {
        const has = (raw: Uint8Array, from: string, want: string): boolean => {
          for (const h of extractHrefs(raw)) {
            if (hrefMatchesSource(h, from, want)) return true;
          }
          return false;
        };
        ok = has(rawN, g.notice.url, g.stock.url) && has(rawS, g.stock.url, g.notice.url);
      }
    }
    mutualLinks.push({ pair: `${ticker}-notice<->${ticker}-stock`, ok });
    if (!ok) holds.push(`mutual-links-missing:${ticker}`);
  }
  for (const o of outcomes) {
    if (!o.literalOk && o.held) holds.push(`${o.slug}:${o.held}`);
  }

  // policy 決定 (ticker 単位。CSV listed は観測値)。
  const policy: Record<string, PolicyDecision> = {};
  const bridgeOkByTicker = (ticker: "622A" | "627A" | "646A"): boolean => {
    if (ticker === "646A") {
      return outcomes.find((o) => o.slug === "646A-securitiesreport")?.literalOk ?? false;
    }
    const pair = mutualLinks.find((m) => m.pair.startsWith(`${ticker}-`));
    const lits = outcomes.filter((o) => o.slug.startsWith(`${ticker}-`));
    return (pair?.ok ?? false) && lits.length === 2 && lits.every((o) => o.literalOk);
  };
  const edinetOf = { "622A": "E42099", "627A": "E38412", "646A": "E42126" } as const;
  for (const ticker of ["622A", "627A", "646A"] as const) {
    const d = policyFor(ticker, edinetOf[ticker], csvRows[ticker].listed, bridgeOkByTicker(ticker));
    policy[ticker] = d;
    if (d.kind !== "bridge-gated") holds.push(`${ticker}:${d.kind}`);
  }

  // inner manifest + key 導出 + ZIP。
  const date = YYYYMMDD(started);
  const manifestFiles: { name: string; sha256: string; bytes: number }[] = [];
  for (const { slug, meta } of metas) {
    const raw = raws.get(slug) as Uint8Array;
    const metaBytes = new TextEncoder().encode(JSON.stringify(meta, null, 1));
    manifestFiles.push({ name: `${slug}.raw`, sha256: await sha256HexBytes(Uint8Array.from(raw)), bytes: raw.length });
    manifestFiles.push({
      name: `${slug}.meta.json`,
      sha256: await sha256HexBytes(metaBytes),
      bytes: metaBytes.length,
    });
  }
  const manifestMinusKey = {
    capturedAt: started.toISOString(),
    urls: metas.map(({ slug, meta }) => ({ slug, ...(meta as object) })),
    outcomes,
    mutualLinks,
    policy,
    csvRef: { asOf: CSV_ASOF, zipSha256: deps.preflight.codelistSha256 },
    preflight: {
      jpxHtmlSha256: jpxSha,
      jpxHosts,
      ledger: ledgerPins,
      csvRows,
      codePins,
    },
    files: manifestFiles,
  };
  const key = await derivationKeyAsync(date, manifestMinusKey);
  const manifest = { key, ...manifestMinusKey };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 1));
  await writeExclusive(join(deps.fsRoot, "manifest.json"), manifestBytes);
  // 1 immutable ZIP (Nix Python stdlib。entry 名順・固定 capture mtime)。
  const zipName = `${key}.zip`;
  const zipNames = [
    ...metas.flatMap(({ slug }) => [`${slug}.raw`, `${slug}.meta.json`]),
    "manifest.json",
  ];
  zipBridge([
    "build",
    "--mtime",
    String(Math.floor(started.getTime() / 1000)),
    "--out",
    join(deps.fsRoot, zipName),
    "--root",
    deps.fsRoot,
    ...zipNames,
  ]);
  const { readFile: readBin, chmod } = await import("node:fs/promises");
  await chmod(join(deps.fsRoot, zipName), 0o600);
  const zipBytes = new Uint8Array(await readBin(join(deps.fsRoot, zipName)));
  const zipSha = await sha256HexBytes(zipBytes);
  const zipLen = zipBytes.length;

  // 共有 logical record 1 件 force:false + readback。
  const dbId = await deps.findDb({
    parentPageId: notionEnv.NOTION_ARCHIVE_PAGE_ID(),
    title: DB_TITLE,
    kind: "database",
  });
  if (!dbId) throw new Error(`capture STOP: 「${DB_TITLE}」DB なし`);
  let pageId: string;
  try {
    const res = await deps.record({
      service: SERVICE,
      key,
      source: "ipo-bridge-capture (official IR HTML 4 + securities report PDF 1)",
      fetchedAt: started.toISOString(),
      metadata: {
        date,
        urls: targets.length,
        zipSha256: zipSha,
        zipBytes: zipLen,
        holds: holds.length,
      },
      files: [{ bytes: zipBytes, filename: zipName, contentType: "application/zip" }],
      force: false,
    });
    if (res.fileTooLarge) throw new Error(`capture STOP: fileTooLarge ${key}`);
    if (res.outcome !== "recorded") {
      throw new Error(`capture STOP: 既存 key の再利用なし (outcome=${res.outcome}) ${key}`);
    }
    pageId = res.pageId;
  } catch (e) {
    if (e instanceof NotionUnknownResultError) throw e;
    if (e instanceof Error && e.message.startsWith("capture STOP")) throw e;
    throw new Error(`capture STOP: record 失敗 ${key}: ${(e as Error).message}`);
  }
  const unique = await deps.queryUnique(
    dbId,
    { property: "Key", title: { equals: key } },
    `capture の重複 key=${key} を選ばず保全停止`
  );
  if (!unique || unique.id !== pageId) {
    throw new Error(`capture STOP: unique 行なし/不一致 ${key} (再送なし)`);
  }
  // 共有 verifier (Promise<void>。失敗は throw)。ZIP bytes 同一性はここで確定。
  // 本 runner の保全停止 taxonomy (capture STOP) に寄せる。
  try {
    await verifyArchivedAttachments(pageId, [{ filename: zipName, bytes: zipBytes }], `ipo-bridge ${key}`);
  } catch (e) {
    throw new Error(`capture STOP: ZIP 照合不一致 ${key} (再送なし): ${(e as Error).message}`);
  }
  // inner readback: ORIGINAL local manifest と hosted 内包を照合する
  // (11 key + manifest bytes + 全 SHA。hosted 自己申告を信用しない)。
  // bytes の長/SHA 再判定はしない (共有 verifier が確定済み)。
  const hosted = await listPageFiles(pageId, "Files");
  const refs = hosted.filter((h) => h.name === zipName);
  if (refs.length !== 1 || refs[0].kind !== "file") {
    throw new Error(`capture STOP: hosted ZIP の URL 解決が unique exact でない ${key} (再送なし)`);
  }
  const dl = await deps.fetchFn((refs[0] as { url: string }).url);
  if (!dl.ok || dl.status !== 200) {
    throw new Error(`capture STOP: hosted 再取得が 200 でない ${key} (再送なし)`);
  }
  const hostedZipPath = join(deps.fsRoot, `hosted-${zipName}`);
  const hostedZipBytes = new Uint8Array(await dl.arrayBuffer());
  await writeExclusive(hostedZipPath, hostedZipBytes);
  const listed = JSON.parse(
    new TextDecoder().decode(zipBridge(["list", "--zip", hostedZipPath]))
  ) as { files: { name: string; sha256: string }[] };
  const listedNames = listed.files.map((f) => f.name).sort();
  const expectedNames = [...zipNames].sort();
  if (JSON.stringify(listedNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`capture STOP: hosted 内包 key 集合不一致 ${key} (再送なし)`);
  }
  const hostedManifestRaw = zipBridge(["cat", "--zip", hostedZipPath, "--name", "manifest.json"]);
  if ((await sha256HexBytes(new Uint8Array(hostedManifestRaw))) !== (await sha256HexBytes(manifestBytes))) {
    throw new Error(`capture STOP: hosted manifest bytes 不一致 ${key} (再送なし)`);
  }
  for (const f of manifest.files) {
    const got = listed.files.find((l) => l.name === f.name);
    if (!got || got.sha256 !== f.sha256) {
      throw new Error(`capture STOP: hosted 内包 SHA 不一致 ${f.name} (再送なし)`);
    }
  }

  return {
    key,
    pageId,
    verified: true,
    outcomes,
    mutualLinks,
    policy,
    preflight: { jpxHosts, ledger: ledgerPins, csvRows },
    holds,
    nextUrls: [],
    sends,
    responses: metas.length,
  };
}

function printScopeAndExit(): never {
  console.info(
    [
      "[ipo-bridge-capture] IPO bridge 5-URL capture (PREP 実装)。",
      ...PINNED_TARGETS.map((t) => `入力 ${t.slug}: ${t.url}`),
      `予算: target≤${BUDGET.maxTargets}・URL毎${BUDGET.getsPerUrl}GET・計${BUDGET.maxGets}送信。`,
      "preflight (GET 前・全 local): --jpx-html/--ledger/--codelist-zip。",
      "1 immutable ZIP → 共有 record 1 件 force:false + readback。",
      "live 実行には --execute が必要です。Root review 境界までは実行しません。",
    ].join("\n")
  );
  process.exit(2);
  throw new Error("unreachable");
}

function argVal(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = argVal(args, "--dir");
  const jpxHtml = argVal(args, "--jpx-html");
  const ledger = argVal(args, "--ledger");
  const codelist = argVal(args, "--codelist-zip");
  if (!args.includes("--execute") || !dir || !jpxHtml || !ledger || !codelist) printScopeAndExit();
  // PDF 抽出 tool の事前確認 (GET 前。なければ STOP する)。
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "pipe" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("[ipo-bridge-capture] エラー: capture STOP: pdftotext 不在 (Nix poppler 追加が Root 承認待ち)");
      process.exit(1);
    }
  }
  const report = await runBridgeCapture({
    fetchFn: fetch,
    record: recordPrimaryData,
    findDb: findBackupChildByTitle,
    queryUnique: queryUniqueRow,
    extractPdfText: (pdfPath: string) => {
      try {
        const out = execFileSync("pdftotext", ["-layout", pdfPath, "-"], {
          maxBuffer: 64 * 1024 * 1024,
        });
        return new TextDecoder().decode(new Uint8Array(out));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") throw e;
        return null;
      }
    },
    fsRoot: dir as string,
    clock: () => new Date(),
    preflight: {
      jpxHtmlPath: jpxHtml as string,
      jpxSha256: argVal(args, "--jpx-sha") ?? JPX_HTML_SHA256,
      ledgerPath: ledger as string,
      codelistZipPath: codelist as string,
      codelistSha256: argVal(args, "--codelist-sha") ?? CODELIST_ZIP_SHA256,
    },
  });
  console.info(
    JSON.stringify(
      {
        key: report.key,
        pageId: report.pageId,
        verified: report.verified,
        sends: report.sends,
        holds: report.holds,
        mutualLinks: report.mutualLinks,
        policy: report.policy,
        outcomes: report.outcomes.map((o) => ({
          slug: o.slug,
          status: o.status,
          bytes: o.bytes,
          sha256: o.sha256,
          literalOk: o.literalOk,
          detail: o.detail,
          held: o.held,
          proof: o.proof
            ? {
                extracted: o.proof.extracted,
                rawSha256: o.proof.rawSha256,
                counts: o.proof.counts,
                truncated: o.proof.truncated,
                locators: o.proof.hits.map((h) => ({ id: h.id, page: h.page, line: h.line })),
              }
            : null,
        })),
      },
      null,
      2
    )
  );
  if (report.holds.length > 0) process.exitCode = 1;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((e) => {
    console.error("[ipo-bridge-capture] エラー:", (e as Error).message);
    process.exit(1);
  });
}
