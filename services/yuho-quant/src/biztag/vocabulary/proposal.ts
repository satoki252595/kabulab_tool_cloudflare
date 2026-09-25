/**
 * 単語帳への変更提案 (Cursor Automation → Worker `/vocabulary/proposals`)。
 * 設計: docs/005-yuho-quant-business-tags.md §6。
 *
 * `ProposalSchema` は外部 (Automation) から届く JSON をそのまま受ける形なので
 * `strictObject` で余計なキーを弾く。`applyProposal` は提案を基の単語帳へ
 * 機械的に適用するだけの純粋関数で、**意味検査はしない**
 * (呼び出し側が `validateVocabulary` を別途走らせる — 関門
 * `pnpm biztag gate` の §6.3「形」の検査)。
 */
import { z } from "../../../../../src/shared/zod-mini.js";
import { STOCK_CODE_REGEX } from "../../../../../src/shared/jpx/stock-code.js";
import {
  BUSINESS_ID_PATTERN,
  BusinessTermSchema,
  NOTION_COLUMNS,
  SOURCE_DATE_PATTERN,
  SourceSchema,
  THEME_ID_PATTERN,
  ThemeTermSchema,
  VERSION_PATTERN,
  type BusinessTerm,
  type ThemeTerm,
  type Vocabulary,
} from "./schema.js";

const nonEmpty = () => z.string().check(z.minLength(1));

/** business の id パターンと theme の id パターンのどちらか一方に一致する。 */
const ANY_TERM_ID_PATTERN = new RegExp(
  `^(?:${BUSINESS_ID_PATTERN.source.slice(1, -1)}|${THEME_ID_PATTERN.source.slice(1, -1)})$`
);

/** 提案が読んだ資料 (`sourcesChecked`)。語ごとの `evidence` とは別に、提案全体として目を通した資料の一覧。 */
const SourcesCheckedItemSchema = z.strictObject({
  title: nonEmpty(),
  url: z.string().check(z.regex(/^https:\/\/\S+$/)),
  date: z.string().check(z.regex(SOURCE_DATE_PATTERN)),
});

/**
 * 1 変更あたりの `evidence[]` の上限。`MAX_PROPOSAL_SOURCE_REFS`
 * (提案全体での合計上限) と合わせた多層防御 (下のコメント参照)。
 */
const EVIDENCE_PER_CHANGE_MAX = 20;

/** 語ごとの根拠 (出典 + 該当箇所 + 引用)。形は `Source` と同じ。 */
const EvidenceSchema = z.array(SourceSchema).check(z.minLength(1), z.maxLength(EVIDENCE_PER_CHANGE_MAX));

const AddBusinessChangeSchema = z.strictObject({
  op: z.literal("add_business"),
  /** `addedIn`/`deprecated` は `applyProposal` が新版に合わせて確定するのでここでは受けない。 */
  term: z.omit(BusinessTermSchema, { addedIn: true, deprecated: true }),
  evidence: EvidenceSchema,
});

const AddThemeChangeSchema = z.strictObject({
  op: z.literal("add_theme"),
  term: z.omit(ThemeTermSchema, { addedIn: true, deprecated: true }),
  evidence: EvidenceSchema,
});

/**
 * 既存語の部分更新。business 専用フィールド
 * (`notionColumn`/`subfamily`/`excludeKeywords`/`keywords`) と theme 専用
 * フィールド (`members`) の両方を型としては受けるが、対象の id が実際に
 * どちらの層かは基の単語帳を見ないと分からないため、層に合わない
 * フィールドの拒否は `applyProposal` (実行時) が行う。
 */
const UpdatePatchSchema = z.partial(
  z.strictObject({
    labelJa: nonEmpty(),
    definitionJa: nonEmpty(),
    definitionEn: nonEmpty(),
    keywords: z.array(nonEmpty()).check(z.minLength(1)),
    excludeKeywords: z.array(nonEmpty()),
    sources: z.array(SourceSchema).check(z.minLength(1), z.maxLength(EVIDENCE_PER_CHANGE_MAX)),
    subfamily: nonEmpty(),
    notionColumn: z.enum(NOTION_COLUMNS),
    members: z.array(z.string().check(z.regex(BUSINESS_ID_PATTERN))).check(z.minLength(1)),
  })
);
export type UpdatePatch = z.infer<typeof UpdatePatchSchema>;

