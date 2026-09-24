{
  pkgs,
  self,
  agentsPackage,
}:
let
  inherit (pkgs) lib;
  homeStubs = {
    options = {
      assertions = lib.mkOption {
        type = lib.types.listOf lib.types.attrs;
        default = [ ];
      };
      warnings = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
      };
      home = {
        file = lib.mkOption {
          type = lib.types.attrsOf lib.types.attrs;
          default = { };
          apply = lib.mapAttrs (
            name: file:
            file
            // lib.optionalAttrs (file ? text && !(file ? source)) {
              source = pkgs.writeText (builtins.baseNameOf name) file.text;
            }
          );
        };
        packages = lib.mkOption {
          type = lib.types.listOf lib.types.package;
          default = [ ];
        };
        shellAliases = lib.mkOption {
          type = lib.types.attrsOf lib.types.str;
          default = { };
        };
        homeDirectory = lib.mkOption {
          type = lib.types.str;
          default = "/home/test";
        };
        profileDirectory = lib.mkOption {
          type = lib.types.str;
          default = "/home/test/.nix-profile";
        };
      };
      xdg = lib.genAttrs [ "configHome" "dataHome" "stateHome" "cacheHome" ] (
        name:
        lib.mkOption {
          type = lib.types.str;
          default = "/home/test/${name}";
        }
      );
      systemd.user = {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = pkgs.stdenv.hostPlatform.isLinux;
        };
        startServices = lib.mkOption {
          type = lib.types.bool;
          default = true;
        };
        services = lib.mkOption {
          type = lib.types.attrsOf lib.types.attrs;
          default = { };
        };
      };
      programs.git = {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = false;
        };
        ignores = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
        };
      };
    };
  };
  evaluateWith =
    settings: extraModules:
    lib.evalModules {
      specialArgs = { inherit pkgs; };
      modules = [
        (import ../modules/home.nix { inherit self; })
        homeStubs
        { programs.limitless = lib.recursiveUpdate { enable = true; } settings; }
      ]
      ++ extraModules;
    };
  evaluate = settings: evaluateWith settings [ ];
  opencodeJson = home: home.config.home.file.".config/opencode/opencode.json".text;
  rendered = home: builtins.fromJSON (builtins.unsafeDiscardStringContext (opencodeJson home));
  plugin = home: lib.last (rendered home).plugins;
  valid = home: lib.all (entry: entry.assertion) home.config.assertions;

  # Mirrors OpenCode's ordered permission evaluation: the last matching rule wins.
  matches =
    pattern: value:
    builtins.match (builtins.replaceStrings [ "\\*" "\\?" ] [ ".*" "." ] (
      lib.escapeRegex pattern
    )) value != null;
  effectFor =
    rules: action: resource:
    lib.foldl' (
      effect: rule:
      if matches rule.action action && matches rule.resource resource then rule.effect else effect
    ) "ask" rules;

  defaults = evaluate { };
  disabled = evaluate { enable = false; };
  connected = evaluate {
    mcp.servers = {
      atlassian.preset = "atlassian";
      notion-work.preset = "notion";
      sentry.preset = "sentry";
      linear.preset = "linear";
      gh = {
        preset = "github";
        settings = {
          oauth = false;
          headers.Authorization = "Bearer {env:TEST_GITHUB_TOKEN}";
        };
      };
    };
    opencode.settings.mcp.servers.custom = {
      type = "local";
      command = [ "test-mcp" ];
    };
  };
  connectedConfig = rendered connected;
  primaryEffect = action: effectFor connectedConfig.permissions action "*";
  researchEffect =
    action:
    effectFor (connectedConfig.permissions ++ connectedConfig.agents.research.permissions) action "*";
  withServers = servers: evaluate { mcp.servers = servers; };

  supervised = evaluate {
    opencode.service = {
      enable = true;
      port = 4096;
    };
  };
  serviceUnit = supervised.config.systemd.user.services.opencode;

  cliProbePackage = pkgs.writeShellScriptBin "opencode" ''
    exec ${lib.getExe pkgs.jq} --null-input \
      --argjson settings "''${OPENCODE_CLI_CONFIG_CONTENT:-null}" \
      --arg disableClaudeCode "''${OPENCODE_DISABLE_CLAUDE_CODE:-}" \
      --arg claudeCodeVersion "''${ANTHROPIC_CLAUDE_CODE_VERSION:-}" \
      --args '{settings: $settings, disableClaudeCode: $disableClaudeCode, claudeCodeVersion: $claudeCodeVersion, arguments: $ARGS.positional}' -- "$@"
  '';
  cliDefaults = evaluate { opencode.package = cliProbePackage; };
  cliCustom = evaluate {
    plugins.anthropicAuth.claudeCodeVersion = "2.1.281";
    opencode = {
      package = cliProbePackage;
      disableClaudeCode = true;
      cliSettings = {
        attention.sounds.permission = "/tmp/opencode/permission's sound.wav";
        theme.name = "tokyonight";
      };
    };
  };
  launcherOf = home: "${home.config.programs.limitless._generated.opencodePackage}/bin/opencode";
