/**
 * 東証上場会社情報サービス 基本情報の取得・厳密パース (Issue #196 IPO 分類)。
 *
 * 源泉 (2026-09-30 実測 8 社 + 618A):
 * entry https://www2.jpx.co.jp/tseHpFront/JJK010010Action.do?Show=Show
 * → search POST (ListShow のみ enable・eqMgrCd) → JJK010030Form
 * → basic POST (gotoBaseJh: mgrCd=CODE0・jjHisiFlg=1・BaseJh のみ enable)。
 *
 * 国内判定の定義 pin (公式案内 https://www.jpx.co.jp/listing/co-search/01.html
 * 2026-09-30T09:25:32+09:00 sha96b4efc0…「市場区分（国名）」):
 * 上場内国会社は所属市場区分のみ掲載、上場外国会社は市場区分+本社所在国名。
 * よって市場区分セルが 4 短名の完全一致なら上場内国会社。
 * ISIN prefix・社名・bare market の言い換えによる推定はしない。
 *
 * 契約:
 * - redirect 追随なし (3xx/Location は STOP)。
 * - retry なし (各段 1 回。失敗は throw でその会社 STOP)。
 * - 追加 GET なし (JS 等の副次取得をしない)。
 * - 9 社 hardcoded map を持たない。分類は毎回この mechanism で取得する。
 */
import { sha256HexBytes } from "../sha256.js";
import { extractTables } from "./official-html.js";

export const TSE_ENTRY_URL =
  "https://www2.jpx.co.jp/tseHpFront/JJK010010Action.do?Show=Show";
export const TSE_SEARCH_PATH = "/tseHpFront/JJK010010Action.do";
export const TSE_BASIC_PATH = "/tseHpFront/JJK010030Action.do";

/** 実測 header (2026-09-30)。完全一致のみ受理。 */
export const BASIC_TABLE_HEAD = [
  "コード",
  "ISINコード",
  "市場区分",
  "業種",
  "決算期",
  "売買単位",
];

/**
 * 検索結果表の実測 header (2026-09-30、extractTables の span 展開後)。
 * 決算期 th は colspan=2 のため 9 cell。code 列は index 0。
 */
export const SEARCH_RESULT_HEAD = [
  "コード",
  "銘柄名",
  "市場区分",
  "業種分類",
  "決算期",
  "決算期",
  "注意情報等",
  "基本情報",
  "株価表示",
];

/** 定義 pins (一次保管済み原本の全文 SHA。値は取得時に検証しない定数)。 */
export const DEFS_COUNTRY_GUIDE = {
  source: "https://www.jpx.co.jp/listing/co-search/01.html",
  sha256:
    "96b4efc099a1d68e01d846617ad9eef72a11b671c46f3cd86e9227af56dcb213",
} as const;
export const DEFS_ORDINARY_CODE = {
  source: "https://www.jpx.co.jp/glossary/ma/429.html",
  sha256:
    "f6fec43bbae08258d067e6a0c7429cfcc9d43ba2eeace1407b3eeea8a7bf29b8",
} as const;

/** 公式案内が内国会社の市場区分として列挙する 4 短名 (verbatim)。 */
export const DOMESTIC_BARE_MARKETS = [
  "プライム",
  "スタンダード",
  "グロース",
  "TOKYO PRO Market",
];

/** 取得生バイト束 (DelistedFetch と同形。custody へ直送する中間形式)。 */
export type BasicFetch = {
  url: string;
  fetchedAt: string;
  status: number;
  bytes: Uint8Array<ArrayBuffer>;
  sha256: string;
};

/** 同一会社・同一表の全行一致を検証済みの basic 行。 */
export type BasicProfileRow = {
  code4: string;
  code5: string;
  isin: string;
  /** 市場区分セル。4 短名の完全一致のみ値を持ち、他は countryCell へ。 */
  marketBare: string | null;
  /** 短名でない市場区分セル原文 (外国 suffix 等。形式推定しない)。 */
  countryCell: string | null;
  sector: string;
};

/** 実保管の receipt pins (reviewed input と証拠で共用する形)。 */
export type BasicReceiptPins = {
  entrySha: string;
  searchSha: string;
  rawSha: string;
  custodyPageIds: readonly string[];
};

