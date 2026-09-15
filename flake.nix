{
  description = "kabulab mono-repo — 日本株投資ツール統合ポータル (Node 22 + pnpm 9 / pipeline は Python 3.12 + uv)";

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
      devShells = forAllSystems (pkgs:
        let
          # uv が入れる numpy/pandas/pyarrow/lxml 等の manylinux wheel は実行時に
          # libstdc++.so.6 等の共有ライブラリを要求する。素の Nix devShell には無いため
          # Linux CI で `ImportError: libstdc++.so.6: cannot open shared object file`
          # になる（macOS は wheel が dylib を同梱するので不要）。LD_LIBRARY_PATH で補う。
          wheelLibs = pkgs.lib.makeLibraryPath [
            pkgs.stdenv.cc.cc.lib # libstdc++.so.6 / libgcc_s.so.1 (numpy/pandas/pyarrow)
            pkgs.zlib # libz.so.1
            pkgs.libxml2 # lxml
            pkgs.libxslt # lxml
            pkgs.openssl # 一部 wheel の libssl/libcrypto
          ];
        in
        {
          default = pkgs.mkShell {
            # pnpm-lock.yaml は lockfileVersion 9.0 → pnpm 9 系で固定。
            # Node は package.json 運用に合わせ 22 系。
            # openvpn: VWAP 取込の Yahoo 429 回避用 VPN ローテーション
            # (scripts/vpn/vpngate-rotate.sh) で使用。接続自体は sudo が必要。
            # python312 + uv: 収集パイプライン (pipeline/) 用。
            packages = [
              pkgs.nodejs_22
              pkgs.pnpm_9
              pkgs.openvpn
              pkgs.python312
              pkgs.uv
            ];

            shellHook = ''
              # wrangler が既定で書く ~/Library/Preferences/.wrangler/logs には D1 の応答
              # (規約上公開できない本文を含みうる) が残るため、既定では書かない。デバッグ時は WRANGLER_WRITE_LOGS=true WRANGLER_LOG=debug を付ける。
              export WRANGLER_WRITE_LOGS=false
              export WRANGLER_LOG_PATH="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.wrangler/logs"
              # uv には nix の Python を使わせる（環境の再現性を nix 側で固定）
              export UV_PYTHON="${pkgs.python312}/bin/python3.12"
              export UV_PYTHON_DOWNLOADS=never
              echo "kabulab dev shell  node $(node -v)  pnpm $(pnpm -v)"
            '' + pkgs.lib.optionalString pkgs.stdenv.isLinux ''
              export LD_LIBRARY_PATH="${wheelLibs}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
            '';
          };
        });
    };
}
