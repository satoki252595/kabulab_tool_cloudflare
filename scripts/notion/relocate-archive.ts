/**
 * 「バックアップ」ページ再配置マイグレーション (2026-09-25)。
 *
 * 背景: 旧「バックアップ」ページは有報テキストの銘柄コード毎の子ページ+
 * 子DB が数千件累積して Notion 上で開けなくなり、ユーザが当該ページを
 * トラッシュする事態になった。本スクリプトは新しく作られた単一 DB
 * 「有報テキスト」(`NOTION_YUHO_TEXT_DB_ID`) と、統合先ページ
 * 「一次データ保管」(`NOTION_ARCHIVE_PAGE_ID`) へ既存データを移す:
 *
 *   (a) D1 yuho_documents.notion_doc_page_id が指す各行 (Notion ページ) を、
 *       旧・銘柄コード毎の子DB から新しい単一 DB へ `POST /pages/{id}/move`
 *       で移動する (ページ ID・プロパティ・本文は維持されるため
 *       notion_doc_page_id は書き換え不要)。
 *   (b) 旧「バックアップ」直下の `一次データ｜<service>`/`銘柄一覧｜ir-catalog`
 *       DB と、旧「ごみ」直下の `ごみ｜<service>` DB を `一次データ保管`
 *       ページへ `PATCH /databases/{id}` (parent 変更) で移動する。
 *   (c) 旧「バックアップ」直下に残っている子ページ/子DB を列挙し、
 *       想定内 (銘柄コード子ページ。中身の「有報テキスト」子DBは (a) で
 *       空になっているはず) とそれ以外を分けて報告する。
 *
 * 冪等・再開可能: (a) は移動先が既に一致していればスキップする。(b) も
 * 現在の親を確認してからでないと移動しない (moveDatabase 自体は毎回上書き
 * PATCH だが、二重実行で壊れるものではない)。1 件の失敗で全体を止めず、
 * 失敗一覧を最後にまとめて表示する (ルール2: 握りつぶさない)。
 *
 * データベース移動 (b) は Notion 公式ドキュメント (2026-03-11 時点の
 * Update a database リファレンス) が PATCH /v1/databases/{id} の `parent`
 * でサポートすると記載しているのを根拠にした未検証の実装。**実 API での
 * 動作は未確認** — 失敗したら「API 非対応。Notion UI で手動移動してください」
 * と正直に報告する (捏造して成功扱いにしない)。
 *
 * 実行: pnpm notion:relocate-archive -- [--dry-run] [--limit=N] [--skip=a,b,c]
 *   --dry-run   : 何も書き込まず、何をするか (移動対象件数) だけ表示する
 *   --limit=N   : (a) の対象件数を先頭 N 件に絞る (動作確認用)
 *   --skip=a,b,c: 指定したフェーズをスキップする (例 --skip=b,c で (a) のみ)
 *
 * 必要 env (.env): NOTION_TOKEN, NOTION_ARCHIVE_PAGE_ID, NOTION_YUHO_TEXT_DB_ID,
 *   NOTION_YUHO_TEXT_DATA_SOURCE_ID, NOTION_BACKUP_PAGE_ID (移行元), 任意で
 *   NOTION_TRASH_PAGE_ID (ごみ配下の DB も動かす場合), CLOUDFLARE_API_TOKEN /
 *   CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID ((a) の D1 読取用)。
 */
import "dotenv/config";
import { isNotNull } from "drizzle-orm";
import { createD1HttpDb } from "../../src/shared/db/d1-http-client.js";
import * as yuhoSchema from "../../services/yuho-quant/src/db/schema.js";
import {
  findDatabasesByTitlePrefix,
  getDatabaseParentPageId,
  getPageParent,
  listDirectChildren,
  moveDatabase,
  movePage,
  notionEnv,
} from "../../src/shared/notion-archive/index.js";

const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const dryRun = process.argv.includes("--dry-run");
const limit = arg("limit") ? Number(arg("limit")) : Infinity;
const skip = new Set((arg("skip") ?? "").split(",").filter(Boolean));

/** 銘柄コード相当の子ページタイトル (4桁数字 or 英数字ティッカー) の粗い判定 */
const STOCK_CODE_LIKE = /^[0-9A-Za-z]{4,5}$/;

async function phaseA(): Promise<void> {
  if (skip.has("a")) {
    console.info("[relocate] (a) skip 指定によりスキップ");
    return;
  }
  const db = createD1HttpDb(yuhoSchema);
  const { yuhoDocuments } = yuhoSchema;
  const rows = await db
    .select({
      id: yuhoDocuments.id,
      docId: yuhoDocuments.docId,
      notionDocPageId: yuhoDocuments.notionDocPageId,
    })
    .from(yuhoDocuments)
    .where(isNotNull(yuhoDocuments.notionDocPageId));

  const targets = rows.slice(0, limit === Infinity ? rows.length : limit);
  console.info(
    `[relocate:a] 対象=${rows.length} 今回=${targets.length} dryRun=${dryRun}`
  );

  const targetDataSourceId = notionEnv.NOTION_YUHO_TEXT_DATA_SOURCE_ID();
  let moved = 0;
  let alreadyMoved = 0;
  let failed = 0;
  const failures: string[] = [];

  let n = 0;
  for (const r of targets) {
    const pageId = r.notionDocPageId;
    if (!pageId) continue; // where 句で除外済みのはずだが型上 null 許容のため防御
    try {
      const parent = await getPageParent(pageId);
      if (
        parent.type === "data_source_id" &&
        parent.data_source_id?.replace(/-/g, "") ===
          targetDataSourceId.replace(/-/g, "")
      ) {
        alreadyMoved++;
      } else if (dryRun) {
        console.info(
          `[relocate:a][dry-run] would move ${r.docId} (page=${pageId}) parent=${parent.type}`
        );
      } else {
        await movePage(pageId, {
          type: "data_source_id",
          data_source_id: targetDataSourceId,
        });
        moved++;
      }
    } catch (e) {
      failed++;
      const msg = `${r.docId} (page=${pageId}): ${(e as Error).message}`;
      failures.push(msg);
      console.error(`[relocate:a] 失敗 ${msg}`);
    }
    n++;
    if (n % 50 === 0) {
      console.info(
        `[relocate:a] ${n}/${targets.length} moved=${moved} already=${alreadyMoved} failed=${failed}`
      );
    }
  }

  console.info(
    `[relocate:a] 完了: moved=${moved} already_moved=${alreadyMoved} failed=${failed} (対象=${targets.length})`
  );
  if (failures.length > 0) {
    console.info("[relocate:a] 失敗一覧:");
    for (const f of failures) console.info(`  - ${f}`);
  }
}