const UpdateChangeSchema = z.strictObject({
  op: z.literal("update"),
  id: z.string().check(z.regex(ANY_TERM_ID_PATTERN)),
  patch: UpdatePatchSchema,
  evidence: EvidenceSchema,
});

const AddKeywordsChangeSchema = z.strictObject({
  op: z.literal("add_keywords"),
  /** keywords を持つのは business 語だけ。 */
  id: z.string().check(z.regex(BUSINESS_ID_PATTERN)),
  keywords: z.array(nonEmpty()).check(z.minLength(1)),
  evidence: EvidenceSchema,
});

const DeprecateChangeSchema = z.strictObject({
  op: z.literal("deprecate"),
  id: z.string().check(z.regex(ANY_TERM_ID_PATTERN)),
  evidence: EvidenceSchema,
});

export const ChangeSchema = z.union([
  AddBusinessChangeSchema,
  AddThemeChangeSchema,
  UpdateChangeSchema,
  AddKeywordsChangeSchema,
  DeprecateChangeSchema,
]);
export type Change = z.infer<typeof ChangeSchema>;

/**
 * 1 つの変更が持つ (url, quote) の組の数。関門の出典検査
 * (`sources-verify.ts` の `collectSources`) が実際に集める組と対応させる
 * (どちらも同じ `Change` の判別共用体を網羅するので、型を変えれば両方が
 * コンパイルエラーで気づける)。
 */
function sourceRefCountOfChange(change: Change): number {
  switch (change.op) {
    case "add_business":
    case "add_theme":
      return change.term.sources.length + change.evidence.length;
    case "update":
      return (change.patch.sources?.length ?? 0) + change.evidence.length;
    case "add_keywords":
    case "deprecate":
      return change.evidence.length;
  }
}

/**
 * 1 提案に含められる (url, quote) の組 (出典 + 根拠) の合計上限。
 *
 * `changes` は最大 200 件・`sources`/`evidence` は語/変更あたり最大 20 件まで
 * (`SOURCES_PER_TERM_MAX`/`EVIDENCE_PER_CHANGE_MAX`) だが、その積 (最大
 * 8,000件) をそのまま許すと、関門の出典検査 (`sources-verify.ts`) が
 * 実在する `.go.jp` URL を大量に逐次 fetch (1件最大15秒) する羽目になり、
 * `pnpm biztag run` (catchup.yml は 60 分・backfill.yml でも 355 分の
 * ジョブタイムアウトがある) を実質ハングさせる。ここで合計にも上限を課し、
 * 悪意/不注意な大量提案をスキーマの時点で 400 として弾く (出典検査に到達する
 * 前に止める。到達後の時間予算の保護は `sources-verify.ts` の
 * `DEFAULT_VERIFY_SOURCES_BUDGET_MS` 側で行う — 多層防御)。
 */
export const MAX_PROPOSAL_SOURCE_REFS = 300;

export const ProposalSchema = z
  .strictObject({
    /** 提案が前提とした単語帳の版。今の有効な版と一致しないと `applyProposal` が throw する。 */
    baseVersion: z.string().check(z.regex(VERSION_PATTERN)),
    noChange: z.boolean(),
    reason: z.optional(z.string().check(z.maxLength(2000))),
    sourcesChecked: z.array(SourcesCheckedItemSchema).check(z.minLength(1)),
    changes: z.array(ChangeSchema).check(z.maxLength(200)),
    /** ゴールデンセット再評価 (関門 §6.3-3) で「この語はこの会社で『はい』のはず」と当てにいく例。 */
    exampleCompanies: z.optional(
      z.record(
        z.string().check(z.regex(ANY_TERM_ID_PATTERN)),
        z.array(z.string().check(z.regex(STOCK_CODE_REGEX))).check(z.minLength(1))
      )
    ),
  })
  .check(
    z.refine(
      (p) => (p.noChange ? p.changes.length === 0 && p.reason !== undefined : p.changes.length >= 1),
      {
        message:
          "noChange:true は changes が空かつ reason 必須、noChange:false は changes が 1 件以上である必要があります",
      }
    ),
    z.refine(
      (p) => p.changes.reduce((sum, c) => sum + sourceRefCountOfChange(c), 0) <= MAX_PROPOSAL_SOURCE_REFS,
      {
        message: `1つの提案に含められる出典・根拠 (url, quote) の合計は ${MAX_PROPOSAL_SOURCE_REFS} 件までです (関門の出典検査が長時間化するのを防ぐため)`,
      }
    )
  );
