/** 保有明細の銘柄同定と期末参考時価。原本の完全一致だけを使い、源GETはしない。 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { unzip } from "./zip.js";
import { tokenizeDelimited } from "./csv.js";
import { parseStockCode } from "../../../../../src/shared/jpx/stock-code.js";
import { parseDailyChart } from "../../../../../src/shared/yahoo/client.js";
import { lastJpxSessionOnOrBefore, type JpxReferenceSession } from "../../../../../src/shared/market-calendar.js";
import { jstDateSec } from "../../../../../src/shared/vwap/proof.js";
import type { Shareholding } from "./shareholdings.js";
import type { OfficialIssuerEnglishName, OfficialIssuerNames } from "./shareholdings-issuer-names.js";
import type { PreSplitFiscalYearBasis } from "./shareholdings-split-basis.js";
import type { HoldingNameChange } from "./shareholdings-name-change.js";

export interface ArchivedSource { archivePageId: string; filename: string; bytes: Buffer; sha256: string;
  /** Explicit activated members only; full gzip bytes/SHA remain unchanged. Omitted for legacy callers. */
  priceMembers?: Readonly<Record<string, { bodySha256: string; bodyBytes: number; receivedAt: string }>> }
export interface ListedIdentity {
  code: string; edinetCode: string; corporateNumber: string; legalName: string; englishName: string;
  asOf: string; row: number; archivePageId: string; zipSha256: string;
}
export interface ShareholdingsCatalog { asOf: string; byLegalName: ReadonlyMap<string, ListedIdentity[]> }
export type HoldingValuation =
  | { status: "unavailable"; reason: string; identity: ListedIdentity | null }
  | { status: "qualified"; identity: ListedIdentity; price: number; value: number; currency: "JPY"; date: string;
      priceSource: { archivePageId: string; gzipSha256: string; bodySha256: string; filename: string; symbol: string;
        capturedAt: string; sourceTimestamp: number; range: string; priceBasis: string; splitObservation: string; officialIssuerName?: OfficialIssuerEnglishName;
        evaluationDate?: string; sharesAsOf?: string; priceAsOf?: string; marketCalendar?: JpxReferenceSession; nameChange?: HoldingNameChange } };

/** 原本/SHA/chart検証後に確定した主体不一致だけ。通信・破損・ACK不明とは区別する。 */
export class HoldingPriceIssuerMismatch extends Error {
  constructor(readonly proof: { symbol: string; expectedEnglishName: string; observedEnglishName: string;
    archivePageId: string; filename: string; gzipSha256: string; bodySha256: string }) {
    super(`価格原本の発行体英字商号が一致しません。${JSON.stringify(proof)}`);
    this.name = "HoldingPriceIssuerMismatch";
  }
}

