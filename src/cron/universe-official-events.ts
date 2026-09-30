/**
 * JPX 公式 3 頁 (上場廃止/新規上場/市場区分変更) の収集 + 一次保管 (Issue #196)。
 *
 * B 所有の取得・厳密パース helper を束ね、共有 custody
 * (`recordPrimaryData`, service `universe`) へ原文 + manifest を記録し、
 * hosted readback で物理完了を確認してから返す。生産関数は
 * `collectUniverseOfficialEvents` ただ 1 つ。
 *
 * 契約 (GPT-sol final):
 * - 入力は厳密実在日。`(baseAsOf, eligibilityAsOf]` の要求年窓を
 *   `requiredCoverageYears` で求め、3 パース共通の yearWindow にする。
 *   selected backnumber 年だけが被覆 (未来行の年は証拠にしない)。
 *   base==elig は helper が throw (黙って空補完しない)。
 *   base=null は bootstrap partial として return/manifest に明示する。
 * - 行は B の row 型のまま全 current-generation を返す (未来・base 以前を
 *   含め、C は発効日 window filter しない)。IPO 分類・instrument・
 *   sector の推測なし。DB/state mutation なし。新規 parser/mapping なし。
 * - 3 source URL は B の固定定数を再利用。追加 history/PDF/XLS 取得なし。
 * - `eventsFetchedAt` は collector 開始時に 1 回固定。各 source の
 *   fetchedAt は metadata 専用 (manifest には時刻を入れない)。
 * - 取得時に owned copy を 1 回だけ保持し、同 copy で hash/parse/archive
 *   する (元 buffer の後発 mutation に影響されない)。各 fetch sha の
 *   再計算一致は必須。不一致 source の bytes は隔離する (custody しない)。
 * - HTTP guard: 非 200 の verified raw は保存するが parse から除外する
 *   (404 の valid HTML を complete 扱いしない)。failed 条件に含める。
 *   network throw (body なし) は missing のまま。失敗 bytes は捏造しない。
 * - eventsSha = sha256Hex(delistedSHA+newListingSHA+transferSHA) full64。
 *   archiveKey = universe-official-events-<base|bootstrap>-<elig>-sha-<prefix12>
 *   (prefix は `officialEventsArchiveKey` 再利用)。不完全形だけ
 *   `-incomplete-<manifest全bytesSHA12>` を付け、後日 parser 修正後の
 *   完全形と fingerprint 衝突しない (完全形 key 不変)。
 * - manifest は決定的 (version/window/coverage/failure・source 固定順/
 *   URL/status/httpStatus/bytes/fullSHA/selectedYear/tableIndex/rowCount)。
 *   例外文等の volatile text は入れず、診断詳細は record metadata 側。
 *   run/fetchedAt/ID/署名 URL を入れず、同一 window+同一 bytes の再実行は
 *   冪等にする (自己 hash 参照なし。key 側が manifest 署名を持つ)。
 * - 記録は `recorded` 成功か `skipped_existing` + manifestMatch `same` かつ
 *   fileTooLarge=false のみ受理。Notion Unknown は STOP (再 POST なし)。
 *   metadata fingerprint は物理証明ではないため、`listPageFiles` で
 *   件数・名前一意・全 kind=file を確認し、全 hosted URL を再取得して
 *   長さ+SHA を照合してから返す (stock-gap-diagnostic の
 *   verifyDiagBatchAttachments と同 pattern。CLI は import しない)。
 * - fetch/parse/coverage/HTTP 失敗で partial-success result は返さない。
 *   3 fetch は allSettled で成功 raw を捨てず、検証済み raw があれば
 *   deterministic incomplete manifest で known-raw-only custody
 *   (非 200 の verified raw・空 bytes 含む。全件 readback) して throw
 *   (exact-3-raw 成功宣言なし)。現 B 契約 (非 200 throw) と新 B 契約
 *   (status+bytes 返却) の両方を扱い、失敗 bytes は捏造しない。
 *
 * live (source GET/Notion POST・GET/D1/R2) は PR200 未 merge のため保留。
 * 本モジュールに CLI・console 出力はない (pageID/署名 URL/body を出さない)。
 */
