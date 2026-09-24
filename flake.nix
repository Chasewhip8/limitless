{
  description = "Limitless - a batteries-included OpenCode workspace";

  nixConfig = {
    extra-substituters = [ "https://cache.numtide.com" ];
    extra-trusted-public-keys = [ "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g=" ];
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        skillsPackage = pkgs.runCommand "limitless-skills" { } ''
          mkdir -p $out
          if [ -d ${self}/skills ]; then
            cp -r ${self}/skills/. $out/
          fi
        '';
        agentsPackage = pkgs.runCommand "limitless-opencode-agents" { } ''
          mkdir -p $out
          cp -r ${self}/opencode/agents/. $out/
        '';
      in
      {
        formatter = pkgs.nixfmt;
        packages = {
          skills = skillsPackage;
          opencode-agents = agentsPackage;
          anthropic-auth = import ./nix/packages/anthropic-auth.nix { inherit pkgs; };
          limitless = import ./nix/packages/limitless.nix { inherit pkgs self; };
          opencode = import ./nix/packages/opencode.nix { inherit pkgs; };
        }
        // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          opencode-desktop = import ./nix/packages/opencode-desktop.nix {
            inherit pkgs;
            opencode = self.packages.${system}.opencode;
          };
        };
        checks = import ./nix/tests/home.nix { inherit pkgs self agentsPackage; };
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            actionlint
            bun
            deadnix
            markdownlint-cli2
            nodejs_22
            node-gyp
            nixfmt
            python3
            pkg-config
            statix
          ];
        };
      }
    )
    // {
      homeModules.default = import ./nix/modules/home.nix { inherit self; };
      overlays.default = final: _prev: {
        abilities-skills = self.packages.${final.stdenv.hostPlatform.system}.skills;
        abilities-opencode-agents = self.packages.${final.stdenv.hostPlatform.system}.opencode-agents;
        opencode-anthropic-auth = self.packages.${final.stdenv.hostPlatform.system}.anthropic-auth;
        opencode-limitless = self.packages.${final.stdenv.hostPlatform.system}.limitless;
      };
    };
}
