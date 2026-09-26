/**
 * SemIf (https://github.com/TheoLeeCJ/SemIf, MLX バックエンド) を jev の
 * 代替判定モデルとして使うクライアント。
 *
 * 背景 (2026-09-26): 競合他社判定 (`biztag competitors`) の全銘柄一括実行中に
 * jev (TypeSafe System One) のクレジットが枯渇 (HTTP 402) し、3,607社中
 * 1,993社だけ判定済のまま停止した。残り 1,614社をこの Apple Silicon (M5 Max)
 * ローカル PC 上で SemIf (標準モデル Qwen/Qwen3.5-4B, リビジョン
 * 851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a, MLX バックエンド) を使って
 * 判定する運用 (docs/005-yuho-quant-business-tags.md §12.9)。
 *
 * `src/shared/jev/client.ts` の `JevClient` と全く同じ形 (`askNoul`) を
 * 実装するため、`competitors/` 配下の呼び出し側 (question.ts / process.ts /
 * pipeline.ts / evaluate.ts) は判定クライアントの差し替えだけで動く。
 *
 * 設計 (jev/muse と違う点):
 *   - **モデルを1回だけロードした常駐 Python プロセスを使う**
 *     (`services/yuho-quant/scripts/semif_server.py`)。MLX での Qwen3.5-4B の
 *     ロードは数秒〜十数秒かかるため、muse クライアントのように呼び出し
 *     ごとに新規プロセスを起動する設計は使えない。プロセスは遅延起動
 *     (最初の askNoul で起動) し、以降の呼び出しは標準入力/標準出力の
 *     JSONL 行プロトコルで使い回す。
 *   - **プロトコル**: リクエスト
 *     `{id, state, questions:[{qid, question, options:[yesの説明, noの説明]}]}`
 *     → レスポンス `{id, answers:{qid: p_yes}}` (成功) または
 *     `{id, error}` (失敗。バッチ全体を判定不能として扱う。ルール2 —
 *     一部だけ既定値で埋めて返すことは絶対にしない)。
 *   - **`JevNoulQuestion.criteria` が必須**: SemIf は「はい」「いいえ」に
 *     対応する実際の説明文 (option description) を要求する構造化 API
 *     (jev の自由形式の instructions 文だけでは判定できない)。
 *     `criteria.true`/`criteria.false` が無い質問は SemIf へマッピング
 *     できないため即座に throw する (既定の "Yes"/"No" 等でごまかさない)。
 *   - **入力トークン上限は絶対に切り詰めない**: SemIf 自体が
 *     `no truncation allowed` として例外を投げる仕様。ここではそれを
 *     握りつぶさず、バッチ全体を失敗としてエラーメッセージ (どの qid が
 *     何トークンで上限を超えたか) をそのまま呼び出し側へ伝える。
 *   - **トークン数は計測できない (課金構造が無いため)**: SemIf はローカル
 *     推論で API 従量課金が存在しない。`inputTokens`/`outputTokens` は
 *     0 を返すが、これは「実費用ゼロ」という事実そのもの (ローカル計算
 *     コストのみで金銭コストは文字通り0円) であり、muse (サブスク契約で
 *     計測不能なだけで実費用はゼロではない) とは意味が異なる。呼び出し側
 *     (pipeline.ts) がこの違いを `costMetering: "not_metered_local"` として
 *     明示する。
 */
import { spawn as nodeSpawn } from "node:child_process";
import { z } from "../zod-mini.js";
import type { JevAskResult, JevClient, JevNoulQuestion } from "../jev/client.js";
import { semifEnv } from "./env.js";

/** SemIf 常駐スコアラーの固定モデル表記 (依頼どおり固定)。 */
export const SEMIF_MODEL = "Qwen3.5-4B@851bf6e/semif-mlx";
/** `semif_server.py` の既定パス解決に使うモデル/リビジョン (SemIf docs/MLX.md 記載のピン留め値)。 */
export const SEMIF_HF_MODEL = "Qwen/Qwen3.5-4B";
export const SEMIF_HF_REVISION = "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a";

/**
 * SemIf が使えない (プロセス起動失敗・恒久エラー・タイムアウト・想定外の応答)
 * ことを表すエラー。呼び出し側は既定値へのフォールバックをせず、このエラーを
 * 「判定不能」として扱う (`JevUnavailableError` と同じ役割の別クラス)。
 */
