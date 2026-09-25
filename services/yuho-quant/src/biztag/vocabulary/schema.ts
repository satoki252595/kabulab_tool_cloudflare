/**
 * 事業タグ単語帳（語彙）の型。設計: docs/005-yuho-quant-business-tags.md §4。
 *
 * 単語帳は 2 層:
 *   - business（事業・製品）… jev で判定する語。`notionColumn` で Notion の
 *     2 つのマルチセレクト列（素材・部品・装置 / 製品・サービス）に分かれる。
 *   - theme（投資テーマ）… business 語の集合としてコードで定義する。判定しない。
 *
 * 形の検査は zod（ここ）、意味の検査（ID 重複・列ごと 100 語・構成語の実在など）は
 * `validate.ts` の `validateVocabulary`。テストと年次見直しの関門が同じ関数を使う。
 *
 * 外部（Cursor Automation の提案）から来る値もこの型で受けるので、余計なキーは
 * 通さない（strictObject）。
 */
import { z } from "../../../../../src/shared/zod-mini.js";

/** business 語の系統（ID の 2 番目のトークンと一致させる） */
export const FAMILIES = [
  "SEMI",
  "ELEC",
  "ENERGY",
  "MAT",
  "MED",
  "MACH",
  "MOBI",
  "DEF",
  "ICT",
  "FOOD",
  "FIN",
  "RE",
  "LOGI",
  "CONT",
  "SVC",
] as const;
export type Family = (typeof FAMILIES)[number];

/**
 * 系統の日本語名（見直し材料・設計書の表示用）。
 * `SVC`（流通・サービス）は 2026-09-25 追加。人材・教育・総合商社・
 * 小売業態・ホテル旅行・自動車ディーラー等、既存系統(製造業由来の分類)に
 * 当てはまらない「モノを作らない事業」の受け皿として新設した
 * (docs/005-yuho-quant-business-tags.md §4)。
 */
export const FAMILY_LABEL_JA: Record<Family, string> = {
  SEMI: "半導体",
  ELEC: "電子部品",
  ENERGY: "電池・エネルギー",
  MAT: "素材",
  MED: "医薬・医療",
  MACH: "機械・ロボット",
  MOBI: "モビリティ・航空宇宙",
  DEF: "防衛",
  ICT: "情報通信・ソフト・データセンター",
  FOOD: "食品・消費",
  FIN: "金融",
  RE: "不動産・建設・インフラ",
  LOGI: "物流・港湾",
  CONT: "コンテンツ",
  SVC: "流通・サービス",
};

/**
 * Notion のマルチセレクト列（business 層の振り分け先）。
 * `upstream`=素材・部品・装置／`downstream`=製品・サービス／
 * `distribution`=流通・サービス（小売・卸・人材・教育・ホテル旅行 等の
 * 「川上でも自社製品でもない」事業を受ける第 3 の列。2026-09-25 追加）。
 */
export const NOTION_COLUMNS = ["upstream", "downstream", "distribution"] as const;
export type NotionColumn = (typeof NOTION_COLUMNS)[number];

/** business 語の ID: B.<FAMILY>.<UPPER_SNAKE> */
export const BUSINESS_ID_PATTERN = /^B\.([A-Z]+)\.[A-Z0-9]+(?:_[A-Z0-9]+)*$/;
/** theme 語の ID: T.<UPPER_SNAKE> */
export const THEME_ID_PATTERN = /^T\.[A-Z0-9]+(?:_[A-Z0-9]+)*$/;
/** 版名: v1, v2, ... */
export const VERSION_PATTERN = /^v[1-9][0-9]*$/;
/** 日付: YYYY-MM または YYYY-MM-DD（公的資料の公表日） */
export const SOURCE_DATE_PATTERN = /^\d{4}-\d{2}(?:-\d{2})?$/;

const nonEmpty = () => z.string().check(z.minLength(1));

/**
 * `quote` として認める最低文字数（末尾・先頭の空白を除いた実文字数）。
 * これ未満だと「の」「は」「。」のような助詞・句読点 1 文字でも
 * `nonEmpty()` を通ってしまい、関門 (`sources-verify.ts` の
 * `verifySources`) の「引用が本文に実在する」照合がほぼ何にでも一致して
 * しまう（出典が実際に主張を裏付けているかを何も確認できなくなる）。
 * 実データ (`vocabulary/v1.json` の実測、2026-09-25) には「薄膜堆積」
 * (4字)・「①永久磁石」(5字) のような、公的資料の**番号付き項目名**を
 * そのまま引用した短い正当な quote が実在するため、それらを壊さない
 * 安全側の下限として実測最小値と同じ 4 字を置く（下の
 * `PARTICLE_OR_PUNCTUATION_ONLY_RE` が助詞・句読点だけの quote を弾く
 * 主な防波堤で、こちらは 1 文字の助詞・記号だけを機械的に落とす補助）。
 */
export const SOURCE_QUOTE_MIN_CHARS = 4;

