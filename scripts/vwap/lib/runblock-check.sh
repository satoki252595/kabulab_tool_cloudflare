#!/usr/bin/env bash
# vwap-ingest.yml daily-intra run block の最小 runnable check。
# YAML 内の実ブロックを抽出して stub pnpm で実行する (複写ロジックの乖離なし)。
# 正常/partial/fatal と Node未完了出口13の後続停止を検査。
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
YML="$ROOT/.github/workflows/vwap-ingest.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 実ブロック抽出: "VWAP daily + intra" step の run: | 以降・10sp インデント行のみ。
awk '
  /name: VWAP daily \+ intra/ { in_step=1 }
  in_step && /^        run: \|$/ { in_run=1; next }
  in_run && /^          / { sub(/^          /, ""); print; next }
  in_run { exit }
' "$YML" > "$TMP/block.sh"
[ -s "$TMP/block.sh" ] || { echo "FAIL: block not extracted"; exit 1; }
grep -q "pnpm ingest:vwap-daily" "$TMP/block.sh" || { echo "FAIL: daily line missing"; exit 1; }
grep -q "pnpm ingest:vwap-intra" "$TMP/block.sh" || { echo "FAIL: intra line missing"; exit 1; }

# stub pnpm: 呼出を記録し STUB_*_RC で終了。
mkdir -p "$TMP/bin"
cat > "$TMP/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$*" in
  ingest:vwap-daily*) exit "${STUB_DAILY_RC:-0}";;
  ingest:vwap-intra*) exit "${STUB_INTRA_RC:-0}";;
  *) exit 99;;
esac
EOF
chmod +x "$TMP/bin/pnpm"

pass=0; fail=0
check() { # name daily_rc intra_rc want_final want_intra_run [daily_only] [daily_codes]
  export STUB_LOG="$TMP/calls.log" STUB_DAILY_RC="$2" STUB_INTRA_RC="$3"
  export DAILY_ONLY="${6:-false}" DAILY_CODES="${7:-}"
  : > "$STUB_LOG"
  out="$(PATH="$TMP/bin:$PATH" bash -e "$TMP/block.sh" 2>&1)"
  rc=$?
  ran="no"; grep -q "ingest:vwap-intra" "$STUB_LOG" && ran="yes"
  if [ "$rc" = "$4" ] && [ "$ran" = "$5" ]; then
    pass=$((pass+1)); echo "PASS $1 (final=$rc intra_run=$ran)"
  else
    fail=$((fail+1)); echo "FAIL $1: want final=$4 intra_run=$5, got final=$rc intra_run=$ran"; echo "$out"
  fi
  echo "$out" | grep -q "daily_exit=" || { fail=$((fail+1)); echo "FAIL $1: status line missing"; }
  expected_daily="ingest:vwap-daily --yahoo-direct"
  if [ "$DAILY_ONLY" = "true" ] && [ -n "$DAILY_CODES" ]; then expected_daily="$expected_daily --codes=$DAILY_CODES"; fi
  [ "$(grep -Fc 'ingest:vwap-daily' "$STUB_LOG")" -eq 1 ] && grep -Fxq "$expected_daily" "$STUB_LOG" || {
    fail=$((fail+1)); echo "FAIL $1: daily arguments/call count differ";
  }
  if [ "$ran" = "yes" ]; then
    grep -Fxq 'ingest:vwap-intra --yahoo-direct' "$STUB_LOG" || { fail=$((fail+1)); echo "FAIL $1: intra direct argument missing"; }
  fi
}

check "daily1-intra-runs-final1" 1 0 1 yes
check "daily-abort2-intra-notrun-final2" 2 0 2 no
check "intra-abort2-final2" 0 2 2 yes
check "daily-unfinished13-intra-notrun-final2" 13 0 2 no
check "intra-unfinished13-final2" 0 13 2 yes
check "success-final0" 0 0 0 yes
check "daily-only-selected-final0" 0 0 0 no true "7203,6758"
check "daily-only-all-final0" 0 0 0 no true ""
check "daily-only-partial-final1" 1 0 1 no true "7203,6758"
check "daily-only-abort-final2" 2 0 2 no true "7203,6758"
check "daily-codes-do-not-limit-daily-intra" 0 0 0 yes false "7203,6758"

grep -q -- "- daily$" "$YML" || { fail=$((fail+1)); echo "FAIL: daily dispatch choice missing"; }
grep -q "DAILY_CODES:.*github.event.inputs.daily_codes" "$YML" || { fail=$((fail+1)); echo "FAIL: daily codes input missing"; }

# failure-artifact 回収口の存在確認 (durable-before-archive の対)。
grep -q "actions/upload-artifact@v4" "$YML" || { fail=$((fail+1)); echo "FAIL: artifact action missing"; }
grep -q "name: summary を失敗時 artifact に残す" "$YML" || { fail=$((fail+1)); echo "FAIL: artifact step missing"; }
grep -q "path: .vwap-summaries/" "$YML" || { fail=$((fail+1)); echo "FAIL: artifact path missing"; }

echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