/** Source-qualified pre-split FY shares and already observed market ex price. No price write was sent. */
export class HoldingPriceShareBasisMismatch extends Error {
  constructor(readonly proof: { symbol: string; fiscalYearEnd: string; marketExDate: string; priceCapturedAt: string;
    priceBodySha256: string; issuer: OfficialIssuerEnglishName; basis: PreSplitFiscalYearBasis }) {
    super(`期末株数は法的分割前、価格原本は市場権利落ちを観測済みで、単位一致を確認できません。${JSON.stringify(proof)}`);
    this.name = "HoldingPriceShareBasisMismatch";
  }
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** (株)/㈱は株式会社の同義表記。法人格の削除・位置変更・近似/略称照合はしない。 */
export const exactLegalName = (value: string): string => value.normalize("NFKC").replace(/\s/g, "").replaceAll("(株)", "株式会社");
/** 英字商号のASCII句読点だけを同義化する。綴り・略称・ハイフンは変更しない。 */
export const exactEnglishName = (value: string) => value.normalize("NFKC").replace(/[\s.,]/g, "").toLowerCase();
function assertSource(source: ArchivedSource): void {
  assert.match(source.archivePageId.replaceAll("-", ""), /^[a-f0-9]{32}$/i);
  assert.equal(sha(source.bytes), source.sha256, "保存原本のSHAが不一致です");
}

export function parseHoldingsCodeList(source: ArchivedSource): ShareholdingsCatalog {
  assertSource(source);
  const csvs = [...unzip(source.bytes)].filter(([name]) => name.endsWith("EdinetcodeDlInfo.csv"));
  assert.equal(csvs.length, 1, "EDINETコードリストCSVを一意に特定できません");
  const rows = tokenizeDelimited(new TextDecoder("shift_jis", { fatal: true }).decode(csvs[0][1]), ",");
  const date = /^(\d{4})年(\d{2})月(\d{2})日現在$/.exec(rows[0][1]);
  assert.ok(date);
  const asOf = `${date[1]}-${date[2]}-${date[3]}`;
  assert.equal(new Date(`${asOf}T00:00:00Z`).toISOString().slice(0, 10), asOf);
  const count = /^(\d+)件$/.exec(rows[0][3]);
  assert.ok(count);
  assert.equal(rows.length - 2, Number(count[1]));
  assert.deepEqual(rows[1], ["ＥＤＩＮＥＴコード", "提出者種別", "上場区分", "連結の有無", "資本金", "決算日", "提出者名", "提出者名（英字）", "提出者名（ヨミ）", "所在地", "提出者業種", "証券コード", "提出者法人番号"]);
  const byLegalName = new Map<string, ListedIdentity[]>();
  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    assert.equal(row.length, 13);
    if (row[2] !== "上場") continue;
    const code = row[11].endsWith("0") ? parseStockCode(row[11].slice(0, -1)) : null;
    // 対象を推測しない。上場でも4文字普通株コード/法人番号が未観測なら同定対象外。
    if (code === null || !/^E\d{5}$/.test(row[0]) || !/^\d{13}$/.test(row[12]) || !row[6] || !row[7]) continue;
    const entry: ListedIdentity = { code, edinetCode: row[0], corporateNumber: row[12], legalName: row[6], englishName: row[7],
      asOf, row: i + 1, archivePageId: source.archivePageId, zipSha256: source.sha256 };
    const key = exactLegalName(row[6]), existing = byLegalName.get(key);
    if (existing) existing.push(entry); else byLegalName.set(key, [entry]);
  }
  return { asOf, byLegalName };
}

/** proxy wrapperは実保存形式。任意のURLをたどらず、内側の要求の構造だけを照合する。 */
function chartRequest(urlText: string, symbol: string): string {
  let url = new URL(urlText);
  if (url.pathname === "/api/ingest/yahoo") {
    const inner = url.searchParams.get("u"); assert.ok(inner); url = new URL(inner);
  }
  assert.equal(url.origin, "https://query1.finance.yahoo.com");
  assert.equal(decodeURIComponent(url.pathname), `/v8/finance/chart/${symbol}`);
  assert.equal(url.searchParams.get("interval"), "1d");
  assert.equal(url.searchParams.get("events"), "split,div");
  const range = url.searchParams.get("range"); assert.ok(range);
  return range;
}

interface PriceMember { api: string; symbol: string; status: number; receivedAt: string; url: string; byteLength: number; sha256: string; bodyBase64: string }
interface PriceCandidate { source: { archivePageId: string; filename: string; sha256: string }; member: PriceMember }
interface VerifiedPriceChart {
  range: string;
  parsed: Awaited<ReturnType<typeof parseDailyChart>>;
  raw: { meta: { currency: string; exchangeTimezoneName: string; longName: string }; timestamp: number[]; indicators: { quote: Array<{ close: Array<number | null> }> } };
}

/** 初回候補使用時だけ全sourceを一度展開し、body/要求/chart検証も共有する。chunk単位で解放する。 */
export class HoldingsPriceIndex {
  #bySymbol: Map<string, PriceCandidate[]> | null = null;
  #buildStarted = false;
  #buildError: unknown;
  readonly #verified = new WeakMap<PriceCandidate, Promise<VerifiedPriceChart>>();

