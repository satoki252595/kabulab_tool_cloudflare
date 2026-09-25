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
] as const;
export type Family = (typeof FAMILIES)[number];

/** 系統の日本語名（見直し材料・設計書の表示用） */
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
};

/** Notion のマルチセレクト列（business 層の振り分け先） */
export const NOTION_COLUMNS = ["upstream", "downstream"] as const;
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
  /** 資料本文からの短い原文引用（関門で実在を照合する） */
  quote: nonEmpty(),
});
export type Source = z.infer<typeof SourceSchema>;

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
  sources: z.array(SourceSchema).check(z.minLength(1)),
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
  sources: z.array(SourceSchema).check(z.minLength(1)),
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
