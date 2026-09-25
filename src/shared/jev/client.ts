/**
 * jev (TypeSafe System One) クライアント (依存ゼロ・fetch 直叩き)。
 *
 * 設計: docs/005-yuho-quant-business-tags.md §5.5。用途は事業タグ判定
 * (noul 型質問のみ) に限定するため、公開する操作は `askNoul` 1 つだけ。
 *
 * 方針 (CLAUDE.md ルール2 の帰結):
 *   - 429/529/5xx・ネットワークエラー・タイムアウトは指数バックオフ
 *     (Retry-After があれば優先) で有界リトライする。
 *   - それ以外の 4xx (認証エラー・形式不正など) はリトライしても直らないので
 *     即座に `JevUnavailableError` を投げる。
 *   - 最終的に失敗した・想定した形の応答が返らなかった・依頼した質問の回答が
 *     欠けている場合も、既定値へのフォールバックは絶対にせず必ず throw する。
 */
import { z } from "../zod-mini.js";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** 入力 100 万トークンあたりの USD 単価 (出力は無料。docs §5.5)。 */
export const JEV_PRICE_PER_MTOK_INPUT_USD = 0.042;

/** noul 型 (0..1 の確率で回答する) 質問 1 件。 */
export interface JevNoulQuestion {
  /** 判定指示文 (英語)。 */
  instructions: string;
  /** true/false 判定の補足基準 (任意)。 */
  criteria?: { true?: string; false?: string };
}

/** askNoul 1 回分の結果。 */
export interface JevAskResult {
  /** 実際に使われたモデル (API 応答の echo をそのまま使う)。 */
  model: string;
  /** questionId → noul 確率 (0..1)。依頼した全 questionId ぶん揃っている。 */
  answers: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  /** この askNoul 呼び出し全体のレイテンシ (ms)。 */
  latencyMs: number;
  /** 実際に行った HTTP 試行回数 (リトライを含む。成功/失敗いずれの経路でも 1 以上)。 */
  attempts: number;
}

/**
 * jev API が使えない (通信不能・恒久エラー・想定外の応答) ことを表すエラー。
 * 呼び出し側は既定値へのフォールバックをせず、このエラーを「判定不能」として扱う。
 */
export class JevUnavailableError extends Error {
  readonly status?: number;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "JevUnavailableError";
    this.status = options?.status;
  }
}

export interface JevClient {
  /**
   * state (jev へ渡す状態文字列) と noul 型質問の集合を渡し、questionId ごとの
   * 確率を得る。依頼した questionId のいずれか 1 つでも回答が欠けている・
   * noul 型でない・0..1 の範囲外なら `JevUnavailableError` を投げる
   * (一部だけ既定値で埋めて返すことはしない)。
   */
  askNoul(
    state: string,
    questions: Record<string, JevNoulQuestion>
  ): Promise<JevAskResult>;
}

export interface CreateJevClientOptions {
  apiKey: string;
  /** 固定するモデル名 (`jev-latest` のような別名は呼び出し側で解決してから渡すこと)。 */
  model: string;
  /** Workers-safe な fetch を注入する (省略時はグローバル fetch)。 */
  fetch?: typeof fetch;
  /** リトライ回数の上限 (初回呼び出しを含まない。既定 3 = 最大 4 回試行)。 */
  maxRetries?: number;
  /** 指数バックオフの基準遅延 (ms)。既定 500ms。 */
  baseDelayMs?: number;
  /** バックオフ遅延の上限 (ms)。既定 8000ms。 */
  maxDelayMs?: number;
  /** 1 回の HTTP リクエストのタイムアウト (ms)。既定 30000ms (AbortController)。 */
  timeoutMs?: number;
  /** テスト高速化用に差し替え可能な sleep (既定は実際の setTimeout ベース)。 */
  sleep?: (ms: number) => Promise<void>;
  /** レイテンシ計測用の時計 (既定 Date.now)。テストで固定値を注入できる。 */
  now?: () => number;
  /** テスト用のエンドポイント差し替え (既定 JEV_ENDPOINT)。 */
  baseUrl?: string;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;
const DEFAULT_TIMEOUT_MS = 30_000;

// ── jev API のワイヤー形式 (外部境界なのでここでだけ zod 検証する) ──────────

const JevNoulAnswerSchema = z.strictObject({
  type: z.literal("noul"),
  noul: z.number().check(z.minimum(0), z.maximum(1)),
});

/** answers の中身までは検査しない (questionId ごとに askNoul 側で検査する)。 */
const JevApiResponseSchema = z.object({
  model: z.string().check(z.minLength(1)),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({
    input_tokens: z.number().check(z.int(), z.minimum(0)),
    output_tokens: z.number().check(z.int(), z.minimum(0)),
  }),
});
type JevApiResponse = z.infer<typeof JevApiResponseSchema>;

// ── リトライ・タイムアウト付き HTTP 呼び出し ────────────────────────────

/** 明示的にリトライ対象と分かっている一過性ステータス。それ以外の非 2xx は即 throw。 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-After (秒) があればそれを、無ければ指数バックオフを使う。 */
function computeDelayMs(
  res: Response | undefined,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  const retryAfterHeader = res?.headers.get("retry-after");
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, maxDelayMs);
    }
  }
  return Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
}