/**
 * 空白・句読点・記号・助詞・助動詞のみで構成された文字列 (全体一致)。
 * これだけの引用は文字数の下限をすり抜けても実質的に何も主張を裏付けない
 * ため、`SOURCE_QUOTE_MIN_CHARS` と合わせて弾く。
 */
const PARTICLE_OR_PUNCTUATION_ONLY_RE =
  /^[\s\u3000。、,.!?！？「」『』（）()・…\-ー~〜のはがをにでともやかねよなだですますでしたた]*$/;

/** 語の出典（公的資料の該当箇所） */
export const SourceSchema = z.strictObject({
  /** 資料の題名 */
  title: nonEmpty(),
  /** 資料の URL（https） */
  url: z.string().check(z.regex(/^https:\/\/\S+$/)),
  /** 資料の公表日（YYYY-MM または YYYY-MM-DD） */
  date: z.string().check(z.regex(SOURCE_DATE_PATTERN)),
  /** 該当の項目・ページ */
  section: nonEmpty(),
  /**
   * 資料本文からの短い原文引用（関門で実在を照合する）。単なる非空文字列
   * ではなく、句読点・助詞だけの引用が「出典検査を通った」ことにならない
   * よう最低文字数と構成を検査する。
   */
  quote: z
    .string()
    .check(
      z.minLength(1),
      z.refine((q) => q.trim().length >= SOURCE_QUOTE_MIN_CHARS, {
        message: `quote は前後の空白を除いて ${SOURCE_QUOTE_MIN_CHARS} 字以上の意味のある引用である必要があります`,
      }),
      z.refine((q) => !PARTICLE_OR_PUNCTUATION_ONLY_RE.test(q), {
        message: "quote が句読点・助詞のみで構成されており、出典の裏付けになっていません",
      })
    ),
});
export type Source = z.infer<typeof SourceSchema>;

/**
 * 1 語あたりの `sources[]` の上限。実データ (v1.json 実測、2026-09-25) の
 * 最大は 6 件で、20 件あれば十分すぎるほど余裕がある。上限を置かない場合、
 * 提案 (Cursor Automation) がここへ大量の (url, quote) を詰め込み、関門の
 * 出典検査 (`sources-verify.ts` の逐次 fetch) を長時間化させられる
 * (対策の全体像は `vocabulary/proposal.ts` の `MAX_PROPOSAL_SOURCE_REFS` 参照)。
 */
const SOURCES_PER_TERM_MAX = 20;

export const BusinessTermSchema = z.strictObject({
  id: z.string().check(z.regex(BUSINESS_ID_PATTERN)),
  layer: z.literal("business"),
  family: z.enum(FAMILIES),
  /** 系統内の小分類（英語スラグ。表示・見直し材料の集計用） */
  subfamily: nonEmpty(),
  notionColumn: z.enum(NOTION_COLUMNS),
  /** Notion の選択肢名。カンマ禁止・40 字以内（validate.ts で検査） */
  labelJa: nonEmpty(),
  definitionJa: nonEmpty(),
  /** jev の指示文に埋め込む定義（英語） */
  definitionEn: nonEmpty(),
  keywords: z.array(nonEmpty()).check(z.minLength(1)),
  excludeKeywords: z.array(nonEmpty()),
  sources: z.array(SourceSchema).check(z.minLength(1), z.maxLength(SOURCES_PER_TERM_MAX)),
  /** この語を追加した版 */
  addedIn: z.string().check(z.regex(VERSION_PATTERN)),
  /** 廃止済み（ID は欠番として残す。判定・表示に使わない） */
  deprecated: z.boolean(),
});
export type BusinessTerm = z.infer<typeof BusinessTermSchema>;

export const ThemeTermSchema = z.strictObject({
  id: z.string().check(z.regex(THEME_ID_PATTERN)),
  layer: z.literal("theme"),
  labelJa: nonEmpty(),
  definitionJa: nonEmpty(),
  definitionEn: nonEmpty(),
  /** 構成語（business の id）。どれか 1 つが「はい」ならこのテーマが付く */
  members: z.array(z.string().check(z.regex(BUSINESS_ID_PATTERN))).check(z.minLength(1)),
  sources: z.array(SourceSchema).check(z.minLength(1), z.maxLength(SOURCES_PER_TERM_MAX)),
  addedIn: z.string().check(z.regex(VERSION_PATTERN)),
  deprecated: z.boolean(),
});
export type ThemeTerm = z.infer<typeof ThemeTermSchema>;

export const VocabularySchema = z.strictObject({
  /** 版名（v1, v2, ...） */
  version: z.string().check(z.regex(VERSION_PATTERN)),
  business: z.array(BusinessTermSchema).check(z.minLength(1)),
  themes: z.array(ThemeTermSchema),
});
export type Vocabulary = z.infer<typeof VocabularySchema>;

/** Notion 1 列あたりの選択肢の上限（公式上限を安全側で守る） */
export const NOTION_OPTIONS_PER_COLUMN_MAX = 100;
/** 選択肢名の上限文字数 */
export const LABEL_MAX_CHARS = 40;
