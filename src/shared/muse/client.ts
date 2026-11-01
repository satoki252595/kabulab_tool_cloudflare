/**
 * muse (ローカル CLI, Meta muse-spark-1.3-contributor) を jev の代替として使う
 * クライアント。
 *
 * 背景 (2026-09-26): 競合他社判定 (`biztag competitors`) の全銘柄一括実行中に
 * jev (TypeSafe System One) のクレジットが枯渇 (HTTP 402) し、3,607社中 1,993社
 * だけ判定済のまま停止した。運営がすぐには追加課金できないため、残り 1,614社は
 * ローカル PC で動く muse CLI (`muse exec` ヘッドレスモード、Meta のサブスク
 * 契約でトークン課金なし) を代替判定モデルとして使う。
 *
 * `src/shared/jev/client.ts` の `JevClient` と全く同じ形 (`askNoul`) を実装する
 * ため、`competitors/` 配下の呼び出し側 (question.ts / process.ts / pipeline.ts /
 * evaluate.ts) は判定クライアントの差し替えだけで動く (型は `JevClient` を再利用)。
 *
 * 設計上の要点 (ルール1/2 の帰結):
 *   - **ツールを一切与えない**: 起動ディレクトリ (cwd) を毎回新規の一時ディレクトリ
 *     にすることで muse の「workspace untrusted」判定に自動的に入り、
 *     ファイル操作等のツールを使わせない (実測で確認済み。`--workspace` は渡さない)。
 *   - **シェル経由の文字列展開をしない**: `child_process.spawn` に引数配列を渡す
 *     だけで、シェルは介さない (`shell: true` を使わない)。プロンプト・スキーマは
 *     いずれもファイル経由 (`--prompt-file`) で渡し、コマンドライン引数に生の
 *     プロンプト文字列を乗せない。
 *   - **出力は JSON Schema (`--output-schema`) で構造を強制した上で、さらに
 *     コード側でも厳密検証する**: 依頼した質問 id が過不足なく揃っているか・
 *     各値が 0..1 の数値かを見て、1つでも合わなければ許容せず throw する
 *     (一部だけ既定値で埋めて返すことは絶対にしない)。
 *   - **プロセスの失敗 (起動失敗・非0終了・タイムアウト) だけ有界リトライする**。
 *     出力の形式不正 (JSON として解釈できない・質問idの過不足・値域外) は
 *     プロセス自体は正常終了しているため、リトライしても改善が見込めず
 *     (jev の応答形式不正を再試行しないのと同じ設計判断)、即座に throw する。
 *   - **トークン数は muse から取得できない** (サブスク契約でリクエスト単位の課金
 *     ではないため、CLI 標準出力・`--json` イベント出力のいずれにも usage 情報が
 *     含まれない。実機確認済み)。`inputTokens`/`outputTokens` は 0 を返すが、
 *     これは「実費用ゼロ」ではなく「計測不能 (サブスク契約で従量課金なし)」を
 *     意味する。呼び出し側 (pipeline.ts の費用サマリ) はこの意味を
 *     `costMetering: "not_metered_subscription"` として明示し、0 を実費用の
 *     ように見せない (ルール2: 「取得できない値」を実測値と混ぜない)。
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "../zod-mini.js";
import type { JevAskResult, JevClient, JevNoulQuestion } from "../jev/client.js";
import { museEnv } from "./env.js";

/** muse CLI に固定で渡すモデル名 (依頼どおり固定)。 */
export const MUSE_MODEL = "muse-spark-1.3-contributor";
/** muse CLI に固定で渡す推論の強さ (依頼どおり固定)。 */
export const MUSE_REASONING_EFFORT = "max";

/**
 * muse が使えない (起動失敗・恒久エラー・タイムアウト・想定外の応答) ことを
 * 表すエラー。呼び出し側は既定値へのフォールバックをせず、このエラーを
 * 「判定不能」として扱う (`JevUnavailableError` と同じ役割の別クラス)。
 */
