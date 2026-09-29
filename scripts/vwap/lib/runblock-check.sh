#!/usr/bin/env bash
# vwap-ingest.yml daily-intra run block の最小 runnable check。
# YAML 内の実ブロックを抽出して stub pnpm で実行する (複写ロジックの乖離なし)。
# 4 cases: daily1→intra実行+final1 / daily2→intra未実行+final2 / intra2→final2 / 成功→0。
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
check() { # name daily_rc intra_rc want_final want_intra_run
  export STUB_LOG="$TMP/calls.log" STUB_DAILY_RC="$2" STUB_INTRA_RC="$3"
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
}

check "daily1-intra-runs-final1" 1 0 1 yes
check "daily-abort2-intra-notrun-final2" 2 0 2 no
check "intra-abort2-final2" 0 2 2 yes
check "success-final0" 0 0 0 yes

echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