export class SemifUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SemifUnavailableError";
  }
}

type SpawnFn = typeof nodeSpawn;
type ChildProcess = ReturnType<SpawnFn>;

export interface CreateSemifClientOptions {
  /** SemIf 隔離venv内の python 実行ファイルの絶対パス (省略時は `semifEnv.SEMIF_PYTHON()` を都度参照)。 */
  pythonBin?: string;
  /** `semif_server.py` の絶対パス (省略時はこのファイルからの相対解決)。 */
  serverScriptPath?: string;
  /** 起動時にロードする HF モデル (既定 `SEMIF_HF_MODEL`)。 */
  hfModel?: string;
  /** 起動時にロードするリビジョン (既定 `SEMIF_HF_REVISION`)。 */
  hfRevision?: string;
  /** 1行あたりの入力トークン上限 (既定16000。server.py 側の既定と揃える)。 */
  maxTokens?: number;
  /** モデルロード完了 (`ready` 行) を待つ上限 (ms)。既定 5分 (初回HFダウンロード込みでも十分な余裕)。 */
  readyTimeoutMs?: number;
  /** 1回の askNoul (1バッチ) の応答を待つ上限 (ms)。既定 5分。 */
  requestTimeoutMs?: number;
  /** テスト用にプロセス起動を差し替え可能にする (既定 node:child_process の spawn)。 */
  spawnFn?: SpawnFn;
  /** レイテンシ計測用の時計 (既定 Date.now)。テストで固定値を注入できる。 */
  now?: () => number;
}

const DEFAULT_READY_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_TOKENS = 16_000;

const ReadyLineSchema = z.strictObject({
  ready: z.literal(true),
  model: z.string(),
  revision: z.string(),
  backend: z.string(),
  max_tokens: z.number(),
});

const AnswersSchema = z.record(z.string(), z.number().check(z.minimum(0), z.maximum(1)));

const ResponseLineSchema = z.union([
  z.strictObject({ id: z.string(), answers: AnswersSchema }),
  z.strictObject({ id: z.nullable(z.string()), error: z.string() }),
]);

