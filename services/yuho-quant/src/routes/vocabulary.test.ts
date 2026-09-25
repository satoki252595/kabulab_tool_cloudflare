/**
 * `/yuho-quant/vocabulary/*` (単語帳の年次見直し受付) のルートテスト。
 * 設計: docs/005-yuho-quant-business-tags.md §6.2。
 *
 * notion-archive 層はモックする (実体は notion エージェントの
 * biztag-ledger.test.ts が保証)。ここでは
 *   - 合言葉認証 (未設定 fail-closed・欠落・誤り・大小文字表記ゆれ)
 *   - GET /review-packet の「無ければ 404」「あれば読んでそのまま返す」
 *   - POST /proposals の 413/400/409/202 の分岐と台帳への引数写像
 * を固定する。ルートを独立した最小 Hono アプリに載せ、本番と同じ
 * `createErrorHandler` を付けて「重い検査はしない (throw は 500)」を確かめる。
 *
 * 提案本体のテストデータは実データ抜粋 (`MINI_VOCAB` fixture) の出典・語 ID を
 * そのまま使い、捏造した値は含めない (ルール1。proposal.test.ts と同じ方針)。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createErrorHandler } from "../../../../src/shared/error-handler.js";
import { sha256Hex } from "../../../../src/shared/sha256.js";
import {
  createLedgerEntry,
  ensureLedgerDb,
  listLedgerEntries,
  readLedgerJson,
} from "../../../../src/shared/notion-archive/index.js";
import { MINI_VOCAB } from "../biztag/vocabulary/__fixtures__/mini-vocab.js";
import type { Proposal } from "../biztag/vocabulary/index.js";
import { vocabularyRoute } from "./vocabulary.js";

vi.mock("../../../../src/shared/notion-archive/index.js", () => ({
  ensureLedgerDb: vi.fn(),
  listLedgerEntries: vi.fn(),
  readLedgerJson: vi.fn(),
  createLedgerEntry: vi.fn(),
}));

const app = new Hono({ strict: false });
app.route("/vocabulary", vocabularyRoute);
app.onError(createErrorHandler("yuho-quant"));

function request(path: string, init?: RequestInit) {
  return app.request(path, init);
}

const TOKEN = "cursor-automation-secret-token";
let TOKEN_HASH: string;

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}` };
}

/** fixture 内の実在の出典を 1 件借りる (evidence/sourcesChecked のダミー捏造を避ける)。 */
const REAL_SOURCE = structuredClone(MINI_VOCAB.business[0].sources[0]);
const REAL_TERM_ID = MINI_VOCAB.business[0].id;

function validProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    baseVersion: "v1",
    noChange: false,
    sourcesChecked: [
      { title: REAL_SOURCE.title, url: REAL_SOURCE.url, date: REAL_SOURCE.date },
    ],
    changes: [{ op: "deprecate", id: REAL_TERM_ID, evidence: [REAL_SOURCE] }],
    ...overrides,
  };
}

function noChangeProposal(): Proposal {
  return {
    baseVersion: "v1",
    noChange: true,
    reason: "公的資料を確認したが追加・変更すべき事業領域は無かった",
    sourcesChecked: [
      { title: REAL_SOURCE.title, url: REAL_SOURCE.url, date: REAL_SOURCE.date },
    ],
    changes: [],
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.VOCAB_REVIEW_TOKEN_SHA256;
  TOKEN_HASH = await sha256Hex(TOKEN);
});

