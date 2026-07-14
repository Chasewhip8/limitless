{
  description = "abilities - skills and tools for AI agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    opencode.url = "github:anomalyco/opencode/v1.17.20";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      opencode,
    }:
    let
      eachSystem = flake-utils.lib.eachDefaultSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          effectSolutionsPackage = import ./nix/packages/effect-solutions.nix {
            inherit pkgs self system;
          };
          linearMcpPackage = import ./nix/packages/linear-mcp.nix {
            inherit pkgs self;
          };
          limitlessPackage = import ./nix/packages/limitless.nix {
            inherit pkgs self;
          };
          agentBrowserPackage = import ./nix/packages/agent-browser.nix {
            inherit pkgs self system;
          };
          opencodePackage = import ./nix/packages/opencode.nix {
            inherit opencode system;
          };

          skillsPackage = pkgs.runCommand "abilities-skills" { } ''
            mkdir -p $out
            if [ -d ${self}/skills ]; then
              cp -r ${self}/skills/. $out/
            fi
          '';
          opencodeAgentsPackage = pkgs.runCommand "abilities-opencode-agents" { } ''
            mkdir -p $out
            if [ -d ${self}/opencode/agents ]; then
              cp -r ${self}/opencode/agents/* $out/
            fi
          '';
        in
        {
          formatter = pkgs.nixfmt;

          packages = {
            skills = skillsPackage;
            "effect-solutions" = effectSolutionsPackage;
            "linear-mcp" = linearMcpPackage;
            limitless = limitlessPackage;
            "agent-browser" = agentBrowserPackage;
            "opencode-agents" = opencodeAgentsPackage;
            opencode = opencodePackage;
          };

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
              typst
              effectSolutionsPackage
              agentBrowserPackage
            ];
          };
        }
      );
    in
    eachSystem
    // {
      homeModules.default = import ./nix/modules/home.nix { inherit self; };
      overlays.default = final: _prev: {
        abilities-skills = self.packages.${final.stdenv.hostPlatform.system}.skills;
        abilities-opencode-agents = self.packages.${final.stdenv.hostPlatform.system}."opencode-agents";
        opencode-limitless = self.packages.${final.stdenv.hostPlatform.system}.limitless;
        linear-mcp = self.packages.${final.stdenv.hostPlatform.system}."linear-mcp";
        agent-browser = self.packages.${final.stdenv.hostPlatform.system}."agent-browser";
        effect-solutions = self.packages.${final.stdenv.hostPlatform.system}."effect-solutions";
      };
    };
}
