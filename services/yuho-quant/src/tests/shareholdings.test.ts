import { beforeEach, describe, expect, it, vi } from "vitest";
import { unzip } from "../services/edinet/zip.js";
import { parseShareholdingsData, verifySavedHoldingsSource } from "../services/edinet/shareholdings.js";

vi.mock("../services/edinet/zip.js", () => ({ unzip: vi.fn() }));
// S100Z2Z6の要素名・ヘッダ・rowspan構造。会社名/数値は選択検証用で原文ではない。
const source = { docId: "S100Z2Z6", stockCode: "9273", edinetCode: "E34071", fiscalYearEnd: "2026-06-30" };
const filename = "XBRL/PublicDoc/0104010_honbun_jpcrp030000-asr-001_E34071-000_2026-06-30_01_2026-09-18_ixbrl.htm";
const table = `<table>
<tr><td rowspan="3">銘柄</td><td>当事業年度</td><td>前事業年度</td></tr>
<tr><td>株式数（株）</td><td>株式数（株）</td></tr>
<tr><td>貸借対照表計上額（千円）</td><td>貸借対照表計上額（千円）</td></tr>
<tr><td rowspan="2">構造ケースA</td><td>12</td><td>99</td></tr>
<tr><td>345</td><td>888</td></tr>
<tr><td rowspan="2">構造ケースB</td><td>－</td><td>33</td></tr>
<tr><td>0</td><td>777</td></tr>
</table>`;
const block = (body = table, attrs = "") => `<ix:nonNumeric name="jpcrp_cor:ShareholdingsTextBlock" contextRef="FilingDateInstant" ${attrs}>
<p>提出会社における株式の保有状況</p><p>特定投資株式<ix:nonNumeric name="jpcrp_cor:NestedTextBlock">構造<ix:nonNumeric name="jpcrp_cor:Nil" xsi:nil="true"/></ix:nonNumeric></p><p>特定投資株式</p>${body}</ix:nonNumeric>`;
function parse(html: string) {
  vi.mocked(unzip).mockReturnValue(new Map([[filename, Buffer.from(html)]]));
  return parseShareholdingsData(Buffer.alloc(0), source);
}

