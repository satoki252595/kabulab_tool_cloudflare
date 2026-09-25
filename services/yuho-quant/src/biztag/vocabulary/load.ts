/**
 * 単語帳データ (`v1.json` / 台帳から読んだ JSON) を型付きの `Vocabulary` に
 * 変換する唯一の入口。形の検査 (zod) と意味の検査 (`assertValidVocabulary`)
 * の両方を必ず通す — どちらか片方だけを個別に呼ぶ経路を増やさない。
 */
import { VocabularySchema, type Vocabulary } from "./schema.js";
import { assertValidVocabulary } from "./validate.js";

/**
 * 未知の JSON 値を単語帳として読み込む。形が違う・意味検査に落ちる場合は
 * (元の値をそのまま通すのではなく) throw する。
 */
export function parseVocabulary(json: unknown): Vocabulary {
  const vocabulary = VocabularySchema.parse(json);
  assertValidVocabulary(vocabulary);
  return vocabulary;
}
