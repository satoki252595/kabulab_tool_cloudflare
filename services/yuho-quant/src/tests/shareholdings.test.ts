import { beforeEach, describe, expect, it, vi } from "vitest";
import { unzip } from "../services/edinet/zip.js";
import { parseShareholdingsData } from "../services/edinet/shareholdings.js";

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
<p>特定投資株式<ix:nonNumeric name="jpcrp_cor:NestedTextBlock">構造<ix:nonNumeric name="jpcrp_cor:Nil" xsi:nil="true"/></ix:nonNumeric></p>${body}</ix:nonNumeric>`;
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
  it("提出者コード未確定は明示HOLDとし、他機能の原本取込まで例外で止めない", () => {
    const result = parseShareholdingsData(Buffer.alloc(0), { ...source, edinetCode: null });
    expect(result.status).toBe("unsupported");
    expect(result.reason).toBe("提出者EDINETコードが未確定です");
    expect(unzip).not.toHaveBeenCalled();
  });
});
