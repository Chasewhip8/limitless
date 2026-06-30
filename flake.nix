{
  description = "abilities - skills and tools for AI agents";

  nixConfig = {
    extra-substituters = [ "https://cache.numtide.com" ];
    extra-trusted-public-keys = [ "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g=" ];
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    llm-agents.url = "github:numtide/llm-agents.nix";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      llm-agents,
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
      homeModules.default = import ./nix/modules/home.nix { inherit self llm-agents; };
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
