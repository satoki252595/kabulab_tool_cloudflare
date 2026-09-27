import { describe, expect, it } from "vitest";
import { extractPdfText } from "./pdf-text.js";

/** テスト入力用の最小 PDF (1 ページ・Helvetica で 1 行) をその場で組み立てる。 */
function tinyPdf(text: string): Uint8Array {
  const content = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe("extractPdfText", () => {
  it("テキストを抽出し、渡したバイト列を detach しない (一次データとして保管できるまま)", async () => {
    const bytes = tinyPdf("moneyflow detach check");
    const before = bytes.byteLength;
    const text = await extractPdfText(bytes);
    expect(text).toContain("moneyflow detach check");
    // unpdf に直接渡すと 0 になる (pdf-text.ts 冒頭参照)。コピーを渡しているので不変
    expect(bytes.byteLength).toBe(before);
    expect(before).toBeGreaterThan(0);
  });
});