import {
  JPX_DELISTED_URL,
  fetchDelistedHtml,
  officialEventsArchiveKey,
  parseDelistedHtml,
  type DelistedFetch,
  type DelistedRow,
} from "../shared/jpx/delisted.js";
import {
  JPX_NEW_LISTINGS_URL,
  fetchNewListingsHtml,
  parseNewListingsHtml,
  type NewListingRow,
  type NewListingsFetch,
} from "../shared/jpx/new-listings.js";
import {
  JPX_TRANSFERS_URL,
  fetchTransfersHtml,
  parseTransfersHtml,
  type TransferRow,
  type TransfersFetch,
} from "../shared/jpx/transfers.js";
import {
  parseIsoDate,
  requiredCoverageYears,
} from "../shared/jpx/official-html.js";
import { NotionUnknownResultError } from "../shared/notion-archive/client.js";
import {
  listPageFiles,
  recordPrimaryData,
} from "../shared/notion-archive/index.js";
import { sha256Hex, sha256HexBytes } from "../shared/sha256.js";

const SERVICE = "universe";
const MANIFEST_VERSION = 1;
const SOURCE_ORDER = ["delisted", "newListings", "transfers"] as const;
type SourceKey = (typeof SOURCE_ORDER)[number];

const SOURCE_URL: Record<SourceKey, string> = {
  delisted: JPX_DELISTED_URL,
  newListings: JPX_NEW_LISTINGS_URL,
  transfers: JPX_TRANSFERS_URL,
};

const RAW_FILENAME: Record<SourceKey, string> = {
  delisted: "delisted.html",
  newListings: "new-listings.html",
  transfers: "transfers.html",
};
const MANIFEST_FILENAME = "manifest.json";

export interface UniverseOfficialEventsBatch {
  baseAsOf: string | null;
  eligibilityAsOf: string;
  eventsFetchedAt: string;
  eventsSha: string;
  archiveKey: string;
  pageId: string;
  coverage: { years: string[]; bootstrapPartial: boolean };
  sources: {
    delisted: { rows: DelistedRow[]; coveredYears: string[]; rawSha: string; sourceUrl: string };
    newListings: { rows: NewListingRow[]; coveredYears: string[]; rawSha: string; sourceUrl: string };
    transfers: { rows: TransferRow[]; coveredYears: string[]; rawSha: string; sourceUrl: string };
  };
}

/** 最小 test seam (7 optional deps。単独 framework なし、型は本 file 内)。 */
export interface UniverseOfficialEventsDeps {
  fetchDelisted?: () => Promise<DelistedFetch>;
  fetchNewListings?: () => Promise<NewListingsFetch>;
  fetchTransfers?: () => Promise<TransfersFetch>;
  record?: typeof recordPrimaryData;
  listFiles?: typeof listPageFiles;
  downloadBytes?: (url: string) => Promise<Uint8Array>;
  nowIso?: () => string;
}

type FetchBundle = {
  url: string;
  fetchedAt: string;
  status: number;
  /** owned copy (取得時に 1 回複写。以降は同 copy を使い回す)。 */
  bytes: Uint8Array<ArrayBuffer>;
  sha256: string;
};

type VerifiedSource = {
  key: SourceKey;
  fetch: FetchBundle;
  parsed: { rows: unknown[]; coveredYears: string[]; tableIndex: number };
};