export type Proposal = z.infer<typeof ProposalSchema>;

/** business/theme 双方から id で引く。見つからなければ `undefined`。 */
function findTerm(
  business: BusinessTerm[],
  themes: ThemeTerm[],
  id: string
): { layer: "business"; term: BusinessTerm } | { layer: "theme"; term: ThemeTerm } | undefined {
  const b = business.find((t) => t.id === id);
  if (b) return { layer: "business", term: b };
  const th = themes.find((t) => t.id === id);
  if (th) return { layer: "theme", term: th };
  return undefined;
}

/** business 専用の patch キー (theme に当てると throw)。 */
const BUSINESS_ONLY_PATCH_KEYS = ["notionColumn", "subfamily", "excludeKeywords", "keywords"] as const;
/** theme 専用の patch キー (business に当てると throw)。 */
const THEME_ONLY_PATCH_KEYS = ["members"] as const;

/**
 * 提案を基の単語帳に機械的に適用し、新しい単語帳を返す (純粋関数。`base` は
 * 変更しない)。**意味検査はしない** — 呼び出し側 (関門) が返り値に対して
 * `validateVocabulary`/`assertValidVocabulary` を走らせる。
 */
export function applyProposal(base: Vocabulary, p: Proposal, newVersion: string): Vocabulary {
  if (p.baseVersion !== base.version) {
    throw new Error(
      `提案の baseVersion (${p.baseVersion}) が今の単語帳の版 (${base.version}) と一致しません`
    );
  }

  const business = base.business.map((t) => ({ ...t }));
  const themes = base.themes.map((t) => ({ ...t }));

  for (const change of p.changes) {
    switch (change.op) {
      case "add_business": {
        if (findTerm(business, themes, change.term.id)) {
          throw new Error(`既に存在する id を追加しようとしています: ${change.term.id}`);
        }
        business.push({ ...change.term, addedIn: newVersion, deprecated: false });
        break;
      }
      case "add_theme": {
        if (findTerm(business, themes, change.term.id)) {
          throw new Error(`既に存在する id を追加しようとしています: ${change.term.id}`);
        }
        themes.push({ ...change.term, addedIn: newVersion, deprecated: false });
        break;
      }
      case "update": {
        const found = findTerm(business, themes, change.id);
        if (!found) throw new Error(`id が見つかりません: ${change.id}`);
        const patchKeys = Object.keys(change.patch);
        const forbidden =
          found.layer === "theme" ? BUSINESS_ONLY_PATCH_KEYS : THEME_ONLY_PATCH_KEYS;
        const invalidKeys = patchKeys.filter((k) => (forbidden as readonly string[]).includes(k));
        if (invalidKeys.length > 0) {
          throw new Error(
            `${change.id} (${found.layer}) には patch できないフィールドです: ${invalidKeys.join(", ")}`
          );
        }
        if (found.term.deprecated) {
          throw new Error(`廃止済みの語は patch できません: ${change.id}`);
        }
        Object.assign(found.term, change.patch);
        break;
      }
      case "add_keywords": {
        const found = findTerm(business, themes, change.id);
        if (!found) throw new Error(`id が見つかりません: ${change.id}`);
        if (found.layer !== "business") {
          throw new Error(`keywords を持たない層です (theme): ${change.id}`);
        }
        if (found.term.deprecated) {
          throw new Error(`廃止済みの語には keywords を追加できません: ${change.id}`);
        }
        found.term.keywords = [...found.term.keywords, ...change.keywords];
        break;
      }
      case "deprecate": {
        const found = findTerm(business, themes, change.id);
        if (!found) throw new Error(`id が見つかりません: ${change.id}`);
        if (found.term.deprecated) {
          throw new Error(`既に廃止済みです: ${change.id}`);
        }
        found.term.deprecated = true;
        break;
      }
    }
  }

  return { version: newVersion, business, themes };
}
