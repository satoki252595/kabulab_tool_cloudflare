/**
 * Issue #102: ①銘柄マスタ重複 (3681/7129) の単発解消 — 純粋ロジック。
 *
 * 対象は 2 コード限定。このモジュールは Notion/D1 への I/O を一切持たない
 * (I/O は `master-dedup-3681-7129.ts` が既存窓口経由で行う)。ここにあるのは
 * 期待値の定数・ガード・relation 置換・検証・receipt 判定のみで、全て単体
 * テストで回帰する (`master-dedup.test.ts`)。
 *
 * 保持先の決定規則は pipeline の既存正本
 * (`pipeline/src/jp_stock_pipeline/notion/upsert.py` の `oldest_page`:
 * created_time 最古・同分ならハイフン除去 page id 辞書順最小) と同一にする。
 * 全 writer が同じ規則で選ぶため、ここだけ別規則にしないこと。
 */
import { createHash } from "node:crypto";

/** 解消対象の 1 コード分の期待値 (2026-09-28 preflight 実測)。 */
export interface MasterTarget {
  code: "3681" | "7129";
  keepId: string;
  retireId: string;
  keepCreated: string;
  retireCreated: string;
  /** 最終更新日時の期待値。writer が触れれば変わるため、不一致は即停止。 */
  keepEdited: string;
  retireEdited: string;
  keepListed: boolean;
  keepStatus: string | null;
  retireListed: boolean;
  retireStatus: string | null;
  /** 逆 relation の期待件数 (④開示書類 / ③財務サマリ)。⑧⑨ は両行とも 0。 */
  keepIncoming: { disclosures: number; financials: number };
  retireIncoming: { disclosures: number; financials: number };
  /** 保持先に残る子 DB の title (退避しない。増減したら停止)。 */
  keepChildDatabases: string[];
}

export const TARGETS: MasterTarget[] = [
  {
    code: "3681",
    keepId: "38dd74ff-84cd-8147-842a-ea9c88839ce6",
    retireId: "38dd74ff-84cd-81e9-a5bc-fa1c52a29572",
    keepCreated: "2026-06-28T02:34:00.000Z",
    retireCreated: "2026-06-28T02:34:00.000Z",
    keepEdited: "2026-09-15T16:20:00.000Z",
    retireEdited: "2026-09-01T23:40:00.000Z",
    keepListed: false,
    keepStatus: null,
    retireListed: true,
    retireStatus: "上場廃止",
    keepIncoming: { disclosures: 0, financials: 0 },
    retireIncoming: { disclosures: 12, financials: 8 },
    keepChildDatabases: [],
  },
  {
    code: "7129",
    keepId: "38dd74ff-84cd-8130-a65e-dd0b0ab4e089",
    retireId: "38dd74ff-84cd-8167-a03c-cc53b4e5028b",
    keepCreated: "2026-06-28T02:44:00.000Z",
    retireCreated: "2026-06-28T06:44:00.000Z",
    keepEdited: "2026-09-10T17:31:00.000Z",
    retireEdited: "2026-06-28T06:44:00.000Z",
    keepListed: true,
    keepStatus: null,
    retireListed: true,
    retireStatus: null,
    keepIncoming: { disclosures: 10, financials: 8 },
    retireIncoming: { disclosures: 0, financials: 0 },
    keepChildDatabases: ["株価テクニカル履歴"],
  },
];

/** 一次データ保管の service 名 (単発用に新規。既存 service と混ぜない)。 */
export const ARCHIVE_SERVICE = "master-dedup-102";
/** 確定 snapshot の冪等キー (recordPrimaryData の key)。 */
export const SNAPSHOT_KEY = "master-dedup-3681-7129/snapshot/v1";

/**
 * relation プロパティ名。pipeline の `notion/schema.py` 定数
 * (`PROP_MASTER_RELATION` / `RAW_PROP_RELATED_MASTER`) と一致させること。
 * Python を import できないため文字列で持ち、適用前に実ページの
 * プロパティ型 (relation) を確認してから書く。
 */
