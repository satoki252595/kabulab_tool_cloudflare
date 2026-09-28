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
  renderFindingHeading,
  renderFindingsSummary,
  renderFreshness,
  renderMoneyflowTotals,
  renderPriorityHeading,
  renderPrioritySummary,
  renderPubRoutes,
  runWrite,
  validateManifest,
  type Manifest,
} from "./render-data-audit.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const MANIFEST_REL = "docs/test-logs/data-audit-2026-09-28.results.json";

function loadRealManifest(): Manifest {
  return parseManifest(JSON.parse(readFileSync(join(ROOT, MANIFEST_REL), "utf8")) as unknown);
}

function aggregateOf(manifest: Manifest, section: "fundamentals" | "moneyflow" | "market", id: string) {
  const agg = manifest.sections[section].aggregates.find((a) => a.id === id);
  if (agg === undefined) throw new Error(`missing aggregate ${id}`);
  return agg;
}

function manifestOf(dir: string): Manifest {
  return parseManifest(JSON.parse(readFileSync(join(dir, MANIFEST_REL), "utf8")) as unknown);
}

/** 指定ブロック内だけを書き換える（ブロック外の同文言に触れない）。 */
function tamperBlock(dir: string, reportRel: string, blockId: string, from: string, to: string): void {
  const reportPath = join(dir, reportRel);
  const text = readFileSync(reportPath, "utf8");
  const begin = beginMarker(blockId);
  const end = endMarker(blockId);
  const s = text.indexOf(begin);
  if (s === -1) throw new Error(`block not found: ${blockId}`);
  const e = text.indexOf(end, s);
  if (e === -1) throw new Error(`end not found: ${blockId}`);
  const block = text.slice(s, e);
  if (!block.includes(from)) throw new Error(`text not found in ${blockId}: ${from}`);
  writeFileSync(reportPath, text.slice(0, s) + block.replace(from, to) + text.slice(e));
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
    // B: F02は日別内訳（1678/3・33/1・32/0）とunique（65/66）を区別する
    expect(aggregateOf(manifest, "market", "F02-vol").parts.map((p) => p.n)).toEqual([1678, 3]);
    expect(aggregateOf(manifest, "market", "F02-fresh-unique").total).toBe(65);
    expect(aggregateOf(manifest, "market", "F02-all-unique").total).toBe(66);
    // B: 公開routeは38=23+9+6（23値join≠23正常はnoteで明示）
    expect(aggregateOf(manifest, "market", "PUB-routes").parts.map((p) => p.n)).toEqual([23, 9, 6]);
    // B: 隔離は1909×3表・2180×2表、2180×RSIは保留
    const bq = manifest.sections.market.quarantines;
    expect(bq.candidates).toHaveLength(5);
    expect(bq.holds).toHaveLength(1);
    expect([bq.holds[0].stock, bq.holds[0].table]).toEqual(["2180", "rsi_percentile"]);
    // 全証拠のSHAは全文64桁か未記録（省略形なし）
    for (const section of Object.values(manifest.sections)) {
      if (section === undefined) continue;
      for (const ev of section.evidence) {
        expect(ev.sha256 === null || /^[0-9a-f]{64}$/.test(ev.sha256)).toBe(true);
      }
      // 隔離候補と保留は銘柄×表キーで重ならない
      const holds = new Set(
        section.quarantines.holds.map((h) => JSON.stringify([h.stock, h.table])),
      );
      for (const cand of section.quarantines.candidates) {
        expect(holds.has(JSON.stringify([cand.stock, cand.table]))).toBe(false);
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

  it("保留ペアの別名候補化を却下する（2180×RSIの実形）", () => {
    // 保留中の 2180×rsi_percentile を別idで候補へ混ぜる誤変更。id 一致ではなく
    // 銘柄×表キーで照合するため別名でも拒否する。
    const manifest = loadRealManifest();
    manifest.sections.market.quarantines.candidates.push({
      id: "Q-2180-rsi-alt",
      stock: "2180",
      table: "rsi_percentile",
      evidence: "誤った追加",
    });
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.startsWith("E_QUARANTINE") && e.includes("2180"))).toBe(true);
  });

  it("隔離候補の銘柄×表の重複登録を却下する", () => {
    const manifest = loadRealManifest();
    manifest.sections.market.quarantines.candidates.push({
      id: "Q-1909-rsi-dup",
      stock: "1909",
      table: "rsi_percentile",
      evidence: "誤った重複",
    });
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.startsWith("E_QUARANTINE") && e.includes("1909"))).toBe(true);
  });

  it("market section の欠落を却下する", () => {
    const raw = JSON.parse(readFileSync(join(ROOT, MANIFEST_REL), "utf8")) as {
      sections: Record<string, unknown>;
    };
    delete raw.sections.market;
    expect(() => parseManifest(raw)).toThrow(/E_SCHEMA/);
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
    expect(first).toContain("純抽選（spec違反）14＋境界（7791・断定不可）1＋適正併記23 | 38 |");
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

  it("writeを2回実行してもwhole3reportsがbyte同一（R5回帰）", () => {
    const dir = tempRoot();
    const manifest = manifestOf(dir);
    const reports: string[] = [];
    for (const section of Object.values(manifest.sections)) {
      if (section === undefined) continue;
      reports.push(join(dir, section.report));
    }
    expect(reports).toHaveLength(3);
    expect(runWrite(dir)).toEqual([]);
    const first = reports.map((p) => readFileSync(p));
    expect(runWrite(dir)).toEqual([]);
    const second = reports.map((p) => readFileSync(p));
    expect(second).toEqual(first);
  });

  it("Finding見出し・件数サマリは現集計IDから生成される（R6）", () => {
    const manifest = loadRealManifest();
    expect(renderFindingHeading(manifest, "F2")).toContain("### F2（未修復）海外売上の合計不一致 59 文書");
    expect(renderFindingHeading(manifest, "F3")).toContain("### F3（未修復）優待利回りの stale 32 行（fresh 7 行）");
    expect(renderFindingHeading(manifest, "F4")).toContain("### F4（未修復）純抽選優待の推定金額 14 行（5 銘柄）");
    const summary = renderFindingsSummary(manifest);
    expect(summary).toContain("59 文書");
    expect(summary).toContain("32 行（fresh 7 行");
    expect(summary).toContain("14 行（5 銘柄");
    expect(summary).toContain("集計ID:F2-docs");
  });

  it("見出しへの誤件数再導入を検出する（R6負例）", () => {
    const dir = tempRoot();
    const reportRel = loadRealManifest().sections.fundamentals.report;
    tamperBlock(dir, reportRel, "fundamentals-F2-heading", "59 文書", "58 文書");
    expect(checkFiles(manifestOf(dir), dir).some((e) => e.startsWith("E_BLOCK"))).toBe(true);
  });

  it("件数サマリへの誤件数再導入を検出する（R6負例）", () => {
    const dir = tempRoot();
    const reportRel = loadRealManifest().sections.fundamentals.report;
    tamperBlock(dir, reportRel, "fundamentals-findings-summary", "fresh 7 行", "fresh 8 行");
    expect(checkFiles(manifestOf(dir), dir).some((e) => e.startsWith("E_BLOCK"))).toBe(true);
  });

  it("F02 uniqueと元内訳の乖離を却下する（R7負例: long-fresh 33→34）", () => {
    const manifest = loadRealManifest();
    const long = aggregateOf(manifest, "market", "F02-long");
    const freshPart = long.parts.find((p) => p.id === "long-fresh");
    if (freshPart === undefined) throw new Error("missing long-fresh");
    freshPart.n = 34;
    long.total = 35;
    // 各 total=sum は満たす (34+1=35・33+32=65) が相互一致で落ちる
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.startsWith("E_TOTAL") && e.includes("F02-fresh-unique"))).toBe(true);
  });

  it("隔離非空でもquarantine注記を候補一覧の後に出す（R8）", () => {
    const manifest = loadRealManifest();
    const marketNote = manifest.sections.market.quarantines.note;
    if (marketNote === undefined) throw new Error("missing market quarantine note");
    const block = renderBlock(manifest, "market");
    expect(block.split(marketNote).length - 1).toBe(1);
    expect(block.lastIndexOf(marketNote)).toBeGreaterThan(block.lastIndexOf("保留 H-2180-rsi"));
    const fundNote = manifest.sections.fundamentals.quarantines.note;
    if (fundNote === undefined) throw new Error("missing fundamentals quarantine note");
    expect(renderBlock(manifest, "fundamentals").split(fundNote).length - 1).toBe(1);
  });

  it("PUB route表はpubRoutes配列から派生し件数が一致する", () => {
    const manifest = loadRealManifest();
    const routes = manifest.sections.market.pubRoutes;
    if (routes === undefined) throw new Error("missing pubRoutes");
    expect(routes).toHaveLength(38);
    const count = (scope: string) => routes.filter((r) => r.scope === scope).length;
    expect([count("valuejoin"), count("httpOnly"), count("boundary")]).toEqual([23, 9, 6]);
    expect(validateManifest(manifest)).toEqual([]);
    const valuejoin = renderPubRoutes(manifest, "valuejoin");
    expect(valuejoin).toContain("### 9.2 値join 23 件");
    expect(valuejoin).not.toContain("旧 19");
    expect(valuejoin).toContain("| 23 | `/rsi-screening/stocks/1909` (新) |");
    expect(renderPubRoutes(manifest, "httpOnly")).toContain("### 9.3 200-only 9 件");
    expect(renderPubRoutes(manifest, "boundary")).toContain("### 9.4 境界 6 件");
  });

  it("route分類と件数の乖離を却下する（PUB負例）", () => {
    const manifest = loadRealManifest();
    const routes = manifest.sections.market.pubRoutes;
    if (routes === undefined || routes.length !== 38) throw new Error("missing pubRoutes");
    routes[0].scope = "httpOnly";
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.startsWith("E_TOTAL") && e.includes("PUB-routes"))).toBe(true);
  });

  it("同一routeの別id重複登録を却下する（PUB負例）", () => {
    const manifest = loadRealManifest();
    const routes = manifest.sections.market.pubRoutes;
    if (routes === undefined || routes.length !== 38) throw new Error("missing pubRoutes");
    routes.push({ id: "PUB-R99", route: routes[0].route, scope: "boundary", evidence: "誤った重複" });
    // 件数側を合わせても (39=23+9+7) route 重複で落ちる
    const agg = aggregateOf(manifest, "market", "PUB-routes");
    agg.total = 39;
    const boundary = agg.parts.find((p) => p.id === "routes-boundary");
    if (boundary === undefined) throw new Error("missing routes-boundary");
    boundary.n = 7;
    const errors = validateManifest(manifest);
    expect(errors.some((e) => e.startsWith("E_DUPID") && e.includes("PUB-R99"))).toBe(true);
  });

  it("生成route表の手編集を検出する（PUB負例）", () => {
    const dir = tempRoot();
    const reportRel = loadRealManifest().sections.market.report;
    tamperBlock(dir, reportRel, "market-pub-valuejoin", "### 9.2 値join 23 件", "### 9.2 値join 24 件");
    expect(checkFiles(manifestOf(dir), dir).some((e) => e.startsWith("E_BLOCK"))).toBe(true);
  });

  it("B鮮度ブロックは日付をJSONから生成する（R6）", () => {
    const manifest = loadRealManifest();
    const block = renderFreshness(manifest);
    expect(block).toContain("**2026-09-28(月)**");
    expect(block).toContain("保存系列の最新日は2026-09-25で");
    expect(block).toContain("9/28営業日分は未反映");
  });

  it("B鮮度ブロックの日付書換えを検出する（R6負例）", () => {
    const dir = tempRoot();
    const reportRel = loadRealManifest().sections.market.report;
    tamperBlock(dir, reportRel, "market-freshness", "保存系列の最新日は2026-09-25で", "保存系列の最新日は2026-09-24で");
    expect(checkFiles(manifestOf(dir), dir).some((e) => e.startsWith("E_BLOCK"))).toBe(true);
  });

  it("B優先対応キューは隔離件数をJSONから生成する（R6）", () => {
    const manifest = loadRealManifest();
    expect(renderPriorityHeading()).toContain("### 優先対応 3 件");
    const summary = renderPrioritySummary(manifest);
    expect(summary).toContain("候補 5 件・保留 1 件");
    expect(summary).toContain("集計ID:Q-1909-rsi");
    expect(summary).toContain("集計ID:H-2180-rsi");
  });

  it("B優先対応見出しの手編集を検出する（R6負例）", () => {
    const dir = tempRoot();
    const reportRel = loadRealManifest().sections.market.report;
    tamperBlock(dir, reportRel, "market-priority-heading", "優先対応 3 件", "優先対応 4 件");
    expect(checkFiles(manifestOf(dir), dir).some((e) => e.startsWith("E_BLOCK"))).toBe(true);
  });

  it("B優先対応キューの手編集を検出する（R6負例）", () => {
    const dir = tempRoot();
    const reportRel = loadRealManifest().sections.market.report;
    tamperBlock(dir, reportRel, "market-priority-summary", "候補 5 件", "候補 6 件");
    expect(checkFiles(manifestOf(dir), dir).some((e) => e.startsWith("E_BLOCK"))).toBe(true);
  });

  it("C全件要約は25spec/5121行をJSONから生成する（R6）", () => {
    const manifest = loadRealManifest();
    const block = renderMoneyflowTotals(manifest);
    expect(block).toContain("全25spec（集計ID:MF-specs）");
    expect(block).toContain("合計5121行（集計ID:MF-rows-total）");
  });

  it("C全件要約の手編集を検出する（R6負例）", () => {
    const dir = tempRoot();
    const reportRel = loadRealManifest().sections.moneyflow.report;
    tamperBlock(dir, reportRel, "moneyflow-totals-summary", "合計5121行", "合計5122行");
    expect(checkFiles(manifestOf(dir), dir).some((e) => e.startsWith("E_BLOCK"))).toBe(true);
  });
});
