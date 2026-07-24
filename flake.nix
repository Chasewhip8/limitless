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
          agentBrowserPackage = import ./nix/packages/agent-browser.nix {
            inherit pkgs self system;
          };
          opencodePackage = llm-agents.packages.${system}.opencode2;
          packageManifest = builtins.fromJSON (builtins.readFile ./packages/limitless/package.json);
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
                    lsp.enable = lspEnabled;
                    mcp.linear.enable = linearEnabled;
                    opencode.service.enable = serviceEnabled;
                  };
                }
              ];
            };

          enabledHome = evaluateHome { linearEnabled = true; };
          disabledHome = evaluateHome { };
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
          enabledConfigFile =
            pkgs.writeText "limitless-opencode2-smoke-config.json"
              enabledHome.config.home.file.".config/opencode/opencode.json".text;
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
            const response = await fetch(plugins, { headers, signal })
            if (!response.ok) throw new Error("Could not list OpenCode2 plugins")
            const payload = await response.json()
            if (!payload.data?.some((plugin) => plugin.id === "limitless")) {
              throw new Error("OpenCode2 did not activate the Limitless plugin: " + JSON.stringify(payload))
            }
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
              ) "Limitless must be configured directly instead of through a generated wrapper plugin";
              assert pkgs.lib.assertMsg (
                builtins.length enabledConfig.plugins == 1
                && (builtins.elemAt enabledConfig.plugins 0).options.lsp == { }
              ) "generated Limitless plugin options drifted";
              pkgs.runCommand "limitless-linear-mcp-config-check" { } ''
                touch "$out"
              '';

            generated-runtime-config =
              assert pkgs.lib.assertMsg (
                lspConfig.lsp != { } && (builtins.elemAt lspConfig.plugins 0).options.lsp == lspConfig.lsp
              ) "generated OpenCode and Limitless plugin LSP configurations drifted";
              assert pkgs.lib.assertMsg
                (builtins.elemAt disabledConfig.plugins 0).options.notifications.events.permission
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
        opencode-limitless = self.packages.${final.stdenv.hostPlatform.system}.limitless;
        agent-browser = self.packages.${final.stdenv.hostPlatform.system}."agent-browser";
        effect-solutions = self.packages.${final.stdenv.hostPlatform.system}."effect-solutions";
      };
    };
}
