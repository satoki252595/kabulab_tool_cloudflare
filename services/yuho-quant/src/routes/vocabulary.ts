/**
 * 005 yuho-quant — 事業タグ単語帳(語彙)の年次見直し受付ルート。
 * 設計: docs/005-yuho-quant-business-tags.md §6.2。
 *
 * Cursor Automation (年 1 回・8月) が
 *   GET  /yuho-quant/vocabulary/review-packet … 見直し材料 (台帳) を読む
 *   POST /yuho-quant/vocabulary/proposals     … 変更案を台帳へ「提案」で置く
 * を叩く。認証は合言葉 (`Authorization: Bearer <token>`) の SHA-256 を
 * `VOCAB_REVIEW_TOKEN_SHA256` (wrangler.toml [vars]) と定数時間比較する。
 * 未設定なら常に 401 を返す (fail-closed。CLAUDE.md ルール2)。
 *
 * ここでは **重い検査はしない** (`validateVocabulary`・出典 URL の実在確認・
 * jev ゴールデンセット再評価は `pnpm biztag gate` の責務)。Worker の実行時間・
 * サブリクエスト数を使わないための意図的な役割分担 (§6.2)。
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  createLedgerEntry,
  ensureLedgerDb,
  listLedgerEntries,
  readLedgerJson,
} from "../../../../src/shared/notion-archive/index.js";
import { sha256Hex, timingSafeEqualHex } from "../../../../src/shared/sha256.js";
import { ProposalSchema } from "../biztag/vocabulary/index.js";
import { yuhoEnv } from "../env.js";

export const vocabularyRoute = new Hono({ strict: false });

/** POST /proposals の本文上限 (§6.2 の受付だけ・重い検査をしない設計に合わせた安全上限) */
const MAX_PROPOSAL_BODY_BYTES = 512 * 1024;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `Authorization: Bearer <token>` の token 部分。形式不正・欠落は null。 */
function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return null;
  return parts[1].length > 0 ? parts[1] : null;
}

/** 台帳の提案名・記録日 (JST 壁時計) を作る。 */
function formatProposalRecord(now: Date): { name: string; recordedAt: string } {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = jst.getUTCFullYear();
  const m = pad(jst.getUTCMonth() + 1);
  const d = pad(jst.getUTCDate());
  const recordedAt = `${y}-${m}-${d}`;
  const hh = pad(jst.getUTCHours());
  const mm = pad(jst.getUTCMinutes());
  return { name: `提案 ${recordedAt} ${hh}:${mm} JST`, recordedAt };
}

/**
 * 合言葉認証 (fail-closed)。`VOCAB_REVIEW_TOKEN_SHA256` が未設定なら
 * トークンの中身を見るまでもなく常に 401 を返す (既定で通してしまう
 * 実装ミスを避ける)。
 */
