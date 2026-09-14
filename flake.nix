{
  description = "kabulab mono-repo — 日本株投資ツール統合ポータル (Node 22 + pnpm 9)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          # pnpm-lock.yaml は lockfileVersion 9.0 → pnpm 9 系で固定。
          # Node は package.json 運用に合わせ 22 系。
          # openvpn: VWAP 取込の Yahoo 429 回避用 VPN ローテーション
          # (scripts/vpn/vpngate-rotate.sh) で使用。接続自体は sudo が必要。
          packages = [
            pkgs.nodejs_22
            pkgs.pnpm_9
            pkgs.openvpn
          ];

          shellHook = ''
            # wrangler が既定で書く ~/Library/Preferences/.wrangler/logs には D1 の応答
            # (規約上公開できない本文を含みうる) が残るため、既定では書かない。デバッグ時は WRANGLER_WRITE_LOGS=true WRANGLER_LOG=debug を付ける。
            export WRANGLER_WRITE_LOGS=false
            export WRANGLER_LOG_PATH="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.wrangler/logs"
            echo "kabulab dev shell  node $(node -v)  pnpm $(pnpm -v)"
          '';
        };
      });
    };
}