export const REL_PROP_MASTER = "銘柄マスタ";
export const REL_PROP_RELATED = "関連銘柄";
/** ① 側の逆向き relation 表示名 (dual_property の自動生成名・実測)。 */
export const REVERSE_PROP_DISCLOSURES = "開示書類";
export const REVERSE_PROP_FINANCIALS = "財務サマリ";
export const REVERSE_PROP_JUKYU = "Related to ⑧ 需給 (銘柄マスタ)";
export const REVERSE_PROP_YUTAI = "Related to ⑨ 株主優待 (銘柄マスタ)";
/** ①→⑤ の順方向 relation (各行が自分の原本を指す)。 */
export const FWD_PROP_RAW = "原本";

/** 7129 の補足行 (master relation 空 → 保持 ID を設定する修復対象)。 */
export const SUPPLEMENT_7129_PAGE_ID = "3e6d74ff-84cd-81aa-ab14-e89f1cc47ccf";

/**
 * 3681 の lifecycle 決定 (一次出典で確定済み。推測で変えない):
 * JPX 上場廃止日 2026-07-01 (既に効力発生) + EDINET コードリスト該当 0。
 * 保持先 listed=false は維持し、状態だけ「上場廃止」へ部分更新する。
 * 7129 は listed=true / 状態 null のまま (変更なし)。
 */
export const LIFECYCLE_PATCH_3681_STATUS = "上場廃止";

/** 1 回の relation PATCH に許す JSON バイト上限の目安 (Notion 上限 500KB に安全側)。 */
export const RELATION_PATCH_BYTES_MAX = 400_000;

// ---------------------------------------------------------------------------
// 最古規則 (upsert.py `oldest_page` と同一)
// ---------------------------------------------------------------------------

/** page id の正規化 (ハイフン除去・小文字化。upsert.py `_normalize_page_id`)。 */
export function normalizePageId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

/**
 * 2 ページのうち正 (保持先) がどちらかを返す。同分なら正規化 id の辞書順最小。
 * created_time が欠けていれば推測で選ばず throw する (ルール2)。
 */
export function olderSide(
  a: { id: string; created_time: string | null | undefined },
  b: { id: string; created_time: string | null | undefined }
): "a" | "b" {
  if (!a.created_time || !b.created_time) {
    throw new Error(
      "olderSide: created_time が欠けているため正のページを決められません " +
        `(a=${a.id} created=${a.created_time} / b=${b.id} created=${b.created_time})`
    );
  }
  if (a.created_time !== b.created_time) return a.created_time < b.created_time ? "a" : "b";
  const na = normalizePageId(a.id);
  const nb = normalizePageId(b.id);
  if (na === nb) {
    throw new Error(`olderSide: 同一ページを比較しています id=${a.id}`);
  }
  return na < nb ? "a" : "b";
}

/**
 * 対象定数の keep/retire が最古規則と一致することを検証し、keepId を返す。
 * 一致しなければ throw (定数の取り違えを適用前に止める)。
 */
export function selectKeepId(t: MasterTarget): string {
  const side = olderSide(
    { id: t.keepId, created_time: t.keepCreated },
    { id: t.retireId, created_time: t.retireCreated }
  );
  if (side !== "a") {
    throw new Error(
      `selectKeepId: ${t.code} の keep/retire が最古規則と一致しません ` +
        `(keep=${t.keepId} ${t.keepCreated} / retire=${t.retireId} ${t.retireCreated})`
    );
  }
  return t.keepId;
}

// ---------------------------------------------------------------------------
// relation 置換 (他銘柄 ID を保つ)
// ---------------------------------------------------------------------------

/**
 * relation 配列内の退避 ID だけを保持 ID へ置換し、重複を除去する。
 * 順序は維持し、退避・保持以外の ID は一文字も変えない。
 * ⑤ の code-list 原本のように数千件の多銘柄配列でも全面上書きしない。
 */
