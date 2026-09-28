/**
 * 監査レポート生成・検査の回帰テスト (Issue #151)。
 *
 * 実 manifest・実レポートを用いる統合検査が中心。生成文の逐語比較ではなく
 * 検査規則の意味 (合計一致・隔離/保留分離・SHA全文・日付・byte一致・参照解決)
 * を正常受理＋変異却下で固定する。network・env 不要。
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  beginMarker,
  checkFiles,
  endMarker,
  parseManifest,
  renderBlock,
  validateManifest,
  type Manifest,
} from "./render-data-audit.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const MANIFEST_REL = "docs/test-logs/data-audit-2026-09-28.results.json";

function loadRealManifest(): Manifest {
  return parseManifest(JSON.parse(readFileSync(join(ROOT, MANIFEST_REL), "utf8")) as unknown);
}

function aggregateOf(manifest: Manifest, section: "fundamentals" | "moneyflow", id: string) {
  const agg = manifest.sections[section].aggregates.find((a) => a.id === id);
  if (agg === undefined) throw new Error(`missing aggregate ${id}`);
  return agg;
}

/** 実 manifest＋実レポートを保全した temp root を作る。 */
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-report-"));
  mkdirSync(join(dir, "docs", "test-logs"), { recursive: true });
  writeFileSync(join(dir, MANIFEST_REL), readFileSync(join(ROOT, MANIFEST_REL)));
  const manifest = loadRealManifest();
  for (const section of Object.values(manifest.sections)) {
    if (section === undefined) continue;
    writeFileSync(join(dir, section.report), readFileSync(join(ROOT, section.report)));
  }
  return dir;
}

