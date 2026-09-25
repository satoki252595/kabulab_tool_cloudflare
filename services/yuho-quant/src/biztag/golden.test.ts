/**
 * golden.ts のテスト。設計 docs/005-yuho-quant-business-tags.md §10。
 *
 * 実在する有報の文 (オークマ S100YFQC・極洋 S100YE8K の「事業の内容」) を使う。
 * 1 件だけ、絞り込みの取りこぼし (filterMissRate) の枝・「候補全てを判定する」
 * 挙動の枝を確かめるために実在しない架空データ (「テスト用架空データ」と明示) を
 * 使う — 本番経路には一切乗らない、純粋な分岐網羅用のテストフィクスチャ。
 */
import { describe, expect, it } from "vitest";
import type { JevClient, JevNoulQuestion } from "../../../../src/shared/jev/index.js";
import type { PrefilterSectionKey } from "./prefilter.js";
import {
  assertGoldenSetInvariants,
  evaluateAtThresholds,
  evaluateGolden,
  goldenItemKey,
  type GoldenItem,
  type GoldenPerItemResult,
  type GoldenSet,
} from "./golden.js";
import { MINI_VOCAB } from "./vocabulary/__fixtures__/mini-vocab.js";

const THRESHOLDS = { yesMin: 0.8, noMax: 0.2 };
const CREATED_AT = "2026-09-25";
const VOCAB_VERSION = MINI_VOCAB.version;

/** 実在する有報の文 (オークマ 2026-03-31 期 有報 S100YFQC「事業の内容」全文)。 */
const OKUMA_BUSINESS_TEXT =
  "３ 【事業の内容】当グループは、当社、連結子会社16社、非連結子会社15社で構成され、ＮＣ旋盤、" +
  "マシニングセンタ、複合加工機、ＮＣ研削盤等の工作機械の製造・販売を主な事業内容としております。";

/** 実在する有報の文 (極洋 2026-03-31 期 有報 S100YE8K「事業の内容」冒頭)。 */
const KYOKUYO_BUSINESS_TEXT =
  "３ 【事業の内容】当社及び当社の関係会社は、株式会社極洋(当社)、子会社36社、関連会社５社及び" +
  "非連結子会社１社により構成され、水産事業、生鮮事業、食品事業、物流サービス事業を主として行っております。";

function makeMockJevClient(answers: Record<string, number>): JevClient {
  return {
    askNoul: async (_state, questions) => {
      const qids = Object.keys(questions);
      const resolved: Record<string, number> = {};
      for (const qid of qids) {
        if (!(qid in answers)) throw new Error(`mock jev: 未設定の質問への回答要求: ${qid}`);
        resolved[qid] = answers[qid] as number;
      }
      return { model: "mock-model", answers: resolved, inputTokens: 100, outputTokens: 0, latencyMs: 1, attempts: 1 };
    },
  };
}

function buildTexts(
  entries: Array<{ item: Pick<GoldenItem, "code" | "docId">; business: string }>
): Map<string, Partial<Record<PrefilterSectionKey, string>>> {
  const map = new Map<string, Partial<Record<PrefilterSectionKey, string>>>();
  for (const e of entries) map.set(goldenItemKey(e.item), { business: e.business });
  return map;
}

function goldenSetOf(items: GoldenItem[]): GoldenSet {
  return { version: "v1", createdAt: CREATED_AT, vocabVersion: VOCAB_VERSION, items };
}