describe("株式保有明細の原表資格", () => {
  beforeEach(() => vi.clearAllMocks());

  it("入れ子/自己閉じを含む原表から当期株数と帳簿価額だけを採り、価格や上場区分を作らない", () => {
    const result = parse(block());
    expect(result.status).toBe("ok");
    expect(result.holdings).toHaveLength(2);
    expect(result.holdings[0]).toMatchObject({ shares: 12, sharesUnit: "株", bookValueYen: 345000,
      bookValueUnit: "千円", listingStatus: "unknown", price: null, priceDate: null, priceCurrency: null });
    expect(result.holdings[1]).toMatchObject({ shares: null, bookValueYen: 0 });
  });

  it.each([
    table.replaceAll("当事業年度", "前事業年度"),
    table.replaceAll("株式数（株）", "株式数（単位不明）"),
    table.replaceAll("千円", "米ドル"),
    table.replace(">12<", ">1,23<"),
    table.replace('<td rowspan="2">構造ケースA</td>', "<td>構造ケースA</td>"),
    table.replaceAll("構造ケースB", "構造ケースA"),
  ])("期間/単位/数値/行対応が不明な表はHOLDし一部値も保存しない", (html) => {
    const result = parse(block(html));
    expect(result.status).toBe("unsupported");
    expect(result.reason).not.toBeNull();
    expect(result.holdings).toEqual([]);
  });

  it("平文化済み本文は明細表として読まず、継続ブロックや複数本文は未対応にする", () => {
    expect(parse("株式の保有状況 銘柄 株式数12貸借対照表計上額345").status).toBe("no_detail_table");
    expect(parse(block(table, 'continuedAt="next"')).status).toBe("unsupported");
    expect(parse(block() + block()).status).toBe("unsupported");
  });

  it("会計期末が違う原本を当期資料へ読み替えない", () => {
    vi.mocked(unzip).mockReturnValue(new Map([[filename, Buffer.from(block())]]));
    expect(parseShareholdingsData(Buffer.alloc(0), { ...source, fiscalYearEnd: "2025-06-30" }).status).toBe("unsupported");
    expect(() => parseShareholdingsData(Buffer.alloc(0), { ...source, fiscalYearEnd: "2026-02-30" })).toThrow();
  });
  it("提出会社区画だけを採り、別会社区画と曖昧区画をfilerへ結びつけない", () => {
    const parent = block();
    expect(parse(parent.replace("提出会社における株式の保有状況", "構造検証子会社における株式の保有状況"))).toMatchObject({ status: "no_detail_table", holdings: [], holderScope: "unqualified" });
    expect(parse(parent.replace("提出会社における株式の保有状況", "保有方針"))).toMatchObject({ status: "unsupported", holdings: [] });
    const mixed = parent;
    const appendix = `<p>連結子会社における株式の保有状況</p><p>特定投資株式</p>${table}`;
    const end = mixed.lastIndexOf("</ix:nonNumeric>");
    expect(parse(mixed.slice(0,end)+appendix+mixed.slice(end))).toMatchObject({ status: "ok", holderScope: "filer_only" });
    expect(parse(mixed.slice(0,end)+appendix+mixed.slice(end)).holdings).toHaveLength(2);
    expect(parse(parent.replace("提出会社における株式の保有状況", "当社は、保有目的が純投資目的である投資株式を区分しております。"))).toMatchObject({ status: "ok", holderScope: "filer_only" });
    expect(parse(mixed.slice(0,end)+`<p>当社における株式の保有状況</p>${table}`+mixed.slice(end))).toMatchObject({ status: "unsupported", holdings: [] });
  });
  it("S100Z2Z6と同じ当社説明→名義別区画をfiler明細へ採用しない（原文はprivate保存）", () => {
    const body = block().replace("提出会社における株式の保有状況", "当社は、投資株式について説明します。構造検証子会社における株式の保有状況");
    expect(parse(body)).toMatchObject({ status: "no_detail_table", holdings: [], holderScope: "unqualified" });
    expect(parse(body.replace("<p>特定投資株式</p>", "<p>当社が保有する株式についての説明</p><p>特定投資株式</p>"))).toMatchObject({ status: "no_detail_table", holdings: [] });
  });
  it("保存S100YHJV/S100YH29の会社名後空白を区画境界として扱い、当社説明を継承しない", () => {
    // Actual saved headings; table names/numbers remain structural test values.
    for (const heading of ["株式会社リョーサン における株式の保有状況", "アルフレッサ株式会社\nにおける株式の保有状況"]) {
      const body = block().replace("提出会社における株式の保有状況", `当社は、投資株式について説明します。${heading}`);
      expect(parse(body)).toMatchObject({ status: "no_detail_table", holdings: [], holderScope: "unqualified" });
    }
    const parent = block(), end = parent.lastIndexOf("</ix:nonNumeric>");
    const child = table.replaceAll("構造ケースA", "別名義構造ケースC").replaceAll("構造ケースB", "別名義構造ケースD");
    const mixed = parent.slice(0, end) + `<p>株式会社リョーサン における株式の保有状況</p><p>当社が保有する株式の説明</p><p>特定投資株式</p>${child}` + parent.slice(end);
    expect(parse(mixed).holdings).toHaveLength(2);
  });
  it("保存S100YB9Pの明示次位保有会社区画を除き、主体不明の次位区画は全体HOLD", () => {
    const parent = block(), end = parent.lastIndexOf("</ix:nonNumeric>");
    const child = table.replaceAll("構造ケースA", "別名義構造ケースC").replaceAll("構造ケースB", "別名義構造ケースD");
    const heading = "（最大保有会社の次に大きい会社） 当社及び連結子会社のうち、当連結会計年度における投資株式計上額が最大保有会社の次に大きい会社は 大陽日酸株式会社";
    const mixed = (label: string) => parent.slice(0, end) + `<p>${label}</p><p>当社が保有する株式の説明</p><p>特定投資株式</p>${child}` + parent.slice(end);
    expect(parse(mixed(heading)).holdings).toHaveLength(2);
    expect(parse(mixed("（最大保有会社の次に大きい会社）"))).toMatchObject({ status: "unsupported", holdings: [], holderScope: "unqualified" });
  });
  it("同名でも特定投資とみなしは別明細とし、同種別の重複はHOLD", () => {
    const body=block(),end=body.lastIndexOf("</ix:nonNumeric>");
    const split=body.slice(0,end)+`<p>みなし保有株式</p>${table}`+body.slice(end);
    expect(parse(split).status).toBe("ok");expect(parse(split).holdings.map(row=>row.kind)).toEqual(["特定投資株式","特定投資株式","みなし保有株式","みなし保有株式"]);
    expect(parse(split.replace("<p>みなし保有株式</p>","<p>特定投資株式</p>")).status).toBe("unsupported");
  });
  it("保存S100YD42の限定みなし見出しだけを許し、別種別や未知の括弧を継承しない", () => {
    const parent = block(), end = parent.lastIndexOf("</ix:nonNumeric>");
    const mixed = (heading: string) => parent.slice(0, end) + `<p>${heading}</p>${table}` + parent.slice(end);
    const annotation = "（信託財産として保有し議決権行使権限のあるもの等）";
    const result = parse(mixed(`みなし保有株式${annotation}`));
    expect(result.status).toBe("ok");
    expect(result.holdings.map(row => row.kind)).toEqual(["特定投資株式", "特定投資株式", "みなし保有株式", "みなし保有株式"]);
    for (const heading of [`特定投資株式${annotation}`, "みなし保有株式（未確認）", "みなし保有株式（信託（未確認））", "みなし保有株式（"]) {
      expect(parse(mixed(heading))).toMatchObject({ status: "unsupported", holdings: [], holderScope: "unqualified" });
    }
  });
  it("実表で明示された上下段セル単位・4段単位行・限定注記だけを数値を変えず読む", () => {
    const upper=table.replaceAll("株式数（株）","株式数（上段）").replaceAll("貸借対照表計上額（千円）","貸借対照表計上額（下段）")
      .replace(">12<",">12株<").replace(">99<",">99株<").replace(">－<",">－株<").replace(">33<",">33株<")
      .replace(">345<",">345千円<").replace(">888<",">888千円<").replace(">0<",">0千円<").replace(">777<",">777千円<");
    expect(parse(block(upper)).holdings[0]).toMatchObject({ shares:12,sharesRaw:12,sharesUnit:"株",bookValueRaw:345,bookValueYen:345000,bookValueUnit:"千円" });
    const fourth=table.replace('rowspan="3"','rowspan="4"').replaceAll("貸借対照表計上額（千円）","貸借対照表計上額").replace('<tr><td rowspan="2">構造ケースA', '<tr><td>（千円）</td><td>（千円）</td></tr><tr><td rowspan="2">構造ケースA');
    expect(parse(block(fourth)).holdings[0]).toMatchObject({ shares:12,bookValueYen:345000,rowIndex:4 });
    expect(parse(block(table.replace(">12<",">（注１） 12<"))).holdings[0]).toMatchObject({ shares:12,sharesRaw:12 });
    expect(parse(block(table.replace(">12<",">（注２） 12<"))).holdings[0]).toMatchObject({ shares:12,sharesRaw:12 });
    for (const value of ["（注３） 12", "（注１）", "12（注）"]) expect(parse(block(table.replace(">12<",`>${value}<`))).status).toBe("unsupported");
    expect(parse(block(upper.replace(">99株<",">99千株<"))).status).toBe("unsupported");
  });
  it("提出者コード未確定は明示HOLDとし、他機能の原本取込まで例外で止めない", () => {
    const result = parseShareholdingsData(Buffer.alloc(0), { ...source, edinetCode: null });
    expect(result.status).toBe("unsupported");
    expect(result.reason).toBe("提出者EDINETコードが未確定です");
    expect(unzip).not.toHaveBeenCalled();
  });
});


