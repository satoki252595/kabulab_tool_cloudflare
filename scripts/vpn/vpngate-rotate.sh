#!/usr/bin/env bash
# ============================================================================
# VPNGate ローテーションで「Yahoo Finance API が 429 にならない exit IP」を探す。
#
# VWAP(007) 取込の Yahoo 429 は IP 単位のレート制限。VPN で egress IP を変えれば
# 回避し得る。VPNGate は OpenVPN(OSレベル)なので接続に root が要る。本スクリプトは
# 候補サーバを順に接続→Yahoo を実テスト→200 が出た所で接続を維持して止まる。
#
# ⚠️ 無料 VPNGate の IP は酷使され Yahoo に既に 429 の可能性が高い。
#    「見つからない」結果も普通に起こり得る(その場合は回線変更/待機/有料プロキシを)。
#
# 使い方 (nix develop 内で openvpn のパスを解決して sudo に渡す):
#   sudo bash scripts/vpn/vpngate-rotate.sh "$(command -v openvpn)"
#
# 200 が出たら: この端末は接続維持のまま、**別ターミナル**で
#   CONC=1 DELAY_MS=3000 pnpm ingest:vwap-daily
# を実行する。終わったら本端末で Ctrl-C → 切断。
#
# 環境変数: MAX(試行サーバ数, 既定15) / TEST_CODE(疎通確認の銘柄, 既定7203)
# ============================================================================
set -uo pipefail

OVPN="${1:-}"
[ -n "$OVPN" ] && [ -x "$OVPN" ] || {
  echo "usage: sudo bash $0 \"\$(command -v openvpn)\"  (nix develop 内で openvpn を解決して渡す)"
  exit 1
}
[ "$(id -u)" = "0" ] || { echo "root で実行してください (sudo)。"; exit 1; }

MAX="${MAX:-15}"
TEST_CODE="${TEST_CODE:-7203}"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
TEST_URL="https://query1.finance.yahoo.com/v8/finance/chart/${TEST_CODE}.T?range=5d&interval=1d"
WORK="$(mktemp -d /tmp/vpngate.XXXXXX)"
OVPN_PID=""

cleanup() { [ -n "$OVPN_PID" ] && kill "$OVPN_PID" 2>/dev/null; wait "$OVPN_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

BASE_IP="$(curl -s -m 10 https://api.ipify.org || true)"
echo "baseline IP: ${BASE_IP:-?}"
echo "VPNGate 一覧を取得中..."
# API は CRLF を返す。base64 フィールド末尾の \r が BSD base64(-d) を
# "invalid input" で失敗させるため、CRLF→LF に正規化してから扱う。
curl -s -m 30 "https://www.vpngate.net/api/iphone/" | tr -d '\r' > "$WORK/list.csv"
[ -s "$WORK/list.csv" ] || { echo "VPNGate 取得失敗"; exit 1; }

# 列: 1 HostName, 2 IP, 3 Score, 5 Speed, 7 CountryShort, 15 OpenVPN_ConfigData_Base64
# 速度(=安定/帯域)降順で候補化。config を持つ行のみ。
# macOS の /bin/bash は 3.2 で mapfile 非対応のため while-read で配列化する。
ROWS=()
while IFS= read -r line; do ROWS+=("$line"); done < <(
  awk -F, 'NR>2 && length($15)>100 {print $5"\t"$1"\t"$2"\t"$7"\t"$15}' "$WORK/list.csv" | sort -k1 -nr
)
echo "候補 ${#ROWS[@]} 台。上位 ${MAX} 台を順に試します。"

found=""
i=0
for row in "${ROWS[@]}"; do
  i=$((i+1)); [ "$i" -gt "$MAX" ] && break
  host="$(echo "$row" | cut -f2)"; ip="$(echo "$row" | cut -f3)"
  cc="$(echo "$row" | cut -f4)"; b64="$(echo "$row" | cut -f5)"
  echo ""
  echo "[$i/$MAX] $host ($cc $ip) 接続中..."
  echo "$b64" | base64 -d > "$WORK/c.ovpn" 2>/dev/null || { echo "  config decode 失敗 → skip"; continue; }

  # VPNGate は OpenVPN 認証に vpn/vpn を要求する。対話プロンプトで固まらないよう
  # creds を CLI で渡す(--auth-user-pass は server がチャレンジした時のみ使われる)。
  printf 'vpn\nvpn\n' > "$WORK/auth.txt"

  "$OVPN" --config "$WORK/c.ovpn" --auth-user-pass "$WORK/auth.txt" \
          --connect-timeout 15 --connect-retry-max 1 \
          > "$WORK/ovpn.log" 2>&1 &
  OVPN_PID=$!

  # トンネル確立待ち: exit IP が baseline から変わるまで最大 ~44s
  up=""
  for _ in $(seq 1 22); do
    sleep 2
    kill -0 "$OVPN_PID" 2>/dev/null || break          # openvpn が死んだら打ち切り
    cur="$(curl -s -m 5 https://api.ipify.org 2>/dev/null || true)"
    if [ -n "$cur" ] && [ "$cur" != "$BASE_IP" ]; then up="$cur"; break; fi
  done

  if [ -z "$up" ]; then
    echo "  トンネル確立せず → 次へ"
    kill "$OVPN_PID" 2>/dev/null; wait "$OVPN_PID" 2>/dev/null; OVPN_PID=""; sleep 3; continue
  fi

  code="$(curl -s -o /dev/null -m 15 -A "$UA" -w '%{http_code}' "$TEST_URL" || echo 000)"
  echo "  exit IP=$up  Yahoo chart=$code"
  if [ "$code" = "200" ]; then
    found="$host ($cc $up)"
    echo ""
    echo "✅ 通りました: $found"
    echo "   → このターミナルは接続維持のまま、**別ターミナル**で次を実行:"
    echo "        CONC=1 DELAY_MS=3000 pnpm ingest:vwap-daily"
    echo "   完了したら本ターミナルで Ctrl-C で切断します。"
    wait "$OVPN_PID"; break
  fi

  kill "$OVPN_PID" 2>/dev/null; wait "$OVPN_PID" 2>/dev/null; OVPN_PID=""; sleep 3
done

if [ -z "$found" ]; then
  echo ""
  echo "❌ 試した ${MAX} 台では Yahoo が 200 を返す VPNGate サーバはありませんでした。"
  echo "   無料 VPN の IP は概ね Yahoo に 429 済みです。回線変更(テザリングで実IP変更)/"
  echo "   時間待機/有料のクリーンなプロキシ を検討してください。MAX を増やして再試行も可:"
  echo "        sudo MAX=40 bash $0 \"$OVPN\""
fi
