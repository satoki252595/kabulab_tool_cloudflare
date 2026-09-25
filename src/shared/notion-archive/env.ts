/**
 * 一次データ Notion アーカイブの型付き環境変数アクセサ (CLAUDE.md ルール3 / ルール6)。
 *
 * `process.env.*` の直参照はこのモジュールに集約する。未設定時は参照時点で
 * throw し、silent fallback (ルール2) は行わない。`.env` が値の唯一の
 * source of truth。Vercel ランタイムでは Dashboard の Environment Variables
 * が `.env` の代わりに正のソースになる。
 */

/**
 * 設定起因の恒久エラー (env 未設定 / Notion ID 形式不正 等)。
 * client.ts の指数バックオフ再試行ループから除外するためのマーカー型。
 * 一過性 (ネットワーク/5xx/429/CDN 一時遮断) と異なり、リトライしても
 * 直らないので 1 度目で即 surface して呼び出し側に判断を委ねる (ルール2)。
 * 過去事例: kabulab Vercel プロジェクト側で NOTION_TOKEN 未設定のまま
 * /file proxy が呼ばれ、retry が「一過性」と誤判定して 6 回 (~61s) backoff
 * → エンドユーザの初回応答が 63s まで膨張した。
 */
export class NotionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotionConfigError";
  }
}

function required(key: string): string {
  const v = process.env[key];
  if (!v || v.trim() === "") {
    throw new NotionConfigError(
      `環境変数 ${key} が設定されていません。.env (または Vercel Env) を確認してください。`
    );
  }
  return v.trim();
}

/** Notion ページ/DB ID のハイフンを除去 (API はどちらも受けるが内部で統一) */
function normalizeId(id: string): string {
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new NotionConfigError(`Notion ID 形式が不正です: ${id}`);
  }
  return hex;
}

function optionalId(key: string): string | undefined {
  const v = process.env[key];
  if (!v || v.trim() === "") return undefined;
  return normalizeId(v.trim());
}

export const notionEnv = {
  /** Notion Internal Integration トークン (ntn_ で始まる) */
  NOTION_TOKEN: () => required("NOTION_TOKEN"),
  /** 一次データを記録する「バックアップ」ページ ID */
  NOTION_BACKUP_PAGE_ID: () => normalizeId(required("NOTION_BACKUP_PAGE_ID")),
  /** 不要化した元データの退避先「ごみ」ページ ID */
  NOTION_TRASH_PAGE_ID: () => normalizeId(required("NOTION_TRASH_PAGE_ID")),
  /** 索引ページ ID (設定時は Search を使わず直接更新。未設定時は自動発見) */
  NOTION_INDEX_PAGE_ID: () => optionalId("NOTION_INDEX_PAGE_ID"),
  /**
   * 「株式情報」ページ ID (005 yuho-quant 事業タグ)。Python パイプラインの
   * ① 銘柄マスタ 等と同じ親ページ。「銘柄マスタ（補足）」「事業タグ単語帳
   * （台帳）」DB をこの直下に作る (docs/005-yuho-quant-business-tags.md §3)。
   */
  NOTION_STOCK_INFO_PAGE_ID: () =>
    normalizeId(required("NOTION_STOCK_INFO_PAGE_ID")),
  /**
   * ① 銘柄マスタ DB ID (`銘柄マスタ（補足）` からの relation 先)。
   * `.env.example` の pipeline ブロックに同値がコメントで残る Python 側の値と
   * 同じもの (値は一致させること)。
   */
  NOTION_DB_STOCK_MASTER: () => normalizeId(required("NOTION_DB_STOCK_MASTER")),
  /** 「銘柄マスタ（補足）」DB ID を固定 (任意。未設定なら Search で自動発見) */
  NOTION_STOCK_SUPPLEMENT_DB_ID: () =>
    optionalId("NOTION_STOCK_SUPPLEMENT_DB_ID"),
  /** 「事業タグ単語帳（台帳）」DB ID を固定 (任意。未設定なら Search で自動発見) */
  NOTION_BIZTAG_LEDGER_DB_ID: () => optionalId("NOTION_BIZTAG_LEDGER_DB_ID"),
};