  constructor(private readonly prices: readonly ArchivedSource[]) {}

  private build(): Map<string, PriceCandidate[]> {
    const bySymbol = new Map<string, PriceCandidate[]>();
    for (const source of this.prices) {
      assertSource(source);
      const wrapper = JSON.parse(gunzipSync(source.bytes).toString("utf8"));
      assert.equal(wrapper.version, 1); assert.ok(Array.isArray(wrapper.members));
      const selected = new Set<string>();
      for (const member of wrapper.members as PriceMember[]) {
        if (member.api !== "daily") continue;
        if (source.priceMembers !== undefined) {
          const expected = source.priceMembers[member.symbol];
          if (expected === undefined) continue;
          // Mixed old/new gzip can contain unactivated observations. Never choose those.
          if (member.sha256 !== expected.bodySha256 || member.byteLength !== expected.bodyBytes || member.receivedAt !== expected.receivedAt) continue;
          assert.equal(member.status, 200); assert.ok(!selected.has(member.symbol), "価格snapshotの同一memberが重複しています");
          selected.add(member.symbol);
        }
        const candidates = bySymbol.get(member.symbol) ?? [];
        candidates.push(Object.freeze({ source: Object.freeze({ archivePageId: source.archivePageId, filename: source.filename, sha256: source.sha256 }), member: Object.freeze(member) }));
        bySymbol.set(member.symbol, candidates);
      }
      if (source.priceMembers !== undefined) assert.deepEqual([...selected].sort(), Object.keys(source.priceMembers).sort(), "価格snapshotの明示member/SHA/実時計が一致しません");
    }
    return bySymbol;
  }

  assertSources(prices: readonly ArchivedSource[]): void { assert.equal(this.prices, prices, "price indexと保存原本集合が別です"); }