describe("evaluateGolden (実データ: オークマ/極洋)", () => {
  const goldenSet: GoldenSet = goldenSetOf([
    {
      code: "6103",
      docId: "S100YFQC",
      docTypeCode: "120",
      periodEnd: "2026-03-31",
      companyName: "オークマ",
      expect: [
        {
          termId: "B.MACH.MACHINE_TOOL",
          label: true,
          quote: "工作機械の製造・販売を主な事業内容としております",
          sectionKey: "business",
          mustHit: true,
        },
      ],
    },
    {
      code: "1301",
      docId: "S100YE8K",
      docTypeCode: "120",
      periodEnd: "2026-03-31",
      companyName: "極洋",
      expect: [
        {
          termId: "B.MACH.MACHINE_TOOL",
          label: false,
          quote: "水産事業、生鮮事業、食品事業、物流サービス事業を主として行っております",
          sectionKey: "business",
        },
      ],
    },
  ]);

  const texts = buildTexts([
    { item: { code: "6103", docId: "S100YFQC" }, business: OKUMA_BUSINESS_TEXT },
    { item: { code: "1301", docId: "S100YE8K" }, business: KYOKUYO_BUSINESS_TEXT },
  ]);

  it("極洋は絞り込みの時点で候補にならず jev を呼ばない (工作機械キーワード無し)", async () => {
    let called = false;
    const jev: JevClient = {
      askNoul: async (state, questions) => {
        called = true;
        return makeMockJevClient({}).askNoul(state, questions);
      },
    };
    const evaluation = await evaluateGolden(
      goldenSetOf([goldenSet.items[1] as GoldenItem]),
      MINI_VOCAB,
      texts,
      jev,
      THRESHOLDS
    );
    expect(called).toBe(false);
    expect(evaluation.perItem[0]).toMatchObject({
      candidate: false,
      band: "no_candidate",
      probability: null,
      correct: true,
      mustHit: false,
      mustNot: false,
    });
  });

  it("正しく判定できれば precisionYes=1・recallYes=1・mustHitRecall=1・filterMissRate=0", async () => {
    const jev = makeMockJevClient({ "bt.B.MACH.MACHINE_TOOL": 0.95 });
    const evaluation = await evaluateGolden(goldenSet, MINI_VOCAB, texts, jev, THRESHOLDS);
    expect(evaluation.precisionYes).toBe(1);
    expect(evaluation.recallYes).toBe(1);
    expect(evaluation.mustHitRecall).toBe(1);
    expect(evaluation.mustNotViolations).toBe(0);
    expect(evaluation.filterMissRate).toBe(0);
    expect(evaluation.confusion).toEqual({ truePositive: 1, falsePositive: 0, trueNegative: 1, falseNegative: 0 });
    const okumaResult = evaluation.perItem.find((r) => r.docId === "S100YFQC");
    expect(okumaResult).toMatchObject({ probability: 0.95, band: "yes", candidate: true, mustHit: true, correct: true });
  });

  it("jev が誤って「いいえ」判定すると recallYes・mustHitRecall が下がる (precisionYes は「はい」0件のため測れない=null)", async () => {
    const jev = makeMockJevClient({ "bt.B.MACH.MACHINE_TOOL": 0.05 });
    const evaluation = await evaluateGolden(goldenSet, MINI_VOCAB, texts, jev, THRESHOLDS);
    expect(evaluation.recallYes).toBe(0);
    expect(evaluation.mustHitRecall).toBe(0);
    expect(evaluation.precisionYes).toBeNull();
    expect(evaluation.confusion.falseNegative).toBe(1);
  });

  it("欠けている本文は throw する (テキストが用意されていないゴールデン項目)", async () => {
    const jev = makeMockJevClient({});
    await expect(evaluateGolden(goldenSet, MINI_VOCAB, new Map(), jev, THRESHOLDS)).rejects.toThrow(/テキストが見つかりません/);
  });
});