export function replaceRelationId(
  before: string[],
  retireId: string,
  keepId: string
): { after: string[]; changed: boolean } {
  const wantRetire = normalizePageId(retireId);
  const wantKeep = normalizePageId(keepId);
  const after: string[] = [];
  const seen = new Set<string>();
  let changed = false;
  for (const id of before) {
    const n = normalizePageId(id);
    const mapped = n === wantRetire ? keepId : id;
    if (n === wantRetire) changed = true;
    const mn = normalizePageId(mapped);
    if (seen.has(mn)) {
      changed = true;
      continue;
    }
    seen.add(mn);
    after.push(mapped);
  }
  if (wantRetire === wantKeep) {
    throw new Error("replaceRelationId: retire と keep が同一 ID です");
  }
  return { after, changed };
}

// ---------------------------------------------------------------------------
// ガード (期待値との照合。不一致が 1 件でもあれば適用しない)
// ---------------------------------------------------------------------------

/** ガード用に切り出した ① ページの読み取り像。 */
export interface MasterPageView {
  id: string;
  code: string;
  created_time: string;
  last_edited_time: string;
  archived: boolean;
  in_trash: boolean;
  listed: boolean;
  status: string | null;
  /** 逆 relation 等の全 relation プロパティ (名前 → ID 群 + has_more)。 */
  relations: Record<string, { ids: string[]; has_more: boolean }>;
  /** ①→⑤ の順方向 relation (原本 ID 群)。 */
  rawIds: string[];
  blockCount: number;
  childDatabases: string[];
}

function relOf(
  v: MasterPageView,
  name: string
): { ids: string[]; has_more: boolean } | null {
  return v.relations[name] ?? null;
}

/**
 * 1 ページ分のガード。不一致の説明を返す (空 = 合格)。
 * has_more=true (25 件超の省略) があれば件数を信用せず不一致にする。
 */
export function guardMasterView(
  t: MasterTarget,
  role: "keep" | "retire",
  v: MasterPageView
): string[] {
  const problems: string[] = [];
  const tag = `${t.code}/${role}`;
  const wantId = role === "keep" ? t.keepId : t.retireId;
  if (normalizePageId(v.id) !== normalizePageId(wantId)) {
    problems.push(`${tag}: page id が期待と不一致 got=${v.id} want=${wantId}`);
    return problems;
  }
  if (v.code !== t.code) problems.push(`${tag}: 銘柄コード不一致 got=${v.code}`);
  if (v.archived || v.in_trash) {
    problems.push(`${tag}: 既に archived/in_trash (archived=${v.archived} in_trash=${v.in_trash})`);
  }
  const wantCreated = role === "keep" ? t.keepCreated : t.retireCreated;
  if (v.created_time !== wantCreated) {
    problems.push(`${tag}: created_time 不一致 got=${v.created_time} want=${wantCreated}`);
  }
  const wantEdited = role === "keep" ? t.keepEdited : t.retireEdited;
  if (v.last_edited_time !== wantEdited) {
    problems.push(
      `${tag}: last_edited_time 不一致 got=${v.last_edited_time} want=${wantEdited} (writer が更新した可能性)`
    );
  }
  const wantListed = role === "keep" ? t.keepListed : t.retireListed;
  if (v.listed !== wantListed) {
    problems.push(`${tag}: 上場状態不一致 got=${v.listed} want=${wantListed}`);
  }
  const wantStatus = role === "keep" ? t.keepStatus : t.retireStatus;
  if (v.status !== wantStatus) {
    problems.push(`${tag}: 状態不一致 got=${v.status} want=${wantStatus}`);
  }
  const wantIncoming = role === "keep" ? t.keepIncoming : t.retireIncoming;
  const disc = relOf(v, REVERSE_PROP_DISCLOSURES);
  const fin = relOf(v, REVERSE_PROP_FINANCIALS);
  if (!disc || !fin) {
    problems.push(`${tag}: 逆 relation プロパティが見つかりません (スキーマ変化の疑い)`);
  } else {
    if (disc.has_more || fin.has_more) {
      problems.push(`${tag}: 逆 relation に has_more=true (件数を信用できない)`);
    }
    if (disc.ids.length !== wantIncoming.disclosures) {
      problems.push(
        `${tag}: 開示書類の逆 relation 件数不一致 got=${disc.ids.length} want=${wantIncoming.disclosures}`
      );
    }
    if (fin.ids.length !== wantIncoming.financials) {
      problems.push(
        `${tag}: 財務サマリの逆 relation 件数不一致 got=${fin.ids.length} want=${wantIncoming.financials}`
      );
    }
  }
  for (const name of [REVERSE_PROP_JUKYU, REVERSE_PROP_YUTAI]) {
    const r = relOf(v, name);
    if (!r) {
      problems.push(`${tag}: 逆 relation ${name} が見つかりません (スキーマ変化の疑い)`);
    } else if (r.has_more || r.ids.length !== 0) {
      problems.push(`${tag}: ${name} に想定外の参照 (n=${r.ids.length} has_more=${r.has_more})`);
    }
  }
  if (v.rawIds.length !== 1) {
    problems.push(`${tag}: 原本の件数不一致 got=${v.rawIds.length} want=1`);
  }
  if (role === "retire") {
    if (v.blockCount !== 0) {
      problems.push(`${tag}: 退避候補に本文ブロックあり (n=${v.blockCount}。再判断が必要)`);
    }
  } else {
    const wantChildren = [...t.keepChildDatabases].sort();
    const gotChildren = [...v.childDatabases].sort();
    if (JSON.stringify(gotChildren) !== JSON.stringify(wantChildren)) {
      problems.push(
        `${tag}: 子 DB 不一致 got=[${gotChildren.join(",")}] want=[${wantChildren.join(",")}]`
      );
    }
  }
  return problems;
}

