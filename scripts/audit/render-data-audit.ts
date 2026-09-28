/**
 * 監査レポート (#146 A/B/C) の正準数値ブロック生成＋検証 (Issue #151)。
 *
 * A/B/C の Markdown 報告を人手転記していたため、分類・合計・日付・SHA省略・
 * 保留/候補の矛盾が混入した。本スクリプトは docs/test-logs/ の results.json を
 * 唯一の入力とし、各レポート内の生成ブロックを機械生成する。合計は内訳から
 * 計算し、本文の要約層は数値の再入力ではなく集計ID参照にする。
 *
 * 実行 (network・env 不要。CI の check ジョブから起動):
 *   tsx scripts/audit/render-data-audit.ts --check            # 検証のみ (既定)
 *   tsx scripts/audit/render-data-audit.ts --write            # 生成ブロックをレポートへ反映
 *   tsx scripts/audit/render-data-audit.ts --print <section>  # 1 section の生成文を stdout へ
 *
 * 検査内容 (いずれも違反があれば exit 1):
 *   E_SCHEMA      results.json の形状不正 (Zod。F02/PUB の相互検査の前提欠落を含む)
 *   E_TOTAL       aggregate.total と内訳合計の不一致 (F02 unique・PUB route の相互一致含む)
 *   E_NUM         件数の非整数・負数、coverage の matched > total
 *   E_STATE       state=verified の coverage が matched != total
 *   E_SHA         sha256 の全文64桁hex以外 (省略形の混入防止)
 *   E_SHA_STATE   sha256 未記録なのに時刻 state が exact
 *   E_DATE        日付形式・前後関係の破れ、snapshot 未来の確定時刻
 *   E_QUARANTINE  隔離候補と保留の重なり (銘柄×表キー。未証明項目の候補混入防止)
 *   E_DUPID       項目IDの重複
 *   E_BLOCK       レポート内ブロックの欠落・重複・手編集 (byte 不一致。Finding見出し/件数サマリ/PUB表の生成ブロック含む)
 *   E_REF         本文の集計ID参照の未解決
 *
 * 対象は今回の A/B/C 監査分のみ。汎用レポート基盤ではない。
 * 自動 checker は語義・源泉の正確性を保証しない。原因解釈は本文と証拠項目IDで
 * 人がレビューすること (results.json の note・unverified がレビュー対象)。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rootCauseMessage } from "../../src/shared/errors.js";
import { z } from "../../src/shared/zod-mini.js";

const MANIFEST_PATH = "docs/test-logs/data-audit-2026-09-28.results.json";
const REF_PATTERN = /集計ID:([A-Za-z0-9][A-Za-z0-9_-]*)/g;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;
const EXACT_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?$/;

/* ---------- schema (形状のみ。意味検査は validateManifest が担う) ---------- */

const PopulationSchema = z.object({
  id: z.string(),
  label: z.string(),
  n: z.number(),
  note: z.optional(z.string()),
});

const PartSchema = z.object({
  id: z.string(),
  label: z.string(),
  n: z.number(),
});

const AggregateSchema = z.object({
  id: z.string(),
  label: z.string(),
  total: z.number(),
  state: z.enum(["verified", "mismatch", "unverified"]),
  source: z.enum(["recomputed", "report-stated", "evidence-reviewed"]),
  note: z.optional(z.string()),
  parts: z.array(PartSchema),
});

const CoverageSchema = z.object({
  id: z.string(),
  label: z.string(),
  matched: z.number(),
  total: z.number(),
  state: z.enum(["verified", "mismatch", "unverified"]),
  note: z.optional(z.string()),
});

const CandidateSchema = z.object({
  id: z.string(),
  stock: z.string(),
  table: z.string(),
  evidence: z.string(),
});

const PubRouteSchema = z.object({
  id: z.string(),
  route: z.string(),
  scope: z.enum(["valuejoin", "httpOnly", "boundary"]),
  evidence: z.string(),
});

const HoldSchema = z.object({
  id: z.string(),
  stock: z.string(),
  table: z.string(),
  reason: z.string(),
});

const EvidenceSchema = z.object({
  id: z.string(),
  path: z.string(),
  sha256: z.nullable(z.string()),
  bytes: z.nullable(z.number()),
  timeState: z.enum(["exact", "mtime-only", "unverified"]),
  exactTime: z.optional(z.string()),
  note: z.string(),
});

const SectionSchema = z.object({
  report: z.string(),
  blockId: z.string(),
  businessDay: z.string(),
  snapshotDate: z.string(),
  savedLatest: z.nullable(z.string()),
  dateNote: z.optional(z.string()),
  populations: z.array(PopulationSchema),
  aggregates: z.array(AggregateSchema),
  coverages: z.array(CoverageSchema),
  pubRoutes: z.optional(z.array(PubRouteSchema)),
  quarantines: z.object({
    candidates: z.array(CandidateSchema),
    holds: z.array(HoldSchema),
    note: z.optional(z.string()),
  }),
  evidence: z.array(EvidenceSchema),
  unverified: z.array(z.string()),
});