describe("evaluateGolden (filterMissRate・mustNotViolations: 純粋な分岐網羅用の架空データ)", () => {
  it("絞り込みで候補にすら挙がらない期待trueは filterMissRate に計上する", async () => {
    const syntheticItem: GoldenItem = {
      code: "0001",
      docId: "S100TEST0",
      docTypeCode: "120",
      periodEnd: "2026-03-31",
      companyName: "テスト用架空データ（実在しない）",
      expect: [
        {
          termId: "B.MACH.MACHINE_TOOL",
          label: true,
          quote: "この文にはキーワードが含まれない (分岐網羅専用のダミー文)",
          sectionKey: "business",
        },
      ],
    };
    const texts = buildTexts([
      { item: syntheticItem, business: "この文にはキーワードが含まれない (分岐網羅専用のダミー文)" },
    ]);
    const jev = makeMockJevClient({});
    const evaluation = await evaluateGolden(goldenSetOf([syntheticItem]), MINI_VOCAB, texts, jev, THRESHOLDS);
    expect(evaluation.filterMissRate).toBe(1);
    expect(evaluation.recallYes).toBe(0);
  });

  it("候補にはなったが jev が誤って「はい」判定すると偽陽性 (mustNot 指定なら mustNotViolations にも計上)", async () => {
    const syntheticItem: GoldenItem = {
      code: "0002",
      docId: "S100TEST1",
      docTypeCode: "120",
      periodEnd: "2026-03-31",
      companyName: "テスト用架空データ（実在しない）",
      expect: [
        {
          termId: "B.MACH.MACHINE_TOOL",
          label: false,
          quote: "工作機械を仕入れて販売する商社です (分岐網羅専用のダミー文)",
          sectionKey: "business",
          mustNot: true,
        },
      ],
    };
    const texts = buildTexts([
      { item: syntheticItem, business: "工作機械を仕入れて販売する商社です (分岐網羅専用のダミー文)" },
    ]);
    const jev = makeMockJevClient({ "bt.B.MACH.MACHINE_TOOL": 0.9 });
    const evaluation = await evaluateGolden(goldenSetOf([syntheticItem]), MINI_VOCAB, texts, jev, THRESHOLDS);
    expect(evaluation.confusion.falsePositive).toBe(1);
    expect(evaluation.precisionYes).toBe(0);
    expect(evaluation.mustNotViolations).toBe(1);
  });

  it("本文が複数語に当たるとき、expect に無い候補語も含めて全て jev に問い合わせる (本番 process.ts と同じバッチ構成)", async () => {
    // テスト用架空データ (実在しない): 工作機械・産業用ロボットの語を両方含む合成文。
    // expect には工作機械の1語しか挙げていないが、絞り込みで候補になった語は
    // 産業用ロボットも含めて2語あるはずで、jev への問い合わせもその2語ぶん行われる
    // ことを確かめる (絞り込みで候補になった語だけを問い合わせに絞ると、本番より
    // 小さいバッチで jev に問い合わせることになり精度の測定が実態とずれるため)。
    const syntheticItem: GoldenItem = {
      code: "0003",
      docId: "S100TEST2",
      docTypeCode: "120",
      periodEnd: "2026-03-31",
      companyName: "テスト用架空データ（実在しない）",
      expect: [
        {
          termId: "B.MACH.MACHINE_TOOL",
          label: true,
          quote: "工作機械の製造を行っています (分岐網羅専用のダミー文)",
          sectionKey: "business",
        },
      ],
    };
    const texts = buildTexts([
      {
        item: syntheticItem,
        business: "当社は工作機械の製造を行っています。また、産業用ロボットの開発も手掛けております。",
      },
    ]);
    let receivedQids: string[] = [];
    const jev: JevClient = {
      askNoul: async (_state, questions: Record<string, JevNoulQuestion>) => {
        receivedQids = Object.keys(questions);
        return {
          model: "mock-model",
          answers: Object.fromEntries(receivedQids.map((qid) => [qid, 0.9])),
          inputTokens: 100,
          outputTokens: 0,
          latencyMs: 1,
          attempts: 1,
        };
      },
    };
    await evaluateGolden(goldenSetOf([syntheticItem]), MINI_VOCAB, texts, jev, THRESHOLDS);
    expect(receivedQids.sort()).toEqual(["bt.B.MACH.INDUSTRIAL_ROBOT", "bt.B.MACH.MACHINE_TOOL"].sort());
  });
});