interface PendingRequest {
  resolve: (line: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** サーバープロセス1本分の状態 (起動・行バッファリング・保留中リクエストの対応付け)。 */
class SemifServerProcess {
  private child: ChildProcess | null = null;
  private readyPromise: Promise<void> | null = null;
  private stdoutBuffer = "";
  private pending = new Map<string, PendingRequest>();
  private nextRequestId = 0;
  private deadError: Error | null = null;

  constructor(private readonly o: Required<Omit<CreateSemifClientOptions, "pythonBin" | "serverScriptPath">> & {
    pythonBin: string;
    serverScriptPath: string;
  }) {}

  private ensureStarted(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.start();
    return this.readyPromise;
  }

  private start(): Promise<void> {
    return new Promise((resolveReady, rejectReady) => {
      const args = [
        this.o.serverScriptPath,
        "--model",
        this.o.hfModel,
        "--revision",
        this.o.hfRevision,
        "--max-tokens",
        String(this.o.maxTokens),
      ];
      let child: ChildProcess;
      try {
        child = this.o.spawnFn(this.o.pythonBin, args, { stdio: ["pipe", "pipe", "pipe"] });
      } catch (err) {
        rejectReady(
          new SemifUnavailableError(
            `semif_server.py の起動に失敗しました (${this.o.pythonBin}): ${err instanceof Error ? err.message : String(err)}`,
            { cause: err }
          )
        );
        return;
      }
      this.child = child;

      let settledReady = false;
      const readyTimer = setTimeout(() => {
        if (settledReady) return;
        settledReady = true;
        child.kill("SIGKILL");
        rejectReady(
          new SemifUnavailableError(
            `semif_server.py がモデルロード完了 (ready) を ${this.o.readyTimeoutMs}ms 以内に報告しませんでした`
          )
        );
      }, this.o.readyTimeoutMs);

      child.stdout?.on("data", (chunk: Buffer | string) => {
        this.stdoutBuffer += chunk.toString();
        for (;;) {
          const idx = this.stdoutBuffer.indexOf("\n");
          if (idx < 0) break;
          const line = this.stdoutBuffer.slice(0, idx).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
          if (line.length === 0) continue;

          if (!settledReady) {
            settledReady = true;
            clearTimeout(readyTimer);
            let parsedJson: unknown;
            try {
              parsedJson = JSON.parse(line);
            } catch (err) {
              rejectReady(
                new SemifUnavailableError(
                  `semif_server.py の起動応答を JSON として解釈できませんでした: ${line.slice(0, 300)}`,
                  { cause: err }
                )
              );
              return;
            }
            const parsedReady = ReadyLineSchema.safeParse(parsedJson);
            if (!parsedReady.success) {
              rejectReady(
                new SemifUnavailableError(
                  `semif_server.py の起動応答が想定した形式と一致しません: ${JSON.stringify(parsedJson).slice(0, 300)}`
                )
              );
              return;
            }
            resolveReady();
            continue;
          }
          this.handleResponseLine(line);
        }
      });

      child.stderr?.on("data", () => {
        // server.py はログを全て stderr へ出す (プロトコル行と混ぜない設計)。
        // ここでは握りつぶさず、プロセス終了時のエラーメッセージにのみ使う
        // ため、直近のログはプロセス終了ハンドラで参照できるよう保持しない
        // (量が多くなり得るため、必要なら運営が semif_server.py を直接
        // 起動してログを見る運用とする — 依頼どおりの範囲)。
      });

      child.on("error", (err) => {
        if (!settledReady) {
          settledReady = true;
          clearTimeout(readyTimer);
          rejectReady(
            new SemifUnavailableError(`semif_server.py の起動でエラーが発生しました: ${err.message}`, { cause: err })
          );
        }
        this.fail(new SemifUnavailableError(`semif_server.py プロセスでエラーが発生しました: ${err.message}`, { cause: err }));
      });

      child.on("close", (code) => {
        clearTimeout(readyTimer);
        const err = new SemifUnavailableError(`semif_server.py プロセスが終了しました (exit code=${code})`);
        if (!settledReady) {
          settledReady = true;
          rejectReady(err);
        }
        this.fail(err);
      });
    });
  }

  /** プロセスが死んだ・使えなくなったことを記録し、保留中の全リクエストを reject する。 */
  private fail(err: Error): void {
    this.deadError = err;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.readyPromise = null;
    this.child = null;
  }

  private handleResponseLine(line: string): void {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch (err) {
      // どのリクエストの応答か分からないため、保留中の全リクエストを失敗させる
      // (一部だけ成功したように見せない。ルール2)。
      this.fail(
        new SemifUnavailableError(`semif_server.py の応答行を JSON として解釈できませんでした: ${line.slice(0, 300)}`, {
          cause: err,
        })
      );
      return;
    }
    const parsed = ResponseLineSchema.safeParse(parsedJson);
    if (!parsed.success) {
      this.fail(
        new SemifUnavailableError(
          `semif_server.py の応答が想定した形式と一致しません: ${JSON.stringify(parsedJson).slice(0, 300)}`
        )
      );
      return;
    }
    const data = parsed.data;
    if (data.id === null) {
      // id を復元できないほど壊れたリクエスト行 (server.py 側の JSON パース失敗)。
      // どの保留中リクエストの応答か対応付けられないため、全滅させる。
      this.fail(new SemifUnavailableError(`semif_server.py が id 不明のエラー応答を返しました: ${JSON.stringify(data)}`));
      return;
    }
    const pendingReq = this.pending.get(data.id);
    if (!pendingReq) {
      // 対応する保留中リクエストが無い (実装ミス・二重応答等)。無視せず fail する。
      this.fail(new SemifUnavailableError(`semif_server.py が未知の id "${data.id}" への応答を返しました`));
      return;
    }
    this.pending.delete(data.id);
    clearTimeout(pendingReq.timer);
    pendingReq.resolve(data);
  }

  async request(state: string, questions: Record<string, JevNoulQuestion>): Promise<Record<string, number>> {
    await this.ensureStarted();
    if (this.deadError) throw this.deadError;
    const child = this.child;
    if (!child?.stdin) {
      throw new SemifUnavailableError("semif_server.py プロセスの標準入力が使えません");
    }

    const qids = Object.keys(questions);
    const requestId = `req-${this.nextRequestId++}`;
    const payloadQuestions = qids.map((qid) => {
      const q = questions[qid] as JevNoulQuestion;
      if (q.criteria?.true === undefined || q.criteria?.false === undefined) {
        // SemIf は yes/no それぞれの実際の説明文 (option description) を要求する
        // 構造化 API。criteria が無い質問は "Yes"/"No" のような既定文言で
        // ごまかさず、呼び出し側の実装ミスとして即座に throw する (ルール2)。
        throw new Error(
          `semif askNoul: 質問 "${qid}" に criteria.true/criteria.false がありません` +
            "(SemIf への変換には両方が必須です。呼び出し側のバグです)"
        );
      }
      return { qid, question: q.instructions, options: [q.criteria.true, q.criteria.false] };
    });

    const request = { id: requestId, state, questions: payloadQuestions };

    return new Promise<Record<string, number>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new SemifUnavailableError(`semif_server.py の応答が ${this.o.requestTimeoutMs}ms 以内に届きませんでした`)
        );
      }, this.o.requestTimeoutMs);