export class MuseUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "MuseUnavailableError";
  }
}

type SpawnFn = typeof nodeSpawn;

export interface CreateMuseClientOptions {
  /** muse CLI 実行ファイルの絶対パス (省略時は `museEnv.MUSE_BIN()` を都度参照)。 */
  binPath?: string;
  /** リトライ回数の上限 (プロセス失敗のみ対象。初回呼び出しを含まない。既定2 = 最大3回試行)。 */
  maxRetries?: number;
  /** 1 回のプロセス実行のタイムアウト (ms)。既定 10分 (バッチ最大50問・reasoning-effort=max の実測ジッタを踏まえた余裕値)。 */
  timeoutMs?: number;
  /** レイテンシ計測用の時計 (既定 Date.now)。テストで固定値を注入できる。 */
  now?: () => number;
  /** テスト用にプロセス起動を差し替え可能にする (既定 node:child_process の spawn)。 */
  spawnFn?: SpawnFn;
  /** 一時ディレクトリの作成先の親ディレクトリ (既定 os.tmpdir())。テスト用。 */
  tmpRoot?: string;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

interface RunResult {
  kind: "exited" | "timeout" | "spawn_error";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  message?: string;
}

/** `muse exec` を1回実行する。プロセス自体の起動失敗・タイムアウトは例外を投げず RunResult で表す。 */
function runMuseOnce(
  spawnFn: SpawnFn,
  binPath: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    let child: ReturnType<SpawnFn>;
    try {
      child = spawnFn(binPath, args, { cwd });
    } catch (err) {
      resolve({
        kind: "spawn_error",
        exitCode: null,
        stdout: "",
        stderr: "",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ kind: "timeout", exitCode: null, stdout, stderr });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ kind: "spawn_error", exitCode: null, stdout, stderr, message: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ kind: "exited", exitCode: code, stdout, stderr });
    });
  });
}

