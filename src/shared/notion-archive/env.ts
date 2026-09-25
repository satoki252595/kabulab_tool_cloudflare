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
  /**
   * 一次データ本体・銘柄別データ・ごみ (不要化データの退避先) を置く
   * 「一次データ保管」ページ ID (2026-09-25 「バックアップ」トラッシュ事件を
   * 機に統合。旧 `NOTION_BACKUP_PAGE_ID`/`NOTION_TRASH_PAGE_ID` の役割を
   * 1 ページに集約する。`一次データ｜<service>`/`銘柄一覧｜<service>`/
   * `ごみ｜<service>` の各 DB は全てこのページ直下に置く — 命名の
   * `一次データ｜`/`ごみ｜` prefix で見分けが付くため、物理的に分ける
   * 必要は無いという判断)。
   */
  NOTION_ARCHIVE_PAGE_ID: () => normalizeId(required("NOTION_ARCHIVE_PAGE_ID")),
  /**
   * [移行専用・一時] 旧「バックアップ」ページ ID。
   * `scripts/notion/relocate-archive.ts` が旧配置からの移動元を特定するために
   * 使うだけで、通常の読み書き経路 (archive.ts/dataset.ts/stock-text.ts/
   * index-page.ts) はもう参照しない。移行完了後は `.env`/Secrets から削除してよい。
   */
  NOTION_BACKUP_PAGE_ID: () => optionalId("NOTION_BACKUP_PAGE_ID"),
  /**
   * [移行専用・一時] 旧「ごみ」ページ ID。用途は `NOTION_BACKUP_PAGE_ID` の
   * 説明と同じ (移行スクリプトの移動元特定専用)。
   */
  NOTION_TRASH_PAGE_ID: () => optionalId("NOTION_TRASH_PAGE_ID"),
  /** 索引ページ ID (設定時は Search を使わず直接更新。未設定時は自動発見) */
  NOTION_INDEX_PAGE_ID: () => optionalId("NOTION_INDEX_PAGE_ID"),
  /**
   * 有報テキスト (1 行 = 1 通・全銘柄共通の単一 DB) の ID。銘柄別の子ページ/
   * 子 DB を作らない設計 (2026-09-25 再配置。旧: 銘柄コード毎に子ページ+子DB
   * を作っていたが、数千件の子ページが「バックアップ」ページを開けなくした)。
   */
  NOTION_YUHO_TEXT_DB_ID: () => normalizeId(required("NOTION_YUHO_TEXT_DB_ID")),
  /**
   * [移行専用] 有報テキスト DB の **データソース ID** (2025-09-03 以降の
   * マルチソースデータベースモデルでの ID。`NOTION_YUHO_TEXT_DB_ID` の
   * database_id とは別の ID)。`POST /pages/{id}/move` の移動先指定
   * (`parent.data_source_id`) にのみ必要。`scripts/notion/relocate-archive.ts`
   * 専用で、通常の読み書き経路 (stock-text.ts) は使わない。
   */
  NOTION_YUHO_TEXT_DATA_SOURCE_ID: () =>
    normalizeId(required("NOTION_YUHO_TEXT_DATA_SOURCE_ID")),
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