interface FetchJevArgs {
  fetchFn: typeof fetch;
  baseUrl: string;
  apiKey: string;
  body: unknown;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * jev API を叩く。429/529/5xx・ネットワークエラー (タイムアウト含む) は
 * 指数バックオフで有界リトライし、それ以外の非 2xx は即座に
 * `JevUnavailableError` を投げる。最終的にリトライを使い切っても復旧しなければ
 * 必ず `JevUnavailableError` を投げる (既定回答へのフォールバックは絶対にしない)。
 */
async function fetchJevWithRetry(
  args: FetchJevArgs
): Promise<{ response: JevApiResponse; attempts: number }> {
  const { fetchFn, baseUrl, apiKey, body, maxRetries, baseDelayMs, maxDelayMs, timeoutMs, sleep } =
    args;

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      try {
        res = await fetchFn(baseUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if (attempt < maxRetries) {
        await sleep(computeDelayMs(undefined, attempt, baseDelayMs, maxDelayMs));
        continue;
      }
      throw new JevUnavailableError(
        `jev API 呼び出しがネットワークエラー（タイムアウト含む）でリトライ上限（${maxRetries}回）に達しました: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }

    if (RETRYABLE_STATUS.has(res.status)) {
      if (attempt < maxRetries) {
        await sleep(computeDelayMs(res, attempt, baseDelayMs, maxDelayMs));
        continue;
      }
      throw new JevUnavailableError(
        `jev API がリトライ上限（${maxRetries}回）に達しても復旧しませんでした（最終status=${res.status}）`,
        { status: res.status }
      );
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new JevUnavailableError(
        `jev API がエラーを返しました（status=${res.status}）: ${bodyText.slice(0, 300)}`,
        { status: res.status }
      );
    }

    const bodyText = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch (err) {
      throw new JevUnavailableError(
        `jev API のレスポンスを JSON として解釈できませんでした: ${bodyText.slice(0, 300)}`,
        { cause: err }
      );
    }
    const parsed = JevApiResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new JevUnavailableError(
        `jev API のレスポンスが想定した形式と一致しません: ${JSON.stringify(parsed.error.issues).slice(0, 300)}`
      );
    }
    return { response: parsed.data, attempts: attempt + 1 };
  }
}

// ── createJevClient ─────────────────────────────────────────────────────

export function createJevClient(o: CreateJevClientOptions): JevClient {
  const {
    apiKey,
    model,
    fetch: fetchFn = fetch,
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sleep = defaultSleep,
    now = () => Date.now(),
    baseUrl = JEV_ENDPOINT,
  } = o;

  return {
    async askNoul(
      state: string,
      questions: Record<string, JevNoulQuestion>
    ): Promise<JevAskResult> {
      const qids = Object.keys(questions);
      if (qids.length === 0) {
        // 呼び出し側の実装ミス (質問 0 件で API を叩く意味が無い)。
        // API 障害ではないので JevUnavailableError にはしない。
        throw new Error("jev askNoul: questions が空です（呼び出し側の実装ミス）");
      }

      const questionsPayload: Record<
        string,
        { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
      > = {};
      for (const qid of qids) {
        const q = questions[qid] as JevNoulQuestion;
        questionsPayload[qid] =
          q.criteria !== undefined
            ? { type: "noul", instructions: q.instructions, criteria: q.criteria }
            : { type: "noul", instructions: q.instructions };
      }

      const start = now();
      const { response, attempts } = await fetchJevWithRetry({
        fetchFn,
        baseUrl,
        apiKey,
        body: { state, model, questions: questionsPayload },
        maxRetries,
        baseDelayMs,
        maxDelayMs,
        timeoutMs,
        sleep,
      });
      const latencyMs = now() - start;

      const answers: Record<string, number> = {};
      for (const qid of qids) {
        const raw = response.answers[qid];
        if (raw === undefined) {
          throw new JevUnavailableError(
            `jev API のレスポンスに質問 "${qid}" の回答がありません（想定していない欠落）`
          );
        }
        const parsedAnswer = JevNoulAnswerSchema.safeParse(raw);
        if (!parsedAnswer.success) {
          throw new JevUnavailableError(
            `jev API の質問 "${qid}" への応答が不正です（noul 型 0..1 ではありません）: ` +
              `${JSON.stringify(raw).slice(0, 300)}`
          );
        }
        answers[qid] = parsedAnswer.data.noul;
      }

      return {
        model: response.model,
        answers,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs,
        attempts,
      };
    },
  };
}
