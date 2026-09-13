/**
 * 優待要約のタスク / 結果ファイルを「コミットされ得る場所」に置かせないガード。
 *
 * タスクファイルには出典サイトの掲載文 (`description`) がそのまま入る。掲載文は
 * 規約上、私的使用を超えた蓄積・公開ができず、しかもこのリポジトリは public。
 * 2026-09-12 には `benefit-descriptions.jsonl` 5,694 行を履歴ごと除去している。
 * 結果ファイルも掲載文の言い換えを含み得るので同じ扱いにする。
 *
 * .gitignore に書いてあるだけでは、`--out ./tasks.jsonl` のように別の場所を
 * 指定された時点で守られない。そこで書き出し / 読み込みの直前に
 * **リポジトリ内なら git が無視する場所であること**を確かめ、違えば止める。
 *
 * 採らなかった案:
 * - 出力先を固定して引数で変えられなくする: 外部エージェントへの受け渡しで
 *   リポジトリ外 (一時ディレクトリ等) に置きたい場面を潰すので採らない。
 * - パス文字列が `data-scripts/data/` 配下かを見る: .gitignore を変えたときに
 *   ガードだけが古い前提で通してしまう。git 自身に聞く方が乖離しない。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** 存在する最も近い祖先ディレクトリ (出力先ディレクトリが未作成でも git に聞ける)。 */
function nearestExistingDir(path: string): string {
  let dir = dirname(resolve(path));
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

/**
 * `path` がリポジトリ内でコミットされ得る場所なら throw する。
 * リポジトリ外 (git 管理外のディレクトリ) は対象外として通す。
 */
export function assertNotCommittable(path: string): void {
  const abs = resolve(path);
  const cwd = nearestExistingDir(abs);
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf-8",
  });
  if (top.error) {
    // git が無い環境で黙って通すと、ガードが効いていないことに気付けない。
    throw new Error(
      `git を実行できないため ${abs} が公開リポジトリにコミットされ得るか判定できません: ${top.error.message}`,
    );
  }
  if (top.status !== 0) return; // git 管理外

  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", abs], {
    cwd,
    encoding: "utf-8",
  });
  if (tracked.status === 0) {
    throw new Error(
      `${abs} は git で追跡されています。掲載文を含むファイルはコミットできません。`,
    );
  }
  const ignored = spawnSync("git", ["check-ignore", "-q", abs], { cwd });
  if (ignored.status === 0) return;
  if (ignored.status === 1) {
    throw new Error(
      `${abs} は .gitignore の対象外です。掲載文を含むファイルは公開リポジトリに置けないため、` +
        `services/otakara-yutai/data-scripts/data/ 配下かリポジトリ外を指定してください。`,
    );
  }
  throw new Error(`git check-ignore が失敗しました (exit ${ignored.status}): ${abs}`);
}