  candidates(symbol: string): readonly PriceCandidate[] {
    if (this.#bySymbol === null) {
      if (this.#buildStarted) throw this.#buildError;
      this.#buildStarted = true;
      try { this.#bySymbol = this.build(); }
      catch (error) { this.#buildError = error; throw error; }
    }
    return this.#bySymbol.get(symbol) ?? [];
  }

  verifiedChart(candidate: PriceCandidate, symbol: string): Promise<VerifiedPriceChart> {
    assert.equal(candidate.member.symbol, symbol);
    let verified = this.#verified.get(candidate);
    if (verified === undefined) {
      verified = (async () => {
        const { member } = candidate;
        assert.equal(member.status, 200);
        const bytes = Buffer.from(member.bodyBase64, "base64");
        assert.equal(bytes.length, member.byteLength); assert.equal(sha(bytes), member.sha256);
        const range = chartRequest(member.url, symbol);
        const parsed = await parseDailyChart(symbol, range, bytes, member.receivedAt);
        const raw = JSON.parse(bytes.toString("utf8")) as { chart: { result: VerifiedPriceChart["raw"][] } };
        return { range, parsed, raw: raw.chart.result[0] };
      })();
      this.#verified.set(candidate, verified);
    }
    return verified;
  }
}

/** loaderと評価は同じ原表診断を使う。直接一致がある場合は注で別主体へ置き換えない。 */
export function resolveHoldingPriceIdentity(holding: Pick<Shareholding, "name">, catalog: ShareholdingsCatalog,
  fiscalYearEnd?: string, nameChanges?: readonly HoldingNameChange[]): { candidates: ListedIdentity[] | undefined; nameChange: HoldingNameChange | undefined } {
  let candidates = catalog.byLegalName.get(exactLegalName(holding.name));
  let nameChange: HoldingNameChange | undefined;
  if (candidates === undefined && fiscalYearEnd !== undefined) {
    const changes = nameChanges?.filter(value => value.holdingName === holding.name && value.source.fiscalYearEnd === fiscalYearEnd && value.effectiveDate <= catalog.asOf);
    if (changes?.length === 1) {
      nameChange = changes[0]; candidates = catalog.byLegalName.get(exactLegalName(nameChange.newName));
    }
  }
  return { candidates, nameChange };
}

export async function qualifyHoldingValuation(args: {
  holding: Shareholding; fiscalYearEnd: string; catalog: ShareholdingsCatalog; prices: readonly ArchivedSource[] | HoldingsPriceIndex; officialIssuerNames?: OfficialIssuerNames;
  nameChanges?: readonly HoldingNameChange[];
}): Promise<HoldingValuation> {
  // 本関数は原表で確定した特定投資/みなし保有の上場scope限定（FSA開示定義）。
  const { candidates, nameChange } = resolveHoldingPriceIdentity(args.holding, args.catalog, args.fiscalYearEnd, args.nameChanges);
  if (candidates === undefined || candidates.length !== 1) return { status: "unavailable", identity: null,
    reason: nameChange !== undefined ? "原表に商号変更の注はありますが、新商号の上場主体・英字名を公式銘柄表で一意に確認できません" :
      candidates === undefined ? "公式上場提出者名へ完全一致しません" : "公式上場提出者名が一意ではありません" };
  const identity = candidates[0], symbol = `${identity.code}.T`;
  if (args.holding.shares === null) return { status: "unavailable", identity, reason: "期末株数が非開示です" };
  const index = args.prices instanceof HoldingsPriceIndex ? args.prices : new HoldingsPriceIndex(args.prices);
  const matches = index.candidates(symbol);
  if (matches.length !== 1) return { status: "unavailable", identity,
    reason: matches.length === 0 ? "該当symbolの保存日足原本がありません" : "該当symbolの保存日足原本が一意ではありません" };
  const { source, member } = matches[0];
  const { range, parsed, raw } = await index.verifiedChart(matches[0], symbol);
  if (nameChange !== undefined && nameChange.effectiveDate > member.receivedAt.slice(0, 10)) return { status: "unavailable", identity, reason: "価格原本のcapture前に商号変更が実施済みと確認できません" };
  assert.equal(raw.meta.currency, "JPY"); assert.equal(raw.meta.exchangeTimezoneName, "Asia/Tokyo");
  const officialName = args.officialIssuerNames?.get(identity.code);
  const acceptedNames = [identity.englishName];
  if (officialName !== undefined) {
    for (const name of ["code", "edinetCode", "corporateNumber"] as const) assert.equal(officialName[name], identity[name], "公式英字名集合の主体が不一致です");
    assert.equal(exactLegalName(officialName.legalName), exactLegalName(identity.legalName));
    assert.equal(officialName.priceCapturedAt, member.receivedAt, "公式英字名集合の価格captureが不一致です");
    assert.ok(Date.parse(officialName.submittedAt) <= Date.parse(member.receivedAt));
    acceptedNames.push(officialName.englishName);
  }
  if (!acceptedNames.some(name => exactEnglishName(name) === exactEnglishName(raw.meta.longName))) throw new HoldingPriceIssuerMismatch({
    symbol, expectedEnglishName: identity.englishName, observedEnglishName: raw.meta.longName,
    archivePageId: source.archivePageId, filename: source.filename, gzipSha256: source.sha256, bodySha256: member.sha256,
  });
  const canonicalMatch = exactEnglishName(raw.meta.longName) === exactEnglishName(identity.englishName);
  if (!canonicalMatch) assert.ok(officialName, "公式英字名の一致証拠が欠けています");
  const dates: string[] = raw.timestamp.map(jstDateSec);
  let priceDate = args.fiscalYearEnd, calendar: JpxReferenceSession | undefined;
  let indexes = dates.map((date: string, index: number) => date === priceDate ? index : -1).filter((index: number) => index >= 0);
  if (indexes.length === 0) {
    const session = lastJpxSessionOnOrBefore(args.fiscalYearEnd, new Set(parsed.bars.filter(bar => bar.c > 0).map(bar => bar.date)));
    if (session === undefined) return { status: "unavailable", identity, reason: "期末以前の最終市場営業日を公式カレンダーで確認できません" };
    if (session.date === args.fiscalYearEnd) return { status: "unavailable", identity, reason: "当期末の市場営業日の価格バーを一意に観測していません" };
    calendar = session; priceDate = session.date;
    indexes = dates.map((date: string, index: number) => date === priceDate ? index : -1).filter((index: number) => index >= 0);
  }
  if (indexes.length !== 1) return { status: "unavailable", identity, reason: "公式に確認した採用市場sessionの価格バーを一意に観測していません" };
  // 期末後のsplitがあれば原本quoteと当時株数の単位一致を主張しない。係数補完はしない。
  if (parsed.proof.firstTs === null || parsed.proof.lastTs === null ||
      jstDateSec(parsed.proof.firstTs) > args.fiscalYearEnd ||
      jstDateSec(parsed.proof.lastTs) < args.fiscalYearEnd ||
      parsed.splits.some(split => split.date > args.fiscalYearEnd)) {
    return { status: "unavailable", identity, reason: "当期末からcaptureまでの株数・価格単位の一致を確認できません" };
  }
  if (parsed.splits.length > 0) {
    const basis = officialName?.preSplitFiscalYearBasis;
    if (basis !== undefined) {
      assert.ok(officialName);
      assert.deepEqual(basis.source, officialName.source, "分割前株数のissuer sourceが不一致です");
      assert.equal(basis.memberSha256, officialName.memberSha256); assert.equal(basis.filename, officialName.filename);
      assert.equal(basis.context.entity, `${identity.edinetCode}-000`); assert.equal(basis.context.endDate, basis.source.fiscalYearEnd);
      assert.ok(basis.legalEffectiveDate <= officialName.filingDate, "予定段階の法的分割日を実施済みへ変換しません");
      const latest = [...parsed.splits].sort((a, b) => b.date.localeCompare(a.date))[0];
      if (basis.source.fiscalYearEnd === args.fiscalYearEnd && basis.legalEffectiveDate > args.fiscalYearEnd &&
        latest.ratio === basis.numerator / basis.denominator && latest.date < basis.legalEffectiveDate) {
        throw new HoldingPriceShareBasisMismatch({ symbol, fiscalYearEnd: args.fiscalYearEnd, marketExDate: latest.date,
          priceCapturedAt: member.receivedAt, priceBodySha256: member.sha256, issuer: officialName, basis });
      }
    }
    // Absence/unsupported Notes cannot establish price/share units, even in the local CLI.
    return { status: "unavailable", identity, reason: "市場権利落日の観測だけでは法的分割日と期末株数の単位を確認できません" };
  }
  // raw closeを採用する。既存dailyの2桁丸め値やadjcloseで置き換えない。
  const price = raw.indicators.quote[0].close[indexes[0]];
  assert.ok(typeof price === "number" && Number.isFinite(price) && price > 0);
  const value = price * args.holding.shares;
  assert.ok(Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER);
  return { status: "qualified", identity, price, value, currency: "JPY", date: priceDate,
    priceSource: { archivePageId: source.archivePageId, gzipSha256: source.sha256, bodySha256: member.sha256, filename: source.filename,
      symbol, capturedAt: member.receivedAt, sourceTimestamp: raw.timestamp[indexes[0]], range,
      priceBasis: calendar === undefined ? "当期末raw quote.close × 当期末株数。adjclose/丸め/局所分割調整なし" :
        "期末以前の公式最終市場営業日のraw quote.close × 期末株数。価格時点と株数時点を分離した参考値。adjclose/丸め/局所分割調整なし",
      ...(calendar === undefined ? {} : { evaluationDate: args.fiscalYearEnd, sharesAsOf: args.fiscalYearEnd, priceAsOf: priceDate, marketCalendar: calendar }),
      splitObservation: "events=split,divを指定した同一応答で当期末後のsplit0。capture後の状態は未観測",
      ...(canonicalMatch ? {} : { officialIssuerName: officialName }), ...(nameChange === undefined ? {} : { nameChange }) } };
}
