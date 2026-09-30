/**
 * root 横断 (src/index.ts / src/cron / src/shared) 用の型付き環境変数アクセサ。
 *
 * CLAUDE.md ルール3: `process.env.*` の直参照は集約モジュールに限定し、
 * 呼び出し側は必ず getter 経由で取得する (誤記事故防止 + フォールバック禁止の一元管理)。
 *
 * - `required()`: 未設定なら throw (ルール2: 黙ってデフォルト値で埋めない)
 * - `optional()`: 未設定は `undefined` を返し、呼び出し側に判断を委ねる
 *   (「未取得」を型で表現する。`??` で消さないこと)
 *
 * 注: 各サービス固有の env は従来どおり各自の env.ts (例:
 * `src/shared/notion-archive/env.ts`) に置く。ここは root 共有分のみ。
 */

function required(key: string): string {
  const v = process.env[key];
  if (!v || v.trim() === "") {
    throw new Error(
      `環境変数 ${key} が設定されていません。.env を確認してください。`
    );
  }
  return v;
}

function optional(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() !== "" ? v : undefined;
}

export const sharedEnv = {
  /**
   * Cron 認証用シークレット。未設定は `undefined` を返す —
   * auth.ts 側が fail-closed (常に 401) で処理するため、参照時 throw に
   * すると cron 全体が 500 になり挙動が変わる。optional が正。
   */
  CRON_SECRET: () => optional("CRON_SECRET"),
  /**
   * Node 取込が Yahoo を Cloudflare エッジ経由で取得する際の Worker URL。
   * URL があるのに CRON_SECRET が無い状態は yahoo/client.ts が構成エラーとして
   * 拒否する。Worker 自身は CRON_SECRET のみを持ち、意図どおり直接取得する。
   */
  YAHOO_PROXY_BASE: () => optional("YAHOO_PROXY_BASE"),
  /**
   * デプロイ済み Worker のベース URL (例 https://kabulab-cf.<sub>.workers.dev)。
   * Node ローカルの CLI (scripts/moneyflow/ingest.ts・scripts/sync/yuho-edinet.ts 等)
   * が Worker の内部認証付きルートを `CRON_SECRET` 付きで叩くために使う。
   * 未設定は required で throw (同じ変数を複数箇所で process.env 直参照しない — ルール3)。
   */
  WORKER_BASE_URL: () => required("WORKER_BASE_URL"),
  /**
   * Node 取込から D1 へ書くための Cloudflare D1 HTTP API 認証 (ADR-0001)。
   * Worker の読取はバインディングで完結するため不要。Node 取込 (ir-catalog /
   * otakara / sync) でのみ参照するので未設定は required で throw。
   */
  CLOUDFLARE_API_TOKEN: () => required("CLOUDFLARE_API_TOKEN"),
  CLOUDFLARE_ACCOUNT_ID: () => required("CLOUDFLARE_ACCOUNT_ID"),
  D1_DATABASE_ID: () => required("D1_DATABASE_ID"),
  R2_ACCOUNT_ID: () => required("R2_ACCOUNT_ID"),
  R2_ACCESS_KEY_ID: () => required("R2_ACCESS_KEY_ID"),
  R2_SECRET_ACCESS_KEY: () => required("R2_SECRET_ACCESS_KEY"),
  R2_BUCKET: () => required("R2_BUCKET"),
  LOCAL_OUT: () => optional("LOCAL_OUT"),
  /**
   * この実行の GitHub Actions run URL。GitHub Actions が自動で注入する
   * `GITHUB_SERVER_URL`/`GITHUB_REPOSITORY`/`GITHUB_RUN_ID` から組み立てる
   * (シークレットではないため .env / GitHub Secrets への登録は不要。ローカル
   * 実行では未設定 = `undefined`)。「株価の日次同期」記録の実行URL列に使う。
   */
  GITHUB_RUN_URL: (): string | undefined => {
    const server = optional("GITHUB_SERVER_URL");
    const repo = optional("GITHUB_REPOSITORY");
    const runId = optional("GITHUB_RUN_ID");
    if (!server || !repo || !runId) return undefined;
    return `${server}/${repo}/actions/runs/${runId}`;
  },
  /**
   * この実行の Actions run ID と attempt (どちらも GitHub 自動注入)。
   * 株価バッチ保管の run 一意キーに使う。ローカル実行では未設定 =
   * `undefined` (呼び出し側が run 開始時刻で代替する。throw しない)。
   */
  GITHUB_RUN_ID: () => optional("GITHUB_RUN_ID"),
  GITHUB_RUN_ATTEMPT: () => optional("GITHUB_RUN_ATTEMPT"),
  /**
   * GitHub Actions の step 出力ファイル。ローカル実行では未設定 =
   * `undefined` (呼び出し側が出力を諦める。throw しない)。
   */
  GITHUB_OUTPUT: () => optional("GITHUB_OUTPUT"),
  /**
   * VWAP 取込 knob (vwap-ingest.yml・.env.example で明示宣言)。
   * 未設定は throw (黙示既定なし)。CONC/MAX_RATE_LIMIT/KEEP_DAYS は
   * 正整数、DELAY_MS は非負有限を要求する。値は出さず名のみ。
   */
  vwapKnobs: (): {
    conc: number;
    delayMs: number;
    maxRateLimit: number;
    keepDays: number;
  } => {
    const num = (key: string): number => {
      const n = Number(required(key));
      if (!Number.isFinite(n)) {
        throw new Error(`環境変数 ${key} は数値である必要があります。`);
      }
      return n;
    };
    const conc = num("CONC");
    const delayMs = num("DELAY_MS");
    const maxRateLimit = num("MAX_RATE_LIMIT");
    const keepDays = num("KEEP_DAYS");
    const positiveInts: Array<[string, number]> = [
      ["CONC", conc],
      ["MAX_RATE_LIMIT", maxRateLimit],
      ["KEEP_DAYS", keepDays],
    ];
    for (const [key, v] of positiveInts) {
      if (!Number.isInteger(v) || v <= 0) {
        throw new Error(`環境変数 ${key} は正の整数である必要があります。`);
      }
    }
    if (delayMs < 0) {
      throw new Error("環境変数 DELAY_MS は非負の数値である必要があります。");
    }
    return { conc, delayMs, maxRateLimit, keepDays };
  },
  /**
   * VWAP 5分足の取得範囲の通常値。CLI --range が無ければ必須
   * (未設定フォールバックなし)。値は出さず名のみ。
   */
  VWAP_INTRA_RANGE: () => required("INTRA_RANGE"),
};

/**
 * GitHub Actions / ローカル Node の全銘柄取込では、Yahoo 直アクセスを許可しない。
 * Worker 内の取込プロキシは yahooFetchDirect() を明示的に呼ぶため、この検査は
 * Node エントリポイントだけが実行する。
 */
export function requireYahooProxyForNodeSync(): void {
  const proxyBase = sharedEnv.YAHOO_PROXY_BASE();
  const secret = sharedEnv.CRON_SECRET();
  if (!proxyBase || !secret) {
    throw new Error(
      "Node 日次同期には YAHOO_PROXY_BASE と CRON_SECRET の両方が必要です。" +
        " GitHub Actions Secrets または .env を確認してください。"
    );
  }
}

export { required as requiredEnv, optional as optionalEnv };
