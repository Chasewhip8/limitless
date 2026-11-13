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
          opencode = import ./nix/packages/opencode.nix { inherit pkgs self; };
        }
        // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          pipeline = import ./nix/packages/pipeline.nix { inherit pkgs self; };
          capsule = import ./nix/packages/capsule.nix { inherit pkgs self; };
          t3 = pkgs.callPackage ./nix/packages/t3.nix { };
        }
        // pkgs.lib.optionalAttrs (system == "x86_64-linux") {
          opencode-desktop = pkgs.callPackage ./nix/packages/opencode-desktop.nix {
            opencode = self.packages.${system}.opencode;
          };
          t3-desktop = pkgs.callPackage ./nix/packages/t3-desktop.nix {
            t3 = self.packages.${system}.t3;
          };
        };
        checks =
          (import ./nix/tests/home.nix { inherit pkgs self agentsPackage; })
          // {
            darwin-desktops = import ./nix/tests/darwin-desktops.nix { inherit pkgs; };
            limitless-dependencies = import ./nix/tests/limitless-dependencies.nix {
              inherit pkgs;
              dependencies = self.packages.${system}.limitless.dependencies;
            };
          }
          // pkgs.lib.optionalAttrs (system == "x86_64-linux") {
            opencode-desktop = self.packages.${system}.opencode-desktop;
            t3-desktop = self.packages.${system}.t3-desktop;
          }
          // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            pipeline = import ./nix/tests/pipeline.nix { inherit pkgs self; };
            capsule = import ./nix/tests/capsule.nix {
              inherit pkgs;
              package = self.packages.${system}.capsule;
            };
            opencode-capsule = import ./nix/tests/opencode-capsule.nix {
              inherit pkgs;
              opencode = self.packages.${system}.opencode;
              capsule = self.packages.${system}.capsule;
            };
            opencode-password = import ./nix/tests/opencode-password.nix {
              inherit pkgs;
              opencode = self.packages.${system}.opencode;
            };
            executor-service = import ./nix/tests/executor-service.nix {
              inherit pkgs nixpkgs;
              module = self.nixosModules.executor;
            };
            t3-browser = import ./nix/tests/t3-browser.nix {
              inherit pkgs;
              package = self.packages.${system}.t3;
            };
          };
        devShells.default = pkgs.mkShell (
          {
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
               ripgrep
               statix
            ];
          }
          // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            CAPSULE_TEST_RUNTIME = self.packages.${system}.capsule.runtimeConfig;
            CAPSULE_TEST_BWRAP = self.packages.${system}.capsule.runtime.bwrap;
            CAPSULE_TEST_SHELL = self.packages.${system}.capsule.runtime.shell;
            CAPSULE_TEST_COREUTILS = "${pkgs.coreutils}/bin";
          }
        );
      }
    )
    // {
      homeModules.default = import ./nix/modules/home.nix { inherit self; };
      homeModules.pipeline = import ./nix/modules/pipeline.nix { inherit self; };
      darwinModules.default = ./nix/modules/darwin.nix;
      nixosModules.executor = ./nix/modules/executor-service.nix;
      overlays.default = final: _prev: {
        abilities-skills = self.packages.${final.stdenv.hostPlatform.system}.skills;
        abilities-opencode-agents = self.packages.${final.stdenv.hostPlatform.system}.opencode-agents;
        opencode-anthropic-auth = self.packages.${final.stdenv.hostPlatform.system}.anthropic-auth;
        opencode-limitless = self.packages.${final.stdenv.hostPlatform.system}.limitless;
      };
    };
}
