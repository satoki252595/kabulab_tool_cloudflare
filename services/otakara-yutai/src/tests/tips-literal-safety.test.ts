/**
 * TIPS 文言の構文安全性テスト。
 *
 * app.ts の screeningJS はサーバ側 template literal で、tip() の出力 (HTML) を
 * クライアント JS の**シングルクォート文字列内**に埋め込む。TIPS の値に
 * シングルクォート / バックスラッシュ / `</script` / `${` が入ると、生成された
 * /screening ページの JS が構文破壊される (型でも lint でも検出されない)。
 * 将来の文言追加での再発をここで恒久的に防ぐ。
 */
import { describe, expect, it } from "vitest";
import { TIPS } from "../../app.js";

describe("TIPS literal safety (screeningJS 埋め込み制約)", () => {
  it("全文言にシングル/ダブルクォート / バックスラッシュ / </script / ${ を含まない", () => {
    for (const [key, text] of Object.entries(TIPS)) {
      expect(text, `TIPS.${key} にシングルクォートが含まれています`).not.toMatch(/'/);
      // tip() が aria-label="..." (ダブルクォート属性) に全文を埋め込むため
      expect(text, `TIPS.${key} にダブルクォートが含まれています`).not.toMatch(/"/);
      expect(text, `TIPS.${key} にバックスラッシュが含まれています`).not.toMatch(/\\/);
      expect(text, `TIPS.${key} に </script が含まれています`).not.toMatch(/<\/script/i);
      expect(text, `TIPS.${key} に \${ が含まれています`).not.toMatch(/\$\{/);
    }
  });

  it("全文言が非空 (ルール2: 空バルーンを silent に出さない)", () => {
    for (const [key, text] of Object.entries(TIPS)) {
      expect(text.trim().length, `TIPS.${key} が空です`).toBeGreaterThan(0);
    }
  });
});
