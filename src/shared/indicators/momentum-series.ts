/**
 * `p_momentum.closes` の符号化 / 復号（純関数）。
 *
 * 投影の writer（`src/cron/daily.ts`）と reader（004 の `/emh`）が**同じ関数**を
 * 通ることを保証するためにここへ置く。片側だけで書き方を変えると、
 * 「保存はできているのに読むと 0 件」という形で静かに壊れる。
 *
 * 表現は CSV。JSON 配列より短く、`wrangler d1 execute --remote` で
 * SELECT したときに人が読める（投影の中身を目で確かめられることを優先した）。
 * バイナリ（Float32 の base64）は約 40% 小さくなるが、D1 の課金軸は
 * 走査**行数**でバイト数ではないため、縮めても継続コストは下がらない。
 */

/**
 * 終値配列（古い順）を CSV へ。
 *
 * 有効な終値（有限・正）だけを残す。落とした分は日付の穴として残らないので、
 * 何本で算出したかは `p_momentum.bars` として別に持つ（= この関数の戻り値の
 * 要素数と一致させる責任は呼び出し側にある）。
 */
export function encodeCloses(closes: ReadonlyArray<number | null>): string {
  const out: string[] = [];
  for (const c of closes) {
    if (c === null || !Number.isFinite(c) || c <= 0) continue;
    // Number → String は往復で値が変わらない (最短再現表現)。
    out.push(String(c));
  }
  return out.join(",");
}

/**
 * CSV を終値配列へ。
 *
 * 壊れた要素（空文字・非数・非正）は落とす。**例外は投げない**:
 * 投影は再生成可能な派生物で、1 銘柄の行が壊れても画面全体を 500 にする理由が
 * 無い。落ちた銘柄は `calcMomentum` が window 不足で null を返し、
 * ランキングから外れる（= 件数として現れる）。
 */
export function decodeCloses(csv: string): number[] {
  if (csv.length === 0) return [];
  const out: number[] = [];
  for (const part of csv.split(",")) {
    const n = Number(part);
    if (!Number.isFinite(n) || n <= 0) continue;
    out.push(n);
  }
  return out;
}
