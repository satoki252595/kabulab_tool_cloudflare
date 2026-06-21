/**
 * kuromoji 形態素解析器のプロセス内シングルトン初期化。
 *
 * kuromoji 0.1.2 (Apache-2.0) は IPAdic ベースの日本語形態素解析器。
 * 辞書ファイル (~10MB の dat.gz) を初回ロードに 500-1000ms 消費するため、
 * **プロセス内で 1 度だけ build** してキャッシュする (per-PDF で再ロードしない)。
 *
 * Vercel Serverless では cold start で 1 回・以降は同 instance で再利用。
 * UI ondemand には組み込まず backfill / 日次 cron でのみ走らせる前提。
 */
// @ts-expect-error -- kuromoji 0.1.2 has no shipped types
import kuromoji from "kuromoji";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export interface Token {
  surface_form: string;
  pos: string;
  pos_detail_1?: string;
  basic_form?: string;
}

interface Tokenizer {
  tokenize: (text: string) => Token[];
}

// 辞書パスは**遅延**解決する。モジュール import 時に fileURLToPath を呼ぶと、
// Worker バンドルの起動検証で import.meta.url が undefined になり落ちるため
// (kuromoji 自体が Node 専用 fs 依存で、本関数は Node 実行時にのみ呼ばれる)。
function dictPath(): string {
  // node_modules/kuromoji/dict 内の辞書を直接指す (require.resolve は ESM では使えない)
  const here = dirname(fileURLToPath(import.meta.url));
  // services/ir-catalog/src/services/pdf-sentiment/dict/ から
  // <project>/node_modules/kuromoji/dict まで辿る
  return resolve(here, "..", "..", "..", "..", "..", "..", "node_modules", "kuromoji", "dict");
}

let tokenizerPromise: Promise<Tokenizer> | null = null;

export function getTokenizer(): Promise<Tokenizer> {
  if (tokenizerPromise) return tokenizerPromise;
  tokenizerPromise = new Promise<Tokenizer>((resolveT, rejectT) => {
    kuromoji
      .builder({ dicPath: dictPath() })
      .build((err: Error | null, tk: Tokenizer) => {
        if (err) {
          tokenizerPromise = null; // 失敗時は再試行可能にする
          rejectT(err);
          return;
        }
        resolveT(tk);
      });
  });
  return tokenizerPromise;
}

/** テキストを内容語 (名詞・動詞・形容詞) を中心に分割する */
export async function tokenize(text: string): Promise<Token[]> {
  const tk = await getTokenizer();
  return tk.tokenize(text);
}
