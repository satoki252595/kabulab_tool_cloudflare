import { describe, expect, it } from "vitest";
import {
  buildCandidates,
  DEFAULT_CANDIDATE_OPTIONS,
  GENERIC_TAG_LABELS,
  type CandidateGenOptions,
  type CompanyProfile,
} from "./candidates.js";

function profile(p: Partial<CompanyProfile> & Pick<CompanyProfile, "stockCode">): CompanyProfile {
  return {
    companyName: `会社${p.stockCode}`,
    pageId: `page-${p.stockCode}`,
    sector33: null,
    tags: [],
    businessText: "",
    docId: `doc-${p.stockCode}`,
    ...p,
  };
}

describe("buildCandidates", () => {
  it("同じタグを持つ会社同士を候補にし、自分自身は含めない", () => {
    const corpus: CompanyProfile[] = [
      profile({ stockCode: "1000", tags: ["自動車完成車"] }),
      profile({ stockCode: "1001", tags: ["自動車完成車"] }),
      profile({ stockCode: "1002", tags: ["食品"] }),
    ];
    const result = buildCandidates(corpus, DEFAULT_CANDIDATE_OPTIONS);
    const c1000 = result.get("1000")!;
    expect(c1000.map((c) => c.stockCode)).toContain("1001");
    expect(c1000.map((c) => c.stockCode)).not.toContain("1000");
    expect(c1000.map((c) => c.stockCode)).not.toContain("1002");
  });

  it("一般的すぎるタグ (GENERIC_TAG_LABELS) はシグナルに使わない", () => {
    const generic = GENERIC_TAG_LABELS[0];
    const corpus: CompanyProfile[] = [
      profile({ stockCode: "2000", tags: [generic] }),
      profile({ stockCode: "2001", tags: [generic] }),
    ];
    const result = buildCandidates(corpus, DEFAULT_CANDIDATE_OPTIONS);
    // 共有する語が一般タグしかないので候補にならない (スコア0で除外)
    expect(result.get("2000") ?? []).toEqual([]);
  });

  it("33業種が同じだけ(タグ・テキストの重なりが無い)では候補にならない(性能上の割り切り。冒頭コメント§3)", () => {
    const corpus: CompanyProfile[] = [
      profile({ stockCode: "3000", sector33: "輸送用機器" }),
      profile({ stockCode: "3001", sector33: "輸送用機器" }),
      profile({ stockCode: "3002", sector33: "食料品" }),
    ];
    const result = buildCandidates(corpus, DEFAULT_CANDIDATE_OPTIONS);
    expect(result.get("3000") ?? []).toEqual([]);
  });

  it("33業種の一致はタグ/テキストで既に候補になっている組のスコアを後付けで押し上げる", () => {
    const corpus: CompanyProfile[] = [
      profile({ stockCode: "3100", sector33: "輸送用機器", tags: ["自動車完成車"] }),
      profile({ stockCode: "3101", sector33: "輸送用機器", tags: ["自動車完成車"] }), // タグ+業種一致
      profile({ stockCode: "3102", sector33: "食料品", tags: ["自動車完成車"] }), // タグのみ一致
      profile({ stockCode: "3103", sector33: "輸送用機器", tags: ["食品"] }), // 業種のみ (候補圏外)
    ];
    const result = buildCandidates(corpus, DEFAULT_CANDIDATE_OPTIONS);
    const c3100 = result.get("3100")!;
    expect(c3100.map((c) => c.stockCode)).toEqual(["3101", "3102"]); // 業種一致の3101が上位
    expect(c3100.find((c) => c.stockCode === "3101")!.sectorMatch).toBe(true);
    expect(c3100.find((c) => c.stockCode === "3102")!.sectorMatch).toBe(false);
    expect(c3100.map((c) => c.stockCode)).not.toContain("3103");
  });

  it("「事業の内容」が似ているとテキスト類似度で候補になる", () => {
    const corpus: CompanyProfile[] = [
      profile({ stockCode: "4000", businessText: "半導体製造装置の開発・製造・販売を行っております" }),
      profile({ stockCode: "4001", businessText: "半導体製造装置及び検査装置の開発・製造・販売を行っております" }),
      profile({ stockCode: "4002", businessText: "食品の製造販売及び物流サービスを展開しております" }),
    ];
    const result = buildCandidates(corpus, DEFAULT_CANDIDATE_OPTIONS);
    const c4000 = result.get("4000")!;
    expect(c4000[0].stockCode).toBe("4001");
    expect(c4000[0].textSimilarity).toBeGreaterThan(0);
  });

  it("topK で上位だけに絞る", () => {
    // 29社が同じタグを共有し (IDF>0 を保つため1社だけ別タグにする)、上位5件に絞られる。
    const corpus: CompanyProfile[] = [
      ...Array.from({ length: 29 }, (_, i) => profile({ stockCode: String(1000 + i), tags: ["自動車完成車"] })),
      profile({ stockCode: "1029", tags: ["別のタグ"] }),
    ];
    const opts: CandidateGenOptions = { ...DEFAULT_CANDIDATE_OPTIONS, topK: 5 };
    const result = buildCandidates(corpus, opts);
    expect(result.get("1000")!.length).toBe(5);
  });

  it("posting数が上限を超える語は集計から丸ごと除外される (性能の割り切り)", () => {
    // 3社が同じタグを持つが cap=2 なので、そのタグの posting リスト (3件) は
    // 上限超過としてスキップされ、他に重なりが無ければ候補が0件になる。
    // (4社目に別タグを混ぜ、IDF がちょうど0にならないようにする — 上の
    // 「posting数が上限以下」テストと同じ理由)。
    const corpus: CompanyProfile[] = [
      profile({ stockCode: "5000", tags: ["共通タグ"] }),
      profile({ stockCode: "5001", tags: ["共通タグ"] }),
      profile({ stockCode: "5002", tags: ["共通タグ"] }),
      profile({ stockCode: "5003", tags: ["別のタグ"] }),
    ];
    const opts: CandidateGenOptions = {
      ...DEFAULT_CANDIDATE_OPTIONS,
      postingCaps: { tag: 2, ngram: 2 },
    };
    const result = buildCandidates(corpus, opts);
    expect(result.get("5000")).toEqual([]);
  });

  it("posting数が上限以下なら通常どおり候補になる", () => {
    // IDF がちょうど0にならないよう、母集団に3社目 (別タグ) を混ぜる
    // (全社が同じタグを持つと IDF=0 になり、意図せずスコア0=候補なしになるため)。
    const corpus: CompanyProfile[] = [
      profile({ stockCode: "6000", tags: ["共通タグ"] }),
      profile({ stockCode: "6001", tags: ["共通タグ"] }),
      profile({ stockCode: "6002", tags: ["別のタグ"] }),
    ];
    const opts: CandidateGenOptions = {
      ...DEFAULT_CANDIDATE_OPTIONS,
      postingCaps: { tag: 2, ngram: 2 },
    };
    const result = buildCandidates(corpus, opts);
    expect(result.get("6000")!.map((c) => c.stockCode)).toEqual(["6001"]);
  });

  it("候補が無い会社は空配列を返す (未定義にしない)", () => {
    const corpus: CompanyProfile[] = [
      profile({ stockCode: "7000", tags: ["A"] }),
      profile({ stockCode: "7001", tags: ["B"] }),
    ];
    const result = buildCandidates(corpus, DEFAULT_CANDIDATE_OPTIONS);
    expect(result.get("7000")).toEqual([]);
  });
});
