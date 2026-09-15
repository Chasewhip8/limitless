{
  description = "abilities - skills and tools for AI agents";

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
    let
      eachSystem = flake-utils.lib.eachDefaultSystem (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfreePredicate = pkg: (pkg.pname or "") == "sentry";
          };
          limitlessPackage = import ./nix/packages/limitless.nix {
            inherit pkgs self;
          };
          anthropicAuthPackage = import ./nix/packages/anthropic-auth.nix {
            inherit pkgs;
          };
          sentryPackage = import ./nix/packages/sentry.nix {
            inherit pkgs self;
          };
          agentBrowserPackage = import ./nix/packages/agent-browser.nix {
            inherit pkgs self system;
          };
          notionCliPackage = import ./nix/packages/notion-cli.nix {
            inherit pkgs self system;
          };
          opencodePackage = import ./nix/packages/opencode2.nix { inherit pkgs; };

          homeOptionStubs = {
            options = {
              assertions = pkgs.lib.mkOption {
                type = pkgs.lib.types.listOf (
                  pkgs.lib.types.submodule {
                    options = {
                      assertion = pkgs.lib.mkOption { type = pkgs.lib.types.bool; };
                      message = pkgs.lib.mkOption { type = pkgs.lib.types.str; };
                    };
                  }
                );
                default = [ ];
              };
              home = {
                file = pkgs.lib.mkOption {
                  type = pkgs.lib.types.attrsOf pkgs.lib.types.attrs;
                  default = { };
                };
                packages = pkgs.lib.mkOption {
                  type = pkgs.lib.types.listOf pkgs.lib.types.package;
                  default = [ ];
                };
                shellAliases = pkgs.lib.mkOption {
                  type = pkgs.lib.types.attrsOf pkgs.lib.types.str;
                  default = { };
                };
              };
              programs.git = {
                enable = pkgs.lib.mkOption {
                  type = pkgs.lib.types.bool;
                  default = false;
                };
                ignores = pkgs.lib.mkOption {
                  type = pkgs.lib.types.listOf pkgs.lib.types.str;
                  default = [ ];
                };
              };
              systemd.user.services = pkgs.lib.mkOption {
                type = pkgs.lib.types.attrsOf pkgs.lib.types.attrs;
                default = { };
              };
            };
          };

          evaluateHome =
            {
              anthropicAuthEnabled ? true,
              fastSubagents ? null,
              linearEnabled ? false,
              notionAccounts ? { },
              notionDefaultAccount ? null,
              notionEnabled ? false,
              notionPackage ? notionCliPackage,
              notionTokenFile ? null,
              skillsEnabled ? false,
            }:
            pkgs.lib.evalModules {
              specialArgs = { inherit pkgs; };
              modules = [
                (import ./nix/modules/home.nix { inherit self; })
                homeOptionStubs
                {
                  programs.limitless = {
                    enable = true;
                    git.ignoreStorage = false;
                    agents = pkgs.lib.optionalAttrs (fastSubagents != null) { inherit fastSubagents; };
                    skills.enable = skillsEnabled;
                    tools = {
                      agentBrowser.enable = false;
                      notion = {
                        accounts = notionAccounts;
                        defaultAccount = notionDefaultAccount;
                        enable = notionEnabled;
                        package = notionPackage;
                        tokenFile = notionTokenFile;
                      };
                    };
                    plugins.anthropicAuth.enable = anthropicAuthEnabled;
                    mcp.linear.enable = linearEnabled;
                  };
                }
              ];
            };

          notionHome = evaluateHome {
            notionEnabled = true;
            skillsEnabled = true;
          };
          notionTestToken = pkgs.writeText "limitless-notion-test-token" "notion-test-token";
          notionPersonalTestToken = pkgs.writeText "limitless-notion-personal-test-token" "notion-personal-test-token";
          notionWorkTestToken = pkgs.writeText "limitless-notion-work-test-token" "notion-work-test-token";
          notionProbePackage = pkgs.writeShellScriptBin "ntn" ''
            printf '%s\n' "$NOTION_API_TOKEN"
          '';
          notionTokenHome = evaluateHome {
            notionEnabled = true;
            notionPackage = notionProbePackage;
            notionTokenFile = toString notionTestToken;
          };
          notionTokenWrapper = pkgs.lib.findFirst (
            package: (package.name or "") == "ntn"
          ) (throw "enabled Notion token wrapper was not installed") notionTokenHome.config.home.packages;
          notionAccountsHome = evaluateHome {
            notionAccounts = {
              personal.tokenFile = toString notionPersonalTestToken;
              work.tokenFile = toString notionWorkTestToken;
            };
            notionDefaultAccount = "work";
            notionEnabled = true;
            notionPackage = notionProbePackage;
          };
          findNotionAccountWrapper =
            name:
            pkgs.lib.findFirst (package: (package.name or "") == name)
              (throw "enabled Notion account wrapper ${name} was not installed")
              notionAccountsHome.config.home.packages;
          notionDefaultWrapper = findNotionAccountWrapper "ntn";
          notionPersonalWrapper = findNotionAccountWrapper "ntn-personal";
          notionWorkWrapper = findNotionAccountWrapper "ntn-work";
          checks = {
            subagent-profiles =
              let
                configuredFastSubagents =
                  home:
                  (pkgs.lib.last
                    (builtins.fromJSON (
                      builtins.unsafeDiscardStringContext home.config.home.file.".config/opencode/opencode.json".text
                    )).plugins
                  ).options.agents.fastSubagents;
              in
              assert pkgs.lib.assertMsg (
                configuredFastSubagents (evaluateHome { }) == [
                  "oracle-solve"
                  "research"
                  "worker"
                ]
              ) "default Fast subagents were not passed to the Limitless plugin";
              assert pkgs.lib.assertMsg (
                configuredFastSubagents (evaluateHome {
                  fastSubagents = [ "worker" ];
                }) == [
                  "worker"
                ]
              ) "custom Fast subagents were not passed to the Limitless plugin";
              assert pkgs.lib.assertMsg (
                configuredFastSubagents (evaluateHome {
                  fastSubagents = [ ];
                }) == [ ]
              ) "empty Fast subagent list was not preserved";
              pkgs.runCommand "limitless-subagent-profiles-check" { } ''
                sed '2d' ${opencodeAgentsPackage}/limitless.md > standard.md
                sed '2d' ${opencodeAgentsPackage}/limitless-fast.md > fast.md
                cmp standard.md fast.md
                grep -F 'with Standard processing for configured subagents.' ${opencodeAgentsPackage}/limitless.md
                grep -F 'with Fast processing for configured subagents.' ${opencodeAgentsPackage}/limitless-fast.md
                test ! -e ${opencodeAgentsPackage}/review.md
                touch "$out"
              '';
            notion-cli =
              assert pkgs.lib.assertMsg (builtins.elem notionCliPackage notionHome.config.home.packages)
                "enabled Notion CLI was not installed";
              assert pkgs.lib.assertMsg (pkgs.lib.all (entry: entry.assertion)
                notionAccountsHome.config.assertions
              ) "valid named Notion account configuration failed a module assertion";
              pkgs.runCommand "limitless-notion-cli-check" { } ''
                ${notionCliPackage}/bin/ntn --version | grep -F 'ntn ${notionCliPackage.version}' >/dev/null
                test -f ${notionHome.config.home.file.".config/opencode/skills".source}/notion-cli/SKILL.md
                test "$(${notionTokenWrapper}/bin/ntn)" = "notion-test-token"
                test "$(${notionDefaultWrapper}/bin/ntn)" = "notion-work-test-token"
                test "$(${notionPersonalWrapper}/bin/ntn-personal)" = "notion-personal-test-token"
                test "$(${notionWorkWrapper}/bin/ntn-work)" = "notion-work-test-token"
                touch "$out"
              '';
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
            sed '2,/^---$/s/^description: .*/description: Primary user-facing OpenCode agent with Fast processing for configured subagents./' \
              "$out/limitless.md" > "$out/limitless-fast.md"
          '';
        in
        {
          formatter = pkgs.nixfmt;

          packages = {
            skills = skillsPackage;
            "anthropic-auth" = anthropicAuthPackage;
            sentry = sentryPackage;
            limitless = limitlessPackage;
            "agent-browser" = agentBrowserPackage;
            "notion-cli" = notionCliPackage;
            "opencode-agents" = opencodeAgentsPackage;
            opencode2 = opencodePackage;
          };

          inherit checks;

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
        opencode-anthropic-auth = self.packages.${final.stdenv.hostPlatform.system}."anthropic-auth";
        opencode-limitless = self.packages.${final.stdenv.hostPlatform.system}.limitless;
        agent-browser = self.packages.${final.stdenv.hostPlatform.system}."agent-browser";
        notion-cli = self.packages.${final.stdenv.hostPlatform.system}."notion-cli";
        sentry = self.packages.${final.stdenv.hostPlatform.system}.sentry;
      };
    };
}