/** 補足 DB のガード像。 */
export interface SupplementView {
  /** 銘柄コード → 行 (pageId + master relation ID 群)。 */
  byCode: Record<string, Array<{ pageId: string; masterIds: string[] }>>;
  /** 4 ページ ID のいずれかを master relation に含む行 (コード横断)。 */
  rowsReferencingTargets: Array<{ pageId: string; code: string }>;
}

/** 補足のガード。3681 行なし・7129 行 1 件 master 空・対象参照なし。 */
export function guardSupplement(v: SupplementView): string[] {
  const problems: string[] = [];
  const rows3681 = v.byCode["3681"] ?? [];
  if (rows3681.length !== 0) {
    problems.push(`補足3681: 想定外の行あり (n=${rows3681.length})`);
  }
  const rows7129 = v.byCode["7129"] ?? [];
  if (rows7129.length !== 1) {
    problems.push(`補足7129: 行数不一致 got=${rows7129.length} want=1`);
  } else {
    const row = rows7129[0];
    if (normalizePageId(row.pageId) !== normalizePageId(SUPPLEMENT_7129_PAGE_ID)) {
      problems.push(`補足7129: page id 不一致 got=${row.pageId}`);
    }
    if (row.masterIds.length !== 0) {
      problems.push(`補足7129: master relation が既に設定済み (n=${row.masterIds.length})`);
    }
  }
  if (v.rowsReferencingTargets.length !== 0) {
    problems.push(
      `補足: 対象 4 ページを参照する行あり (n=${v.rowsReferencingTargets.length})`
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 移行計画と検証
// ---------------------------------------------------------------------------

export type IncomingDb = "financials" | "disclosures" | "raw_files";

export interface MigrationOp {
  rowPageId: string;
  db: IncomingDb;
  /** 書き換える relation プロパティ名 (③④=銘柄マスタ / ⑤=関連銘柄)。 */
  prop: string;
  before: string[];
  after: string[];
}

/**
 * 実配列から移行 op 群を作る。呼び出し側は各行の relation 実配列を
 * snapshot 時に読んで渡すこと。実配列に退避 ID が無い行は op にしない
 * (推測で書かない)。変化のない行も op にしない。
 */
export function planMigration(args: {
  retireId: string;
  keepId: string;
  rows: Array<{ rowPageId: string; db: IncomingDb; prop: string; actualBefore: string[] }>;
}): MigrationOp[] {
  const ops: MigrationOp[] = [];
  for (const row of args.rows) {
    const { after, changed } = replaceRelationId(
      row.actualBefore,
      args.retireId,
      args.keepId
    );
    if (!changed) continue;
    ops.push({
      rowPageId: row.rowPageId,
      db: row.db,
      prop: row.prop,
      before: row.actualBefore,
      after,
    });
  }
  return ops;
}

/**
 * 移行後の実配列を検証する。op.after と完全一致しなければ理由を返す。
 * (null = 合格)。他銘柄 ID の欠落・順序の変化も検出する。
 */
export function verifyOpResult(op: MigrationOp, remoteAfter: string[]): string | null {
  const norm = (ids: string[]) => ids.map(normalizePageId);
  if (JSON.stringify(norm(remoteAfter)) !== JSON.stringify(norm(op.after))) {
    return (
      `移行結果不一致 row=${op.rowPageId} prop=${op.prop}: ` +
      `got=[${remoteAfter.join(",")}] want=[${op.after.join(",")}]`
    );
  }
  return null;
}

/**
 * ① 逆 relation の和の保存を検証する。保持先の移行後 = 移行前の和
 * (退避→保持へ読み替え) と完全一致しなければ理由を返す (null = 合格)。
 */
export function verifyReverseUnion(args: {
  label: string;
  keepBefore: string[];
  retireBefore: string[];
  keepAfter: string[];
  retireId: string;
  keepId: string;
}): string | null {
  const { after: want } = replaceRelationId(
    [...args.keepBefore, ...args.retireBefore],
    args.retireId,
    args.keepId
  );
  const sortNorm = (ids: string[]) => ids.map(normalizePageId).sort();
  if (JSON.stringify(sortNorm(args.keepAfter)) !== JSON.stringify(sortNorm(want))) {
    return (
      `${args.label}: 逆 relation の和が保存されていません ` +
      `got=${args.keepAfter.length}件 want=${want.length}件`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// 正準化・ハッシュ・比較
// ---------------------------------------------------------------------------

/** キーを再帰的に整列した JSON (ハッシュ・比較の正準形)。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** UTF-8 文字列の SHA-256 hex。 */
export function sha256HexUtf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** バイト列の SHA-256 hex (証拠ファイル用。文字列経由にしない)。 */
export function sha256HexBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 1 プロパティを除いて properties 全体が等しいか (③④ の数値/出典/日時
 * 不変・補足の他 props 不変の検証用)。順序・表記ゆれは吸収しない —
 * Notion の返却形状は安定しているため厳密比較し、差があれば止める。
 */
export function propertiesEqualExcept(
  exceptProp: string,
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (k === exceptProp) continue;
    if (stableStringify(a[k]) !== stableStringify(b[k])) return false;
  }
  return true;
}

/**
 * relation PATCH の概算バイト数 (Notion 要求上限への抵触を事前に検出)。
 * 上限超えは切り詰めず呼び出し側が停止する (ルール2)。
 */
export function relationPatchBytes(prop: string, after: string[]): number {
  return Buffer.byteLength(
    JSON.stringify({ properties: { [prop]: { relation: after.map((id) => ({ id })) } } }),
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// receipt (中断再開。非冪等 create の二重実行防止)
// ---------------------------------------------------------------------------

export interface DedupReceipt {
  version: 1;
  snapshot?: {
    file: string;
    sha256: string;
    archivePageId: string;
    archiveVerifiedAt: string;
  };
  lifecycle3681?: { patchedAt: string; verifiedAt: string };
  migrated: Record<
    string,
    { db: IncomingDb; prop: string; before: string[]; after: string[]; verifiedAt: string }
  >;
  supplement7129?: { pageId: string; verifiedAt: string };
  retired: Record<string, { trashPageId: string; verifiedAt: string }>;
  d1?: { checkedAt: string; fixed: string[]; verifiedAt: string };
  completedAt?: string;
}

export function emptyReceipt(): DedupReceipt {
  return { version: 1, migrated: {}, retired: {} };
}

/** receipt 済みを除いた未実行 op 群 (再開用)。 */
export function pendingMigrationOps(
  ops: MigrationOp[],
  receipt: DedupReceipt
): MigrationOp[] {
  return ops.filter((op) => receipt.migrated[op.rowPageId] === undefined);
}

/** 全 op が receipt 済みか。 */
export function allMigrated(ops: MigrationOp[], receipt: DedupReceipt): boolean {
  return pendingMigrationOps(ops, receipt).length === 0;
}
