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
          effectSolutionsPackage = import ./nix/packages/effect-solutions.nix {
            inherit pkgs self system;
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
                    skills.enable = skillsEnabled;
                    tools = {
                      agentBrowser.enable = false;
                      effectSolutions.enable = false;
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

          enabledHome = evaluateHome { linearEnabled = true; };
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
          enabledConfig = builtins.fromJSON (
            builtins.unsafeDiscardStringContext
              enabledHome.config.home.file.".config/opencode/opencode.json".text
          );
          pluginSmokeConfig = pkgs.lib.recursiveUpdate enabledConfig {
            providers = {
              anthropic = {
                package = "aisdk:@ai-sdk/anthropic";
                settings.apiKey = "opencode-plugin-smoke-not-a-real-key";
              };
              google-vertex.settings.apiKey = "opencode-plugin-smoke-not-a-real-key";
              google-vertex-anthropic.settings.apiKey = "opencode-plugin-smoke-not-a-real-key";
            };
          };
          enabledConfigFile = pkgs.writeText "limitless-opencode2-smoke-config.json" (
            builtins.toJSON pluginSmokeConfig
          );
          pluginSmokeScript = pkgs.writeText "limitless-opencode2-plugin-smoke.mjs" ''
            import { readFile } from "node:fs/promises"

            const [serviceFile, directory] = process.argv.slice(2)
            const service = JSON.parse(await readFile(serviceFile, "utf8"))
            const headers = service.password
              ? { authorization: "Basic " + btoa("opencode:" + service.password) }
              : {}
            const signal = AbortSignal.timeout(30_000)
            const events = await fetch(new URL("/api/event", service.url), { headers, signal })
            if (!events.ok || events.body === null) throw new Error("Could not subscribe to OpenCode2 events")
            const reader = events.body.pipeThrough(new TextDecoderStream()).getReader()
            let buffer = ""

            async function waitForEvent(expected) {
              while (true) {
                const newline = buffer.indexOf("\n")
                if (newline === -1) {
                  const chunk = await reader.read()
                  if (chunk.done) throw new Error("OpenCode2 event stream ended before " + expected)
                  buffer += chunk.value
                  continue
                }
                const line = buffer.slice(0, newline).replace(/\r$/, "")
                buffer = buffer.slice(newline + 1)
                if (!line.startsWith("data:")) continue
                const event = JSON.parse(line.slice(5).trimStart())
                if (event.type === expected) return
              }
            }

            const plugins = new URL("/api/plugin", service.url)
            plugins.searchParams.set("location[directory]", directory)
            await waitForEvent("server.connected")
            const initial = await fetch(plugins, { headers, signal })
            if (!initial.ok) throw new Error("Could not initialize the OpenCode2 plugin location")
            await waitForEvent("plugin.updated")
            await waitForEvent("catalog.updated")
            const response = await fetch(plugins, { headers, signal })
            if (!response.ok) throw new Error("Could not list OpenCode2 plugins")
            const payload = await response.json()
            const expected = [
              { id: "ex-machina.anthropic-auth", source: "file://${anthropicAuthPackage}" },
              { id: "limitless", source: "file://${limitlessPackage}" },
            ]
            const missing = expected.filter(({ id }) => !payload.data?.some((plugin) => plugin.id === id))
            if (missing.length > 0) {
              throw new Error(
                "OpenCode2 did not activate plugins " +
                  missing.map(({ id, source }) => id + " from " + source).join(", ") +
                  ": " +
                  JSON.stringify(payload),
              )
            }

            const agents = new URL("/api/agent", service.url)
            agents.searchParams.set("location[directory]", directory)
            const agentResponse = await fetch(agents, { headers, signal })
            if (!agentResponse.ok) throw new Error("Could not list OpenCode2 agents")
            const agentPayload = await agentResponse.json()
            const expectedAgents = [
              { id: "limitless", providerID: "openai", modelID: "gpt-5.6-sol-fast-long", variant: "max" },
              { id: "gary", providerID: "openai", modelID: "gpt-5.6-sol-fast-long", variant: "xhigh" },
              { id: "oracle", providerID: "anthropic", modelID: "claude-fable-5-1", variant: "high" },
              { id: "research", providerID: "openai", modelID: "gpt-5.6-sol-fast", variant: "medium" },
              { id: "review", providerID: "openai", modelID: "gpt-5.6-sol-fast", variant: "xhigh" },
              { id: "worker", providerID: "openai", modelID: "gpt-5.6-sol-fast", variant: "xhigh" },
            ]
            const invalidAgents = expectedAgents.filter((expectedAgent) => {
              const agent = agentPayload.data?.find((candidate) => candidate.id === expectedAgent.id)
              return (
                agent === undefined ||
                agent.model?.providerID !== expectedAgent.providerID ||
                agent.model?.id !== expectedAgent.modelID ||
                agent.model?.variant !== expectedAgent.variant
              )
            })
            if (invalidAgents.length > 0) {
              throw new Error(
                "OpenCode2 agent loading drifted for " +
                  invalidAgents.map((agent) => agent.id).join(", ") +
                  ": " +
                  JSON.stringify(agentPayload),
              )
            }

            const models = new URL("/api/model", service.url)
            models.searchParams.set("location[directory]", directory)
            const modelResponse = await fetch(models, { headers, signal })
            if (!modelResponse.ok) throw new Error("Could not list OpenCode2 models")
            const modelPayload = await modelResponse.json()
            const anthropic = modelPayload.data?.filter((model) => model.providerID === "anthropic") ?? []
            if (anthropic.length === 0) throw new Error("Anthropic models are unavailable")
            const vertex = modelPayload.data?.filter((model) =>
              ["google-vertex", "google-vertex-anthropic"].includes(model.providerID),
            ) ?? []
            if (vertex.length > 0) {
              throw new Error("Disabled Vertex providers remained available: " + JSON.stringify(vertex))
            }

            const integration = new URL("/api/integration/anthropic", service.url)
            integration.searchParams.set("location[directory]", directory)
            const integrationResponse = await fetch(integration, { headers, signal })
            if (!integrationResponse.ok) throw new Error("Could not read the Anthropic integration")
            const integrationPayload = await integrationResponse.json()
            const oauth = integrationPayload.data?.methods?.filter((method) => method.type === "oauth") ?? []
            if (oauth.length !== 1 || oauth[0].label !== "Claude Pro/Max") {
              throw new Error("Anthropic OAuth methods drifted: " + JSON.stringify(integrationPayload))
            }

            const connect = new URL("/api/integration/anthropic/connect/oauth", service.url)
            connect.searchParams.set("location[directory]", directory)
            const attemptResponse = await fetch(connect, {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({ methodID: oauth[0].id, inputs: {} }),
              signal,
            })
            if (!attemptResponse.ok) throw new Error("Could not begin Anthropic OAuth")
            const attemptPayload = await attemptResponse.json()
            const attempt = attemptPayload.data
            const authorize = new URL(attempt.url)
            if (authorize.origin !== "https://claude.ai" || attempt.mode !== "code") {
              throw new Error("Anthropic OAuth attempt drifted: " + JSON.stringify(attemptPayload))
            }
            for (const key of ["client_id", "code_challenge", "state"]) {
              if (!authorize.searchParams.get(key)) throw new Error("Anthropic OAuth URL is missing " + key)
            }

            const cancel = new URL(
              "/api/integration/anthropic/connect/oauth/" + encodeURIComponent(attempt.attemptID),
              service.url,
            )
            cancel.searchParams.set("location[directory]", directory)
            const cancelResponse = await fetch(cancel, { method: "DELETE", headers, signal })
            if (!cancelResponse.ok) throw new Error("Could not cancel Anthropic OAuth attempt")
            await reader.cancel()
          '';

          checks = {
            opencode-plugin-load = pkgs.runCommand "limitless-opencode2-plugin-load-check" { } ''
              export HOME="$TMPDIR/home"
              export XDG_CACHE_HOME="$HOME/.cache"
              export XDG_CONFIG_HOME="$HOME/.config"
              export XDG_DATA_HOME="$HOME/.local/share"
              export XDG_STATE_HOME="$HOME/.local/state"
              mkdir -p "$HOME/.config/opencode"
              ln -s ${enabledConfigFile} "$HOME/.config/opencode/opencode.json"
              ln -s ${opencodeAgentsPackage} "$HOME/.config/opencode/agents"
              export OPENCODE_CONFIG="$HOME/.config/opencode/opencode.json"

              ${opencodePackage}/bin/opencode2 service start >/dev/null
              trap '${opencodePackage}/bin/opencode2 service stop >/dev/null 2>&1 || true' EXIT
              ${pkgs.bun}/bin/bun ${pluginSmokeScript} \
                "$XDG_STATE_HOME/opencode/service.json" \
                "$PWD"
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
          '';
        in
        {
          formatter = pkgs.nixfmt;

          packages = {
            skills = skillsPackage;
            "anthropic-auth" = anthropicAuthPackage;
            "effect-solutions" = effectSolutionsPackage;
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
        opencode-anthropic-auth = self.packages.${final.stdenv.hostPlatform.system}."anthropic-auth";
        opencode-limitless = self.packages.${final.stdenv.hostPlatform.system}.limitless;
        agent-browser = self.packages.${final.stdenv.hostPlatform.system}."agent-browser";
        effect-solutions = self.packages.${final.stdenv.hostPlatform.system}."effect-solutions";
        notion-cli = self.packages.${final.stdenv.hostPlatform.system}."notion-cli";
        sentry = self.packages.${final.stdenv.hostPlatform.system}.sentry;
      };
    };
}