in
{
  home-module =
    assert lib.assertMsg (valid defaults && valid connected) "valid configuration failed assertions";
    assert lib.assertMsg (
      disabled.config.home.file == { }
      && disabled.config.home.packages == [ ]
      && disabled.config.home.shellAliases == { }
      && disabled.config.systemd.user.services == { }
    ) "a disabled module changed the home configuration";
    assert lib.assertMsg (lib.all
      (action: primaryEffect action == "allow" && researchEffect action == "allow")
      [
        "notion-work_notion-fetch"
        "atlassian_getJiraIssue"
        "sentry_search_issues"
        "gh_pull_request_read"
        "github_clone"
      ]
    ) "audited MCP reads and local research tools must stay available to research";
    assert lib.assertMsg (lib.all
      (action: primaryEffect action == "allow" && researchEffect action == "deny")
      [
        "notion-work_notion-create-pages"
        "notion-work_new-tool"
        "atlassian_editJiraIssue"
        "sentry_execute_sentry_tool"
        "gh_create_pull_request"
        "linear_unknown-tool"
        "custom_write"
      ]
    ) "MCP mutations and unaudited tools must run for execution agents and be denied to research";
    assert lib.assertMsg (lib.all
      (
        name:
        !valid (withServers {
          ${name}.preset = "notion";
        })
      )
      [
        "github"
        "lsp"
        "ast"
        "artifact"
        "browser"
        "opencode"
        "bad name"
      ]
    ) "MCP namespaces that shadow local tools passed assertions";
    assert lib.assertMsg (
      !valid (withServers {
        notion.preset = "notion";
        notion_work.preset = "notion";
      })
    ) "overlapping MCP account prefixes passed assertions";
    assert lib.assertMsg (
      !valid (evaluate {
        github.enable = true;
      })
    ) "GitHub clones became unrestricted without explicit opt-in";
    pkgs.runCommand "limitless-home-module-check"
      {
        nativeBuildInputs = [
          pkgs.bun
          pkgs.nodejs
        ];
      }
      ''
        mkdir -p "$out"
        cp ${pkgs.writeText "default-opencode.json" (opencodeJson defaults)} "$out/default.json"
        cp ${pkgs.writeText "connected-opencode.json" (opencodeJson connected)} "$out/connected.json"
        ln -s ${
          self.packages.${pkgs.stdenv.hostPlatform.system}.limitless.dependencies
        }/packages/limitless/node_modules node_modules
        cp ${./validate-config.mjs} validate-config.mjs
        bun validate-config.mjs ${agentsPackage} "$out/default.json" "$out/connected.json"
        cp ${./validate-plugin.mjs} validate-plugin.mjs
        node validate-plugin.mjs ${defaults.config.programs.limitless.plugins.limitless.package}
        ${lib.concatMapStringsSep "\n" (
          server: "test -x ${lib.escapeShellArg (builtins.head server.command)}"
        ) (builtins.attrValues (plugin defaults).options.lsp)}
      '';

  cli-settings =
    pkgs.runCommand "limitless-cli-settings-check" { nativeBuildInputs = [ pkgs.jq ]; }
      ''
        mkdir -p "$out"
        unset OPENCODE_CLI_CONFIG_CONTENT OPENCODE_DISABLE_CLAUDE_CODE ANTHROPIC_CLAUDE_CODE_VERSION

        ${launcherOf cliDefaults} "path with spaces" --version > "$out/default.json"
        jq -e '
          .settings == {attention: {sound: true}}
          and .disableClaudeCode == ""
          and .claudeCodeVersion == ""
          and .arguments == ["path with spaces", "--version"]
        ' "$out/default.json"

        OPENCODE_DISABLE_CLAUDE_CODE=0 ${launcherOf cliCustom} > "$out/custom.json"
        jq -e --argjson expected ${lib.escapeShellArg (builtins.toJSON cliCustom.config.programs.limitless.opencode.cliSettings)} '
          .settings == $expected and .disableClaudeCode == "1" and .claudeCodeVersion == "2.1.281"
        ' "$out/custom.json"

        OPENCODE_CLI_CONFIG_CONTENT='{"theme":{"name":"override"}}' \
          ANTHROPIC_CLAUDE_CODE_VERSION=2.1.282 \
          ${launcherOf cliCustom} > "$out/environment.json"
        jq -e '
          .settings == {theme: {name: "override"}} and .claudeCodeVersion == "2.1.282"
        ' "$out/environment.json"
      '';

  service =
    assert lib.assertMsg (
      !pkgs.stdenv.hostPlatform.isLinux
      ||
        builtins.elem supervised.config.home.file.".config/opencode/opencode.json".source
          serviceUnit.Unit.X-Restart-Triggers
    ) "configuration changes must restart the supervised service";
    pkgs.runCommand "limitless-service-check" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
      cp ${../packages/opencode-service.mjs} opencode-service.mjs
      cp ${../packages/opencode-service.test.mjs} opencode-service.test.mjs
      node --test opencode-service.test.mjs
      ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
        test -x ${serviceUnit.Service.ExecStart}
        grep -F ${lib.escapeShellArg (launcherOf supervised)} ${serviceUnit.Service.ExecStart}
        grep -F '127.0.0.1 4096' ${serviceUnit.Service.ExecStart}
      ''}
      touch "$out"
    '';
}
