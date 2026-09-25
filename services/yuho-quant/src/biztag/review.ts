/**
 * 見直し材料 (review packet) の組み立てと台帳への反映。
 * 設計: docs/005-yuho-quant-business-tags.md §6.1・§6.2。
 *
 * Cursor Automation の年次見直しが読む GET /vocabulary/review-packet の中身。
 * 今の単語帳・語ごとのタグ数・「語なし」の多い業種・確認不能の多い銘柄・
 * 見直しに使う公的資料の URL をまとめる。
 */
import {
  type LedgerEntry,
  type LedgerKind,
  type LedgerState,
  type SupplementRow,
} from "../../../../src/shared/notion-archive/index.js";
import { canonicalJson } from "./vocabulary/hash.js";
import type { Vocabulary } from "./vocabulary/schema.js";

/** 単語帳の出典 URL に加える、公的資料の固定ルート URL (設計 §4・
 *  `scripts/biztag-automation/vocabulary-review.md` と同じ 5 件)。 */
export const OFFICIAL_ROOT_SOURCES: readonly string[] = [
  "https://www.soumu.go.jp/toukei_toukatsu/index/seido/sangyo/R05index.htm",
  "https://www.cao.go.jp/keizai_anzen_hosho/suishinhou/supply_chain/supply_chain.html",
  "https://www.cas.go.jp/jp/seisaku/nipponseichosenryaku/index.html",
  "https://www.meti.go.jp/policy/mono_info_service/joho/conference/semicon_digital.html",
  "https://www.meti.go.jp/press/2025/12/20251226003/20251226003.html",
];

export interface TermStat {
  id: string;
  label: string;
  column: "upstream" | "downstream" | "distribution" | "theme";
  tagCount: number;
  uncertainCount: number;
}

export interface SectorNoHitStat {
  sector33: string;
  judged: number;
  zeroCandidate: number;
  ratio: number;
}

export interface UncertainHeavyStock {
  stockCode: string;
  companyName: string;
  uncertainCount: number;
  uncertain: string;
}

export interface ReviewPacket {
  version: string;
  vocab: Vocabulary;
  termStats: TermStat[];
  noHitSectors: SectorNoHitStat[];
  uncertainHeavy: UncertainHeavyStock[];
  officialSources: string[];
  generatedAt: string;
}

/** "名前（0.55）／名前2（0.42）" → ["名前","名前2"] (row.ts の書式の逆変換)。 */
function parseUncertainLabels(uncertain: string | null): string[] {
  if (!uncertain) return [];
  return uncertain
    .split(" / ")
    .map((s) => s.replace(/（[0-9.]+）$/, "").trim())
    .filter((s) => s.length > 0);
}

function collectVocabSourceUrls(vocab: Vocabulary): string[] {
  const urls = new Set<string>();
  for (const t of [...vocab.business, ...vocab.themes]) {
    for (const s of t.sources) urls.add(s.url);
  }
  return [...urls];
}

/**
 * Notion「銘柄マスタ（補足）」の全行と今の単語帳から見直し材料を組み立てる
 * (純粋関数。I/O なし)。
 */