describe("assertGoldenSetInvariants", () => {
  function itemWith(expect: GoldenItem["expect"][number]): GoldenSet {
    return goldenSetOf([
      {
        code: "0001",
        docId: "S100TEST0",
        docTypeCode: "120",
        periodEnd: "2026-03-31",
        companyName: "テスト用架空データ（実在しない）",
        expect: [expect],
      },
    ]);
  }

  it("mustHit:true なのに label:false は throw する", () => {
    expect(() =>
      assertGoldenSetInvariants(
        itemWith({ termId: "B.MACH.MACHINE_TOOL", label: false, quote: "x", sectionKey: "business", mustHit: true })
      )
    ).toThrow(/mustHit/);
  });

  it("mustNot:true なのに label:true は throw する", () => {
    expect(() =>
      assertGoldenSetInvariants(
        itemWith({ termId: "B.MACH.MACHINE_TOOL", label: true, quote: "x", sectionKey: "business", mustNot: true })
      )
    ).toThrow(/mustNot/);
  });

  it("整合していれば何もしない", () => {
    expect(() =>
      assertGoldenSetInvariants(
        itemWith({ termId: "B.MACH.MACHINE_TOOL", label: true, quote: "x", sectionKey: "business", mustHit: true })
      )
    ).not.toThrow();
  });
});

describe("evaluateAtThresholds", () => {
  const perItem: GoldenPerItemResult[] = [
    // 候補になり、しきい値次第で yes/uncertain/no が変わる true 正解 (mustHit)。
    {
      code: "1",
      docId: "d1",
      termId: "T1",
      expectedLabel: true,
      candidate: true,
      band: "yes",
      probability: 0.85,
      correct: true,
      mustHit: true,
      mustNot: false,
    },
    // 候補になり、しきい値次第で false 正解が false 陽性化しうる (mustNot)。
    {
      code: "2",
      docId: "d2",
      termId: "T2",
      expectedLabel: false,
      candidate: true,
      band: "uncertain",
      probability: 0.6,
      correct: true,
      mustHit: false,
      mustNot: true,
    },
    // 絞り込みで候補にならなかった期待true (filterMiss)。
    {
      code: "3",
      docId: "d3",
      termId: "T3",
      expectedLabel: true,
      candidate: false,
      band: "no_candidate",
      probability: null,
      correct: false,
      mustHit: false,
      mustNot: false,
    },
  ];

  it("元のしきい値 (yesMin=0.8) では T2 は uncertain のまま (mustNot 違反なし)", () => {
    const m = evaluateAtThresholds(perItem, { yesMin: 0.8, noMax: 0.2 });
    expect(m.precisionYes).toBe(1); // T1 だけが yes で正解
    expect(m.recallYes).toBe(0.5); // 期待true 2件 (T1,T3) 中 T1 のみ的中
    expect(m.mustHitRecall).toBe(1);
    expect(m.mustNotViolations).toBe(0);
    expect(m.filterMissRate).toBe(0.5); // 期待true 2件中 T3 が候補外
    expect(m.confusion).toEqual({ truePositive: 1, falsePositive: 0, trueNegative: 1, falseNegative: 1 });
  });

  it("yesMin を 0.5 まで下げると T2 (mustNot) が yes 化し mustNotViolations が増える (jev を呼び直さず再計算)", () => {
    const m = evaluateAtThresholds(perItem, { yesMin: 0.5, noMax: 0.2 });
    expect(m.mustNotViolations).toBe(1);
    expect(m.precisionYes).toBe(0.5); // yes 2件 (T1,T2) 中 T1 のみ正解
  });

  it("mustHit/mustNot が0件なら null (測定不可)。空配列なら precisionYes/recallYes/filterMissRate も null", () => {
    const m = evaluateAtThresholds([], { yesMin: 0.8, noMax: 0.2 });
    expect(m).toMatchObject({
      precisionYes: null,
      recallYes: null,
      mustHitRecall: null,
      mustNotViolations: 0,
      filterMissRate: null,
    });
  });
});
