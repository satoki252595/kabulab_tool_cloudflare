/**
 * 単語帳の巻き戻し。設計: docs/005-yuho-quant-business-tags.md §11.5。
 *
 * 「指定した版と同じ内容の新しい版」を作る (内容を上書きしない・台帳の履歴は
 * 消さない。巻き戻しの巻き戻しも含めて全部残る)。
 */
import {
  createLedgerEntry,
  ensureLedgerDb,
  listLedgerEntries,
  readLedgerJson,
  updateLedgerEntry,
  type LedgerEntry,
} from "../../../../src/shared/notion-archive/index.js";
import { diffVocabularies } from "./vocabulary/diff.js";
import { parseVocabulary } from "./vocabulary/load.js";
import type { Vocabulary } from "./vocabulary/schema.js";

export interface RollbackResult {
  newVersion: string;
  fromVersion: string;
  rollbackFrom: string;
  entry: LedgerEntry;
}

function nextVersion(current: string): string {
  const m = /^v([1-9][0-9]*)$/.exec(current);
  if (!m) throw new Error(`rollback: 版名の形式が不正です: ${current}`);
  return `v${Number(m[1]) + 1}`;
}

/**
 * 単語帳を過去の版 `to` の内容へ巻き戻す。今の有効な版を「置換済」にし、
 * `to` と同じ内容を持つ新しい版 (次の連番) を「有効」として台帳へ記録する。
 * `recordedAt` は台帳の「記録日」(JST, YYYY-MM-DD)。
 */
export async function rollback(to: string, reason: string, recordedAt: string): Promise<RollbackResult> {
  if (reason.trim() === "") {
    throw new Error("rollback: reason (理由) は必須です");
  }
  const dbId = await ensureLedgerDb();
  const versions = await listLedgerEntries(dbId, { kind: "版" });

  const active = versions.filter((v) => v.state === "有効");
  if (active.length !== 1) {
    throw new Error(`rollback: 有効な版が ${active.length} 件です (ちょうど1件である必要があります)`);
  }
  const currentEntry = active[0];
  if (currentEntry.version === null) {
    throw new Error("rollback: 有効な版の版名が空です");
  }

  const targetEntry = versions.find((v) => v.version === to);
  if (!targetEntry) {
    throw new Error(`rollback: 巻き戻し先の版が台帳に見つかりません: ${to}`);
  }

  const targetVocab: Vocabulary = parseVocabulary(await readLedgerJson(targetEntry));
  const currentVocab: Vocabulary = parseVocabulary(await readLedgerJson(currentEntry));

  const newVersion = nextVersion(currentEntry.version);
  const newVocab: Vocabulary = { ...targetVocab, version: newVersion };
  const diff = diffVocabularies(currentVocab, newVocab);

  await updateLedgerEntry(currentEntry.pageId, {
    state: "置換済",
    reason: `${newVersion} への巻き戻し (基点 ${to}) により置換`,
  });

  const entry = await createLedgerEntry(dbId, {
    name: `版 ${newVersion}`,
    kind: "版",
    state: "有効",
    version: newVersion,
    reason,
    diff: diff.changedTermIds.join(", "),
    rollbackFrom: to,
    json: newVocab,
    recordedAt,
  });

  return { newVersion, fromVersion: currentEntry.version, rollbackFrom: to, entry };
}
