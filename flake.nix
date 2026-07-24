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
          limitlessPackage = import ./nix/packages/limitless.nix {
            inherit pkgs self;
          };
          anthropicAuthPackage = import ./nix/packages/anthropic-auth.nix {
            inherit pkgs self;
          };
          agentBrowserPackage = import ./nix/packages/agent-browser.nix {
            inherit pkgs self system;
          };
          opencodePackage = llm-agents.packages.${system}.opencode2;
          packageManifest = builtins.fromJSON (builtins.readFile ./packages/limitless/package.json);
          anthropicAuthManifest = builtins.fromJSON (
            builtins.readFile ./packages/anthropic-auth/package.json
          );
          pluginSdkVersion = packageManifest.dependencies."@opencode-ai/plugin";
          effectVersion = packageManifest.dependencies.effect;
          pinnedOpencodeVersion = "0.0.0-next-16040";

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
              lspEnabled ? false,
              serviceEnabled ? false,
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
                    skills.enable = false;
                    tools.agentBrowser.enable = false;
                    tools.effectSolutions.enable = false;
                    plugins.anthropicAuth.enable = anthropicAuthEnabled;
                    lsp.enable = lspEnabled;
                    mcp.linear.enable = linearEnabled;
                    opencode.service.enable = serviceEnabled;
                  };
                }
              ];
            };

          enabledHome = evaluateHome { linearEnabled = true; };
          disabledHome = evaluateHome { };
          anthropicAuthDisabledHome = evaluateHome { anthropicAuthEnabled = false; };
          lspHome = evaluateHome { lspEnabled = true; };
          serviceHome = evaluateHome { serviceEnabled = pkgs.stdenv.isLinux; };
          enabledConfig = builtins.fromJSON (
            builtins.unsafeDiscardStringContext
              enabledHome.config.home.file.".config/opencode/opencode.json".text
          );
          disabledConfig = builtins.fromJSON (
            builtins.unsafeDiscardStringContext
              disabledHome.config.home.file.".config/opencode/opencode.json".text
          );
          anthropicAuthDisabledConfig = builtins.fromJSON (
            builtins.unsafeDiscardStringContext
              anthropicAuthDisabledHome.config.home.file.".config/opencode/opencode.json".text
          );
          lspConfig = builtins.fromJSON (
            builtins.unsafeDiscardStringContext lspHome.config.home.file.".config/opencode/opencode.json".text
          );
          expectedLinearConfig = {
            type = "remote";
            url = "https://mcp.linear.app/mcp";
            disabled = false;
            headers.Authorization = "Bearer {env:LINEAR_API_KEY}";
            oauth = false;
          };
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
              { id: "limitless.anthropic-auth", source: "file://${anthropicAuthPackage}/anthropic-auth.js" },
              { id: "limitless", source: "file://${limitlessPackage}/limitless.js" },
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

            const models = new URL("/api/model", service.url)
            models.searchParams.set("location[directory]", directory)
            const modelResponse = await fetch(models, { headers, signal })
            if (!modelResponse.ok) throw new Error("Could not list OpenCode2 models")
            const modelPayload = await modelResponse.json()
            const anthropic = modelPayload.data?.filter((model) => model.providerID === "anthropic") ?? []
            const expectedPackage = expected[0].source
            if (
              anthropic.length === 0 ||
              anthropic.some((model) => !model.package?.startsWith(expectedPackage))
            ) {
              throw new Error("Anthropic native provider routing drifted: " + JSON.stringify(anthropic))
            }
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
            linear-mcp-config =
              assert pkgs.lib.assertMsg (
                enabledConfig.mcp.servers.linear == expectedLinearConfig
              ) "generated Linear MCP config drifted";
              assert pkgs.lib.assertMsg (
                !(disabledConfig ? mcp)
              ) "disabled Linear MCP unexpectedly generated config";
              assert pkgs.lib.assertMsg (
                !(enabledHome.config.home.file ? ".config/opencode/plugins/limitless.js")
                && !(enabledHome.config.home.file ? ".config/opencode/plugins/anthropic-auth.js")
              ) "managed plugins must be configured directly instead of through generated wrappers";
              assert pkgs.lib.assertMsg (
                builtins.length enabledConfig.plugins == 2
                &&
                  (builtins.elemAt enabledConfig.plugins 0).package
                  == "file://${anthropicAuthPackage}/anthropic-auth.js"
                &&
                  (builtins.elemAt enabledConfig.plugins 1).options.providers.disabled == [
                    "google-vertex"
                    "google-vertex-anthropic"
                  ]
                && (builtins.elemAt enabledConfig.plugins 1).options.lsp == { }
              ) "generated managed plugin configuration drifted";
              assert pkgs.lib.assertMsg (
                builtins.length anthropicAuthDisabledConfig.plugins == 1
                &&
                  (builtins.elemAt anthropicAuthDisabledConfig.plugins 0).package
                  == "file://${limitlessPackage}/limitless.js"
              ) "disabled Anthropic auth unexpectedly generated plugin configuration";
              pkgs.runCommand "limitless-linear-mcp-config-check" { } ''
                touch "$out"
              '';

            generated-runtime-config =
              assert pkgs.lib.assertMsg (
                lspConfig.lsp != { } && (builtins.elemAt lspConfig.plugins 1).options.lsp == lspConfig.lsp
              ) "generated OpenCode and Limitless plugin LSP configurations drifted";
              assert pkgs.lib.assertMsg
                (builtins.elemAt disabledConfig.plugins 1).options.notifications.events.permission
                "permission request notifications must default to enabled";
              assert pkgs.lib.assertMsg (
                !pkgs.stdenv.isLinux
                || serviceHome.config.home.shellAliases.oc == "${opencodePackage}/bin/opencode2 \"$PWD\""
              ) "generated OpenCode2 service alias drifted";
              assert pkgs.lib.assertMsg (
                !pkgs.stdenv.isLinux
                ||
                  serviceHome.config.systemd.user.services.opencode2.Service.ExecStart
                  == "${opencodePackage}/bin/opencode2 serve --service --hostname 127.0.0.1 --port 4096"
              ) "generated OpenCode2 service command drifted";
              assert pkgs.lib.assertMsg (
                !pkgs.stdenv.isLinux
                || builtins.elem anthropicAuthPackage serviceHome.config.systemd.user.services.opencode2.Unit.X-Restart-Triggers
              ) "OpenCode2 service does not restart when the Anthropic auth package changes";
              pkgs.runCommand "limitless-generated-runtime-config-check" { } ''
                touch "$out"
              '';

            opencode-version-alignment =
              assert pkgs.lib.assertMsg (
                pluginSdkVersion == pinnedOpencodeVersion
              ) "Limitless plugin SDK must remain pinned to ${pinnedOpencodeVersion}";
              assert pkgs.lib.assertMsg (
                effectVersion == "4.0.0-beta.98"
              ) "Limitless Effect must remain pinned to the plugin SDK dependency 4.0.0-beta.98";
              assert pkgs.lib.assertMsg (
                anthropicAuthManifest.dependencies."@opencode-ai/plugin" == pinnedOpencodeVersion
                && anthropicAuthManifest.dependencies."@opencode-ai/ai" == pinnedOpencodeVersion
                && anthropicAuthManifest.dependencies.effect == effectVersion
              ) "Anthropic auth runtime dependencies must remain aligned with OpenCode2";
              assert pkgs.lib.assertMsg (
                opencodePackage.version == pluginSdkVersion
              ) "OpenCode2 runtime ${opencodePackage.version} does not match plugin SDK ${pluginSdkVersion}";
              pkgs.runCommand "limitless-opencode2-version-alignment-${pluginSdkVersion}" { } ''
                export HOME="$TMPDIR"
                runtimeVersion="$(${opencodePackage}/bin/opencode2 --version)"
                if [ "$runtimeVersion" != "opencode2 v${pluginSdkVersion}" ]; then
                  echo "OpenCode2 executable $runtimeVersion does not match plugin SDK ${pluginSdkVersion}" >&2
                  exit 1
                fi
                touch "$out"
              '';

            opencode-plugin-load = pkgs.runCommand "limitless-opencode2-plugin-load-check" { } ''
              export HOME="$TMPDIR/home"
              export XDG_CACHE_HOME="$HOME/.cache"
              export XDG_CONFIG_HOME="$HOME/.config"
              export XDG_DATA_HOME="$HOME/.local/share"
              export XDG_STATE_HOME="$HOME/.local/state"
              mkdir -p "$HOME/.config/opencode"
              ln -s ${enabledConfigFile} "$HOME/.config/opencode/opencode.json"
              export OPENCODE_CONFIG="$HOME/.config/opencode/opencode.json"

              ${opencodePackage}/bin/opencode2 service start >/dev/null
              trap '${opencodePackage}/bin/opencode2 service stop >/dev/null 2>&1 || true' EXIT
              ${pkgs.bun}/bin/bun ${pluginSmokeScript} \
                "$XDG_STATE_HOME/opencode/service.json" \
                "$PWD"
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
            limitless = limitlessPackage;
            "agent-browser" = agentBrowserPackage;
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
      };
    };
}
