/**
 * wrangler のデバッグログを既定でローカルに残さないことのテスト。
 *
 * wrangler は既定で `~/Library/Preferences/.wrangler/logs`（xdg config）に
 * D1 応答をそのまま書く。優待の掲載文など規約上再配布できない本文が
 * 含まれうるため、devShell に入った時点で無効化しておく
 * (実測 2026-09-14: 同ディレクトリに 33,096 本・620MB が既に蓄積していた)。
 *
 * 固定するのは flake.nix の shellHook が次の 2 点を満たすこと:
 * - `WRANGLER_WRITE_LOGS=false` でディスク書込そのものを止める
 * - `WRANGLER_LOG_PATH` をリポジトリ内 (gitignore 済み) の `.wrangler/logs` に
 *   向け、デバッグで `WRANGLER_WRITE_LOGS=true` を付けたときも既定の
 *   `~/Library` へ書かせない
 *
 * `nix develop` を実際に起動する検証はしない (CI・ローカルとも低速で、
 * この 2 行が消えたことだけを検出したいなら不要)。実機確認は
 * `nix develop -c sh -c 'echo $WRANGLER_WRITE_LOGS $WRANGLER_LOG_PATH'` で行う。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function shellHook(): string {
  const flake = readFileSync(`${ROOT}/flake.nix`, "utf-8");
  const match = flake.match(/shellHook\s*=\s*''([\s\S]*?)'';/);
  if (!match) throw new Error("flake.nix に shellHook が見つからない");
  return match[1];
}

describe("wrangler ログを既定でディスクに書かない", () => {
  it("WRANGLER_WRITE_LOGS=false を export している", () => {
    expect(shellHook()).toContain("export WRANGLER_WRITE_LOGS=false");
  });

  it("既存の起動メッセージ echo を壊していない", () => {
    // shellHook を丸ごと差し替える変更をしたら壊れる、既存機能の回帰チェック。
    expect(shellHook()).toMatch(/echo "kabulab dev shell/);
  });
});

describe("WRANGLER_LOG_PATH をリポジトリ内に向けている", () => {
  it("WRANGLER_LOG_PATH を export している", () => {
    expect(shellHook()).toContain("export WRANGLER_LOG_PATH=");
  });

  it("既定のホームディレクトリ配下 (~/Library) を直接指していない", () => {
    const line = shellHook()
      .split("\n")
      .find((l) => l.includes("WRANGLER_LOG_PATH="));
    expect(line).toBeDefined();
    expect(line).not.toContain("$HOME");
    expect(line).not.toContain("~");
    expect(line).toContain(".wrangler/logs");
  });
});

describe(".gitignore が .wrangler/ を追跡除外している", () => {
  it(".wrangler/ パターンを持つ", () => {
    const gitignore = readFileSync(`${ROOT}/.gitignore`, "utf-8");
    const patterns = new Set(gitignore.split("\n").map((l) => l.trim()));
    expect(patterns.has(".wrangler/")).toBe(true);
  });
});