interface DbMoveTarget {
  service: string;
  oldParentPageId: string;
  prefix: string;
}

async function phaseB(): Promise<void> {
  if (skip.has("b")) {
    console.info("[relocate] (b) skip 指定によりスキップ");
    return;
  }
  const targetPageId = notionEnv.NOTION_ARCHIVE_PAGE_ID();
  const oldBackup = notionEnv.NOTION_BACKUP_PAGE_ID();
  const oldTrash = notionEnv.NOTION_TRASH_PAGE_ID();

  const searches: DbMoveTarget[] = [];
  if (oldBackup) {
    searches.push(
      { service: "一次データ｜*", oldParentPageId: oldBackup, prefix: "一次データ｜" },
      { service: "銘柄一覧｜*", oldParentPageId: oldBackup, prefix: "銘柄一覧｜" }
    );
  } else {
    console.info(
      "[relocate:b] NOTION_BACKUP_PAGE_ID 未設定のため 一次データ｜*/銘柄一覧｜* は探索しない"
    );
  }
  if (oldTrash) {
    searches.push({ service: "ごみ｜*", oldParentPageId: oldTrash, prefix: "ごみ｜" });
  } else {
    console.info("[relocate:b] NOTION_TRASH_PAGE_ID 未設定のため ごみ｜* は探索しない");
  }

  let moved = 0;
  let alreadyMoved = 0;
  let failed = 0;
  const manualNeeded: string[] = [];

  for (const s of searches) {
    const found = await findDatabasesByTitlePrefix(s.oldParentPageId, s.prefix);
    console.info(`[relocate:b] ${s.service}: ${found.length} 件発見`);
    for (const db of found) {
      try {
        const currentParent = await getDatabaseParentPageId(db.id);
        if (
          currentParent &&
          currentParent.replace(/-/g, "") === targetPageId.replace(/-/g, "")
        ) {
          alreadyMoved++;
          continue;
        }
        if (dryRun) {
          console.info(
            `[relocate:b][dry-run] would move database "${db.title}" (${db.id})`
          );
          continue;
        }
        await moveDatabase(db.id, targetPageId);
        moved++;
        console.info(`[relocate:b] 移動: "${db.title}" (${db.id})`);
      } catch (e) {
        failed++;
        const msg = `"${db.title}" (${db.id}): ${(e as Error).message}`;
        manualNeeded.push(msg);
        console.error(
          `[relocate:b] 移動失敗 (API 非対応の可能性。手動移動が必要) ${msg}`
        );
      }
    }
  }

  console.info(
    `[relocate:b] 完了: moved=${moved} already_moved=${alreadyMoved} failed=${failed}`
  );
  if (manualNeeded.length > 0) {
    console.info(
      "[relocate:b] 以下は API での移動に失敗した。Notion UI で手動移動してください:"
    );
    for (const m of manualNeeded) console.info(`  - ${m}`);
  }
}

async function phaseC(): Promise<void> {
  if (skip.has("c")) {
    console.info("[relocate] (c) skip 指定によりスキップ");
    return;
  }
  const oldBackup = notionEnv.NOTION_BACKUP_PAGE_ID();
  if (!oldBackup) {
    console.info("[relocate:c] NOTION_BACKUP_PAGE_ID 未設定のためスキップ");
    return;
  }
  const { children, truncated } = await listDirectChildren(oldBackup);
  const stockCodeLike = children.filter(
    (c) => c.type === "child_page" && STOCK_CODE_LIKE.test(c.title)
  );
  const other = children.filter((c) => !stockCodeLike.includes(c));

  console.info(
    `[relocate:c] 旧バックアップ直下: 銘柄コード子ページ (想定内・中身は空DB化済のはず)=${stockCodeLike.length} 件 / それ以外=${other.length} 件`
  );
  if (truncated) {
    console.info(
      "[relocate:c] 警告: children 列挙が上限ページ数で打ち切られた可能性がある " +
        "(block children は約1万件で打ち切られる実測あり)。全件確認が必要なら " +
        "Notion UI で直接確認すること。"
    );
  }
  if (other.length > 0) {
    console.info("[relocate:c] それ以外の子要素一覧 (要確認):");
    for (const o of other) {
      console.info(`  - ${o.type} "${o.title}" (${o.id})`);
    }
  }
}

async function main() {
  console.info(`[relocate] 開始 dryRun=${dryRun} limit=${limit} skip=${[...skip].join(",") || "(none)"}`);
  await phaseA();
  await phaseB();
  await phaseC();
  console.info("[relocate] 全フェーズ完了");
}

main().catch((e) => {
  console.error(`[relocate] 致命的エラー: ${(e as Error).message}`);
  process.exitCode = 1;
});
