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
  /**
   * 退避候補の逆 relation 期待件数 (④開示書類 / ③財務サマリ。移行前形状)。
   * ⑧⑨ は両行とも 0。
   * 保持先の件数期待は持たない — 件数固定は陳腐化した (7129 keep の
   * 開示 10→11 valid-addition)。保持先は証明済み ID 集合ガード
   * (`guardKeeperIncomingIds`) で保護する。
   */
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
    retireIncoming: { disclosures: 0, financials: 0 },
    keepChildDatabases: ["株価テクニカル履歴"],
  },
];

/** 一次データ保管の service 名 (単発用に新規。既存 service と混ぜない)。 */
export const ARCHIVE_SERVICE = "master-dedup-102";
/** 確定 snapshot の冪等キー (recordPrimaryData の key)。 */
export const SNAPSHOT_KEY = "master-dedup-3681-7129/snapshot/v1";
/**
 * 完全 proof 版 snapshot (v2。本文全 capture + 添付 inventory + physical 添付)
 * の冪等キー。v1 レコードは不変のまま残し、v2 は別レコードとして保存する
 * (v1 の skipped_existing を new full proof として採用しない)。
 */
export const SNAPSHOT_KEY_V2 = "master-dedup-3681-7129/snapshot/v2";

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
 * 保持先 (keep) の ④③ 逆 relation はここでは見ない —
 * 件数固定は陳腐化するため、live 全 ID 集合ガード
 * (`guardKeeperIncomingIds` + take 固定 + 直後再読) が担当する。
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
  const disc = relOf(v, REVERSE_PROP_DISCLOSURES);
  const fin = relOf(v, REVERSE_PROP_FINANCIALS);
  if (!disc || !fin) {
    problems.push(`${tag}: 逆 relation プロパティが見つかりません (スキーマ変化の疑い)`);
  } else if (role === "retire") {
    // 退避候補のみ件数で縛る (移行前形状。take 候補はこの preview から採る
    // ため has_more の打切りもここで止める)。keep は集合ガードへ委譲。
    const wantIncoming = t.retireIncoming;
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
// 保持先 incoming の ID 集合ガード (件数 baseline の置換)
// ---------------------------------------------------------------------------

/**
 * 保持先 incoming 1 行の membership 証明 (live 観測値)。
 * baseline 外の追加行はこの 3 点が揃うものだけ許可する。
 * 欠測は null/未完フラグのまま渡し、ここで停止理由にする (推測で埋めない)。
 */
export interface KeeperRowProof {
  rowPageId: string;
  /** 行の「銘柄コード」実値 (rich_text 連結。欠測・型違いは null)。 */
  issuerCode: string | null;
  /** 原本 relation の打切り (true なら未完として停止)。 */
  originHasMore: boolean;
  /** 原本 relation の完全件数。 */
  originCount: number;
  /** master relation 全 ID (readRelationFull 実配列)。 */
  masterIdsFull: string[];
}

/** 保持先 incoming の既知 baseline (実証跡由来の証明済み ID 集合)。 */
export interface KeeperIncomingBaseline {
  disclosures: string[];
  financials: string[];
}

/**
 * 保持先 incoming の集合ガード。live 全 ID と既知 baseline を集合比較する。
 * - baseline 喪失 (既知 ID の消失) → 理由を返す (STOP)
 * - 追加行 (live−baseline) → issuer/原本/keep-only membership の実証が
 *   `addedProofs` に揃うものだけ許可。1 行でも欠ければ理由を返す (STOP)
 * - 未完 pagination は呼出側 readRelationFull が throw する前提
 *   (ここには完全配列だけが来る)
 * 戻りは verifyReverseUnion と同じ成功=null 規約。
 */
export function guardKeeperIncomingIds(args: {
  tag: string;
  code: "3681" | "7129";
  keepId: string;
  liveIds: string[];
  baselineIds: string[];
  addedProofs: KeeperRowProof[];
}): string | null {
  const live = new Map(args.liveIds.map((id) => [normalizePageId(id), id]));
  const baseline = new Map(args.baselineIds.map((id) => [normalizePageId(id), id]));
  const missing = [...baseline.keys()].filter((k) => !live.has(k));
  if (missing.length > 0) {
    const ids = missing.map((k) => baseline.get(k) as string);
    return (
      `${args.tag}: 既知 baseline の喪失を検出 (n=${missing.length} 行が live にありません): ` +
      `${ids.join(",")}`
    );
  }
  const added = [...live.keys()].filter((k) => !baseline.has(k));
  if (added.length === 0) return null;
  const proofOf = new Map(args.addedProofs.map((p) => [normalizePageId(p.rowPageId), p]));
  const keepNorm = normalizePageId(args.keepId);
  for (const k of added) {
    const id = live.get(k) as string;
    const proof = proofOf.get(k);
    if (!proof) {
      return `${args.tag}: 未証明の追加行があるため停止します row=${id} (issuer/原本/membership の実証なし)`;
    }
    if (proof.issuerCode !== args.code) {
      return `${args.tag}: 追加行の発行者が不一致のため停止します row=${id} got=${proof.issuerCode} want=${args.code}`;
    }
    if (proof.originHasMore) {
      return `${args.tag}: 追加行の原本 relation が未完のため停止します row=${id} (has_more)`;
    }
    if (proof.originCount < 1) {
      return `${args.tag}: 追加行に原本が無いため停止します row=${id} (原本 0 件)`;
    }
    const masters = proof.masterIdsFull.map(normalizePageId).sort();
    if (masters.length !== 1 || masters[0] !== keepNorm) {
      return (
        `${args.tag}: 追加行の membership が keep-only でないため停止します row=${id} ` +
        `masters=[${proof.masterIdsFull.join(",")}]`
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 移行計画と検証
// ---------------------------------------------------------------------------

export type IncomingDb = "financials" | "disclosures" | "raw_files";
/** incoming 候補の発見由来。同一行の重複は reverse 優先。 */
export type IncomingOrigin = "reverse" | "fwd";

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
/**
 * Notion Files プロパティの安定同一性への正規化 (純粋)。
 * hosted (`type: "file"`) の署名 URL は短期認証情報 (query=署名・期限)
 * のため resource (host+path) のみで比べ、query と expiry_time を捨てる。
 * rotation (同 object の再署名) だけを同一判定する。
 * external の URL は利用者管理の安定値として全体比較する
 * (無差別 strip 禁止)。name/type の不一致・未知形状は fail closed。
 * 実 bytes の同一性は capture proof (files inventory の bytes SHA) が
 * 全呼出側で併せて検証する (props 比較と proof の二重関門)。
 */
function normalizeFilePropForCompare(prop: unknown): { ok: true; norm: unknown } | { ok: false } {
  const p = prop as { type?: unknown; files?: unknown };
  if (!p || typeof p !== "object" || p.type !== "files" || !Array.isArray(p.files)) {
    return { ok: false };
  }
  const norm: Array<{ name: string; kind: string; resource: string }> = [];
  for (const f of p.files) {
    const e = f as {
      name?: unknown;
      type?: unknown;
      file?: { url?: unknown };
      external?: { url?: unknown };
    };
    if (!e || typeof e !== "object" || typeof e.name !== "string" || e.name === "") {
      return { ok: false };
    }
    if (e.type === "file") {
      const url = e.file?.url;
      if (typeof url !== "string") return { ok: false };
      const resource = url.split("?")[0];
      if (!resource.startsWith("https://") || resource.length <= "https://".length) {
        return { ok: false };
      }
      norm.push({ name: e.name, kind: "hosted", resource });
    } else if (e.type === "external") {
      const url = e.external?.url;
      if (typeof url !== "string" || url === "") return { ok: false };
      norm.push({ name: e.name, kind: "external", resource: url });
    } else {
      return { ok: false };
    }
  }
  return { ok: true, norm };
}

/**
 * 1 プロパティ分の等価判定 (純粋)。Files 型は安定同一性で比べる。
 * 片側だけ Files (型変化)・正規化不能は不一致 (fail closed)。
 */
function propValueEqual(a: unknown, b: unknown): boolean {
  const at = (a as { type?: unknown } | undefined)?.type;
  const bt = (b as { type?: unknown } | undefined)?.type;
  if (at === "files" || bt === "files") {
    if (at !== "files" || bt !== "files") return false;
    const na = normalizeFilePropForCompare(a);
    const nb = normalizeFilePropForCompare(b);
    if (!na.ok || !nb.ok) return false;
    return stableStringify(na.norm) === stableStringify(nb.norm);
  }
  return stableStringify(a) === stableStringify(b);
}

export function propertiesEqualExcept(
  exceptProp: string,
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (k === exceptProp) continue;
    if (!propValueEqual(a[k], b[k])) return false;
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
    /** 実ダウンロード検証用の元バイト列 SHA (snapshot ファイル・公式 ZIP/HTML)。 */
    snapshotBytesSha256?: string;
    zipSha256?: string;
    htmlSha256?: string;
    fileNames?: string[];
  };
  /** snapshot 非冪等 create の発行マーカー (helper 呼出前に atomic 保存)。 */
  snapshotIssued?: { key: string; snapshotHash: string; issuedAt: string };
  /**
   * v2 snapshot の保管記録 (v1 `snapshot` とは別枠。混在したら gate が停止)。
   * attachmentShas は保管レコードの添付名 → 実バイト列 SHA。
   */
  snapshotV2?: {
    file: string;
    sha256: string;
    archivePageId: string;
    archiveVerifiedAt: string;
    snapshotBytesSha256?: string;
    zipSha256?: string;
    htmlSha256?: string;
    attachmentShas?: Record<string, string>;
    fileNames?: string[];
  };
  /** v2 snapshot 非冪等 create の発行マーカー (v1 marker とは別枠)。 */
  snapshotV2Issued?: { key: string; snapshotHash: string; issuedAt: string };
  lifecycle3681?: { patchedAt: string; verifiedAt: string };
  migrated: Record<
    string,
    { db: IncomingDb; prop: string; before: string[]; after: string[]; verifiedAt: string }
  >;
  supplement7129?: { pageId: string; verifiedAt: string };
  /**
   * 退避候補の直接 archive 記録 (retireId → 記録)。
   * master ページは一次データ保管のレコードではないため moveToTrash の対象外
   * (共有 helper が Service 不一致で保全停止する)。pipeline の重複収束と同じく
   * 直接 archive し、証拠は snapshot (一次データ保管) + 本記録で保つ。
   * archivedAt は archive 後の再読 API の last_edited_time (推測値ではない)。
   */
  retired: Record<string, { archivedAt: string; verifiedAt: string }>;
  /** 退避 archive 発行マーカー (retireId → 発行記録)。自動解除禁止。 */
  retireIssued?: Record<string, { key: string; origin: string; snapshotHash: string; issuedAt: string }>;
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

/** receipt に何らかの進捗 (snapshot 確定以降) があるか。再開判定用。 */
export function hasSnapshotProgress(receipt: DedupReceipt): boolean {
  return (
    receipt.snapshot !== undefined ||
    receipt.snapshotIssued !== undefined ||
    receipt.snapshotV2 !== undefined ||
    receipt.snapshotV2Issued !== undefined ||
    receipt.lifecycle3681 !== undefined ||
    Object.keys(receipt.migrated).length > 0 ||
    receipt.supplement7129 !== undefined ||
    Object.keys(receipt.retired).length > 0 ||
    (receipt.retireIssued !== undefined && Object.keys(receipt.retireIssued).length > 0) ||
    receipt.d1 !== undefined
  );
}

// ---------------------------------------------------------------------------
// incoming スキーマ列挙 (未知 incoming の検出。/search→schema のみ。全行 scan 不要)
// ---------------------------------------------------------------------------

/** master 向け relation を持つ DB の 1 ヒット。 */
export interface IncomingSchemaHit {
  dbId: string;
  dbTitle: string;
  propName: string;
  relType: "dual_property" | "single_property" | "unknown";
}

export interface IncomingSchemaEvidence {
  enumeratedAt: string;
  dbCount: number;
  hits: IncomingSchemaHit[];
  /**
   * schema の取得経路の内訳 (search 応答の schema 再利用 + 不足分のみ GET)。
   * 旧証拠には無いため optional。v2 snapshot では必須とし、
   * searchSchemaUsed + getSchemaUsed === dbCount を gate が要求する
   * (schema の省略を許さない)。
   */
  schemaProvenance?: { searchSchemaUsed: number; getSchemaUsed: number };
}

/**
 * 既知の incoming (2026-09-28 preflight 実測 + pipeline 正本)。
 * ③④⑤ は pipeline `DB_REGISTRY` の title、⑧⑨ は ① 側の逆向き自動生成名
 * ("Related to ⑧ 需給 (銘柄マスタ)") からの逆算、補足は `SUPPLEMENT_DB_TITLE`。
 * これ以外が 1 件でもあれば未知 incoming として STOP する (fail closed)。
 */
export const KNOWN_MASTER_INCOMING: ReadonlyArray<{
  title: string;
  prop: string;
  rel: IncomingSchemaHit["relType"];
}> = [
  { title: "③ 財務サマリ", prop: REL_PROP_MASTER, rel: "dual_property" },
  { title: "④ 開示書類", prop: REL_PROP_MASTER, rel: "dual_property" },
  { title: "⑤ 原本ファイル", prop: REL_PROP_RELATED, rel: "dual_property" },
  { title: "⑧ 需給", prop: REL_PROP_MASTER, rel: "dual_property" },
  { title: "⑨ 株主優待", prop: REL_PROP_MASTER, rel: "dual_property" },
  { title: "銘柄マスタ（補足）", prop: "銘柄マスタ", rel: "single_property" },
];

/**
 * 列挙ヒットが既知のみか検証する。未知が 1 件でもあれば理由を返す (空=合格)。
 * 不足 (既知の欠落) はここでは問わない — 逆 relation ガード・補足ガードが
 * 別途検出する。未知の追加だけを fail closed で止める。
 */
export function guardIncomingSchema(hits: IncomingSchemaHit[]): string[] {
  const problems: string[] = [];
  for (const h of hits) {
    const known = KNOWN_MASTER_INCOMING.some(
      (k) => k.title === h.dbTitle && k.prop === h.propName && k.rel === h.relType
    );
    if (!known) {
      problems.push(
        `未知の incoming: db=${h.dbTitle} (${h.dbId}) prop=${h.propName} rel=${h.relType}`
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 中間状態ガード (receipt+snapshot に基づく before/after のみ許可)
// ---------------------------------------------------------------------------

/**
 * relation 型を除いて properties 全体が等しいか (退避直前の非 relation 比較用)。
 * 移行後は逆 relation が空になるため、relation は比較対象外とする。
 */
export function nonRelationPropsEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const at = (a[k] as { type?: unknown } | undefined)?.type;
    const bt = (b[k] as { type?: unknown } | undefined)?.type;
    if (at === "relation" || bt === "relation") continue;
    if (!propValueEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * 中間状態の逆 relation 和の保存を検証する。fresh の keep∪retire が snapshot の
 * keep∪retire と集合一致しなければ理由を返す (null=合格)。部分移行 (中間件数)
 * を許しつつ、新規不明 ID・欠落を検出する。順序は問わない (逆向き表示のため)。
 */
export function verifyIntermediateUnion(args: {
  label: string;
  snapKeep: string[];
  snapRetire: string[];
  freshKeep: string[];
  freshRetire: string[];
}): string | null {
  const normSet = (ids: string[]) =>
    [...new Set(ids.map(normalizePageId))].sort();
  const want = normSet([...args.snapKeep, ...args.snapRetire]);
  const got = normSet([...args.freshKeep, ...args.freshRetire]);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    const wantSet = new Set(want);
    const gotSet = new Set(got);
    const missing = want.filter((id) => !gotSet.has(id));
    const extra = got.filter((id) => !wantSet.has(id));
    return (
      `${args.label}: 中間状態の逆 relation 和が保存されていません ` +
      `(欠落 ${missing.length} 件・不明 ${extra.length} 件)`
    );
  }
  return null;
}

/**
 * receipt 済みの移行 op 行 ID (code+DB 限定)。D1 前 union の意図状態用。
 * before に退避 ID を含む op のうち receipt.migrated にあるものだけ返す。
 */
export function completedMigrationRowIds(
  ops: MigrationOp[],
  migrated: DedupReceipt["migrated"],
  retireId: string,
  db: IncomingDb
): string[] {
  const wantRetire = normalizePageId(retireId);
  return ops
    .filter(
      (op) =>
        op.db === db &&
        op.before.some((id) => normalizePageId(id) === wantRetire) &&
        migrated[op.rowPageId] !== undefined
    )
    .map((op) => op.rowPageId);
}

/**
 * D1 前の union 一致 (全 pagination 実配列で呼ぶ。preview 不可)。
 * 期待 keep 集合 = snapshot 固定 keeper ∪ 移行済み、
 * 期待 retire 集合 = snapshot 退避 − 移行済み と live が完全一致すること。
 * retire archived 時は retire 側を問わない (終端状態。archived 自体は
 * 呼出側・最終検証が別途断定する)。戻りは成功=null 規約。
 */
export function verifyPreD1Union(args: {
  label: string;
  snapKeep: string[];
  snapRetire: string[];
  liveKeepFull: string[];
  liveRetireFull: string[] | null;
  expectedMigrated: string[];
  retireArchived: boolean;
}): string | null {
  const normSet = (ids: string[]) => [...new Set(ids.map(normalizePageId))].sort();
  const snapKeepSet = new Set(normSet(args.snapKeep));
  const snapRetireSet = new Set(normSet(args.snapRetire));
  const migratedSet = new Set(normSet(args.expectedMigrated));
  // 移行済みのはずが snapshot 退避に無い = stale 記録。
  const stale = [...migratedSet].filter((id) => !snapRetireSet.has(id));
  if (stale.length > 0) {
    return `${args.label}: 移行済み記録が snapshot 退避にありません (stale ${stale.length} 件)`;
  }
  const wantKeep = normSet([...snapKeepSet, ...migratedSet]);
  const gotKeep = normSet(args.liveKeepFull);
  if (JSON.stringify(gotKeep) !== JSON.stringify(wantKeep)) {
    const want = new Set(wantKeep);
    const got = new Set(gotKeep);
    const missing = wantKeep.filter((id) => !got.has(id));
    const extra = gotKeep.filter((id) => !want.has(id));
    return (
      `${args.label}: D1 前の keep 集合が意図状態と不一致です ` +
      `(欠落 ${missing.length} 件・不明 ${extra.length} 件)`
    );
  }
  if (args.retireArchived) return null;
  if (args.liveRetireFull === null) {
    return `${args.label}: 退避候補が有効なのに live retire 集合がありません`;
  }
  const wantRetire = normSet([...snapRetireSet].filter((id) => !migratedSet.has(id)));
  const gotRetire = normSet(args.liveRetireFull);
  if (JSON.stringify(gotRetire) !== JSON.stringify(wantRetire)) {
    const want = new Set(wantRetire);
    const got = new Set(gotRetire);
    const missing = wantRetire.filter((id) => !got.has(id));
    const extra = gotRetire.filter((id) => !want.has(id));
    return (
      `${args.label}: D1 前の retire 集合が意図状態と不一致です ` +
      `(欠落 ${missing.length} 件・不明 ${extra.length} 件)`
    );
  }
  return null;
}

/**
 * 移行の 1 行分の実 flow 判定 (純粋決定。I/O 側はこの結果に従うだけ)。
 * - recorded 済み: fresh==after なら skip、fresh==before なら repatch (PATCH 消失)、
 *   それ以外は stop (同時変更)。
 * - 未記録: fresh==before なら patch、fresh==after かつ非対象不変なら recover
 *   (PATCH 成功→receipt 断の回収。再送しない)、それ以外は stop。
 * 非対象不変 (props/body) が偽なら after 一致でも stop (同時変更の疑い)。
 */
export type MigrationDecision = "skip" | "patch" | "repatch" | "recover" | "stop";

/**
 * relation 実配列の一致 (正規化 ID の順序つき比較。既存判定と同一意味)。
 * 順序まで含めるのは decideMigrationAction と同じ契約 (preview/walk の
 * 決定論的順序を前提にする)。
 */
export function relationArraysEqual(a: string[], b: string[]): boolean {
  return JSON.stringify(a.map(normalizePageId)) === JSON.stringify(b.map(normalizePageId));
}

/**
 * entry 照合の incoming relation CAS (純粋判定。空=合格)。
 * - noop 行 (ops 対象外): target relation 実配列が snapshot と完全一致。
 * - linked 行: fresh が original-before または expected-after のどちらか
 *   (receipt に沿う。意図済みの target relation 差だけ許容)。
 * - receipt.migrated がある行は receipt の before/after が op と一致すること
 *   (別 snapshot 由来の stale 記録の混入を止める)。
 */
export function incomingRelationProblems(args: {
  rowPageId: string;
  snapRelationFull: string[];
  freshFull: string[];
  op: { before: string[]; after: string[] } | undefined;
  recorded: { before: string[]; after: string[] } | undefined;
}): string[] {
  if (!args.op) {
    if (!relationArraysEqual(args.freshFull, args.snapRelationFull)) {
      return [`incoming ${args.rowPageId} の relation が snapshot と不一致です (noop 行は不変のはず)`];
    }
    return [];
  }
  if (
    !relationArraysEqual(args.freshFull, args.op.before) &&
    !relationArraysEqual(args.freshFull, args.op.after)
  ) {
    return [`incoming ${args.rowPageId} の relation が before/after のどちらでもありません (同時変更の疑い)`];
  }
  if (
    args.recorded &&
    (!relationArraysEqual(args.recorded.before, args.op.before) ||
      !relationArraysEqual(args.recorded.after, args.op.after))
  ) {
    return [`incoming ${args.rowPageId} の receipt が op と不一致です (stale 記録の疑い)`];
  }
  return [];
}

export function decideMigrationAction(args: {
  recorded: { before: string[]; after: string[] } | undefined;
  opBefore: string[];
  opAfter: string[];
  freshFull: string[];
  nonTargetUnchanged: boolean;
}): MigrationDecision {
  const eq = relationArraysEqual;
  if (args.recorded) {
    if (eq(args.freshFull, args.recorded.after) && args.nonTargetUnchanged) return "skip";
    if (eq(args.freshFull, args.recorded.before) && args.nonTargetUnchanged) return "repatch";
    return "stop";
  }
  if (eq(args.freshFull, args.opBefore) && args.nonTargetUnchanged) return "patch";
  if (eq(args.freshFull, args.opAfter) && args.nonTargetUnchanged) return "recover";
  return "stop";
}

/**
 * 退避の実 flow 判定 (純粋決定)。fresh の archived 状態と marker に基づく。
 * archive PATCH は冪等 (何度送っても同じ終状態・複製物を作らない) のため、
 * 結果不明でも create 系のような二重化は起きない。分岐:
 * - active かつ marker なし → create (新規 archive へ進む。呼出前に marker 保存)。
 * - active かつ marker あり → repatch (前回の PATCH が不達と確定。再送は安全)。
 * - archived かつ marker あり → recover (原像突合の上で記録回収。終状態を検証済み)。
 * - archived かつ marker なし → stop (外部の archive。系統不明のため人手確認)。
 */
export type RetireDecision = "create" | "repatch" | "recover" | "stop";

export function decideRetireAction(args: {
  originArchived: boolean;
  hasMarker: boolean;
}): RetireDecision {
  if (!args.originArchived) return args.hasMarker ? "repatch" : "create";
  return args.hasMarker ? "recover" : "stop";
}

/**
 * snapshot 保管の実 flow 判定 (純粋決定)。backup の full 検索ヒット数と marker。
 * 退避と同じ 0/1/複数 + marker の表 (自動解除・再 create 禁止)。
 */
export type SnapshotDecision = "recover" | "create" | "stop";

export function decideSnapshotAction(args: {
  backupHits: number;
  hasMarker: boolean;
}): SnapshotDecision {
  if (args.backupHits >= 2) return "stop";
  if (args.backupHits === 1) return "recover";
  return args.hasMarker ? "stop" : "create";
}