export function buildReviewPacket(rows: SupplementRow[], vocab: Vocabulary, generatedAt: string): ReviewPacket {
  const labelMeta = new Map<string, { id: string; column: TermStat["column"] }>();
  for (const t of vocab.business) {
    if (t.deprecated) continue;
    labelMeta.set(t.labelJa, { id: t.id, column: t.notionColumn });
  }
  for (const t of vocab.themes) {
    if (t.deprecated) continue;
    labelMeta.set(t.labelJa, { id: t.id, column: "theme" });
  }

  const judgedRows = rows.filter((r) => r.tagStatus === "判定済");

  const tagCount = new Map<string, number>();
  const uncertainCount = new Map<string, number>();
  for (const row of judgedRows) {
    for (const label of [...row.upstream, ...row.downstream, ...row.distribution, ...row.themes]) {
      tagCount.set(label, (tagCount.get(label) ?? 0) + 1);
    }
    for (const label of parseUncertainLabels(row.uncertain)) {
      uncertainCount.set(label, (uncertainCount.get(label) ?? 0) + 1);
    }
  }

  const termStats: TermStat[] = [...labelMeta.entries()].map(([label, meta]) => ({
    id: meta.id,
    label,
    column: meta.column,
    tagCount: tagCount.get(label) ?? 0,
    uncertainCount: uncertainCount.get(label) ?? 0,
  }));

  const sectorJudged = new Map<string, number>();
  const sectorZero = new Map<string, number>();
  for (const row of judgedRows) {
    if (row.sector33 === null) continue;
    sectorJudged.set(row.sector33, (sectorJudged.get(row.sector33) ?? 0) + 1);
    if ((row.candidateCount ?? 0) === 0) {
      sectorZero.set(row.sector33, (sectorZero.get(row.sector33) ?? 0) + 1);
    }
  }
  const noHitSectors: SectorNoHitStat[] = [...sectorJudged.entries()]
    .map(([sector33, judged]) => {
      const zeroCandidate = sectorZero.get(sector33) ?? 0;
      return { sector33, judged, zeroCandidate, ratio: zeroCandidate / judged };
    })
    .sort((a, b) => b.ratio - a.ratio);

  const uncertainHeavy: UncertainHeavyStock[] = judgedRows
    .map((row) => ({
      stockCode: row.stockCode,
      companyName: row.companyName,
      uncertainCount: parseUncertainLabels(row.uncertain).length,
      uncertain: row.uncertain ?? "",
    }))
    .filter((r) => r.uncertainCount > 0)
    .sort((a, b) => b.uncertainCount - a.uncertainCount);

  const officialSources = [...new Set([...OFFICIAL_ROOT_SOURCES, ...collectVocabSourceUrls(vocab)])];

  return { version: vocab.version, vocab, termStats, noHitSectors, uncertainHeavy, officialSources, generatedAt };
}

function stripGeneratedAt(p: { generatedAt: string }): Record<string, unknown> {
  const { generatedAt: _generatedAt, ...rest } = p;
  return rest;
}

export interface RefreshReviewPacketDeps {
  dbId: string;
  packet: ReviewPacket;
  listLedgerEntries: (
    dbId: string,
    filter?: { kind?: LedgerKind; state?: LedgerState }
  ) => Promise<LedgerEntry[]>;
  readLedgerJson: (entry: LedgerEntry) => Promise<unknown>;
  createLedgerEntry: (dbId: string, e: {
    name: string;
    kind: LedgerKind;
    state: LedgerState;
    version: string | null;
    reason: string;
    diff: string;
    rollbackFrom: string | null;
    json: unknown;
    recordedAt: string;
  }) => Promise<LedgerEntry>;
  replaceLedgerJson: (entry: LedgerEntry, json: unknown, recordedAt: string) => Promise<LedgerEntry>;
}

export interface RefreshReviewPacketResult {
  updated: boolean;
  entry: LedgerEntry;
}

/**
 * 台帳の「見直し材料」(状態=最新) を、内容が変わったときだけ更新する。
 * `generatedAt` は比較対象から除く (毎回変わる値なので、これだけの違いで
 * 台帳を更新しない)。
 */
export async function refreshReviewPacketLedger(deps: RefreshReviewPacketDeps): Promise<RefreshReviewPacketResult> {
  const existing = (await deps.listLedgerEntries(deps.dbId, { kind: "見直し材料" })).filter(
    (e) => e.state === "最新"
  );
  if (existing.length > 1) {
    throw new Error(`refreshReviewPacketLedger: 「見直し材料」の「最新」行が複数あります (${existing.length}件)`);
  }

  const newContent = canonicalJson(stripGeneratedAt(deps.packet));

  if (existing.length === 0) {
    const entry = await deps.createLedgerEntry(deps.dbId, {
      name: "見直し材料",
      kind: "見直し材料",
      state: "最新",
      version: deps.packet.version,
      reason: "自動生成 (pnpm biztag run の冒頭)",
      diff: "",
      rollbackFrom: null,
      json: deps.packet,
      recordedAt: deps.packet.generatedAt,
    });
    return { updated: true, entry };
  }

  const current = existing[0];
  const currentJson = await deps.readLedgerJson(current);
  const currentContent = canonicalJson(stripGeneratedAt(currentJson as { generatedAt: string }));
  if (currentContent === newContent) {
    return { updated: false, entry: current };
  }
  const entry = await deps.replaceLedgerJson(current, deps.packet, deps.packet.generatedAt);
  return { updated: true, entry };
}
