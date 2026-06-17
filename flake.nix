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
          packages = [
            pkgs.nodejs_22
            pkgs.pnpm_9
          ];

          shellHook = ''
            echo "kabulab dev shell  node $(node -v)  pnpm $(pnpm -v)"
          '';
        };
      });
    };
}