/** 依頼した questionId ごとに、指示文・判定基準を書き下したプロンプトを組み立てる。 */
function buildPrompt(state: string, questions: Record<string, JevNoulQuestion>): string {
  const lines: string[] = [
    "You are a strict evaluator used as a drop-in substitute for a probability-judging API. " +
      "You will be given a STATE (context) and a set of yes/no questions about it, each identified by a question id. " +
      "For EACH question id, output your best estimate — as a probability between 0 and 1 — that the statement in its " +
      "instructions is true, based only on the STATE and that question's own instructions/criteria (ignore any other question's content). " +
      "Use the full 0..1 range when your confidence is not extreme; do not default to only 0 or 1. " +
      "Respond only with a JSON object mapping every question id below to a number in [0,1]. " +
      "Every id listed below must appear exactly once in your answer, and no other ids may appear.",
    "",
    "## STATE",
    state,
    "",
    "## QUESTIONS",
  ];
  for (const [qid, q] of Object.entries(questions)) {
    lines.push(`### ${qid}`);
    lines.push(`Instructions: ${q.instructions}`);
    if (q.criteria?.true !== undefined) lines.push(`Criteria for true: ${q.criteria.true}`);
    if (q.criteria?.false !== undefined) lines.push(`Criteria for false: ${q.criteria.false}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** 依頼した questionId 全てを number[0,1] のプロパティとして要求する JSON Schema。 */
function buildOutputSchema(qids: string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const qid of qids) {
    properties[qid] = { type: "number", minimum: 0, maximum: 1 };
  }
  return {
    type: "object",
    properties,
    required: [...qids],
    additionalProperties: false,
  };
}

/** JSON 応答を「依頼した質問idと過不足なく一致し、値が全て0..1の数値」であるか厳密検証する。 */
function validateAnswers(json: unknown, qids: string[]): Record<string, number> {
  const shape: Record<string, ReturnType<typeof z.number>> = {};
  for (const qid of qids) {
    shape[qid] = z.number().check(z.minimum(0), z.maximum(1));
  }
  const schema = z.strictObject(shape);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new MuseUnavailableError(
      "muse exec の応答が想定した形式と一致しません" +
        "（依頼した質問idと完全一致し、各値が0..1の数値であることが必要）: " +
        `${JSON.stringify(parsed.error.issues).slice(0, 500)}`
    );
  }
  return parsed.data as Record<string, number>;
}

export function createMuseClient(o: CreateMuseClientOptions = {}): JevClient {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = () => Date.now(),
    spawnFn = nodeSpawn,
    tmpRoot = tmpdir(),
  } = o;

  return {
    async askNoul(state: string, questions: Record<string, JevNoulQuestion>): Promise<JevAskResult> {
      const qids = Object.keys(questions);
      if (qids.length === 0) {
        // 呼び出し側の実装ミス (質問 0 件でプロセスを起動する意味が無い)。
        throw new Error("muse askNoul: questions が空です（呼び出し側の実装ミス）");
      }

      const binPath = o.binPath ?? museEnv.MUSE_BIN();
      const schema = buildOutputSchema(qids);
      const prompt = buildPrompt(state, questions);

      const start = now();
      for (let attempt = 0; ; attempt++) {
        const workDir = await mkdtemp(join(tmpRoot, "muse-biztag-"));
        try {
          const schemaPath = join(workDir, "schema.json");
          const promptPath = join(workDir, "prompt.txt");
          await writeFile(schemaPath, JSON.stringify(schema), "utf-8");
          await writeFile(promptPath, prompt, "utf-8");

          const args = [
            "exec",
            "--model",
            MUSE_MODEL,
            "--reasoning-effort",
            MUSE_REASONING_EFFORT,
            "--output-schema",
            schemaPath,
            "--prompt-file",
            promptPath,
          ];

          // cwd を毎回新規の一時ディレクトリにすることで muse の
          // 「workspace untrusted」判定に入り、ツール利用を封じる (実測で確認済み)。
          const result = await runMuseOnce(spawnFn, binPath, args, workDir, timeoutMs);

          if (result.kind === "timeout") {
            if (attempt < maxRetries) continue;
            throw new MuseUnavailableError(
              `muse exec がタイムアウトしました（${timeoutMs}ms、リトライ上限${maxRetries}回に到達）`
            );
          }
          if (result.kind === "spawn_error") {
            if (attempt < maxRetries) continue;
            throw new MuseUnavailableError(
              `muse exec の起動に失敗しました（リトライ上限${maxRetries}回に到達）: ${result.message ?? "不明なエラー"}`
            );
          }
          if (result.exitCode !== 0) {
            if (attempt < maxRetries) continue;
            throw new MuseUnavailableError(
              `muse exec が終了コード${result.exitCode}で失敗しました（リトライ上限${maxRetries}回に到達）: ` +
                `${result.stderr.slice(0, 500)}`
            );
          }

          // ここから先はプロセスとしては正常終了 (exitCode=0)。応答内容の不備は
          // プロセスの一過性障害ではないため、リトライせず即座に throw する
          // (ルール2: 想定外の応答をリトライで誤魔化さない)。
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(result.stdout.trim());
          } catch (err) {
            throw new MuseUnavailableError(
              `muse exec の標準出力を JSON として解釈できませんでした: ${result.stdout.slice(0, 500)}`,
              { cause: err }
            );
          }
          const answers = validateAnswers(parsedJson, qids);

          return {
            model: `${MUSE_MODEL}@${MUSE_REASONING_EFFORT}`,
            answers,
            // muse はサブスク契約でリクエスト単位のトークン課金が無く、CLI もその
            // usage を報告しない (実機確認済み)。0 は「実費ゼロ」ではなく
            // 「計測不能 (not_metered_subscription)」を意味する — 呼び出し側の
            // 費用サマリでこの意味を明示すること (ヘッダコメント参照)。
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: now() - start,
            attempts: attempt + 1,
          };
        } finally {
          await rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    },
  };
}