/** planner が消費する分類証拠 (同一 batch 世代に束縛して供給する)。 */
export type BasicProfileEvidence = BasicProfileRow & {
  /** basic 取得時刻 (ISO)。監査 clock (世代証明は boundEventsFetchedAt)。 */
  basicFetchedAt: string;
  /** R1/R2/R3 raw の全文 SHA。 */
  entrySha: string;
  searchSha: string;
  rawSha: string;
  sourceUrl: string;
  /** 定義 pins (country-guide + ordinary-code の全文 SHA)。 */
  defsPins: { countryGuide: string; ordinaryCode: string };
  /** 一次保管 (1 社 1 record の pageId)。保管前の証拠は planner が拒否する。 */
  custody: { pageId: string } | null;
  /** 束縛した batch 世代 (composer が stamp。planner は一致を要求)。 */
  boundEventsFetchedAt: string | null;
  /**
   * この証拠が qualify する日付 (YYYY-MM-DD、composer が stamp)。
   * current 所有検証のみ。historic 日付への流用は planner が拒否する。
   */
  qualificationDate: string | null;
  /** qualify 根拠。現行は current-owner-qualified のみ受理。 */
  qualificationBasis: "current-owner-qualified" | null;
  /**
   * dated admission 証明 pin (将来の明示 source 用。現行は常に null)。
   * 非 null の未知形式は planner が fail-closed で拒否する。
   */
  datedSourcePin: {
    source: string;
    effectiveDate: string;
    rawSha: string;
  } | null;
  /**
   * stamp 時に照合した reviewed receipt pins (一致済み)。
   * 未 stamp は null。将来頁への stale 印流用を防ぐ束縛。
   */
  reviewedPins: BasicReceiptPins | null;
};

function fail(code4: string, step: string, detail: string): never {
  throw new Error(`basic ${code4} ${step}: ${detail}。STOP (retry なし)`);
}

/**
 * 基本情報ページから対象行を厳密抽出する。
 * header 完全一致・対象 4 桁の dedicated cell 行・予備桁 0 の検証・
 * 全表一致を要求する。本文の任意一致では判定しない。
 */
export function parseBasicProfile(
  html: string,
  code4: string
): BasicProfileRow {
  const code5 = `${code4}0`;
  const tables = extractTables(html);
  const allRows = tables.flatMap((t) => [...t.head, ...t.body]);
  const headerOk = allRows.some(
    (r) =>
      r.length === BASIC_TABLE_HEAD.length &&
      r.every((c, i) => c.text === BASIC_TABLE_HEAD[i])
  );
  if (!headerOk) fail(code4, "parse", "基本情報 header 不一致");
  // 対象 4 桁の 5 桁表示を dedicated cell で集める。
  // 予備桁は検証する (仮定しない)。0 以外は新株/優先株等の矛盾。
  // exact-header の BASIC 表だけを対象にする (無関係表の行混入を防ぐ)。
  const basicTables = tables.filter((t) =>
    [...t.head, ...t.body].some(
      (r) =>
        r.length === BASIC_TABLE_HEAD.length &&
        r.every((c, i) => c.text === BASIC_TABLE_HEAD[i])
    )
  );
  if (basicTables.length === 0) fail(code4, "parse", "BASIC 表なし");
  // 対象 4 桁の 5 桁表示を同一表の dedicated cell で集める。
  // 予備桁は検証する (仮定しない)。0 以外は新株/優先株等の矛盾。
  const fives = new Map<string, string[][]>();
  for (const t of basicTables) {
    for (const r of [...t.head, ...t.body]) {
      if (r.length !== BASIC_TABLE_HEAD.length) continue;
      const c0 = r[0].text;
      if (c0.length === 5 && c0.slice(0, 4) === code4) {
        const arr = fives.get(c0) ?? [];
        arr.push(r.map((c) => c.text));
        fives.set(c0, arr);
      }
    }
  }
  if (!fives.has(code5)) fail(code4, "parse", `${code5} 行なし`);
  for (const key of fives.keys()) {
    if (key !== code5) {
      fail(code4, "parse", `予備桁矛盾 ${key} (reserve0 でない)`);
    }
  }
  const hits = fives.get(code5) as string[][];
  const first = hits[0];
  for (const h of hits) {
    if (h.some((t, i) => t !== first[i])) {
      fail(code4, "parse", "基本情報の複数表が不一致");
    }
  }
  const marketCell = first[2];
  const bare = (DOMESTIC_BARE_MARKETS as readonly string[]).includes(marketCell)
    ? marketCell
    : null;
  return {
    code4,
    code5,
    isin: first[1],
    marketBare: bare,
    countryCell: bare === null ? marketCell : null,
    sector: first[3],
  };
}

/**
 * 証明済み国内普通株のみ既存 market full-form に解決する。
 * bare 不一致 (外国 suffix・欠落・矛盾) は null (= HOLD)。
 */
export function resolveDomesticFullMarket(
  row: Pick<BasicProfileRow, "marketBare" | "countryCell">
): string | null {
  if (row.marketBare === null || row.countryCell !== null) return null;
  return `${row.marketBare}（内国株式）`;
}

