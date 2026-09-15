/**
 * `public/` の置き場ガード (X-07)。
 *
 * ライセンス系テスト (core-stocks-license-boundary / public-summary-safety) は
 * `src/` と `services/` しか走査しない。`public/` は Worker の [assets] で
 * 無認証配信されるため、ここに置いたファイルは公開面そのものになる。
 * 規則: **`public/` に D1 由来の生成物以外を置かない**。
 *
 * 機械的に見る 2 つ:
 *   1. `public/` 配下のファイル集合が下の許可リストと一致すること。
 *      新しいファイルを足すときはライセンスを確認してからリストへ追加する。
 *   2. `data/stocks.json` が `[code, name, label]` の 3 要素のままであること。
 *      列 (要素) を足すと、市場区分・業種・掲載文などの personal-only が
 *      無認証配信に混ざる。U3 の判断までは触らない (L-42 G3)。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");

/** `public/` に置いてよいファイル (相対パス)。足すときはライセンスを確認すること。 */
const PUBLIC_DIR_ALLOWLIST = new Set([
  "_headers",
  "otakara-yutai/icon-192.png",
  "otakara-yutai/icon-512.png",
  "otakara-yutai/manifest.json",
  "otakara-yutai/sw.js",
  "vwap-analysis/app.js",
  "vwap-analysis/config.json",
  "vwap-analysis/index.html",
  "vwap-analysis/style.css",
  "vwap-analysis/data/stocks.json",
  "vwap-analysis/vendor/lightweight-charts.standalone.production.js",
]);

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...listFiles(abs));
    } else {
      out.push(relative(PUBLIC_DIR, abs));
    }
  }
  return out.sort();
}

describe("public/ の置き場ガード (X-07)", () => {
  it("許可リスト外のファイルが無い", () => {
    const extra = listFiles(PUBLIC_DIR).filter((f) => !PUBLIC_DIR_ALLOWLIST.has(f));
    expect(extra, "public/ に許可リスト外のファイルがある。ライセンスを確認してリストへ追加すること").toEqual([]);
  });

  it("許可リストのファイルが消えていない", () => {
    const present = new Set(listFiles(PUBLIC_DIR));
    const missing = [...PUBLIC_DIR_ALLOWLIST].filter((f) => !present.has(f));
    expect(missing).toEqual([]);
  });

  it("stocks.json が [code, name, label] の 3 要素のまま", () => {
    const raw = JSON.parse(
      readFileSync(join(PUBLIC_DIR, "vwap-analysis/data/stocks.json"), "utf-8")
    ) as { count: number; stocks: unknown[] };
    expect(raw.stocks.length).toBeGreaterThan(0);
    expect(raw.count).toBe(raw.stocks.length);
    for (const entry of raw.stocks) {
      expect(Array.isArray(entry)).toBe(true);
      expect((entry as unknown[]).length).toBe(3);
      const [code, name, label] = entry as unknown[];
      expect(typeof code).toBe("string");
      expect((code as string).length).toBeGreaterThanOrEqual(4);
      expect(typeof name).toBe("string");
      expect((name as string).length).toBeGreaterThan(0);
      expect(typeof label).toBe("string");
    }
  });
});