describe("合言葉認証 (fail-closed)", () => {
  it("VOCAB_REVIEW_TOKEN_SHA256 未設定なら Authorization があっても 401", async () => {
    const res = await request("/vocabulary/review-packet", { headers: authHeaders() });
    expect(res.status).toBe(401);
    expect(ensureLedgerDb).not.toHaveBeenCalled();
  });

  it("Authorization ヘッダが無ければ 401", async () => {
    process.env.VOCAB_REVIEW_TOKEN_SHA256 = TOKEN_HASH;
    const res = await request("/vocabulary/review-packet");
    expect(res.status).toBe(401);
  });

  it("Bearer 形式が壊れていれば 401", async () => {
    process.env.VOCAB_REVIEW_TOKEN_SHA256 = TOKEN_HASH;
    const res = await request("/vocabulary/review-packet", {
      headers: { Authorization: TOKEN },
    });
    expect(res.status).toBe(401);
  });

  it("トークンが違えば 401", async () => {
    process.env.VOCAB_REVIEW_TOKEN_SHA256 = TOKEN_HASH;
    const res = await request("/vocabulary/review-packet", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("正しいトークンなら通す (ハッシュ大文字表記でも正規化して一致する)", async () => {
    process.env.VOCAB_REVIEW_TOKEN_SHA256 = TOKEN_HASH.toUpperCase();
    vi.mocked(ensureLedgerDb).mockResolvedValue("ledger-db-id");
    vi.mocked(listLedgerEntries).mockResolvedValue([]);
    const res = await request("/vocabulary/review-packet", { headers: authHeaders() });
    expect(res.status).toBe(404); // 401 ではない = 認証を通過した
    expect(ensureLedgerDb).toHaveBeenCalledOnce();
  });
});

describe("GET /vocabulary/review-packet", () => {
  beforeEach(() => {
    process.env.VOCAB_REVIEW_TOKEN_SHA256 = TOKEN_HASH;
  });

  it("「見直し材料」(状態=最新) が無ければ 404", async () => {
    vi.mocked(ensureLedgerDb).mockResolvedValue("ledger-db-id");
    vi.mocked(listLedgerEntries).mockResolvedValue([]);
    const res = await request("/vocabulary/review-packet", { headers: authHeaders() });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "見直し材料がまだありません" });
    expect(listLedgerEntries).toHaveBeenCalledWith("ledger-db-id", {
      kind: "見直し材料",
      state: "最新",
    });
    expect(readLedgerJson).not.toHaveBeenCalled();
  });

  it("あればハッシュ照合つきで読んでそのまま返す", async () => {
    const latest = { pageId: "page-new" } as never;
    const packet = {
      version: "v1",
      termStats: [{ id: REAL_TERM_ID, label: "シリコンウエハ", column: "upstream", tagCount: 3, uncertainCount: 0 }],
      generatedAt: "2026-08-01",
    };
    vi.mocked(ensureLedgerDb).mockResolvedValue("ledger-db-id");
    vi.mocked(listLedgerEntries).mockResolvedValue([latest]);
    vi.mocked(readLedgerJson).mockResolvedValue(packet);

    const res = await request("/vocabulary/review-packet", { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(packet);
    expect(readLedgerJson).toHaveBeenCalledWith(latest);
  });

  it("「最新」行が複数あれば台帳異常として 500 で正直に落ちる (黙って1件へ縮退させない)", async () => {
    const older = { pageId: "page-old" } as never;
    const latest = { pageId: "page-new" } as never;
    vi.mocked(ensureLedgerDb).mockResolvedValue("ledger-db-id");
    vi.mocked(listLedgerEntries).mockResolvedValue([older, latest]);

    const res = await request("/vocabulary/review-packet", { headers: authHeaders() });
    expect(res.status).toBe(500);
    expect(readLedgerJson).not.toHaveBeenCalled();
  });

  it("readLedgerJson の失敗 (ハッシュ不一致など) は 500 で正直に落ちる (握り潰さない)", async () => {
    vi.mocked(ensureLedgerDb).mockResolvedValue("ledger-db-id");
    vi.mocked(listLedgerEntries).mockResolvedValue([{ pageId: "page-1" } as never]);
    vi.mocked(readLedgerJson).mockRejectedValue(new Error("ハッシュ不一致です"));

    const res = await request("/vocabulary/review-packet", { headers: authHeaders() });
    expect(res.status).toBe(500);
  });
});

describe("POST /vocabulary/proposals", () => {
  beforeEach(() => {
    process.env.VOCAB_REVIEW_TOKEN_SHA256 = TOKEN_HASH;
    vi.mocked(ensureLedgerDb).mockResolvedValue("ledger-db-id");
  });

  it("512KB 超の本文は 413 (JSON として読みもしない)", async () => {
    const huge = "a".repeat(600_000);
    const res = await request("/vocabulary/proposals", {
      method: "POST",
      headers: authHeaders(),
      body: huge,
    });
    expect(res.status).toBe(413);
    expect(ensureLedgerDb).not.toHaveBeenCalled();
  });

  it("Content-Length ヘッダが上限超過を申告していれば、本文を読む前に 413", async () => {
    // 本文を読み切る前に Content-Length だけで弾けることを確かめる
    // (本文自体は小さくても、ヘッダの自己申告が嘘でも安全側に倒す)。
    const res = await request("/vocabulary/proposals", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Length": "600000" },
      body: "{}",
    });
    expect(res.status).toBe(413);
    expect(ensureLedgerDb).not.toHaveBeenCalled();
  });

  it("JSON として壊れていれば 400", async () => {
    const res = await request("/vocabulary/proposals", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: "{ 壊れた json",
    });
    expect(res.status).toBe(400);
  });

  it("ProposalSchema に合わない形は 400 + issues", async () => {
    const res = await request("/vocabulary/proposals", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ baseVersion: "v1", noChange: false }), // sourcesChecked/changes 欠落
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("バリデーションエラー");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
    expect(createLedgerEntry).not.toHaveBeenCalled();
  });

  it("baseVersion が今の有効な版とズレていれば 409 (適用可否は判定しない)", async () => {
    vi.mocked(listLedgerEntries).mockResolvedValue([
      { version: "v2" } as never, // 台帳の「版・有効」は v2 に更新済み
    ]);
    const res = await request("/vocabulary/proposals", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(validProposal({ baseVersion: "v1" })),
    });
    expect(res.status).toBe(409);
    expect(createLedgerEntry).not.toHaveBeenCalled();
  });

  it("有効な版がちょうど1件でなければ (台帳異常) 502ではなく明示的に落ちる", async () => {
    vi.mocked(listLedgerEntries).mockResolvedValue([]); // 0件は台帳の整合性異常
    const res = await request("/vocabulary/proposals", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(validProposal()),
    });
    expect(res.status).toBe(500);
    expect(createLedgerEntry).not.toHaveBeenCalled();
  });

  it("形が正しく baseVersion も一致すれば 台帳に「提案・未審査」を作り 202", async () => {
    vi.mocked(listLedgerEntries).mockResolvedValue([{ version: "v1" } as never]);
    vi.mocked(createLedgerEntry).mockResolvedValue({
      pageId: "proposal-page-1",
      name: "提案 2026-08-03 06:00 JST",
      kind: "提案",
      state: "未審査",
      version: "v1",
      hash: "dummy-hash-from-mock",
      recordedAt: "2026-08-03",
      reason: "",
      diff: "",
      rollbackFrom: null,
    });
    const proposal = validProposal();

    const res = await request("/vocabulary/proposals", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(proposal),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: "proposal-page-1", state: "未審査" });
    expect(createLedgerEntry).toHaveBeenCalledWith(
      "ledger-db-id",
      expect.objectContaining({
        kind: "提案",
        state: "未審査",
        version: "v1",
        reason: "",
        diff: "",
        rollbackFrom: null,
        json: proposal,
      })
    );
    const call = vi.mocked(createLedgerEntry).mock.calls[0][1];
    expect(call.name).toMatch(/^提案 \d{4}-\d{2}-\d{2} \d{2}:\d{2} JST$/);
    expect(call.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("noChange:true の提案は状態「変更なし」で台帳に置く", async () => {
    vi.mocked(listLedgerEntries).mockResolvedValue([{ version: "v1" } as never]);
    vi.mocked(createLedgerEntry).mockResolvedValue({
      pageId: "proposal-page-2",
      name: "提案 2026-08-03 06:00 JST",
      kind: "提案",
      state: "変更なし",
      version: "v1",
      hash: "dummy-hash-from-mock",
      recordedAt: "2026-08-03",
      reason: noChangeProposal().reason ?? "",
      diff: "",
      rollbackFrom: null,
    });

    const res = await request("/vocabulary/proposals", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(noChangeProposal()),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: "proposal-page-2", state: "変更なし" });
    expect(createLedgerEntry).toHaveBeenCalledWith(
      "ledger-db-id",
      expect.objectContaining({ state: "変更なし", reason: noChangeProposal().reason })
    );
  });
});