const ManifestSchema = z.object({
  contractVersion: z.literal(1),
  auditDate: z.string(),
  issue: z.number(),
  note: z.string(),
  sections: z.object({
    fundamentals: SectionSchema,
    moneyflow: SectionSchema,
    market: SectionSchema,
  }),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type Section = z.infer<typeof SectionSchema>;

export function beginMarker(blockId: string): string {
  return `<!-- audit-report:BEGIN ${blockId} -->`;
}

export function endMarker(blockId: string): string {
  return `<!-- audit-report:END ${blockId} -->`;
}

/** Zod 形状検査。失敗時は E_SCHEMA を先頭にした例外を投げる。 */
export function parseManifest(json: unknown): Manifest {
  try {
    return ManifestSchema.parse(json);
  } catch (error) {
    throw new Error(`E_SCHEMA: results.json の形状が不正です: ${rootCauseMessage(error)}`);
  }
}

function isCount(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

function isCalendarDate(value: string): boolean {
  const m = DATE_PATTERN.exec(value);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function findPartN(
  agg: Section["aggregates"][number] | undefined,
  partId: string,
): number | undefined {
  return agg?.parts.find((p) => p.id === partId)?.n;
}

/**
 * R7: F02 unique 2集計と long/short 元内訳の相互一致。
 * unique 側の 33/32/34 は元 part の再入力であり、各 total=sum だけでは
 * 元内訳の変更を見逃す。重なり0は実 proof 由来で、unique 65/66 の区別は維持する。
 */
function checkF02Cross(section: Section, where: string): string[] {
  const errors: string[] = [];
  const byId = new Map(section.aggregates.map((a) => [a.id, a]));
  const long = byId.get("F02-long");
  const short = byId.get("F02-short");
  const fresh = byId.get("F02-fresh-unique");
  const all = byId.get("F02-all-unique");
  if (long === undefined && short === undefined && fresh === undefined && all === undefined) {
    return errors;
  }
  if (long === undefined || short === undefined || fresh === undefined || all === undefined) {
    errors.push(`E_SCHEMA: ${where} の F02 集計は4件そろっている必要があります`);
    return errors;
  }
  const pairs: [string, number | undefined, string, number | undefined][] = [
    ["F02-fresh-unique.fresh-long", findPartN(fresh, "fresh-long"), "F02-long.long-fresh", findPartN(long, "long-fresh")],
    ["F02-fresh-unique.fresh-short", findPartN(fresh, "fresh-short"), "F02-short.short-fresh", findPartN(short, "short-fresh")],
    ["F02-all-unique.all-long", findPartN(all, "all-long"), "F02-long.total", long.total],
    ["F02-all-unique.all-short", findPartN(all, "all-short"), "F02-short.total", short.total],
  ];
  for (const [leftName, left, rightName, right] of pairs) {
    if (left === undefined || right === undefined) {
      errors.push(`E_SCHEMA: ${where} の F02 相互検査の内訳がありません (${leftName} / ${rightName})`);
    } else if (left !== right) {
      errors.push(
        `E_TOTAL: ${leftName} (${left}) が ${rightName} (${right}) と一致しません` +
          " (unique は元内訳から派生すること。重なり0は実proof由来)",
      );
    }
  }
  return errors;
}

/**
 * PUB: pubRoutes 配列からの派生件数と PUB-routes 集計の相互一致。
 * route 分類表だけ変更して counts が古いまま残る分離を拒否する。
 */
function checkPubRoutesCross(section: Section, where: string, sectionKey: string): string[] {
  const errors: string[] = [];
  if (section.pubRoutes === undefined) {
    if (sectionKey === "market") {
      errors.push(`E_SCHEMA: ${where} に pubRoutes がありません (§9 route表の生成元が必須)`);
    }
    return errors;
  }
  const derived = {
    valuejoin: section.pubRoutes.filter((r) => r.scope === "valuejoin").length,
    httpOnly: section.pubRoutes.filter((r) => r.scope === "httpOnly").length,
    boundary: section.pubRoutes.filter((r) => r.scope === "boundary").length,
  };
  const agg = section.aggregates.find((a) => a.id === "PUB-routes");
  if (agg === undefined) {
    errors.push(`E_SCHEMA: ${where} に PUB-routes 集計がありません (pubRoutes との相互検査に必須)`);
    return errors;
  }
  const pairs: [string, number | undefined, string, number][] = [
    ["routes-joined", findPartN(agg, "routes-joined"), "valuejoin route数", derived.valuejoin],
    ["routes-httponly", findPartN(agg, "routes-httponly"), "httpOnly route数", derived.httpOnly],
    ["routes-boundary", findPartN(agg, "routes-boundary"), "boundary route数", derived.boundary],
  ];
  for (const [partId, part, scopeName, count] of pairs) {
    if (part === undefined) {
      errors.push(`E_SCHEMA: ${where} の PUB-routes.${partId} がありません`);
    } else if (part !== count) {
      errors.push(
        `E_TOTAL: PUB-routes.${partId} (${part}) が${scopeName} (${count}) と一致しません` +
          " (件数は pubRoutes 配列から派生すること)",
      );
    }
  }
  if (agg.total !== section.pubRoutes.length) {
    errors.push(
      `E_TOTAL: PUB-routes.total (${agg.total}) が pubRoutes 件数 (${section.pubRoutes.length}) と一致しません`,
    );
  }
  return errors;
}

/** 意味検査。違反がなければ空配列を返す。 */
export function validateManifest(manifest: Manifest): string[] {
  const errors: string[] = [];
  const seenIds = new Map<string, string>();
  const claimId = (id: string, where: string) => {
    if (id.trim() === "") {
      errors.push(`E_DUPID: ${where} の項目IDが空です`);
      return;
    }
    const prev = seenIds.get(id);
    if (prev !== undefined) {
      errors.push(`E_DUPID: 項目ID ${id} が重複しています (${prev} / ${where})`);
      return;
    }
    seenIds.set(id, where);
  };

  if (!isCalendarDate(manifest.auditDate)) {
    errors.push(`E_DATE: auditDate が YYYY-MM-DD の実在日付ではありません: ${manifest.auditDate}`);
  }
  for (const [sectionKey, section] of Object.entries(manifest.sections)) {
    if (section === undefined) continue;
    const where = `sections.${sectionKey}`;
    for (const field of ["businessDay", "snapshotDate"] as const) {
      if (!isCalendarDate(section[field])) {
        errors.push(`E_DATE: ${where}.${field} が実在日付ではありません: ${section[field]}`);
      }
    }
    if (section.savedLatest !== null && !isCalendarDate(section.savedLatest)) {
      errors.push(`E_DATE: ${where}.savedLatest が実在日付ではありません: ${section.savedLatest}`);
    }
    if (section.snapshotDate !== manifest.auditDate) {
      errors.push(
        `E_DATE: ${where}.snapshotDate (${section.snapshotDate}) が auditDate (${manifest.auditDate}) と一致しません`,
      );
    }
    if (section.savedLatest !== null && section.savedLatest > section.businessDay) {
      errors.push(`E_DATE: ${where}.savedLatest が businessDay より未来です`);
    }
    if (section.businessDay > section.snapshotDate) {
      errors.push(`E_DATE: ${where}.businessDay が snapshotDate より未来です`);
    }
    if (section.savedLatest === null && (section.dateNote ?? "").trim() === "") {
      errors.push(`E_DATE: ${where}.savedLatest を null にする場合は dateNote で理由が必須です`);
    }

    for (const pop of section.populations) {
      claimId(pop.id, `${where}.populations`);
      if (!isCount(pop.n)) errors.push(`E_NUM: ${pop.id} の n が非負整数ではありません: ${pop.n}`);
      if (pop.label.trim() === "") errors.push(`E_NUM: ${where}.populations に空ラベルがあります`);
    }
    for (const agg of section.aggregates) {
      claimId(agg.id, `${where}.aggregates`);
      if (!isCount(agg.total)) {
        errors.push(`E_NUM: ${agg.id} の total が非負整数ではありません: ${agg.total}`);
      }
      let sum = 0;
      for (const part of agg.parts) {
        claimId(part.id, `${where}.aggregates.${agg.id}`);
        if (!isCount(part.n)) {
          errors.push(`E_NUM: ${agg.id}.${part.id} の n が非負整数ではありません: ${part.n}`);
        } else {
          sum += part.n;
        }
      }
      if (isCount(agg.total) && sum !== agg.total) {
        errors.push(`E_TOTAL: ${agg.id} の total (${agg.total}) が内訳合計 (${sum}) と一致しません`);
      }
      if (agg.label.trim() === "") errors.push(`E_NUM: ${agg.id} のラベルが空です`);
      if (agg.note !== undefined && (agg.note.includes("|") || agg.note.includes("\n"))) {
        errors.push(`E_SCHEMA: ${agg.id} の note に表を壊す文字 (|・改行) があります`);
      }
    }
    for (const cov of section.coverages) {
      claimId(cov.id, `${where}.coverages`);
      if (!isCount(cov.matched) || !isCount(cov.total)) {
        errors.push(`E_NUM: ${cov.id} の matched/total が非負整数ではありません`);
      } else if (cov.matched > cov.total) {
        errors.push(`E_NUM: ${cov.id} の matched (${cov.matched}) が total (${cov.total}) を超えています`);
      } else if (cov.state === "verified" && cov.matched !== cov.total) {
        errors.push(`E_STATE: ${cov.id} は verified ですが matched != total です`);
      }
      if (cov.label.trim() === "") errors.push(`E_NUM: ${cov.id} のラベルが空です`);
      if (cov.note !== undefined && (cov.note.includes("|") || cov.note.includes("\n"))) {
        errors.push(`E_SCHEMA: ${cov.id} の note に表を壊す文字 (|・改行) があります`);
      }
    }

    if (section.pubRoutes !== undefined) {
      const seenRoutes = new Set<string>();
      for (const route of section.pubRoutes) {
        claimId(route.id, `${where}.pubRoutes`);
        const routeKey = route.route.trim();
        if (seenRoutes.has(routeKey)) {
          errors.push(`E_DUPID: pubRoutes に同一 route の重複があります: ${routeKey} (${route.id})`);
        } else {
          seenRoutes.add(routeKey);
        }
        if (route.route.trim() === "" || route.evidence.trim() === "") {
          errors.push(`E_SCHEMA: ${route.id} の route/evidence が空です`);
        }
        if (
          route.route.includes("|") ||
          route.evidence.includes("|") ||
          route.route.includes("\n") ||
          route.evidence.includes("\n")
        ) {
          errors.push(`E_SCHEMA: ${route.id} の route/evidence に表を壊す文字 (|・改行) があります`);
        }
      }
    }
    errors.push(...checkF02Cross(section, where));
    errors.push(...checkPubRoutesCross(section, where, sectionKey));

    // 隔離の照合キーは銘柄×表。id を変えた別名候補化でも拒否する。
    const pairKey = (stock: string, table: string) => JSON.stringify([stock, table]);
    const holdPairs = new Set(section.quarantines.holds.map((h) => pairKey(h.stock, h.table)));
    const candPairs = new Set<string>();
    for (const cand of section.quarantines.candidates) {
      claimId(cand.id, `${where}.quarantines.candidates`);
      const key = pairKey(cand.stock, cand.table);
      if (holdPairs.has(key)) {
        errors.push(`E_QUARANTINE: ${cand.stock}×${cand.table} が隔離候補と保留の両方に入っています`);
      }
      if (candPairs.has(key)) {
        errors.push(`E_QUARANTINE: ${cand.stock}×${cand.table} が隔離候補に重複しています`);
      }
      candPairs.add(key);
      if (cand.stock.trim() === "" || cand.table.trim() === "") {
        errors.push(`E_QUARANTINE: ${cand.id} の stock/table が空です`);
      }
      if (cand.evidence.trim() === "") errors.push(`E_QUARANTINE: ${cand.id} の evidence が空です`);
    }
    const seenHoldPairs = new Set<string>();
    for (const hold of section.quarantines.holds) {
      claimId(hold.id, `${where}.quarantines.holds`);
      const key = pairKey(hold.stock, hold.table);
      if (seenHoldPairs.has(key)) {
        errors.push(`E_QUARANTINE: ${hold.stock}×${hold.table} が保留に重複しています`);
      }
      seenHoldPairs.add(key);
      if (hold.stock.trim() === "" || hold.table.trim() === "") {
        errors.push(`E_QUARANTINE: ${hold.id} の stock/table が空です`);
      }
      if (hold.reason.trim() === "") errors.push(`E_QUARANTINE: ${hold.id} の reason が空です`);
    }

    for (const ev of section.evidence) {
      claimId(ev.id, `${where}.evidence`);
      if (ev.sha256 !== null && !SHA_PATTERN.test(ev.sha256)) {
        errors.push(`E_SHA: ${ev.id} の sha256 が全文64桁hexではありません: ${ev.sha256}`);
      }
      if (ev.bytes !== null && !isCount(ev.bytes)) {
        errors.push(`E_NUM: ${ev.id} の bytes が非負整数ではありません: ${ev.bytes}`);
      }
      if (ev.timeState === "exact") {
        if (ev.exactTime === undefined) {
          errors.push(`E_SHA_STATE: ${ev.id} は timeState=exact ですが exactTime がありません`);
        } else if (!EXACT_TIME_PATTERN.test(ev.exactTime) || Number.isNaN(Date.parse(ev.exactTime))) {
          errors.push(`E_DATE: ${ev.id} の exactTime が ISO日時ではありません: ${ev.exactTime}`);
        } else if (ev.exactTime.slice(0, 10) > section.snapshotDate) {
          errors.push(`E_DATE: ${ev.id} の exactTime が snapshot 未来です: ${ev.exactTime}`);
        }
      } else if (ev.exactTime !== undefined) {
        errors.push(
          `E_SHA_STATE: ${ev.id} は timeState=${ev.timeState} のため exactTime を持てません (mtime を観測時刻にしない)`,
        );
      }
    }
    for (const item of section.unverified) {
      if (item.trim() === "") errors.push(`E_NUM: ${where}.unverified に空項目があります`);
    }
  }
  return errors;
}

/* ---------- 生成 ---------- */

const STATE_LABEL: Record<string, string> = {
  verified: "確認済み",
  mismatch: "不一致あり",
  unverified: "未検証",
};

const SOURCE_LABEL: Record<string, string> = {
  recomputed: "既存dumpから再導出",
  "report-stated": "報告書記載値",
  "evidence-reviewed": "証拠を見た人手判定",
};

function stateLabel(state: string): string {
  const label = STATE_LABEL[state];
  if (label === undefined) throw new Error(`E_SCHEMA: 未知の state です: ${state}`);
  return label;
}

function sourceLabel(source: string): string {
  const label = SOURCE_LABEL[source];
  if (label === undefined) throw new Error(`E_SCHEMA: 未知の source です: ${source}`);
  return label;
}

function timeLabel(ev: Section["evidence"][number]): string {
  if (ev.timeState === "exact") return `確定時刻 ${ev.exactTime ?? ""}`.trimEnd();
  if (ev.timeState === "mtime-only") return "ファイルmtimeのみ（観測時刻ではない）";
  return "未確認";
}

/** 1 section の生成ブロック全文 (マーカー込み)。時刻・乱数を含まず決定的。 */
export function renderBlock(manifest: Manifest, sectionKey: string): string {
  const section = manifest.sections[sectionKey as keyof Manifest["sections"]];
  if (section === undefined) throw new Error(`E_SCHEMA: 未知の section です: ${sectionKey}`);
  const lines: string[] = [];
  lines.push(beginMarker(section.blockId));
  lines.push(`## 生成集計ブロック: ${section.blockId}（機械生成・手編集禁止）`);
  lines.push("");
  lines.push(
    `生成元 \`${MANIFEST_PATH}\`（contract v${manifest.contractVersion}・Issue #${manifest.issue}）。` +
      "本文の要約層は数値を再入力せず集計ID参照にすること。",
  );
  lines.push(
    "自動 checker は語義・源泉の正確性を保証しない。原因解釈は本文と証拠項目IDで人がレビューすること。",
  );
  lines.push("");
  lines.push(
    `監査スナップショット日 ${section.snapshotDate} / 最新確定営業日 ${section.businessDay} / ` +
      `保存系列最新 ${section.savedLatest ?? "ドメイン別（下記注）"}`,
  );
  if (section.dateNote !== undefined) lines.push(`日付注: ${section.dateNote}`);
  lines.push("");
  lines.push("### 母集団");
  lines.push("");
  lines.push("| 項目ID | 内容 | n | 備考 |");
  lines.push("|---|---|---:|---|");
  for (const pop of section.populations) {
    lines.push(`| ${pop.id} | ${pop.label} | ${pop.n} | ${pop.note ?? "—"} |`);
  }
  lines.push("");
  lines.push("### 内訳集計（合計は内訳から計算）");
  lines.push("");
  lines.push("| 項目ID | 内訳 | 合計 | 状態 | 出所 | 備考 |");
  lines.push("|---|---|---:|---|---|---|");
  for (const agg of section.aggregates) {
    const sum = agg.parts.reduce((acc, p) => acc + p.n, 0);
    const parts = agg.parts.map((p) => `${p.label}${p.n}`).join("＋");
    lines.push(
      `| ${agg.id} | ${parts} | ${sum} | ${stateLabel(agg.state)} | ${sourceLabel(agg.source)} | ${agg.note ?? "—"} |`,
    );
  }
  lines.push("");
  lines.push("### 照合カバレッジ");
  lines.push("");
  lines.push("| 項目ID | 内容 | 一致/母数 | 状態 | 備考 |");
  lines.push("|---|---|---:|---|---|");
  for (const cov of section.coverages) {
    lines.push(
      `| ${cov.id} | ${cov.label} | ${cov.matched}/${cov.total} | ${stateLabel(cov.state)} | ${cov.note ?? "—"} |`,
    );
  }
  lines.push("");
  lines.push("### 隔離候補・保留");
  lines.push("");
  if (section.quarantines.candidates.length === 0 && section.quarantines.holds.length === 0) {
    lines.push(`隔離候補・保留ともに該当なし。${section.quarantines.note ?? ""}`.trimEnd());
  } else {
    for (const cand of section.quarantines.candidates) {
      lines.push(`- 候補 ${cand.id}: ${cand.stock}×${cand.table}（証拠: ${cand.evidence}）`);
    }
    for (const hold of section.quarantines.holds) {
      lines.push(`- 保留 ${hold.id}: ${hold.stock}×${hold.table}（${hold.reason}）`);
    }
    // R8: 候補・保留が非空でも note (preview のみ・本番未適用の限定) を常時1行出す。
    if (section.quarantines.note !== undefined) lines.push(`注: ${section.quarantines.note}`);
  }
  lines.push("");
  lines.push("### 証拠");
  lines.push("");
  lines.push("| 項目ID | path | sha256 | bytes | 時刻state | 備考 |");
  lines.push("|---|---|---|---|---|---|");
  for (const ev of section.evidence) {
    lines.push(
      `| ${ev.id} | \`${ev.path}\` | ${ev.sha256 ?? "未記録（制約）"} | ${ev.bytes ?? "—"} | ${timeLabel(ev)} | ${ev.note} |`,
    );
  }
  lines.push("");
  lines.push("### 未検証範囲（合格に数えない）");
  lines.push("");
  for (const item of section.unverified) lines.push(`- ${item}`);
  lines.push(endMarker(section.blockId));
  return `${lines.join("\n")}\n`;
}

/* ---------- 追加生成ブロック (R6 Finding見出し/サマリ・PUB route表) ---------- */

function needAggregate(section: Section, id: string): Section["aggregates"][number] {
  const agg = section.aggregates.find((a) => a.id === id);
  if (agg === undefined) throw new Error(`E_SCHEMA: 集計 ${id} がありません`);
  return agg;
}

function needPartN(agg: Section["aggregates"][number], partId: string): number {
  const part = agg.parts.find((p) => p.id === partId);
  if (part === undefined) throw new Error(`E_SCHEMA: 内訳 ${agg.id}.${partId} がありません`);
  return part.n;
}

function needPopulationN(section: Section, id: string): number {
  const pop = section.populations.find((p) => p.id === id);
  if (pop === undefined) throw new Error(`E_SCHEMA: 母集団 ${id} がありません`);
  return pop.n;
}

function shortDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (m === null) throw new Error(`E_SCHEMA: 日付ではありません: ${ymd}`);
  return `${Number(m[2])}/${Number(m[3])}`;
}

function weekdayJa(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (m === null) throw new Error(`E_SCHEMA: 日付ではありません: ${ymd}`);
  const names = ["日", "月", "火", "水", "木", "金", "土"] as const;
  return names[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
}

/**
 * R6: §7 の Finding 見出し3件を現集計IDから生成する (単独ブロック化し byte 検査対象に)。
 * 個別原本の導出節 (§4.3 等) の数値は導出記録として残し、人的意味レビューの範囲とする。
 */
export function renderFindingHeading(manifest: Manifest, which: "F2" | "F3" | "F4"): string {
  const section = manifest.sections.fundamentals;
  const blockId = `fundamentals-${which}-heading`;
  let heading: string;
  if (which === "F2") {
    heading = `### F2（未修復）海外売上の合計不一致 ${needAggregate(section, "F2-docs").total} 文書`;
  } else if (which === "F3") {
    const agg = needAggregate(section, "F3-yield");
    heading = `### F3（未修復）優待利回りの stale ${agg.total} 行（fresh ${needPartN(agg, "fresh")} 行）`;
  } else {
    const rows = needPartN(needAggregate(section, "F4-lottery"), "pure");
    const codes = needPartN(needAggregate(section, "F4-codes"), "pure-codes");
    heading = `### F4（未修復）純抽選優待の推定金額 ${rows} 行（${codes} 銘柄）`;
  }
  return `${beginMarker(blockId)}\n${heading}\n${endMarker(blockId)}\n`;
}

/** R6: §7 冒頭の件数サマリ (3行) を現集計IDから生成する。 */
export function renderFindingsSummary(manifest: Manifest): string {
  const section = manifest.sections.fundamentals;
  const blockId = "fundamentals-findings-summary";
  const f2 = needAggregate(section, "F2-docs").total;
  const f3 = needAggregate(section, "F3-yield");
  const fresh = needPartN(f3, "fresh");
  const pure = needPartN(needAggregate(section, "F4-lottery"), "pure");
  const pureCodes = needPartN(needAggregate(section, "F4-codes"), "pure-codes");
  const lines = [
    beginMarker(blockId),
    "**Finding件数サマリ（機械生成・手編集禁止）**",
    "",
    `- F2: 海外売上合計不一致 ${f2} 文書（集計ID:F2-docs・集計ID:F2-cause）`,
    `- F3: 優待利回り不一致 ${f3.total} 行（fresh ${fresh} 行。集計ID:F3-yield）`,
    `- F4: 純抽選 ${pure} 行（${pureCodes} 銘柄。集計ID:F4-lottery・集計ID:F4-codes）`,
    endMarker(blockId),
  ];
  return `${lines.join("\n")}\n`;
}

export type PubScope = "valuejoin" | "httpOnly" | "boundary";

const PUB_SCOPE_BLOCK: Record<PubScope, string> = {
  valuejoin: "market-pub-valuejoin",
  httpOnly: "market-pub-httponly",
  boundary: "market-pub-boundary",
};

/**
 * PUB: §9.n の route 表を pubRoutes 配列から生成する。件数・#番号は配列から派生し、
 * 本文の手入力表は持たない。route 境界は旧観測のまま (新 fetch なし)。
 */
export function renderPubRoutes(manifest: Manifest, scope: PubScope): string {
  const section = manifest.sections.market;
  const routes = section.pubRoutes;
  if (routes === undefined) throw new Error("E_SCHEMA: market section に pubRoutes がありません");
  const rows = routes.filter((r) => r.scope === scope);
  const blockId = PUB_SCOPE_BLOCK[scope];
  const lines = [beginMarker(blockId)];
  if (scope === "valuejoin") {
    lines.push(`### 9.2 値join ${rows.length} 件`, "", "| # | URL | 結果 |", "|---|---|---|");
  } else if (scope === "httpOnly") {
    lines.push(`### 9.3 200-only ${rows.length} 件 (値合格に数えない)`, "", "| # | route | 確認 |", "|---|---|---|");
  } else {
    lines.push(
      `### 9.4 境界 ${rows.length} 件 (値合格に数えない) + 未確認`,
      "",
      "| # | route | 確認 |",
      "|---|---|---|",
    );
  }
  rows.forEach((r, i) => lines.push(`| ${i + 1} | ${r.route} | ${r.evidence} |`));
  lines.push("");
  if (scope === "valuejoin") {
    lines.push(`${rows.length}値join≠${rows.length}正常（誤表示/エラー契約/表示照合を含む。集計ID:PUB-routes）`);
  } else if (scope === "httpOnly") {
    lines.push("到達の証明。値合格に数えない（集計ID:PUB-routes）");
  } else {
    lines.push("防御・契約の証明。値合格に数えない（集計ID:PUB-routes）");
  }
  lines.push(endMarker(blockId));
  return `${lines.join("\n")}\n`;
}

export interface GeneratedBlock {
  report: string;
  blockId: string;
  expected: string;
}

/**
 * R6: B §0 の鮮度要約 (営業日・保存最新・snapshot 条件) を日付 JSON から生成する。
 * 休場名・当日 run 時刻・警告文は単発の既存観測であり固定テンプレートに保持する。
 */
export function renderFreshness(manifest: Manifest): string {
  const section = manifest.sections.market;
  const blockId = "market-freshness";
  const savedLatest = section.savedLatest;
  if (savedLatest === null) {
    throw new Error("E_SCHEMA: market.savedLatest が null のため鮮度ブロックを生成できません");
  }
  const bdShort = shortDate(section.businessDay);
  const slShort = shortDate(savedLatest);
  const lines = [
    beginMarker(blockId),
    `- 最新確定営業日: **${section.businessDay}(${weekdayJa(section.businessDay)})**。` +
      `保存系列の最新日は${savedLatest}で、${bdShort}営業日分は未反映。9/21–9/23 は休場`,
    "  (敬老の日・国民の休日・秋分の日)、9/26–9/27 は週末。",
    `  保存系列の最新も ${slShort} (D1 市場系・R2 daily/intra とも)。`,
    `  ${bdShort} 営業日分は未反映: 当日 run (${bdShort} 17:13 UTC stock-sync・`,
    "  08:00 UTC vwap-ingest) の予定時刻と実成功を混同しない。",
    "  本監査の snapshot 時点ではいずれも反映前である。",
    endMarker(blockId),
  ];
  return `${lines.join("\n")}\n`;
}

/** R6: B §13 の優先対応見出し (固定テンプレート。3件は直下の固定 prose 項目数)。 */
export function renderPriorityHeading(): string {
  const blockId = "market-priority-heading";
  return `${beginMarker(blockId)}\n### 優先対応 3 件 (親 review・merge 後の follow-up)\n${endMarker(blockId)}\n`;
}

/** R6: B §13 の優先対応キュー (隔離候補/保留の件数・ID は JSON 派生)。 */
export function renderPrioritySummary(manifest: Manifest): string {
  const q = manifest.sections.market.quarantines;
  const blockId = "market-priority-summary";
  const candRefs = q.candidates.map((c) => `集計ID:${c.id}`).join("・");
  const holdRefs = q.holds.map((h) => `集計ID:${h.id}`).join("・");
  const lines = [
    beginMarker(blockId),
    "**優先対応キュー（機械生成・手編集禁止）**",
    "",
    `- 修復優先1 (F-01/F-15 破損隔離): 候補 ${q.candidates.length} 件・保留 ${q.holds.length} 件（${candRefs}＋${holdRefs}）`,
    "- 修復優先2: F-02 stale bool（集計ID:F02-fresh-unique・集計ID:F02-all-unique）",
    "- 修復優先3: F-03 JPX発見不能",
    endMarker(blockId),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * R6: C の全件要約 (25spec/5121行は既存 JSON 派生)。
 * 5633→5121 の訂正履歴は歴史説明として本文に保持する。
 */
export function renderMoneyflowTotals(manifest: Manifest): string {
  const section = manifest.sections.moneyflow;
  const blockId = "moneyflow-totals-summary";
  const specs = needPopulationN(section, "MF-specs");
  const total = needAggregate(section, "MF-rows-total").total;
  return (
    `${beginMarker(blockId)}\n` +
    `**全件要約（機械生成・手編集禁止）**: 全${specs}spec（集計ID:MF-specs）構造検査合格・` +
    `合計${total}行（集計ID:MF-rows-total）\n` +
    `${endMarker(blockId)}\n`
  );
}

/** 全生成ブロック (section 主ブロック3件＋R6小ブロック7件＋PUB表3件)。 */
export function allBlocks(manifest: Manifest): GeneratedBlock[] {
  const blocks: GeneratedBlock[] = [];
  for (const [sectionKey, section] of Object.entries(manifest.sections)) {
    if (section === undefined) continue;
    blocks.push({ report: section.report, blockId: section.blockId, expected: renderBlock(manifest, sectionKey) });
  }
  const fundReport = manifest.sections.fundamentals.report;
  for (const which of ["F2", "F3", "F4"] as const) {
    blocks.push({
      report: fundReport,
      blockId: `fundamentals-${which}-heading`,
      expected: renderFindingHeading(manifest, which),
    });
  }
  blocks.push({
    report: fundReport,
    blockId: "fundamentals-findings-summary",
    expected: renderFindingsSummary(manifest),
  });
  const marketReport = manifest.sections.market.report;
  blocks.push({ report: marketReport, blockId: "market-freshness", expected: renderFreshness(manifest) });
  for (const scope of ["valuejoin", "httpOnly", "boundary"] as const) {
    blocks.push({ report: marketReport, blockId: PUB_SCOPE_BLOCK[scope], expected: renderPubRoutes(manifest, scope) });
  }
  blocks.push({ report: marketReport, blockId: "market-priority-heading", expected: renderPriorityHeading() });
  blocks.push({
    report: marketReport,
    blockId: "market-priority-summary",
    expected: renderPrioritySummary(manifest),
  });
  blocks.push({
    report: manifest.sections.moneyflow.report,
    blockId: "moneyflow-totals-summary",
    expected: renderMoneyflowTotals(manifest),
  });
  return blocks;
}

function groupByReport(blocks: GeneratedBlock[]): Map<string, GeneratedBlock[]> {
  const byReport = new Map<string, GeneratedBlock[]>();
  for (const block of blocks) {
    const list = byReport.get(block.report);
    if (list === undefined) byReport.set(block.report, [block]);
    else list.push(block);
  }
  return byReport;
}

/* ---------- レポート検査 ---------- */

/** マーカー外の本文に残る集計ID参照を集める。 */
export function collectRefs(bodyWithoutBlocks: string): string[] {
  const refs: string[] = [];
  for (const m of bodyWithoutBlocks.matchAll(REF_PATTERN)) refs.push(m[1]);
  return refs;
}

function stripBlocks(text: string, blockIds: string[]): string {
  let out = text;
  for (const blockId of blockIds) {
    const begin = beginMarker(blockId);
    const end = endMarker(blockId);
    for (;;) {
      const s = out.indexOf(begin);
      if (s === -1) break;
      const e = out.indexOf(end, s + begin.length);
      if (e === -1) break;
      out = out.slice(0, s) + out.slice(e + end.length);
    }
  }
  return out;
}

/**
 * 全レポート検査 (全生成ブロックの byte 一致＋参照解決)。
 * rootDir はリポジトリルート。違反がなければ空配列を返す。
 */
export function checkFiles(manifest: Manifest, rootDir: string): string[] {
  const errors: string[] = [];
  const idIndex = new Set<string>();
  for (const section of Object.values(manifest.sections)) {
    if (section === undefined) continue;
    for (const pop of section.populations) idIndex.add(pop.id);
    for (const agg of section.aggregates) {
      idIndex.add(agg.id);
      for (const part of agg.parts) idIndex.add(part.id);
    }
    for (const cov of section.coverages) idIndex.add(cov.id);
    for (const cand of section.quarantines.candidates) idIndex.add(cand.id);
    for (const hold of section.quarantines.holds) idIndex.add(hold.id);
    for (const ev of section.evidence) idIndex.add(ev.id);
    for (const route of section.pubRoutes ?? []) idIndex.add(route.id);
  }

  // manifest 自身の note 内相互参照も解決を強制する (改名時の置き忘れ防止)。
  const manifestText = readFileSync(join(rootDir, MANIFEST_PATH), "utf8");
  for (const ref of collectRefs(manifestText)) {
    if (!idIndex.has(ref)) errors.push(`E_REF: 未解決の集計ID参照です: ${MANIFEST_PATH} の集計ID:${ref}`);
  }

  for (const [report, blocks] of groupByReport(allBlocks(manifest))) {
    const reportPath = join(rootDir, report);
    if (!existsSync(reportPath)) {
      errors.push(`E_BLOCK: レポートが存在しません: ${report}`);
      continue;
    }
    const text = readFileSync(reportPath, "utf8");
    for (const block of blocks) {
      const begin = beginMarker(block.blockId);
      const end = endMarker(block.blockId);
      const first = text.indexOf(begin);
      const last = text.lastIndexOf(begin);
      if (first === -1) {
        errors.push(`E_BLOCK: 生成ブロックがありません: ${report} (${block.blockId})`);
        continue;
      }
      if (first !== last) {
        errors.push(`E_BLOCK: 生成ブロックが重複しています: ${report} (${block.blockId})`);
        continue;
      }
      const endPos = text.indexOf(end, first + begin.length);
      if (endPos === -1) {
        errors.push(`E_BLOCK: 生成ブロックの END マーカーがありません: ${report} (${block.blockId})`);
        continue;
      }
      const actual = text.slice(first, endPos + end.length + 1);
      const actualNormalized = actual.endsWith("\n") ? actual : `${actual}\n`;
      if (actualNormalized !== block.expected) {
        errors.push(
          `E_BLOCK: 生成ブロックが手編集されています (byte不一致): ${report} (${block.blockId}) ` +
            `(--write で再生成すること。差分は目視レビュー対象)`,
        );
      }
    }
    const body = stripBlocks(text, blocks.map((b) => b.blockId));
    for (const ref of collectRefs(body)) {
      if (!idIndex.has(ref)) errors.push(`E_REF: 未解決の集計ID参照です: ${report} の集計ID:${ref}`);
    }
  }
  return errors;
}

/* ---------- CLI ---------- */

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function runCheck(rootDir: string): string[] {
  const raw = readFileSync(join(rootDir, MANIFEST_PATH), "utf8");
  const manifest = parseManifest(JSON.parse(raw) as unknown);
  return [...validateManifest(manifest), ...checkFiles(manifest, rootDir)];
}

/** R5 回帰用に export。全生成ブロックをレポートへ反映する (決定的・冪等)。 */
export function runWrite(rootDir: string): string[] {
  const manifestPath = join(rootDir, MANIFEST_PATH);
  const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
  const errors = validateManifest(manifest);
  if (errors.length > 0) return errors;
  const updated: string[] = [];
  for (const [report, blocks] of groupByReport(allBlocks(manifest))) {
    const reportPath = join(rootDir, report);
    if (!existsSync(reportPath)) return [`E_BLOCK: レポートが存在しません: ${report}`];
    let text = readFileSync(reportPath, "utf8");
    for (const block of blocks) {
      const begin = beginMarker(block.blockId);
      const end = endMarker(block.blockId);
      const first = text.indexOf(begin);
      if (first === -1) {
        return [`E_BLOCK: 生成ブロックがありません: ${report} (${block.blockId}) (--write 初回は空ブロックを貼ること)`];
      }
      if (first !== text.lastIndexOf(begin)) {
        return [`E_BLOCK: 生成ブロックが重複しています: ${report} (${block.blockId})`];
      }
      const endPos = text.indexOf(end, first + begin.length);
      if (endPos === -1) return [`E_BLOCK: 生成ブロックの END マーカーがありません: ${report} (${block.blockId})`];
      const head = text.slice(0, first);
      const tail = text.slice(endPos + end.length);
      const tailNormalized = tail.replace(/^\n+/, "");
      text = `${head}${block.expected}\n${tailNormalized}`;
    }
    writeFileSync(reportPath, text);
    updated.push(report);
  }
  const errorsAfter = checkFiles(manifest, rootDir);
  if (errorsAfter.length > 0) return errorsAfter;
  console.info(`[audit-report] 更新: ${updated.join(", ")}`);
  return [];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = repoRoot();
  if (args.includes("--write")) {
    const errors = runWrite(root);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    return;
  }
  const printAt = args.indexOf("--print");
  if (printAt !== -1) {
    const sectionKey = args[printAt + 1];
    if (sectionKey === undefined) throw new Error("E_SCHEMA: --print には section 名が必要です");
    const manifest = parseManifest(
      JSON.parse(readFileSync(join(root, MANIFEST_PATH), "utf8")) as unknown,
    );
    const errors = validateManifest(manifest);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    process.stdout.write(renderBlock(manifest, sectionKey));
    return;
  }
  if (args.length > 0 && !args.includes("--check")) {
    throw new Error("E_SCHEMA: 指定できる引数は --check / --write / --print <section> です");
  }
  const errors = runCheck(root);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  console.info("[audit-report] OK: manifest 検証＋生成ブロック byte 一致＋参照解決");
}

const invoked = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  main().catch((e: unknown) => {
    console.error("[audit-report] エラー:", rootCauseMessage(e));
    process.exit(1);
  });
}