describe("audit-report", () => {
  it("実 manifest が形状＋意味検査を通る", () => {
    expect(validateManifest(loadRealManifest())).toEqual([]);
  });

  it("実レポートがブロック検査（byte一致＋参照解決）を通る", () => {
    expect(checkFiles(loadRealManifest(), ROOT)).toEqual([]);
  });

  it("実数値の意味を固定する（転記ミスの再発防止）", () => {
    const manifest = loadRealManifest();
    // F4: 純抽選14＋境界1＋併記23＝38（13/14取違え・38/37合計誤りを防ぐ）
    const lottery = aggregateOf(manifest, "fundamentals", "F4-lottery");
    expect(lottery.total).toBe(38);
    expect(lottery.parts.map((p) => p.n)).toEqual([14, 1, 23]);
    expect(lottery.source).toBe("evidence-reviewed");
    // F3: frozen25＋fresh7＝32
    const yld = aggregateOf(manifest, "fundamentals", "F3-yield");
    expect(yld.total).toBe(32);
    expect(yld.parts.map((p) => p.n)).toEqual([25, 7]);
    // F2: 原因確定1＋未確認58＝59（1原本からの一般化を許さない）
    const cause = aggregateOf(manifest, "fundamentals", "F2-cause");
    expect(cause.total).toBe(59);
    expect(cause.parts.map((p) => p.n)).toEqual([1, 58]);
    // C: 25specの内訳合計が5121（5633誤記を防ぐ）
    const rows = aggregateOf(manifest, "moneyflow", "MF-rows-total");
    expect(rows.parts).toHaveLength(25);
    expect(rows.parts.reduce((acc, p) => acc + p.n, 0)).toBe(5121);
    // 全証拠のSHAは全文64桁か未記録（省略形なし）
    for (const section of Object.values(manifest.sections)) {
      if (section === undefined) continue;
      for (const ev of section.evidence) {
        expect(ev.sha256 === null || /^[0-9a-f]{64}$/.test(ev.sha256)).toBe(true);
      }
      // 隔離候補と保留は重ならない
      const holds = new Set(section.quarantines.holds.map((h) => h.id));
      for (const cand of section.quarantines.candidates) {
        expect(holds.has(cand.id)).toBe(false);
      }
    }
    // 確定営業日と保存最新の区別（9/28と9/25の混同を防ぐ）
    expect(manifest.sections.moneyflow.businessDay).toBe("2026-09-28");
    expect(manifest.sections.moneyflow.savedLatest).toBe("2026-09-25");
  });

  it("合計と内訳の不一致を却下する", () => {
    const manifest = loadRealManifest();
    aggregateOf(manifest, "fundamentals", "F4-lottery").total = 37;
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.startsWith("E_TOTAL") && e.includes("F4-lottery"))).toBe(true);
  });

  it("保留項目の隔離候補化を却下する（2180-RSI形）", () => {
    // B所掌の実例（2180 rsi_percentile の保留）は market section が PR149 merge 後に
    // 持つ。ここでは規則自体を合成入力で固定する。
    const manifest = loadRealManifest();
    manifest.sections.fundamentals.quarantines.holds.push({
      id: "2180-rsi-percentile",
      reason: "破損由来が未証明のため隔離保留",
    });
    manifest.sections.fundamentals.quarantines.candidates.push({
      id: "2180-rsi-percentile",
      scope: "2180 の rsi_percentile 行",
      tables: ["rsi_percentile"],
    });
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.startsWith("E_QUARANTINE"))).toBe(true);
  });

  it("SHA省略形を却下する", () => {
    const manifest = loadRealManifest();
    manifest.sections.fundamentals.evidence[0].sha256 = "3be26f4de954364e";
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.startsWith("E_SHA"))).toBe(true);
  });

  it("不一致カバレッジの verified 偽装を却下する", () => {
    const manifest = loadRealManifest();
    const cov = manifest.sections.moneyflow.coverages.find((c) => c.id === "MF-imf-official");
    if (cov === undefined) throw new Error("missing MF-imf-official");
    cov.state = "verified";
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.startsWith("E_STATE"))).toBe(true);
  });

  it("snapshot未来の確定時刻を却下する", () => {
    const manifest = loadRealManifest();
    const ev = manifest.sections.fundamentals.evidence[0];
    ev.timeState = "exact";
    ev.exactTime = "2026-09-29T10:00:00Z";
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.startsWith("E_DATE"))).toBe(true);
  });

  it("mtime-only証拠への確定時刻付与を却下する", () => {
    const manifest = loadRealManifest();
    manifest.sections.fundamentals.evidence[0].exactTime = "2026-09-28T10:00:00Z";
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.startsWith("E_SHA_STATE"))).toBe(true);
  });

  it("生成は決定的で合計は内訳から計算される", () => {
    const manifest = loadRealManifest();
    const first = renderBlock(manifest, "fundamentals");
    const second = renderBlock(manifest, "fundamentals");
    expect(second).toBe(first);
    // 38は内訳14＋1＋23から計算された表示（手入力totalの転写ではない）
    expect(first).toContain("純抽選14＋境界1＋適正併記23 | 38 |");
    // 時刻・乱数を含まない（2回生成の同一byteを構造で保証）
    expect(/\d{2}:\d{2}:\d{2}/.test(first)).toBe(false);
  });

  it("生成ブロックの手編集を検出する", () => {
    const dir = tempRoot();
    const reportRel = loadRealManifest().sections.fundamentals.report;
    const reportPath = join(dir, reportRel);
    const text = readFileSync(reportPath, "utf8");
    const begin = beginMarker("fundamentals");
    const pos = text.indexOf(begin);
    if (pos === -1) throw new Error("block not found");
    const tampered = `${text.slice(0, pos + begin.length + 10)}X${text.slice(pos + begin.length + 10)}`;
    writeFileSync(reportPath, tampered);
    const manifest = parseManifest(
      JSON.parse(readFileSync(join(dir, MANIFEST_REL), "utf8")) as unknown,
    );
    expect(checkFiles(manifest, dir).some((e) => e.startsWith("E_BLOCK"))).toBe(true);
  });

  it("生成ブロックの欠落を検出する", () => {
    const dir = tempRoot();
    const reportRel = loadRealManifest().sections.moneyflow.report;
    const reportPath = join(dir, reportRel);
    const text = readFileSync(reportPath, "utf8");
    const begin = beginMarker("moneyflow");
    const end = endMarker("moneyflow");
    const stripped = text.slice(0, text.indexOf(begin)) + text.slice(text.indexOf(end) + end.length);
    writeFileSync(reportPath, stripped);
    const manifest = parseManifest(
      JSON.parse(readFileSync(join(dir, MANIFEST_REL), "utf8")) as unknown,
    );
    expect(checkFiles(manifest, dir).some((e) => e.startsWith("E_BLOCK"))).toBe(true);
  });

  it("未解決の集計ID参照を検出する", () => {
    const dir = tempRoot();
    const reportRel = loadRealManifest().sections.fundamentals.report;
    const reportPath = join(dir, reportRel);
    writeFileSync(reportPath, `${readFileSync(reportPath, "utf8")}\n集計ID:DOES-NOT-EXIST\n`);
    const manifest = parseManifest(
      JSON.parse(readFileSync(join(dir, MANIFEST_REL), "utf8")) as unknown,
    );
    expect(checkFiles(manifest, dir).some((e) => e.startsWith("E_REF"))).toBe(true);
  });
});
