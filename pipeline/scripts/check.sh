#!/usr/bin/env bash
# 検証の一括実行。パイプで終了コードが隠れないよう個別に判定する。
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
echo "--- ruff ---"
nix develop -c uv run ruff check src tests || fail=1
echo "--- pytest ---"
out=$(nix develop -c uv run pytest 2>&1) || fail=1
echo "$out" | tail -1
echo "--- jss-api (typecheck + vitest) ---"
if [ -d ../services/jss-api/node_modules ]; then
  nix develop -c bash -c 'cd ../services/jss-api && pnpm typecheck' || fail=1
  nix develop -c bash -c 'cd ../services/jss-api && pnpm test' 2>&1 | tail -3 || fail=1
else
  echo "(../services/jss-api/node_modules が無いのでスキップ。pnpm install --dir ../services/jss-api で入る)"
fi
if [ $fail -ne 0 ]; then echo "CHECK: FAILED"; exit 1; fi
echo "CHECK: OK"