function rootCause(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** hosted 再取得の既定実装 (redirect 明示 follow + ok + 全 bytes)。 */
async function defaultDownloadBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`hosted 再取得に失敗 status=${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

type ManifestSourceEntry = {
  key: SourceKey;
  url: string;
  status: "ok" | "fetch-failed" | "http-failed" | "sha-mismatch" | "parse-failed" | "unparsed";
  httpStatus: number | null;
  byteLength: number | null;
  sha256: string | null;
  selectedYear: string | null;
  tableIndex: number | null;
  rowCount: number | null;
};

type ManifestFailure = {
  /** 検出順の先頭 stage (fetch→integrity→http→parse)。volatile 文なし。 */
  stage: "fetch" | "integrity" | "http" | "parse";
  /** 該当 source (SOURCE_ORDER 順)。 */
  sources: SourceKey[];
} | null;

function buildManifest(
  complete: boolean,
  baseAsOf: string | null,
  eligibilityAsOf: string,
  years: string[],
  bootstrapPartial: boolean,
  failure: ManifestFailure,
  entries: ManifestSourceEntry[]
): Uint8Array {
  // 決定的: 固定 key 順・固定 source 順。時刻・run・ID・署名 URL なし。
  // 例外文等の volatile text は入れない (診断詳細は record metadata 側)。
  // 自己 hash 参照なし (key 側が manifest 全 bytes hash を署名する)。
  const manifest = {
    version: MANIFEST_VERSION,
    complete,
    window: { baseAsOf, eligibilityAsOf },
    coverage: { years: [...years], bootstrapPartial },
    failure,
    sources: entries.map((e) => ({ ...e })),
  };
  return new TextEncoder().encode(JSON.stringify(manifest));
}

/**
 * custody 記録 + 物理 readback (件数・名前一意・全 hosted・全 bytes SHA)。
 * verifyDiagBatchAttachments と同 pattern (CLI 非 import・private 実装)。
 */
async function recordAndVerify(
  deps: Required<UniverseOfficialEventsDeps>,
  key: string,
  source: string,
  fetchedAt: string,
  metadata: Record<string, unknown>,
  files: { filename: string; bytes: Uint8Array; contentType: string }[],
  label: string
): Promise<string> {
  const fail = (why: string): never => {
    throw new Error(`${label} の readback 照合に失敗したため HOLD: ${why}`);
  };
  const res = await deps.record({
    service: SERVICE,
    key,
    source,
    fetchedAt,
    metadata,
    files,
    force: false,
  });
  if (res.fileTooLarge) {
    throw new Error(`${label} の保管が不完全 (fileTooLarge): ${key}`);
  }
  const ok =
    res.outcome === "recorded" ||
    (res.outcome === "skipped_existing" && res.manifestMatch === "same");
  if (!ok) {
    throw new Error(
      `${label} の保管が不完全 (outcome=${res.outcome} manifestMatch=${res.manifestMatch}): ${key}`
    );
  }
  // metadata fingerprint は物理証明ではない。同一 key・同一 fingerprint の
  // 再実行でも readback を省かない。
  const names = files.map((f) => f.filename);
  if (new Set(names).size !== names.length) fail("添付名の重複 (内部不整合)");
  const hosted = await deps.listFiles(res.pageId, "Files");
  if (hosted.length !== files.length) {
    fail(`添付 ${hosted.length} 件 ≠ 記録 ${files.length} 件`);
  }
  const hostedNames = hosted.map((h) => h.name);
  if (new Set(hostedNames).size !== hostedNames.length) fail("hosted 添付名の重複");
  const byName = new Map(hosted.map((h) => [h.name, h]));
  for (const f of files) {
    const got = byName.get(f.filename) ?? fail(`添付「${f.filename}」なし`);
    if (got.kind !== "file") fail(`「${f.filename}」が Notion-hosted 添付ではありません`);
    const bytes = await deps.downloadBytes(got.url);
    if (bytes.length !== f.bytes.length) {
      fail(`「${f.filename}」のバイト長 ${bytes.length} ≠ ${f.bytes.length}`);
    }
    const [gotSha, wantSha] = await Promise.all([
      sha256HexBytes(Uint8Array.from(bytes)),
      sha256HexBytes(Uint8Array.from(f.bytes)),
    ]);
    if (gotSha !== wantSha) fail(`「${f.filename}」の SHA256 不一致`);
  }
  return res.pageId;
}

export async function collectUniverseOfficialEvents(
  input: { baseAsOf: string | null; eligibilityAsOf: string },
  deps: UniverseOfficialEventsDeps = {}
): Promise<UniverseOfficialEventsBatch> {
  const d: Required<UniverseOfficialEventsDeps> = {
    fetchDelisted: deps.fetchDelisted ?? fetchDelistedHtml,
    fetchNewListings: deps.fetchNewListings ?? fetchNewListingsHtml,
    fetchTransfers: deps.fetchTransfers ?? fetchTransfersHtml,
    record: deps.record ?? recordPrimaryData,
    listFiles: deps.listFiles ?? listPageFiles,
    downloadBytes: deps.downloadBytes ?? defaultDownloadBytes,
    nowIso: deps.nowIso ?? (() => new Date().toISOString()),
  };
  // 収集開始で共通 eventsFetchedAt を固定する。
  const eventsFetchedAt = d.nowIso();

  // 入力は厳密実在日。base==elig は helper が throw (黙って空補完しない)。
  if (parseIsoDate(input.eligibilityAsOf) === null) {
    throw new Error(`universe 収集 STOP: eligibilityAsOf が厳密実在日ではない (${input.eligibilityAsOf})`);
  }
  if (input.baseAsOf !== null && parseIsoDate(input.baseAsOf) === null) {
    throw new Error(`universe 収集 STOP: baseAsOf が厳密実在日ではない (${input.baseAsOf})`);
  }
  const { years, bootstrapPartial } = requiredCoverageYears(input.baseAsOf, input.eligibilityAsOf);

  // 3 fetch は allSettled (成功 raw を捨てない。追加 GET なし)。
  const settled = await Promise.allSettled([
    d.fetchDelisted(),
    d.fetchNewListings(),
    d.fetchTransfers(),
  ]);
  const fetched = new Map<SourceKey, FetchBundle>();
  const fetchErrors = new Map<SourceKey, string>();
  SOURCE_ORDER.forEach((key, i) => {
    const s = settled[i] as PromiseSettledResult<FetchBundle>;
    if (s.status === "fulfilled") {
      // owned copy を取得時に 1 回だけ保持する。以降の hash/parse/archive は
      // 同 copy を使い、元 buffer の後発 mutation に影響されない。
      fetched.set(key, { ...s.value, bytes: Uint8Array.from(s.value.bytes) });
    } else {
      // 現 B 契約は非 200 時に throw (bytes なし)。失敗 bytes は捏造しない。
      // 新 B 契約 (status+bytes 返却) は下の httpErrors 経路で扱う。
      fetchErrors.set(key, rootCause(s.reason).slice(0, 200));
    }
  });

  // owned copy で各 fetch sha の再計算一致 (必須)。不一致は隔離する。
  const verified = new Map<SourceKey, FetchBundle>();
  const shaErrors = new Map<SourceKey, string>();
  for (const key of SOURCE_ORDER) {
    const f = fetched.get(key);
    if (!f) continue;
    const recomputed = await sha256HexBytes(f.bytes);
    if (recomputed !== f.sha256) {
      shaErrors.set(key, `fetch sha 再計算不一致 (bytes は隔離)`);
      continue;
    }
    verified.set(key, f);
  }

  // HTTP guard: 非 200 の verified raw は保存するが parse から除外する
  // (404 の valid HTML を complete 扱いしない)。failed 条件に含める。
  const httpErrors = new Map<SourceKey, number>();
  for (const key of SOURCE_ORDER) {
    const v = verified.get(key);
    if (v && v.status !== 200) httpErrors.set(key, v.status);
  }

  // 3 parse 共通 yearWindow。200 のみ・固定順で最初の失敗まで (決定的)。
  const parsed = new Map<SourceKey, VerifiedSource["parsed"]>();
  let parseFailure: { key: SourceKey; message: string } | null = null;
  for (const key of SOURCE_ORDER) {
    const f = verified.get(key);
    if (!f || httpErrors.has(key)) continue;
    try {
      const out =
        key === "delisted"
          ? parseDelistedHtml(f.bytes, { yearWindow: years })
          : key === "newListings"
            ? parseNewListingsHtml(f.bytes, { yearWindow: years })
            : parseTransfersHtml(f.bytes, { yearWindow: years });
      parsed.set(key, out);
    } catch (e) {
      parseFailure = { key, message: rootCause(e).slice(0, 200) };
      break;
    }
  }

  const failed =
    fetchErrors.size > 0 ||
    shaErrors.size > 0 ||
    httpErrors.size > 0 ||
    parseFailure !== null ||
    parsed.size !== 3;
  // 不完全時は known sha + missing 固定文字列で決定的に作り、完全形と衝突させない。
  const digestShas = {
    delisted: verified.get("delisted")?.sha256 ?? "<missing:delisted>",
    newListings: verified.get("newListings")?.sha256 ?? "<missing:newListings>",
    transfers: verified.get("transfers")?.sha256 ?? "<missing:transfers>",
  };
  const eventsShaFull = await sha256Hex(digestShas.delisted + digestShas.newListings + digestShas.transfers);
  const prefix12 = await officialEventsArchiveKey(digestShas);
  const baseTag = input.baseAsOf ?? "bootstrap";
  const completeKey = `universe-official-events-${baseTag}-${input.eligibilityAsOf}-sha-${prefix12}`;

  const statusOf = (key: SourceKey): ManifestSourceEntry["status"] => {
    if (parsed.has(key)) return "ok";
    if (fetchErrors.has(key)) return "fetch-failed";
    if (httpErrors.has(key)) return "http-failed";
    if (shaErrors.has(key)) return "sha-mismatch";
    if (parseFailure?.key === key) return "parse-failed";
    return "unparsed";
  };
  const entries: ManifestSourceEntry[] = SOURCE_ORDER.map((key) => {
    const p = parsed.get(key);
    const v = verified.get(key);
    const f = fetched.get(key);
    if (p && v) {
      return {
        key,
        url: SOURCE_URL[key],
        status: "ok",
        httpStatus: v.status,
        byteLength: v.bytes.length,
        sha256: v.sha256,
        selectedYear: p.coveredYears[0] ?? null,
        tableIndex: p.tableIndex,
        rowCount: p.rows.length,
      };
    }
    return {
      key,
      url: SOURCE_URL[key],
      status: statusOf(key),
      httpStatus: v?.status ?? f?.status ?? null,
      byteLength: v ? v.bytes.length : null,
      sha256: v ? v.sha256 : null,
      selectedYear: null,
      tableIndex: null,
      rowCount: null,
    };
  });
  // manifest 用の failure 記述子 (volatile 文なし。検出順の先頭 stage)。
  const failureOf = (): ManifestFailure => {
    if (!failed) return null;
    if (fetchErrors.size > 0) {
      return { stage: "fetch", sources: SOURCE_ORDER.filter((k) => fetchErrors.has(k)) };
    }
    if (shaErrors.size > 0) {
      return { stage: "integrity", sources: SOURCE_ORDER.filter((k) => shaErrors.has(k)) };
    }
    if (httpErrors.size > 0) {
      return { stage: "http", sources: SOURCE_ORDER.filter((k) => httpErrors.has(k)) };
    }
    const unparsed = SOURCE_ORDER.filter((k) => verified.has(k) && !parsed.has(k));
    return {
      stage: "parse",
      sources: parseFailure !== null ? [parseFailure.key] : unparsed,
    };
  };

  if (failed) {
    // partial-success result は返さない。検証済み raw があれば
    // known-raw-only の incomplete custody をしてから throw する。
    // (exact-3-raw 成功宣言なし)。
    const firstFailure =
      parseFailure !== null
        ? `${parseFailure.key}: ${parseFailure.message}`
        : [...fetchErrors.entries()].map(([k, m]) => `${k}: ${m}`)[0] ??
          [...shaErrors.entries()].map(([k, m]) => `${k}: ${m}`)[0] ??
          [...httpErrors.entries()].map(([k, s]) => `${k}: HTTP ${s}`)[0] ??
          "unknown";
    if (verified.size === 0) {
      throw new Error(`universe 収集 STOP (custody なし・検証済み raw 0): ${firstFailure}`);
    }
    const manifestBytes = buildManifest(
      false,
      input.baseAsOf,
      input.eligibilityAsOf,
      years,
      bootstrapPartial,
      failureOf(),
      entries
    );
    // incomplete key は完全形と衝突させない。manifest 全 bytes の署名付き。
    const manifestShaFull = await sha256HexBytes(Uint8Array.from(manifestBytes));
    const manifestSig = manifestShaFull.slice(0, 12);
    const archiveKey = `${completeKey}-incomplete-${manifestSig}`;
    const files = [
      ...SOURCE_ORDER.filter((k) => verified.has(k)).map((key) => ({
        filename: RAW_FILENAME[key],
        bytes: (verified.get(key) as FetchBundle).bytes,
        contentType: "text/html",
      })),
      { filename: MANIFEST_FILENAME, bytes: manifestBytes, contentType: "application/json" },
    ];
    try {
      await recordAndVerify(
        d,
        archiveKey,
        "universe-official-events (incomplete: known raw only)",
        eventsFetchedAt,
        {
          version: MANIFEST_VERSION,
          complete: false,
          baseAsOf: input.baseAsOf,
          eligibilityAsOf: input.eligibilityAsOf,
          years,
          bootstrapPartial,
          eventsSha: eventsShaFull,
          manifestSha256: manifestShaFull,
          failure: firstFailure,
          fetchErrors: Object.fromEntries(fetchErrors),
          shaErrors: Object.fromEntries(shaErrors),
          httpErrors: Object.fromEntries(httpErrors),
          parseFailure: parseFailure ? `${parseFailure.key}: ${parseFailure.message}` : null,
        },
        files,
        "universe incomplete custody"
      );
    } catch (e) {
      if (e instanceof NotionUnknownResultError) throw e;
      throw new Error(`universe incomplete custody に失敗: ${rootCause(e)} (元失敗: ${firstFailure})`, {
        cause: e,
      });
    }
    throw new Error(`universe 収集 STOP (incomplete custody 済み): ${firstFailure}`);
  }

  // 完全形: exact 4 files。key は suffix なし (不変)。
  const manifestBytes = buildManifest(
    true,
    input.baseAsOf,
    input.eligibilityAsOf,
    years,
    bootstrapPartial,
    null,
    entries
  );
  const getV = (key: SourceKey): FetchBundle => {
    const v = verified.get(key);
    if (!v) throw new Error(`内部不整合: ${key} の検証済み raw なし`);
    return v;
  };
  const files = [
    { filename: RAW_FILENAME.delisted, bytes: getV("delisted").bytes, contentType: "text/html" },
    { filename: RAW_FILENAME.newListings, bytes: getV("newListings").bytes, contentType: "text/html" },
    { filename: RAW_FILENAME.transfers, bytes: getV("transfers").bytes, contentType: "text/html" },
    { filename: MANIFEST_FILENAME, bytes: manifestBytes, contentType: "application/json" },
  ];
  const pageId = await recordAndVerify(
    d,
    completeKey,
    "universe-official-events (JPX delisted/new-listings/transfers)",
    eventsFetchedAt,
    {
      version: MANIFEST_VERSION,
      complete: true,
      baseAsOf: input.baseAsOf,
      eligibilityAsOf: input.eligibilityAsOf,
      years,
      bootstrapPartial,
      eventsSha: eventsShaFull,
      delistedSha256: getV("delisted").sha256,
      newListingsSha256: getV("newListings").sha256,
      transfersSha256: getV("transfers").sha256,
      delistedFetchedAt: getV("delisted").fetchedAt,
      newListingsFetchedAt: getV("newListings").fetchedAt,
      transfersFetchedAt: getV("transfers").fetchedAt,
    },
    files,
    "universe official events"
  );

  const rowsOf = (key: SourceKey): VerifiedSource["parsed"] => {
    const p = parsed.get(key);
    if (!p) throw new Error(`内部不整合: ${key} の parse 結果なし`);
    return p;
  };
  return {
    baseAsOf: input.baseAsOf,
    eligibilityAsOf: input.eligibilityAsOf,
    eventsFetchedAt,
    eventsSha: eventsShaFull,
    archiveKey: completeKey,
    pageId,
    coverage: { years, bootstrapPartial },
    sources: {
      delisted: {
        rows: rowsOf("delisted").rows as DelistedRow[],
        coveredYears: rowsOf("delisted").coveredYears,
        rawSha: getV("delisted").sha256,
        sourceUrl: SOURCE_URL.delisted,
      },
      newListings: {
        rows: rowsOf("newListings").rows as NewListingRow[],
        coveredYears: rowsOf("newListings").coveredYears,
        rawSha: getV("newListings").sha256,
        sourceUrl: SOURCE_URL.newListings,
      },
      transfers: {
        rows: rowsOf("transfers").rows as TransferRow[],
        coveredYears: rowsOf("transfers").coveredYears,
        rawSha: getV("transfers").sha256,
        sourceUrl: SOURCE_URL.transfers,
      },
    },
  };
}
