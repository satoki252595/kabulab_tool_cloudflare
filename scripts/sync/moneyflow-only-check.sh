#!/usr/bin/env bash
# stock-sync.yml moneyflow-only selector の runnable check (sender0)。
# YAML 内の実 run block を抽出し、stub env + GITHUB_OUTPUT で実行する
# (producer・Source・gh を起動しない)。stocks/all/既知全列挙/unknown 系。
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
YML="$ROOT/.github/workflows/stock-sync.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 実ブロック抽出: id moneyflow_only の run: | 以降・10sp 接頭辞行のみ。
awk '
  /id: moneyflow_only/ { in_step=1 }
  in_step && /^        run: \|$/ { in_run=1; next }
  in_run && /^          / { sub(/^          /, ""); print; next }
  in_run { exit }
' "$YML" > "$TMP/block.sh"
[ -s "$TMP/block.sh" ] || { echo "FAIL: block not extracted"; exit 1; }
grep -q "sector-turnover" "$TMP/block.sh" || { echo "FAIL: selector body missing"; exit 1; }
# 未知の空文字 fallback 禁止: *) 行は exit 1 必須・ONLY 代入なし。
awk '/\*\)/ { if ($0 !~ /exit 1/ || $0 ~ /ONLY=/) { print "FAIL: fallback branch: " $0; fail=1 } } END { exit fail }' "$TMP/block.sh" || exit 1

pass=0; fail=0
check() { # name event target schedule want_exit want_only
  export EVENT_NAME="$2" DISPATCH_TARGET="$3" EVENT_SCHEDULE="$4" GITHUB_OUTPUT="$TMP/out.env"
  : > "$GITHUB_OUTPUT"
  bash -e "$TMP/block.sh" > "$TMP/log.txt" 2>&1; rc=$?
  got="__none__"; grep -q "^only=" "$GITHUB_OUTPUT" && got="$(grep '^only=' "$GITHUB_OUTPUT" | cut -d= -f2)"
  if [ "$rc" = "$5" ] && [ "$got" = "$6" ]; then
    pass=$((pass+1)); echo "PASS $1 (exit=$rc only='$got')"
  else
    fail=$((fail+1)); echo "FAIL $1: want exit=$5 only='$6', got exit=$rc only='$got'"; cat "$TMP/log.txt"
  fi
}

check "dispatch-stocks" workflow_dispatch stocks "" 0 "sector-turnover"
check "dispatch-all" workflow_dispatch all "" 0 ""
check "dispatch-daily" workflow_dispatch daily "" 0 ""
check "dispatch-context" workflow_dispatch context "" 0 ""
check "dispatch-monthly" workflow_dispatch monthly "" 0 ""
check "dispatch-scheduled-stocks" workflow_dispatch scheduled-stocks "" 0 ""
check "dispatch-scheduled-context" workflow_dispatch scheduled-context "" 0 ""
check "removed-schedule-stocks" schedule "" "13 17 * * 1-5" 1 "__none__"
check "removed-schedule-macro" schedule "" "0 21 * * 1-5" 1 "__none__"
check "schedule-monthly" schedule "" "30 1 10 * *" 0 ""
check "unknown-target" workflow_dispatch bogus "" 1 "__none__"
check "empty-target" workflow_dispatch "" "" 1 "__none__"
check "unknown-schedule" schedule "" "0 0 * * *" 1 "__none__"
check "unknown-event" push "" "" 1 "__none__"

echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
