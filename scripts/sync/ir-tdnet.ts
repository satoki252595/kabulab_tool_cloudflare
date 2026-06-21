// TDnet 適時開示キャッチアップ CLI（ADR-0001 移行中・現在は無効）。
//
// ir-catalog は **読取を D1 へ移行済み**だが、取込(catchup)は PDF センチメント判定
// が kuromoji(Node 専用・辞書を fs から読む)に依存するため Worker 上で実行できない。
// よって取込は「Node 実行 + D1 HTTP API 書込(drizzle sqlite-proxy)」へ作り替える
// 必要があり、これは CLOUDFLARE_API_TOKEN(D1 edit 権限) を要する別タスク。
//
// それまでは新規開示の D1 取込は停止する(既存 20,152 件は cutover 済みで読取可能)。
// 黙って壊れる代わりに fail-fast する(CLAUDE.md ルール2)。
import "dotenv/config";

throw new Error(
  "ADR-0001: ir-catalog の取込は D1 移行に伴い再実装中(Node + D1 HTTP API)。" +
    "kuromoji が Node 専用のため Worker ルート化不可。CLOUDFLARE_API_TOKEN 設定後に有効化予定。"
);