      this.pending.set(requestId, {
        resolve: (line: unknown) => {
          const data = line as { id: string; answers?: Record<string, number>; error?: string };
          if (data.error !== undefined) {
            reject(new SemifUnavailableError(`semif_server.py がエラーを返しました: ${data.error}`));
            return;
          }
          if (data.answers === undefined) {
            reject(new SemifUnavailableError("semif_server.py の応答に answers も error もありません (実装ミス)"));
            return;
          }
          resolve(data.answers);
        },
        reject,
        timer,
      });

      try {
        child.stdin!.write(`${JSON.stringify(request)}\n`);
      } catch (err) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(
          new SemifUnavailableError(`semif_server.py への書き込みに失敗しました: ${err instanceof Error ? err.message : String(err)}`, {
            cause: err,
          })
        );
      }
    });
  }
}

export function createSemifClient(o: CreateSemifClientOptions = {}): JevClient {
  const resolvedPythonBin = o.pythonBin ?? semifEnv.SEMIF_PYTHON();
  const resolvedScriptPath = o.serverScriptPath ?? defaultServerScriptPath();
  const proc = new SemifServerProcess({
    pythonBin: resolvedPythonBin,
    serverScriptPath: resolvedScriptPath,
    hfModel: o.hfModel ?? SEMIF_HF_MODEL,
    hfRevision: o.hfRevision ?? SEMIF_HF_REVISION,
    maxTokens: o.maxTokens ?? DEFAULT_MAX_TOKENS,
    readyTimeoutMs: o.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    requestTimeoutMs: o.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    spawnFn: o.spawnFn ?? nodeSpawn,
    now: o.now ?? (() => Date.now()),
  });
  const now = o.now ?? (() => Date.now());

  return {
    async askNoul(state: string, questions: Record<string, JevNoulQuestion>): Promise<JevAskResult> {
      const qids = Object.keys(questions);
      if (qids.length === 0) {
        throw new Error("semif askNoul: questions が空です（呼び出し側の実装ミス）");
      }
      const start = now();
      const answers = await proc.request(state, questions);

      // 依頼した questionId と過不足なく一致するか厳密検証する
      // (一部だけ既定値で埋めて返すことは絶対にしない。ルール2)。
      for (const qid of qids) {
        const p = answers[qid];
        if (p === undefined) {
          throw new SemifUnavailableError(`semif_server.py の応答に質問 "${qid}" の回答がありません（想定していない欠落）`);
        }
        if (!(p >= 0 && p <= 1)) {
          throw new SemifUnavailableError(`semif_server.py の質問 "${qid}" への応答が不正です（0..1 ではありません）: ${p}`);
        }
      }
      const extraKeys = Object.keys(answers).filter((k) => !qids.includes(k));
      if (extraKeys.length > 0) {
        throw new SemifUnavailableError(
          `semif_server.py が依頼していない質問への回答を返しました（実装ミス）: ${extraKeys.join(",")}`
        );
      }

      return {
        model: SEMIF_MODEL,
        answers,
        // SemIf はローカル推論で API 従量課金が存在しない。0 は「実費用ゼロ」
        // という事実そのもの (ヘッダコメント参照。muse の「計測不能」とは
        // 意味が異なる — 呼び出し側の costMetering で明示する)。
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: now() - start,
        attempts: 1,
      };
    },
  };
}

function defaultServerScriptPath(): string {
  return new URL(
    "../../../services/yuho-quant/scripts/semif_server.py",
    import.meta.url
  ).pathname;
}