describe("保存type1のDEI識別", () => {
  const member = "XBRL/PublicDoc/jpcrp030000-asr-001_E34071-000_2026-06-30_01_2026-09-18.xbrl";
  const xml = `<xbrli:xbrl xmlns:dei="http://disclosure.edinet-fsa.go.jp/taxonomy/jpdei/2013-08-31/jpdei_cor">
    <dei:EDINETCodeDEI contextRef="FilingDateInstant">E34071</dei:EDINETCodeDEI>
    <dei:SecurityCodeDEI contextRef="FilingDateInstant">92730</dei:SecurityCodeDEI>
    <dei:CurrentFiscalYearEndDateDEI contextRef="FilingDateInstant">2026-06-30</dei:CurrentFiscalYearEndDateDEI></xbrli:xbrl>`;
  const check = (body: string, name = member) => { vi.mocked(unzip).mockReturnValue(new Map([[name, Buffer.from(body)]])); return verifySavedHoldingsSource(Buffer.alloc(0), source); };
  it("公式namespaceの単一DEIを提出者・証券コード・期末へ照合する", () => {
    expect(check(xml)).toEqual({ status: "verified", filename: member });
    expect(unzip).toHaveBeenLastCalledWith(Buffer.alloc(0), { maxEntries: 5000, maxExpandedBytes: 64 * 1024 * 1024 });
  });
  it.each([xml.replace("E34071</", "E00000</"), xml.replace("2026-06-30</", "2025-06-30</"), xml.replaceAll("FilingDateInstant", "PriorYearInstant"),
    xml.replace("<dei:EDINETCodeDEI", '<dei:EDINETCodeDEI xmlns:dei="http://untrusted.invalid"')])("値/context/namespace再束縛の不一致は停止する", body => { expect(() => check(body)).toThrow(); });
  it("DEI欠測・重複・未知namespace・CSVは資格未成立とする", () => {
    for (const body of [xml.replace(/<dei:SecurityCodeDEI[^>]*>[^<]*<\/dei:SecurityCodeDEI>/, ""), xml.replace("</xbrli:xbrl>", '<dei:EDINETCodeDEI contextRef="FilingDateInstant">E34071</dei:EDINETCodeDEI></xbrli:xbrl>'), xml.replace("http://disclosure.edinet-fsa.go.jp", "http://untrusted.invalid")]) expect(check(body).status).toBe("held");
    expect(check(xml, "XBRL_TO_CSV/flattened.csv").status).toBe("held");
    expect(check(xml.replace("92730</", "00000</"))).toMatchObject({ status: "held", reason: expect.stringContaining("未割当00000") });
    expect(() => check(xml.replace("92730</", "00005</"))).toThrow();
    expect(() => check(xml.replace("92730</", "00000</").replace("2026-06-30</", "2025-06-30</"))).toThrow();
    vi.mocked(unzip).mockReturnValue(new Map([[member, Buffer.from(xml)], [member.replace("001_", "002_"), Buffer.from(xml)]]));
    expect(verifySavedHoldingsSource(Buffer.alloc(0), source).status).toBe("held");
  });
});
