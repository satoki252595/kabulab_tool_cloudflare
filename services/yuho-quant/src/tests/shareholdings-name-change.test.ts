/** 実2502の全文注2/3。CIの断片文法投影とprivate保存ZIPの原本回帰は分ける。 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { observeHoldingNameChanges } from "../services/edinet/shareholdings-name-change.js";
import { parseShareholdingsData } from "../services/edinet/shareholdings.js";
import { parseHoldingsCodeList, qualifyHoldingValuation, resolveHoldingPriceIdentity } from "../services/edinet/shareholdings-valuation.js";
import { readFilingDateInstant, readReportedFilingInstant } from "../services/edinet/duration-context.js";
import { unzip } from "../services/edinet/zip.js";
const source = { docId: "S100YVTZ", stockCode: "2502", edinetCode: "E00394", fiscalYearEnd: "2025-12-31" };
const statement2 = "２　サッポロホールディングス㈱は2026年７月１日付でサッポロビール㈱に商号変更しております。";
const statement3 = "３　サントリー食品インターナショナル㈱は2026年４月１日付でサントリービバレッジ＆フード㈱に商号変更しております。";
const holdings = [{ name: "サッポロホールディングス㈱ （注）２" }, { name: "サントリー食品インターナショナル㈱ （注）３" }];
const filename = "XBRL/PublicDoc/0104010_honbun_jpcrp030000-asr-001_E00394-000_2025-12-31_02_2026-08-12_ixbrl.htm";
const fragment = (text: string) => `<p>${text}</p>`;
function projected(blockHtml = fragment(statement2) + fragment(statement3)) {
  // Grammar-only transport projection; these fragment bytes are not an actual ZIP/member custody proof.
  return { source, filename, zip: Buffer.from(blockHtml), member: Buffer.from(blockHtml), blockHtml,
    context: { contextRef: "FilingDateInstant", entity: "E00394-000", instantDate: "2026-07-27", clockKind: "reported_context" as const, sourceFilenameDate: "2026-08-12" }, holdings };
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
describe("原表の注に明記された実施済み商号変更", () => {
  it("同じ節の注番号・旧名・完全形だけを診断へ残し、holding値を変えない", () => {
    const input = projected(), before = structuredClone(input.holdings), result = observeHoldingNameChanges(input);
    expect(result.map(value => [value.noteNumber, value.oldName, value.newName, value.effectiveDate])).toEqual([
      [2, "サッポロホールディングス(株)", "サッポロビール(株)", "2026-07-01"],
      [3, "サントリー食品インターナショナル(株)", "サントリービバレッジ&フード(株)", "2026-04-01"],
    ]);
    expect(result[0].statement).toBe(statement2.replace(/\s/g," ")); expect(result[0].blockHtmlSha256).toBe(hash(Buffer.from(input.blockHtml)));
    expect(input.holdings).toEqual(before);
  });
  it.each([
    statement2.replace("商号変更しております。", "商号変更する予定です。"),
    statement2.replace("商号変更しております。", "合併しております。"),
    statement2.replace("２", "３"), statement2.replace("2026年７月１日", "2026年９月１日"),
    statement2.replace("2026年７月１日", "2026年２月30日"),
    statement2.replace("サッポロホールディングス㈱は", "サッポロビール㈱は"),
    statement2 + "事業譲渡を伴います。",
  ])("予定・未来・不正日付・別主体・不完全な原文は採らない: %s", text => {
    expect(observeHoldingNameChanges(projected(fragment(text)))).toEqual([]);
  });
  it("同じ注の重複・相反する追記は、一方だけを選ばない", () => {
    expect(observeHoldingNameChanges(projected(fragment(statement2) + fragment(statement2)))).toEqual([]);
    expect(observeHoldingNameChanges(projected(fragment(statement2) + fragment(statement2.replace("変更しております。", "変更する予定です。"))))).toEqual([]);
  });
  it("loaderと評価の共通同定は同じFYの一意な注だけを使い、直接一致を置き換えない", () => {
    const changes = observeHoldingNameChanges(projected()), catalog = { asOf: "2026-10-13", byLegalName: new Map() };
    expect(resolveHoldingPriceIdentity(holdings[0], catalog, source.fiscalYearEnd, changes).nameChange).toBe(changes[0]);
    for (const [fy, notes, asOf] of [[undefined, changes, catalog.asOf], ["2024-12-31", changes, catalog.asOf],
      [source.fiscalYearEnd, [changes[0], changes[0]], catalog.asOf], [source.fiscalYearEnd, changes, "2026-06-30"]] as const) {
      expect(resolveHoldingPriceIdentity(holdings[0], { ...catalog, asOf }, fy, notes).nameChange).toBeUndefined();
    }
    const direct = new Map([[holdings[0].name.normalize("NFKC").replace(/\s/g, "").replaceAll("(株)", "株式会社"), []]]);
    expect(resolveHoldingPriceIdentity(holdings[0], { ...catalog, byLegalName: direct }, source.fiscalYearEnd, changes))
      .toEqual({ candidates: [], nameChange: undefined }); // 直接候補が曖昧でも注で別名へ逃がさない。
  });
  const privatePath = new URL("../../../../tmp/feature-audit-20261018/holdings-rights-needed-current-v1/price-first-source-preflight-v1/source.zip", import.meta.url);
  it.skipIf(!existsSync(privatePath))("実保存ZIPの2注とcurrent FSA新名を照合し、全holding factsを不変に保つ", async () => {
    const zip = readFileSync(privatePath); expect(hash(zip)).toBe("75d3250aeaca6c169674ba709c8ffc62539bdfbeab5ac55a9f0d209cc5150859");
    const parsed = parseShareholdingsData(zip, source); expect(parsed.status).toBe("ok"); expect(parsed.nameChanges).toHaveLength(2);
    expect(parsed.nameChanges![0].context).toEqual({contextRef:"FilingDateInstant",entity:"E00394-000",instantDate:"2026-07-27",clockKind:"reported_context",sourceFilenameDate:"2026-08-12"});
    const entries = unzip(zip); expect(readFilingDateInstant(entries, filename, source.fiscalYearEnd)).toBeNull();
    expect(readReportedFilingInstant(entries, filename, source.fiscalYearEnd)).toEqual(parsed.nameChanges![0].context);
    const header = [...entries.keys()].find(name => /\/\d+_header_/.test(name) && name.endsWith("_2026-08-12_ixbrl.htm"))!;
    const oldHeader=entries.get(header)!.toString(), changedHeader=oldHeader.replace(/(<xbrli:context id="FilingDateInstant">[\s\S]*?<xbrli:instant>)2026-07-27(<\/xbrli:instant>)/,
      (_,prefix,suffix)=>`${prefix}2026-07-28${suffix}`);
    expect(changedHeader).not.toBe(oldHeader); entries.set(header,Buffer.from(changedHeader));
    expect(readReportedFilingInstant(entries, filename, source.fiscalYearEnd)).toBeNull(); // 同じ原本内の相反するcontextは採らない。
    const codeBytes = readFileSync(new URL("./codes.private.bin", privatePath));
    expect(hash(codeBytes)).toBe("f65840ce54b4817583d02669cfbba8cbabf66d2225400a6ec0ee890450b86b0b");
    const catalog = parseHoldingsCodeList({ archivePageId: "3f8d74ff-84cd-8188-9724-c64cf81e15e8", filename: "Edinetcode.zip", bytes: codeBytes, sha256: hash(codeBytes) });
    for (const [name, code] of [[holdings[0].name, "2501"], [holdings[1].name, "2587"]]) {
      const holding = parsed.holdings.find(row => row.name === name)!;
      expect((await qualifyHoldingValuation({ holding, fiscalYearEnd: source.fiscalYearEnd, catalog, prices: [] })).identity).toBeNull();
      const after = await qualifyHoldingValuation({ holding, fiscalYearEnd: source.fiscalYearEnd, catalog, prices: [], nameChanges: parsed.nameChanges });
      if (code === "2501") expect(after).toMatchObject({ status: "unavailable", identity: { code }, reason: "該当symbolの保存日足原本がありません" });
      else expect(after).toMatchObject({ status: "unavailable", identity: null, reason: "原表に商号変更の注はありますが、新商号の上場主体・英字名を公式銘柄表で一意に確認できません" }); // 実FSAの英字名空欄は翻訳しない。
    }
    expect(parsed.holdings.every(row => row.price === null)).toBe(true);
  });
});
