/**
 * sources-verify.ts のテスト。設計 docs/005-yuho-quant-business-tags.md §6.3-2。
 *
 * fetch は全てモック (ネットワークに出ない)。PDF 分岐 (`unpdf`) はローカルに
 * 実在する小さな PDF が無いため検証対象外とし、HTML → テキスト化 +
 * NFKC・空白正規化の部分一致に絞って検証する (タスク指示どおりの縮退)。
 */
import { describe, expect, it, vi } from "vitest";
import { makeBudgetedVerifySources, verifySources, type SourceCheckIssue } from "./sources-verify.js";
import type { Proposal } from "./vocabulary/proposal.js";

const EVIDENCE = {
  title: "日本標準産業分類",
  url: "https://www.soumu.go.jp/main_content/000941216.pdf",
  date: "2023-07",
  section: "細分類2661 金属工作機械製造業",
  quote: "主として金属塊から切削加工製品を製造する工作機械類を製造する事",
};

function addKeywordsProposal(url: string, quote: string): Proposal {
  return {
    baseVersion: "v1",
    noChange: false,
    sourcesChecked: [{ title: EVIDENCE.title, url: EVIDENCE.url, date: EVIDENCE.date }],
    changes: [
      {
        op: "add_keywords",
        id: "B.MACH.MACHINE_TOOL",
        keywords: ["精密加工機"],
        evidence: [{ ...EVIDENCE, url, quote }],
      },
    ],
  };
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

describe("verifySources", () => {
  it("引用が本文に実在すれば issue 無し", async () => {
    const proposal = addKeywordsProposal(
      "https://www.soumu.go.jp/page.html",
      "主として金属塊から切削加工製品を製造する工作機械類を製造する事"
    );
    const fetchMock = vi.fn(async () =>
      htmlResponse("<html><body>説明文…主として金属塊から切削加工製品を製造する工作機械類を製造する事…続く</body></html>")
    );
    const issues = await verifySources(proposal, fetchMock as unknown as typeof fetch);
    expect(issues).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("引用文の途中にインラインタグ (強調等) が入っていても分断されず見つかる", async () => {
    const proposal = addKeywordsProposal("https://www.soumu.go.jp/page.html", "工作機械類を製造する事");
    const fetchMock = vi.fn(async () =>
      htmlResponse("<p>工作機械類を<b>製造</b>する事です。</p><script>ignore(1)</script>")
    );
    const issues = await verifySources(proposal, fetchMock as unknown as typeof fetch);
    expect(issues).toEqual([]);
  });

  it("全角スペース・HTML エンティティは正規化後に半角スペース相当として一致する", async () => {
    // クエリ (quote) 側は既に正規化後の形 (半角スペース1個) で用意する — 正規化は
    // 空白の「畳み込み」であって「除去」ではないため、一致には両者の空白位置を揃える。
    const proposal = addKeywordsProposal("https://www.soumu.go.jp/page.html", "A社 & B社の共同事業");
    const fetchMock = vi.fn(async () => htmlResponse("<p>A社　&amp;　B社の共同事業</p>"));
    const issues = await verifySources(proposal, fetchMock as unknown as typeof fetch);
    expect(issues).toEqual([]);
  });

  it("引用が本文に見つからなければ quote_not_found を返す", async () => {
    const proposal = addKeywordsProposal("https://www.soumu.go.jp/page.html", "存在しない引用文言");
    const fetchMock = vi.fn(async () => htmlResponse("<html><body>全く関係ない内容</body></html>"));
    const issues: SourceCheckIssue[] = await verifySources(proposal, fetchMock as unknown as typeof fetch);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("quote_not_found");
  });

  it("HTTP エラー (非 2xx) は fetch_failed", async () => {
    const proposal = addKeywordsProposal("https://www.soumu.go.jp/missing.html", "何か");
    const fetchMock = vi.fn(async () => htmlResponse("not found", 404));
    const issues = await verifySources(proposal, fetchMock as unknown as typeof fetch);
    expect(issues).toEqual([
      expect.objectContaining({ code: "fetch_failed", url: "https://www.soumu.go.jp/missing.html" }),
    ]);
  });

  it("ネットワークエラーは fetch_failed (フォールバックせず issue として報告)", async () => {
    const proposal = addKeywordsProposal("https://www.soumu.go.jp/down.html", "何か");
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    const issues = await verifySources(proposal, fetchMock as unknown as typeof fetch);
    expect(issues).toEqual([expect.objectContaining({ code: "fetch_failed" })]);
  });

  it("同じ URL は 1 回だけ取得する (提案内で使い回している場合)", async () => {
    const url = "https://www.soumu.go.jp/shared.html";
    const proposal: Proposal = {
      baseVersion: "v1",
      noChange: false,
      sourcesChecked: [{ title: EVIDENCE.title, url: EVIDENCE.url, date: EVIDENCE.date }],
      changes: [
        { op: "add_keywords", id: "B.MACH.MACHINE_TOOL", keywords: ["精密加工機"], evidence: [{ ...EVIDENCE, url, quote: "工作機械" }] },
        { op: "deprecate", id: "B.DEF.SMALL_ARMS", evidence: [{ ...EVIDENCE, url, quote: "工作機械" }] },
      ],
    };
    const fetchMock = vi.fn(async () => htmlResponse("<p>工作機械の説明</p>"));
    const issues = await verifySources(proposal, fetchMock as unknown as typeof fetch);
    expect(issues).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sourcesChecked (引用を持たない全体の参照資料一覧) は検査対象外", async () => {
    const proposal: Proposal = {
      baseVersion: "v1",
      noChange: false,
      sourcesChecked: [{ title: "参照だけした資料", url: "https://www.soumu.go.jp/never-fetched.html", date: "2026-01" }],
      changes: [],
    };
    const fetchMock = vi.fn();
    const issues = await verifySources(proposal, fetchMock as unknown as typeof fetch);
    expect(issues).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("許可ホスト外・SSRF対策", () => {
    it("公的資料 (.go.jp) 以外のホストは fetch すらせず disallowed_host を返す", async () => {
      const proposal = addKeywordsProposal("https://attacker.example.com/page.html", "何か");
      const fetchMock = vi.fn();
      const issues = await verifySources(proposal, fetchMock as unknown as typeof fetch);
      expect(issues).toEqual([
        expect.objectContaining({ code: "disallowed_host", url: "https://attacker.example.com/page.html" }),
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it(".go.jp のサブドメインは許可される", async () => {
      const proposal = addKeywordsProposal("https://www.meti.go.jp/page.html", "工作機械");
      const fetchMock = vi.fn(async () => htmlResponse("<p>工作機械の説明</p>"));
      const issues = await verifySources(proposal, fetchMock as unknown as typeof fetch);
      expect(issues).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("リダイレクト応答 (redirect: manual の opaqueredirect) は自動追従せず fetch_failed", async () => {
      const proposal = addKeywordsProposal("https://www.soumu.go.jp/redirect.html", "何か");
      const fetchMock = vi.fn(
        async () =>
          ({ ok: false, status: 0, type: "opaqueredirect", headers: new Headers() }) as unknown as Response
      );
      const issues = await verifySources(proposal, fetchMock as unknown as typeof fetch);
      expect(issues).toEqual([expect.objectContaining({ code: "fetch_failed" })]);
      // redirect: "manual" を指定して自動追従させないこと (SSRF対策)。
      expect(fetchMock).toHaveBeenCalledWith(
        "https://www.soumu.go.jp/redirect.html",
        expect.objectContaining({ redirect: "manual" })
      );
    });

    it("タイムアウト付き (AbortSignal) で fetch する", async () => {
      const proposal = addKeywordsProposal("https://www.soumu.go.jp/page.html", "工作機械");
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => htmlResponse("<p>工作機械の説明</p>"));
      await verifySources(proposal, fetchMock as unknown as typeof fetch);
      const init = fetchMock.mock.calls[0]?.[1];
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it("Content-Length が上限を超える応答は本文を読まず fetch_failed", async () => {
      const proposal = addKeywordsProposal("https://www.soumu.go.jp/huge.html", "工作機械");
      const textSpy = vi.fn(async () => "<p>工作機械の説明</p>");
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": String(30 * 1024 * 1024) }),
        text: textSpy,
        arrayBuffer: vi.fn(),
      }) as unknown as Response);
      const issues = await verifySources(proposal, fetchMock as unknown as typeof fetch);
      expect(issues).toEqual([expect.objectContaining({ code: "fetch_failed" })]);
      expect(textSpy).not.toHaveBeenCalled();
    });
  });

  describe("時間予算 (deadlineAt) — レビュー指摘の回帰: 大量の出典を持つ提案が検査ループを長時間化させない", () => {
    it("締切を既に過ぎていれば、1件も fetch せず全件 verification_timed_out を返す", async () => {
      const proposal = addKeywordsProposal("https://www.soumu.go.jp/page.html", "工作機械");
      const fetchMock = vi.fn(async () => htmlResponse("<p>工作機械の説明</p>"));
      const issues = await verifySources(proposal, fetchMock as unknown as typeof fetch, {
        deadlineAt: Date.now() - 1,
      });
      expect(issues).toEqual([expect.objectContaining({ code: "verification_timed_out" })]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("締切が途中の項目で来たら、それより前は通常どおり検査し、以降は timed_out として打ち切る (残りを黙って「問題なし」にしない)", async () => {
      const url1 = "https://www.soumu.go.jp/first.html";
      const url2 = "https://www.soumu.go.jp/second.html";
      const url3 = "https://www.soumu.go.jp/third.html";
      const proposal: Proposal = {
        baseVersion: "v1",
        noChange: false,
        sourcesChecked: [{ title: EVIDENCE.title, url: EVIDENCE.url, date: EVIDENCE.date }],
        changes: [
          { op: "add_keywords", id: "B.MACH.MACHINE_TOOL", keywords: ["a"], evidence: [{ ...EVIDENCE, url: url1, quote: "工作機械" }] },
          { op: "add_keywords", id: "B.MACH.INDUSTRIAL_ROBOT", keywords: ["b"], evidence: [{ ...EVIDENCE, url: url2, quote: "産業用ロボット" }] },
          { op: "deprecate", id: "B.DEF.SMALL_ARMS", evidence: [{ ...EVIDENCE, url: url3, quote: "小火器" }] },
        ],
      };
      const fetchMock = vi.fn(async () => htmlResponse("<p>工作機械の説明</p>"));
      // ループは項目ごとに1回ずつ Date.now() で締切を見る (3項目 → 最大3回)。
      // 1回目 (url1 の検査前) は締切前、2回目 (url2 の検査前) 以降は締切後を
      // 返すよう固定し、「1件目は通常どおり検査され、2件目以降は timed_out で
      // 打ち切られる」を決定的に再現する。
      const originalNow = Date.now;
      let call = 0;
      Date.now = () => {
        call++;
        return call === 1 ? 1_000 : 2_000;
      };
      try {
        const issues = await verifySources(proposal, fetchMock as unknown as typeof fetch, { deadlineAt: 1_500 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ code: "verification_timed_out", url: url2 });
      } finally {
        Date.now = originalNow;
      }
    });

    it("makeBudgetedVerifySources: 予算が負 (既に過ぎている) なら即座に timed_out (fetch しない)", async () => {
      const proposal = addKeywordsProposal("https://www.soumu.go.jp/page.html", "工作機械");
      const fetchMock = vi.fn(async () => htmlResponse("<p>工作機械の説明</p>"));
      const budgeted = makeBudgetedVerifySources(-60_000, fetchMock as unknown as typeof fetch);
      const issues = await budgeted(proposal);
      expect(issues).toEqual([expect.objectContaining({ code: "verification_timed_out" })]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("makeBudgetedVerifySources: 十分な予算があれば通常どおり検査する", async () => {
      const proposal = addKeywordsProposal("https://www.soumu.go.jp/page.html", "工作機械");
      const fetchMock = vi.fn(async () => htmlResponse("<p>工作機械の説明</p>"));
      const budgeted = makeBudgetedVerifySources(60_000, fetchMock as unknown as typeof fetch);
      const issues = await budgeted(proposal);
      expect(issues).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
