/**
 * 開示 PDF 本文テキストの読み取り層。
 *
 * ルール2: 行が無い (TDnet purge 済み・抽出不能・未処理) は null のまま返し、
 * 呼び出し側に判断を委ねる。本文テキストは factual-cite (TDnet 原文) のため
 * 公開面への露出はライセンス地図の判断に従う (現状は内部利用)。
 */
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { disclosures, disclosureTexts } from "../db/schema.js";

export interface DisclosureText {
  tdnetId: string;
  text: string;
  charCount: number;
  title: string;
}

/** tdnet_id 指定で本文 1 件。無ければ null。 */
export async function getDisclosureText(
  db: Database,
  tdnetId: string
): Promise<DisclosureText | null> {
  const rows = await db
    .select({
      tdnetId: disclosureTexts.tdnetId,
      text: disclosureTexts.text,
      charCount: disclosureTexts.charCount,
      title: disclosures.title,
    })
    .from(disclosureTexts)
    .innerJoin(disclosures, eq(disclosureTexts.disclosureId, disclosures.id))
    .where(eq(disclosureTexts.tdnetId, tdnetId))
    .limit(1);
  return rows[0] ?? null;
}
