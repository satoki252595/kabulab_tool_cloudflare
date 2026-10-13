/** 保有明細の銘柄同定と期末参考時価。原本の完全一致だけを使い、源GETはしない。 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { unzip } from "./zip.js";
import { tokenizeDelimited } from "./csv.js";
import { parseStockCode } from "../../../../../src/shared/jpx/stock-code.js";
import { parseDailyChart } from "../../../../../src/shared/yahoo/client.js";
import { jstDateSec } from "../../../../../src/shared/vwap/proof.js";
import type { Shareholding } from "./shareholdings.js";

export interface ArchivedSource { archivePageId: string; filename: string; bytes: Buffer; sha256: string }
export interface ListedIdentity {
  code: string; edinetCode: string; corporateNumber: string; legalName: string; englishName: string;
  asOf: string; row: number; archivePageId: string; zipSha256: string;
}
export interface ShareholdingsCatalog { asOf: string; byLegalName: ReadonlyMap<string, ListedIdentity[]> }
export type HoldingValuation =
  | { status: "unavailable"; reason: string; identity: ListedIdentity | null }
  | { status: "qualified"; identity: ListedIdentity; price: number; value: number; currency: "JPY"; date: string;
      priceSource: { archivePageId: string; gzipSha256: string; bodySha256: string; filename: string; symbol: string;
        capturedAt: string; sourceTimestamp: number; range: string; priceBasis: string; splitObservation: string } };

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** (株)/㈱は株式会社の同義表記。法人格の削除・位置変更・近似/略称照合はしない。 */
export const exactLegalName = (value: string): string => value.normalize("NFKC").replace(/\s/g, "").replaceAll("(株)", "株式会社");
const englishName = (value: string) => value.normalize("NFKC").replace(/\s/g, "").toLowerCase();
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

export async function qualifyHoldingValuation(args: {
  holding: Shareholding; fiscalYearEnd: string; catalog: ShareholdingsCatalog; prices: readonly ArchivedSource[];
}): Promise<HoldingValuation> {
  // 本関数は原表で確定した特定投資/みなし保有の上場scope限定（FSA開示定義）。
  const candidates = args.catalog.byLegalName.get(exactLegalName(args.holding.name));
  if (candidates === undefined || candidates.length !== 1) return { status: "unavailable", identity: null,
    reason: candidates === undefined ? "公式上場提出者名へ完全一致しません" : "公式上場提出者名が一意ではありません" };
  const identity = candidates[0], symbol = `${identity.code}.T`;
  if (args.holding.shares === null) return { status: "unavailable", identity, reason: "期末株数が非開示です" };
  const matches: Array<{ source: ArchivedSource; member: { symbol: string; status: number; receivedAt: string; url: string; byteLength: number; sha256: string; bodyBase64: string } }> = [];
  for (const source of args.prices) {
    assertSource(source);
    const wrapper = JSON.parse(gunzipSync(source.bytes).toString("utf8"));
    assert.equal(wrapper.version, 1); assert.ok(Array.isArray(wrapper.members));
    for (const member of wrapper.members) if (member.api === "daily" && member.symbol === symbol) matches.push({ source, member });
  }
  if (matches.length !== 1) return { status: "unavailable", identity,
    reason: matches.length === 0 ? "該当symbolの保存日足原本がありません" : "該当symbolの保存日足原本が一意ではありません" };
  const { source, member } = matches[0];
  assert.equal(member.status, 200);
  const bytes = Buffer.from(member.bodyBase64, "base64");
  assert.equal(bytes.length, member.byteLength); assert.equal(sha(bytes), member.sha256);
  const range = chartRequest(member.url, symbol);
  const parsed = await parseDailyChart(symbol, range, bytes, member.receivedAt);
  const raw = JSON.parse(bytes.toString("utf8")).chart.result[0];
  assert.equal(raw.meta.currency, "JPY"); assert.equal(raw.meta.exchangeTimezoneName, "Asia/Tokyo");
  assert.equal(englishName(raw.meta.longName), englishName(identity.englishName), "価格原本の発行体英字商号が一致しません");
  const dates: string[] = raw.timestamp.map(jstDateSec);
  const indexes = dates.map((date: string, index: number) => date === args.fiscalYearEnd ? index : -1).filter((index: number) => index >= 0);
  if (indexes.length !== 1) return { status: "unavailable", identity, reason: "当期末当日の価格バーを一意に観測していません" };
  // 期末後のsplitがあれば原本quoteと当時株数の単位一致を主張しない。係数補完はしない。
  if (parsed.proof.firstTs === null || parsed.proof.lastTs === null ||
      jstDateSec(parsed.proof.firstTs) > args.fiscalYearEnd ||
      jstDateSec(parsed.proof.lastTs) < args.fiscalYearEnd ||
      parsed.splits.some(split => split.date > args.fiscalYearEnd)) {
    return { status: "unavailable", identity, reason: "当期末からcaptureまでの株数・価格単位の一致を確認できません" };
  }
  // raw closeを採用する。既存dailyの2桁丸め値やadjcloseで置き換えない。
  const price = raw.indicators.quote[0].close[indexes[0]];
  assert.ok(typeof price === "number" && Number.isFinite(price) && price > 0);
  const value = price * args.holding.shares;
  assert.ok(Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER);
  return { status: "qualified", identity, price, value, currency: "JPY", date: args.fiscalYearEnd,
    priceSource: { archivePageId: source.archivePageId, gzipSha256: source.sha256, bodySha256: member.sha256, filename: source.filename,
      symbol, capturedAt: member.receivedAt, sourceTimestamp: raw.timestamp[indexes[0]], range,
      priceBasis: "当期末raw quote.close × 当期末株数。adjclose/丸め/局所分割調整なし",
      splitObservation: "events=split,divを指定した同一応答で当期末後のsplit0。capture後の状態は未観測" } };
}