vocabularyRoute.use("/*", async (c, next) => {
  const expectedHash = yuhoEnv.VOCAB_REVIEW_TOKEN_SHA256();
  if (expectedHash === undefined) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const token = extractBearerToken(c.req.header("Authorization"));
  if (token === null) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const tokenHash = await sha256Hex(token);
  if (!timingSafeEqualHex(tokenHash, expectedHash)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

/**
 * 台帳の「見直し材料」(状態=最新) をハッシュ照合つきで読んで返す。
 * 無ければ 404 (「見直し材料がまだありません」— 黙って空オブジェクトを
 * 返さない・ルール2)。
 */
vocabularyRoute.get("/review-packet", async (c) => {
  const dbId = await ensureLedgerDb();
  const entries = await listLedgerEntries(dbId, {
    kind: "見直し材料",
    state: "最新",
  });
  if (entries.length > 1) {
    // refreshReviewPacketLedger (review.ts) と同じ不変条件 (「最新」はちょうど
    // 1件) を検査する。ここだけ黙って最後の1件へ縮退させない (ルール2)。
    throw new Error(`台帳の「見直し材料」の「最新」行が複数あります (${entries.length}件)`);
  }
  const latest = entries[0];
  if (!latest) {
    return c.json({ error: "見直し材料がまだありません" }, 404);
  }
  const packet = await readLedgerJson(latest);
  return c.json(packet as Record<string, unknown>);
});

/**
 * 単語帳への変更提案を受け付ける。形の検査 (zod) だけ行い、台帳へ
 * 「提案」として保存する。基にした版が今の有効な版と食い違う場合は
 * 409 (提案者に基版のズレを機械的に気づかせる — 適用可否の意味検査は
 * `pnpm biztag gate` に委ねる)。
 */
vocabularyRoute.post(
  "/proposals",
  // Content-Length があればヘッダだけで判定し (本文を読まない)、無い/
  // 信頼できない場合はストリームを読みながら上限超過で即座に中断する
  // (`c.req.text()` で本文を全部バッファしてから数える方式だと、
  // Content-Length を付けない/偽装したリクエストが実際には
  // MAX_PROPOSAL_BODY_BYTES を大幅に超えるバイト列を最後まで読み切って
  // メモリに載せてしまう — hono/body-limit はストリームを見ながら中断する)。
  bodyLimit({
    maxSize: MAX_PROPOSAL_BODY_BYTES,
    onError: (c) =>
      c.json({ error: `リクエストボディが大きすぎます (${MAX_PROPOSAL_BODY_BYTES} バイト以下)` }, 413),
  }),
  async (c) => {
    const rawBody = await c.req.text();

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "JSON の形式が不正です" }, 400);
    }

    const result = ProposalSchema.safeParse(parsed);
    if (!result.success) {
      return c.json({ error: "バリデーションエラー", issues: result.error.issues }, 400);
    }
    const proposal = result.data;

    const dbId = await ensureLedgerDb();
    const activeEntries = await listLedgerEntries(dbId, { kind: "版", state: "有効" });
    if (activeEntries.length !== 1) {
      // 0 件・2 件以上は台帳の整合性異常 (運営が直すべき事態)。既定値で
      // 埋めて 202 を返さず、はっきり失敗させる (ルール2)。
      throw new Error(
        `台帳の有効な版がちょうど1件ではありません (${activeEntries.length}件)`
      );
    }
    const activeVersion = activeEntries[0].version;
    if (activeVersion === null) {
      // 版名が空は台帳データ不整合 (rollback.ts と同じ規約)。ここを ?? "不明" で
      // 埋めると通常のバージョン不一致 409 と見分けが付かなくなる (ルール2)。
      throw new Error("台帳の有効な版の版名が空です (Notion 上のデータ不整合)");
    }
    if (activeVersion !== proposal.baseVersion) {
      return c.json(
        { error: `baseVersion (${proposal.baseVersion}) が今の有効な版 (${activeVersion}) と一致しません` },
        409
      );
    }

    // noChange:true も含め、提案は常に「未審査」で台帳に置く (docs §2 の図・
    // §6.2: 「台帳 DB に『提案（未審査）』」)。ここで noChange を見て
    // 「変更なし」に確定させてしまうと `pnpm biztag gate` (runGate) の対象
    // (state: 未審査) から外れてしまい、`理由` 列 (関門の判定理由。コードが
    // 作る文で、提案者の作文は入れない契約 — §3.2 の表) に提出者の自由記述が
    // そのまま残り続ける。`理由` は関門 (`evaluateProposal` の no_change 分岐)
    // が確定するので、ここでは空のまま渡す。
    const { name, recordedAt } = formatProposalRecord(new Date());
    const entry = await createLedgerEntry(dbId, {
      name,
      kind: "提案",
      state: "未審査",
      version: proposal.baseVersion,
      reason: "",
      diff: "",
      rollbackFrom: null,
      json: proposal,
      recordedAt,
    });
    return c.json({ id: entry.pageId, state: entry.state }, 202);
  }
);