/** 1 往復の最小 seam (redirect 手動・cookie は呼出側 jar)。 */
export type BasicRoundTrip = (req: {
  method: "GET" | "POST";
  url: string;
  body?: string;
  cookie?: string;
}) => Promise<{
  status: number;
  location: string | null;
  setCookies: string[];
  /** 受信生バイト (一次保管用。text はここからの decode)。 */
  bytes: Uint8Array<ArrayBuffer>;
  text: string;
}>;

export interface BasicFetchDeps {
  roundTrip?: BasicRoundTrip;
  nowIso?: () => string;
}

function cookieJarApply(jar: Map<string, string>, setCookies: string[]): void {
  for (const sc of setCookies) {
    const pair = sc.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function defaultRoundTrip(
  req: Parameters<BasicRoundTrip>[0]
): Promise<{
  status: number;
  location: string | null;
  setCookies: string[];
  bytes: Uint8Array<ArrayBuffer>;
  text: string;
}> {
  const headers: Record<string, string> = {
    "user-agent": "kabulab-universe/1.0 (+issue196)",
  };
  if (req.cookie !== undefined) headers["cookie"] = req.cookie;
  if (req.method === "POST") {
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const res = await fetch(req.url, {
    method: req.method,
    headers,
    body: req.method === "POST" ? req.body ?? "" : undefined,
    redirect: "manual",
  });
  // 生バイトを先に確保する (後段の失敗時も partial として運ぶため)。
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  const getSetCookie = (
    res.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie;
  if (typeof getSetCookie !== "function") {
    const err = new Error(
      "basic: getSetCookie unavailable — session 保管不能のため STOP"
    );
    (err as Error & { partialRaw?: RoundTripPartialRaw }).partialRaw = {
      url: req.url,
      status: res.status,
      bytes,
    };
    throw err;
  }
  // text は生バイトからの decode (再生成しない)。
  return {
    status: res.status,
    location: res.headers.get("location"),
    setCookies: getSetCookie.call(res.headers),
    bytes,
    text,
  };
}

/** roundTrip 層が失敗時に運ぶ得済み生バイト。 */
export type RoundTripPartialRaw = {
  url: string;
  status: number;
  bytes: Uint8Array<ArrayBuffer>;
};

function inputTag(formHtml: string, name: string): string | null {
  for (const m of formHtml.matchAll(/<input[^>]*>/g)) {
    if (m[0].match(/name="([^"]*)"/)?.[1] === name) return m[0];
  }
  return null;
}

/** 必須 control の tag 存在を要求し、観測値を verbatim で返す。 */
function requiredInput(formHtml: string, code4: string, name: string): string {
  const tag = inputTag(formHtml, name);
  if (tag === null) fail(code4, "controls", `${name} control なし`);
  return tag.match(/value="([^"]*)"/)?.[1] ?? "";
}

/** select の観測 default (selected 優先、無ければ先頭 option)。 */
function selectDefault(
  pageHtml: string,
  code4: string,
  name: string
): string {
  const sel = pageHtml.match(
    new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`)
  )?.[1];
  if (sel === undefined) fail(code4, "controls", `${name} select なし`);
  const opts = [...sel.matchAll(/<option[^>]*value="([^"]*)"[^>]*>/g)];
  if (opts.length === 0) fail(code4, "controls", `${name} option なし`);
  const marked = opts.find((o) => o[0].includes("selected"));
  return (marked ?? opts[0])[1];
}

/** 失敗時に得済み primary raw を運ぶ (composer が partial 保管する)。 */
export type BasicPartial = {
  entry?: BasicFetch;
  search?: BasicFetch;
  basic?: BasicFetch;
};

/**
 * 1 社の entry→search→basic を実行し証拠を返す。
 * 失敗は throw (その会社 STOP)。redirect 追随・retry・追加 GET なし。
 * 得済み raw は error.partial に添付する (黙殺せず保管させるため)。
 */
export async function collectBasicProfile(
  code4: string,
  deps: BasicFetchDeps = {}
): Promise<{
  entry: BasicFetch;
  search: BasicFetch;
  basic: BasicFetch;
  evidence: BasicProfileEvidence;
}> {
  const roundTrip = deps.roundTrip ?? defaultRoundTrip;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const jar = new Map<string, string>();
  const code5 = `${code4}0`;
  const cycleStartedAt = nowIso();
  const partial: BasicPartial = {};
  const mkFetch = async (
    url: string,
    status: number,
    bytes: Uint8Array<ArrayBuffer>,
    fetchedAt: string
  ): Promise<BasicFetch> => ({
    url,
    fetchedAt,
    status,
    bytes,
    sha256: await sha256HexBytes(bytes),
  });
  try {
    return await collectBasicProfileInner(
      code4,
      code5,
      roundTrip,
      nowIso,
      cycleStartedAt,
      jar,
      partial,
      mkFetch
    );
  } catch (e) {
    // roundTrip 層の partialRaw (cookie API 失敗等) は URL で段を特定する。
    // 当該段のみ未保管なら回収する (他段の有無は問わない)。
    const raw =
      e !== null && typeof e === "object"
        ? (e as { partialRaw?: RoundTripPartialRaw }).partialRaw
        : undefined;
    if (raw !== undefined) {
      const recovered = await mkFetch(
        raw.url,
        raw.status,
        raw.bytes,
        cycleStartedAt
      );
      if (raw.url === TSE_ENTRY_URL) partial.entry ??= recovered;
      else if (raw.url === `https://www2.jpx.co.jp${TSE_BASIC_PATH}`) {
        partial.basic ??= recovered;
      } else if (raw.url.startsWith("https://www2.jpx.co.jp" + TSE_SEARCH_PATH)) {
        partial.search ??= recovered;
      }
    }
    if (
      partial.entry !== undefined ||
      partial.search !== undefined ||
      partial.basic !== undefined
    ) {
      (e as Error & { partial?: BasicPartial }).partial = { ...partial };
    }
    throw e;
  }
}

async function collectBasicProfileInner(
  code4: string,
  code5: string,
  roundTrip: BasicRoundTrip,
  nowIso: () => string,
  cycleStartedAt: string,
  jar: Map<string, string>,
  partial: BasicPartial,
  mkFetch: (
    url: string,
    status: number,
    bytes: Uint8Array<ArrayBuffer>,
    fetchedAt: string
  ) => Promise<BasicFetch>
): Promise<{
  entry: BasicFetch;
  search: BasicFetch;
  basic: BasicFetch;
  evidence: BasicProfileEvidence;
}> {
  // ---- R1: fresh anonymous entry ----
  const r1 = await roundTrip({ method: "GET", url: TSE_ENTRY_URL });
  // partial は status/session/schema guard の前に得済み raw から確保する。
  partial.entry = await mkFetch(
    TSE_ENTRY_URL,
    r1.status,
    r1.bytes,
    cycleStartedAt
  );
  if (r1.status !== 200 || r1.location !== null) {
    fail(code4, "R1", `http=${r1.status} redirect=${r1.location !== null}`);
  }
  cookieJarApply(jar, r1.setCookies);
  // session 連続性の強制 (値は出さない。bool のみ)。
  const session1 = jar.get("JSESSIONID") ?? "";
  if (session1 === "") fail(code4, "R1", "JSESSIONID 未発行");
  const form1 = r1.text.match(
    /<form[^>]*name="JJK010010Form"[^>]*action="([^"]+)"/
  );
  const action1 = form1?.[1] ?? "";
  const sid1 = action1.startsWith(`${TSE_SEARCH_PATH};jsessionid=`)
    ? action1.slice(`${TSE_SEARCH_PATH};jsessionid=`.length)
    : "";
  if (sid1 === "" || sid1 !== session1) {
    fail(code4, "R1", "form action session と jar 不一致");
  }
  // 成功 control は観測値のみ (仮定・fallback なし)。
  const listShow = requiredInput(r1.text, code4, "ListShow");
  if (listShow === "") fail(code4, "R1", "ListShow 無値");
  const body2 = new URLSearchParams({
    ListShow: listShow,
    sniMtGmnId: requiredInput(r1.text, code4, "sniMtGmnId"),
    dspSsuPdMapOut: requiredInput(r1.text, code4, "dspSsuPdMapOut"),
    mgrMiTxtBx: requiredInput(r1.text, code4, "mgrMiTxtBx"),
    eqMgrCd: code4,
    dspSsuPd: selectDefault(r1.text, code4, "dspSsuPd"),
    szkbuChkbxMapOut: requiredInput(r1.text, code4, "szkbuChkbxMapOut"),
  }).toString();

  // ---- R2: search POST (ListShow のみ enable) ----
  const r2 = await roundTrip({
    method: "POST",
    url: `https://www2.jpx.co.jp${action1}`,
    body: body2,
    cookie: cookieHeader(jar),
  });
  partial.search = await mkFetch(
    `https://www2.jpx.co.jp${action1}`,
    r2.status,
    r2.bytes,
    cycleStartedAt
  );
  if (r2.status !== 200 || r2.location !== null) {
    fail(code4, "R2", `http=${r2.status} redirect=${r2.location !== null}`);
  }
  cookieJarApply(jar, r2.setCookies);
  if ((jar.get("JSESSIONID") ?? "") !== session1) {
    fail(code4, "R2", "session 断 (S1 型 bounce)");
  }
  // exact-one は検索結果表の code 列 (index 0) で判定する。
  // 各結果行は gotoBaseJh('CODE5','1') を 1 つ描く。
  if (!r2.text.includes(`gotoBaseJh('${code5}', '1')`)) {
    fail(code4, "R2", "gotoBaseJh 非観測");
  }
  const resultTables = extractTables(r2.text).filter((t) =>
    [...t.head, ...t.body].some(
      (r) =>
        r.length === SEARCH_RESULT_HEAD.length &&
        r.every((c, i) => c.text === SEARCH_RESULT_HEAD[i])
    )
  );
  if (resultTables.length === 0) fail(code4, "R2", "検索結果表なし");
  // header 行を除く data 行 (空行除外) の code 列を集める。
  const codes: string[] = [];
  for (const t of resultTables) {
    for (const r of [...t.head, ...t.body]) {
      if (r.length !== SEARCH_RESULT_HEAD.length) continue;
      if (r.every((c, i) => c.text === SEARCH_RESULT_HEAD[i])) continue;
      const v = r[0].text;
      if (v === "") continue;
      codes.push(v);
    }
  }
  if (codes.length !== 1 || codes[0] !== code5) {
    fail(code4, "R2", `exact-one 不成立 (結果表 code 列 ${codes.length} 行)`);
  }
  const form2 = r2.text.match(
    /<form[^>]*name="JJK010030Form"[^>]*action="([^"]+)"/
  );
  if (form2?.[1] !== TSE_BASIC_PATH) {
    fail(code4, "R2", "030form action 非 literal");
  }
  const form2Html = r2.text.match(
    /<form[^>]*name="JJK010030Form"[\s\S]*?<\/form>/
  )?.[0];
  if (form2Html === undefined) fail(code4, "R2", "030form 欠落");
  const params = new URLSearchParams();
  for (const m of form2Html.matchAll(/<input[^>]*>/g)) {
    const tag = m[0];
    const nm = tag.match(/name="([^"]+)"/)?.[1];
    if (nm === undefined || tag.includes('type="button"')) continue;
    const dis = tag.includes("disabled");
    const v = tag.match(/value="([^"]*)"/)?.[1] ?? "";
    if (nm === "mgrCd") params.set(nm, code5);
    else if (nm === "jjHisiFlg") params.set(nm, "1");
    else if (nm === "BaseJh" || !dis) params.set(nm, v);
  }
  if (!params.has("BaseJh") || !params.has("mgrCd")) {
    fail(code4, "R2", "030form 必須 control 欠落");
  }

  // ---- R3: basic POST (gotoBaseJh) ----
  const r3 = await roundTrip({
    method: "POST",
    url: `https://www2.jpx.co.jp${TSE_BASIC_PATH}`,
    body: params.toString(),
    cookie: cookieHeader(jar),
  });
  partial.basic = await mkFetch(
    `https://www2.jpx.co.jp${TSE_BASIC_PATH}`,
    r3.status,
    r3.bytes,
    cycleStartedAt
  );
  if (r3.status !== 200 || r3.location !== null) {
    fail(code4, "R3", `http=${r3.status} redirect=${r3.location !== null}`);
  }
  cookieJarApply(jar, r3.setCookies);
  if ((jar.get("JSESSIONID") ?? "") !== session1) {
    fail(code4, "R3", "session 断 (S1 型 bounce)");
  }
  const basicFetchedAt = nowIso();
  const row = parseBasicProfile(r3.text, code4);
  const entry = partial.entry as BasicFetch;
  const search = partial.search as BasicFetch;
  const basic = partial.basic as BasicFetch;
  return {
    entry,
    search,
    basic,
    evidence: {
      ...row,
      basicFetchedAt,
      entrySha: entry.sha256,
      searchSha: search.sha256,
      rawSha: basic.sha256,
      sourceUrl: TSE_ENTRY_URL,
      defsPins: {
        countryGuide: DEFS_COUNTRY_GUIDE.sha256,
        ordinaryCode: DEFS_ORDINARY_CODE.sha256,
      },
      // custody/qualification 束縛は composer (保管後に stamp)。
      // 未束縛は planner が拒否する。
      custody: null,
      boundEventsFetchedAt: null,
      qualificationDate: null,
      qualificationBasis: null,
      datedSourcePin: null,
      reviewedPins: null,
    },
  };
}
