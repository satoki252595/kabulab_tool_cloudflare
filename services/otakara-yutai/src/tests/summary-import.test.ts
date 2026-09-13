/**
 * クラウド LLM 要約の書き出し・取り込みのテスト。
 *
 * LLM の出力は信用しない前提なので、「はじくべきものをはじく」「dry-run で書かない」
 * を固定する。掲載文はすべて架空 (出典サイトの文面は使わない)。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { benefitKey } from "../../data-scripts/benefit-key.js";
import { sanitizeEstimatedValue } from "../../data-scripts/estimated-value-guard.js";
import { assertNotCommittable } from "../../data-scripts/private-path.js";
import { SUMMARY_CONTRACT_VERSION } from "../../data-scripts/summary-contract.js";
import {
  MAX_IDS_PER_UPDATE,
  applySummaryImport,
  formatPlanReport,
  planSummaryImport,
  type SummaryWriter,
} from "../../data-scripts/summary-import.js";
import {
  parseTaskFile,
  selectSummaryTasks,
  serializeTasks,
  type BenefitRow,
} from "../../data-scripts/summary-tasks.js";

const SERVICE_DIR = fileURLToPath(new URL("../..", import.meta.url));

const DESC_CATALOG = "架空ギフトカタログ 3,000円相当\n■贈呈時期\n毎年7月下旬";
const DESC_DISCOUNT = "架空レストラン全店 お食事代20%割引券 2枚";
const DESC_NEW = "架空農園の新米 5kg";

const row = (over: Partial<BenefitRow>): BenefitRow => ({
  id: 1,
  stockCode: "9990",
  stockName: "架空ホールディングス",
  description: DESC_CATALOG,
  shortSummary: "カタログギフト 3,000円相当",
  estimatedValue: 3000,
  ...over,
});

const ROWS: BenefitRow[] = [
  // 契約違反の既存要約 (注記記号 + 説明文調)。権利月違いで 2 行。
  row({ id: 11, shortSummary: "※カタログから選べます。" }),
  row({ id: 12, shortSummary: "※カタログから選べます。" }),
  // 要約が無い
  row({ id: 21, stockCode: "9991", description: DESC_NEW, shortSummary: null, estimatedValue: null }),
  // 契約を満たす既存要約 (対象外)
  row({ id: 31, stockCode: "9992", description: DESC_DISCOUNT, shortSummary: "食事代 20%割引券 2枚", estimatedValue: null }),
];

const keyOf = (code: string, desc: string) => benefitKey(code, desc);
const K_CATALOG = keyOf("9990", DESC_CATALOG);
const K_NEW = keyOf("9991", DESC_NEW);
const K_DISCOUNT = keyOf("9992", DESC_DISCOUNT);

const result = (over: Record<string, unknown>) =>
  JSON.stringify({ taskId: K_CATALOG, contractVersion: SUMMARY_CONTRACT_VERSION, shortSummary: "カタログギフト 3,000円相当", estimatedValue: 3000, ...over });

describe("selectSummaryTasks", () => {
  it("要約が無い文言と契約違反の文言だけを、(銘柄, 掲載文) 単位で選ぶ", () => {
    const tasks = selectSummaryTasks(ROWS);
    expect(tasks.map((t) => [t.taskId, t.reason, t.rowCount])).toEqual([
      [K_CATALOG, "contract_violation", 2],
      [K_NEW, "missing", 1],
    ]);
    expect(tasks[0].violations).toEqual(["annotation", "prose"]);
    expect(tasks[0].contractVersion).toBe(SUMMARY_CONTRACT_VERSION);
  });

  it("--violations-only は契約違反だけに絞る", () => {
    const tasks = selectSummaryTasks(ROWS, { violationsOnly: true });
    expect(tasks.map((t) => t.taskId)).toEqual([K_CATALOG]);
  });

  it("--limit は決定的な順序の先頭から切る", () => {
    expect(selectSummaryTasks(ROWS, { limit: 1 }).map((t) => t.taskId)).toEqual([K_CATALOG]);
  });

  it("書き出したファイルを読み戻せる / taskId を書き換えたファイルは止める", () => {
    const tasks = selectSummaryTasks(ROWS);
    const text = serializeTasks(tasks);
    expect(parseTaskFile(text)).toEqual(tasks);
    const tampered = text.replace(K_CATALOG, K_DISCOUNT);
    expect(() => parseTaskFile(tampered)).toThrow(/taskId が銘柄コードと掲載文に一致しません/);
    expect(() => parseTaskFile("{not json")).toThrow(/JSON ではありません/);
  });
});

describe("planSummaryImport", () => {
  const tasks = selectSummaryTasks(ROWS);
  const plan = (resultsText: string, currentRows: BenefitRow[] = ROWS) =>
    planSummaryImport({ tasks, resultsText, currentRows });

  it("契約と金額ガードを満たす結果は、今の D1 の行 ID へ書く計画になる", () => {
    const p = plan(
      [
        result({}),
        result({ taskId: K_NEW, shortSummary: "新米 5kg", estimatedValue: null }),
      ].join("\n"),
    );
    expect(p.rejections).toEqual([]);
    expect(p.updates).toEqual([
      { taskId: K_CATALOG, ids: [11, 12], shortSummary: "カタログギフト 3,000円相当", estimatedValue: 3000, estimateValueSource: "company", estimateSourceUrl: null },
      { taskId: K_NEW, ids: [21], shortSummary: "新米 5kg", estimatedValue: null, estimateValueSource: null, estimateSourceUrl: null },
    ]);
    expect(p.unansweredTaskIds).toEqual([]);
  });

  it("全角英数字は NFKC で揃えてから検査する", () => {
    const p = plan(result({ shortSummary: " カタログギフト ３,０００円相当 " }));
    expect(p.updates[0].shortSummary).toBe("カタログギフト 3,000円相当");
  });

  it.each([
    ["too_long", "あ".repeat(61)],
    ["annotation", "カタログギフト 3,000円相当 ※毎年7月"],
    ["prose", "カタログから好きな商品を選べます。"],
    ["empty", "   "],
  ])("契約違反 (%s) の要約ははじく", (rule, shortSummary) => {
    const p = plan(result({ shortSummary }));
    expect(p.updates).toEqual([]);
    expect(p.rejections).toHaveLength(1);
    expect(p.rejections[0]).toMatchObject({ line: 1, taskId: K_CATALOG, reason: "contract" });
    expect(p.rejections[0].detail).toContain(rule);
  });

  it("発行していない taskId ははじく (ID 不一致)", () => {
    const p = plan(result({ taskId: K_DISCOUNT, shortSummary: "食事代 20%割引券 2枚", estimatedValue: null }));
    expect(p.updates).toEqual([]);
    expect(p.rejections.map((r) => r.reason)).toEqual(["unknown_task"]);
  });

  it("タスク発行後に掲載文が変わった (今の D1 に内容キーが無い) 結果ははじく", () => {
    const refetched = ROWS.map((r) => (r.stockCode === "9990" ? { ...r, id: r.id + 1000, description: DESC_CATALOG + "(改訂)" } : r));
    const p = plan(result({}), refetched);
    expect(p.updates).toEqual([]);
    expect(p.rejections.map((r) => r.reason)).toEqual(["stale"]);
  });

  it("再取得で行 ID だけ振り直された場合は、今の ID へ書く", () => {
    const renumbered = ROWS.map((r) => ({ ...r, id: r.id + 1000 }));
    const p = plan(result({}), renumbered);
    expect(p.updates[0].ids).toEqual([1011, 1012]);
  });

  it("契約の版が違う結果ははじく", () => {
    const p = plan(result({ contractVersion: "1999-01-01.1" }));
    expect(p.rejections.map((r) => r.reason)).toEqual(["contract_version"]);
  });

  it("同じ taskId への複数回答は両方はじく", () => {
    const p = plan([result({}), result({ shortSummary: "カタログギフト" })].join("\n"));
    expect(p.updates).toEqual([]);
    expect(p.rejections.map((r) => [r.line, r.reason])).toEqual([
      [1, "duplicate"],
      [2, "duplicate"],
    ]);
  });

  it("JSON でない行・余計なキー (掲載文の書き戻し等)・0 円ははじく", () => {
    const p = plan(
      [
        "{broken",
        result({ description: DESC_CATALOG }),
        result({ taskId: K_NEW, shortSummary: "新米 5kg", estimatedValue: 0 }),
      ].join("\n"),
    );
    expect(p.updates).toEqual([]);
    expect(p.rejections.map((r) => [r.line, r.reason])).toEqual([
      [1, "parse"],
      [2, "schema"],
      [3, "schema"],
    ]);
  });

  it("金額ガードに掛かる推定金額ははじく (割引の金額化 / 本文と桁が合わない高額)", () => {
    const discountTasks = selectSummaryTasks(
      [row({ id: 41, stockCode: "9993", description: DESC_DISCOUNT, shortSummary: null, estimatedValue: null })],
    );
    const kd = keyOf("9993", DESC_DISCOUNT);
    const rows = [row({ id: 41, stockCode: "9993", description: DESC_DISCOUNT, shortSummary: null })];
    const p1 = planSummaryImport({
      tasks: discountTasks,
      resultsText: result({ taskId: kd, shortSummary: "食事代 20%割引券 2枚", estimatedValue: 2000 }),
      currentRows: rows,
    });
    expect(p1.rejections.map((r) => r.reason)).toEqual(["value_guard"]);

    const p2 = plan(result({ estimatedValue: 300000 }));
    expect(p2.rejections.map((r) => r.reason)).toEqual(["value_guard"]);
  });

  it("掲載文の 40 字以上の逐語コピーははじく", () => {
    const sentence = "架空テーマパークの一日入場券と園内レストランで使える食事券のセット、年に二回まで家族全員で利用可能";
    expect(sentence.length).toBeGreaterThanOrEqual(40);
    const desc = `${sentence}\n■有効期限\n翌年6月末`;
    const rows = [row({ id: 51, stockCode: "9994", description: desc, shortSummary: null })];
    const p = planSummaryImport({
      tasks: selectSummaryTasks(rows),
      resultsText: result({ taskId: keyOf("9994", desc), shortSummary: sentence, estimatedValue: null }),
      currentRows: rows,
    });
    expect(p.rejections.map((r) => r.reason)).toEqual(["verbatim"]);
  });

  it("形の崩れた行と正しい行が同じ taskId に並んだら、正しい方も duplicate ではじく", () => {
    const p = plan([result({ description: DESC_CATALOG }), result({})].join("\n"));
    expect(p.updates).toEqual([]);
    expect(p.rejections.map((r) => [r.line, r.reason])).toEqual([
      [1, "schema"],
      [2, "duplicate"],
    ]);
  });

  it("掲載文に金額表現が無いのに推定金額を入れた結果ははじく (企業公表額として出るため)", () => {
    const p = plan(result({ taskId: K_NEW, shortSummary: "新米 5kg", estimatedValue: 3000 }));
    expect(p.updates).toEqual([]);
    expect(p.rejections.map((r) => r.reason)).toEqual(["value_ungrounded"]);
  });

  it("既存の推定金額が消える / 変わる行数を dry-run の報告に出す", () => {
    const p = plan(result({ estimatedValue: null }));
    expect(p.valueChanges).toEqual({ toNull: 2, fromNull: 0, changed: 0 });
    expect(formatPlanReport(p).join("\n")).toContain("消える 2 行");
    const same = plan(result({}));
    expect(same.valueChanges).toEqual({ toNull: 0, fromNull: 0, changed: 0 });
  });

  it("結果に現れないタスクは未回答として数える", () => {
    const p = plan(result({}));
    expect(p.unansweredTaskIds).toEqual([K_NEW]);
    expect(formatPlanReport(p).join("\n")).toContain("未回答のタスク: 1");
  });
});

describe("dry-run の出力に掲載文の断片を出さない (既定)", () => {
  const tasks = selectSummaryTasks(ROWS);
  const plan = (resultsText: string, currentRows: BenefitRow[] = ROWS, includeText?: boolean) =>
    planSummaryImport({ tasks, resultsText, currentRows, includeText });

  it("formatPlanReport の出力に task.description と拒否した shortSummary が含まれない", () => {
    // 注記記号を含む = 掲載文の注記ブロックをそのまま写した要約、という契約違反の典型例。
    const rejectedSummary = "※争奪ギフトは抽選になります";
    const p = plan(result({ shortSummary: rejectedSummary }));
    expect(p.rejections).toHaveLength(1);
    expect(p.rejections[0]).toMatchObject({ reason: "contract", taskId: K_CATALOG });
    // detail は規則名と字数だけで、要約本体そのものは積まない。
    expect(p.rejections[0].detail).not.toContain(rejectedSummary);
    expect(p.rejections[0].text).toBeUndefined();
    const report = formatPlanReport(p).join("\n");
    expect(report).not.toContain(rejectedSummary);
    expect(report).not.toContain(DESC_CATALOG);
  });

  it("JSON として読めない行は固定文になり、Node のエラー文 (入力の先頭を含む) を出さない", () => {
    // ```json フェンス混入や、掲載文をそのまま書き戻した行を想定した壊れた入力。
    const brokenLine = "架空の掲載文をそのままここに書いてしまった行";
    const p = plan(brokenLine);
    expect(p.rejections).toEqual([{ line: 1, taskId: null, reason: "parse", detail: "JSON として読めない" }]);
    const report = formatPlanReport(p).join("\n");
    expect(report).not.toContain(brokenLine);
    expect(report).not.toContain("架空の掲載文");
  });

  it("includeText: true を明示したときだけ Rejection.text が付き、showText: true のときだけ出力に出る", () => {
    const rejectedSummary = "※争奪ギフトは抽選になります";
    const p = plan(result({ shortSummary: rejectedSummary }), ROWS, true);
    expect(p.rejections[0].text).toBe(rejectedSummary);
    expect(formatPlanReport(p, 30, true).join("\n")).toContain(rejectedSummary);
    // showText を渡さなければ、text を保持していても出力には出さない。
    expect(formatPlanReport(p).join("\n")).not.toContain(rejectedSummary);
  });
});

describe("applySummaryImport", () => {
  const tasks = selectSummaryTasks(ROWS);
  const p = planSummaryImport({ tasks, resultsText: result({}), currentRows: ROWS });

  it("dry-run (既定) では writer を一度も呼ばない", async () => {
    const update = vi.fn<SummaryWriter["update"]>();
    const res = await applySummaryImport(p, { update }, { apply: false });
    expect(update).not.toHaveBeenCalled();
    expect(res).toEqual({ rows: 2, groups: 1, written: false });
  });

  it("--apply では計画どおりに書く", async () => {
    const update = vi.fn<SummaryWriter["update"]>().mockResolvedValue(undefined);
    const res = await applySummaryImport(p, { update }, { apply: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith([11, 12], {
      shortSummary: "カタログギフト 3,000円相当",
      estimatedValue: 3000,
      estimateValueSource: "company",
      estimateSourceUrl: null,
    });
    expect(res.written).toBe(true);
  });

  it("行 ID が多いときは D1 の bind 上限に収まるよう分割する", async () => {
    const many = Array.from({ length: MAX_IDS_PER_UPDATE * 2 + 1 }, (_, i) => row({ id: i + 1, shortSummary: null }));
    const bigPlan = planSummaryImport({ tasks: selectSummaryTasks(many), resultsText: result({}), currentRows: many });
    const update = vi.fn<SummaryWriter["update"]>().mockResolvedValue(undefined);
    await applySummaryImport(bigPlan, { update }, { apply: true });
    expect(update.mock.calls.map((c) => c[0].length)).toEqual([MAX_IDS_PER_UPDATE, MAX_IDS_PER_UPDATE, 1]);
  });
});

describe("sanitizeEstimatedValue (ローカル LLM 経路から移設。挙動は不変)", () => {
  it("割引系で金券表現が無ければ null", () => {
    expect(sanitizeEstimatedValue("全品10%割引", 1000)).toBeNull();
  });
  it("5 万円未満はそのまま通す", () => {
    expect(sanitizeEstimatedValue("QUOカード 1,000円分", 1000)).toBe(1000);
  });
  it("高額は本文の金額 × 数量に一致するときだけ通す", () => {
    expect(sanitizeEstimatedValue("旅行券 20万円相当", 200000)).toBe(200000);
    expect(sanitizeEstimatedValue("旅行券 20万円相当", 2000000)).toBeNull();
    expect(sanitizeEstimatedValue("宿泊券 30,000円 2枚", 60000)).toBe(60000);
  });
});

describe("assertNotCommittable (掲載文を含むファイルの置き場所)", () => {
  it("gitignore 済みの data-scripts/data/ 配下は通す (未作成のディレクトリでも)", () => {
    expect(() =>
      assertNotCommittable(join(SERVICE_DIR, "data-scripts/data/summary-tasks/not-yet/tasks.jsonl")),
    ).not.toThrow();
  });

  it("リポジトリ内でコミットされ得る場所は止める", () => {
    expect(() => assertNotCommittable(join(SERVICE_DIR, "docs/tasks.jsonl"))).toThrow(/gitignore の対象外/);
  });

  it("追跡中のファイルは止める", () => {
    expect(() => assertNotCommittable(join(SERVICE_DIR, "app.ts"))).toThrow(/追跡されています/);
  });

  it("リポジトリ外は通す", () => {
    const dir = mkdtempSync(join(tmpdir(), "yutai-summary-"));
    try {
      expect(() => assertNotCommittable(join(dir, "results.jsonl"))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
