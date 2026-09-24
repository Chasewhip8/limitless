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
  rendered =
    home:
    builtins.fromJSON (
      builtins.unsafeDiscardStringContext home.config.home.file.".config/opencode/opencode.json".text
    );
  plugin = home: lib.last (rendered home).plugins;
  valid = home: lib.all (entry: entry.assertion) home.config.assertions;
  defaults = evaluate { };
  disabled = evaluate { enable = false; };
  noLsp = evaluate { lsp.enable = false; };
  custom = evaluate {
    lsp.servers.nixd = {
      command = "/custom/nixd";
      args = [ "--test" ];
      env.TEST = "enabled";
    };
    lsp.extraServers.test = {
      command = [ "/custom/test" ];
      extensions = [ ".test" ];
    };
    plugins.anthropicAuth.enable = false;
    skills.enable = false;
    opencode.settings = {
      model = "openai/test";
      plugins = [ "custom-plugin" ];
      formatter = true;
      agents.oracle-solve = {
        description = "Custom Oracle";
        permissions = [
          {
            action = "read";
            resource = "private/*";
            effect = "ask";
          }
        ];
      };
    };
  };
  connected = evaluate {
    mcp.servers = {
      atlassian.preset = "atlassian";
      notion-work.preset = "notion";
      notion-personal = {
        preset = "notion";
        settings.timeout.execution = 10000;
      };
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
  customReadTools = rendered (evaluate {
    mcp.servers.notion = {
      preset = "notion";
      readTools = [ "notion-fetch" ];
      settings.disabled = true;
    };
  });
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
  primaryEffect = action: effectFor connectedConfig.permissions action "*";
  readOnlyAgents = [ "research" ];
  readOnlyEffect =
    name: action:
    effectFor (connectedConfig.permissions ++ connectedConfig.agents.${name}.permissions) action "*";
  invalidServer = name: evaluate { mcp.servers.${name}.preset = "notion"; };
  supervised = evaluate {
    opencode.service = {
      enable = true;
      port = 4096;
    };
    opencode.disableClaudeCode = true;
  };
  serviceUnit = supervised.config.systemd.user.services.opencode;
  noServiceSwitching = evaluateWith { opencode.service.enable = true; } [
    { systemd.user.startServices = false; }
  ];
  noUserManager = evaluateWith { opencode.service.enable = true; } [
    { systemd.user.enable = false; }
  ];
  cliProbePackage = pkgs.writeShellScriptBin "opencode" ''
    exec ${lib.getExe pkgs.jq} --null-input \
      --argjson settings "''${OPENCODE_CLI_CONFIG_CONTENT:-null}" \
      --arg disableClaudeCode "''${OPENCODE_DISABLE_CLAUDE_CODE:-}" \
      --arg claudeCodeVersion "''${ANTHROPIC_CLAUDE_CODE_VERSION:-}" \
      --args '{settings: $settings, disableClaudeCode: $disableClaudeCode, claudeCodeVersion: $claudeCodeVersion, arguments: $ARGS.positional}' -- "$@"
  '';
  cliDefaults = evaluate { opencode.package = cliProbePackage; };
  cliAdditional = evaluate {
    opencode.package = cliProbePackage;
    opencode.cliSettings.session.thinking = "show";
  };
  cliCustom = evaluate {
    plugins.anthropicAuth.claudeCodeVersion = "2.1.281";
    opencode = {
      package = cliProbePackage;
      disableClaudeCode = true;
      cliSettings = {
        attention = {
          sound = false;
          volume = 0.25;
          sounds.permission = "/tmp/opencode/permission's sound.wav";
        };
        theme.name = "tokyonight";
      };
    };
  };
  cliAuthDisabled = evaluate {
    opencode.package = cliProbePackage;
    plugins.anthropicAuth.enable = false;
    plugins.anthropicAuth.claudeCodeVersion = "2.1.281";
  };
  cliUnwrapped = evaluateWith { opencode.package = cliProbePackage; } [
    { programs.limitless.opencode.cliSettings = lib.mkForce { }; }
  ];
in
{
  home-module =
    assert lib.assertMsg (
      valid defaults && valid connected && valid custom
    ) "valid module configuration failed assertions";
    assert lib.assertMsg (
      disabled.config.home.file == { } && disabled.config.home.packages == [ ]
    ) "disabled module installs files or packages";
    assert lib.assertMsg ((rendered defaults).mcp.servers == { }) "MCP connections must be opt-in";
    assert lib.assertMsg (lib.all
      (
        home:
        let
          config = rendered home;
        in
        effectFor config.permissions "browser" "*" == "deny"
        && lib.all (
          agent: effectFor (config.permissions ++ (agent.permissions or [ ])) "browser" "*" == "deny"
        ) (builtins.attrValues config.agents)
      )
      [
        defaults
        connected
        custom
      ]
    ) "native browser tools must be denied globally and for every configured agent";
    assert lib.assertMsg (
      !(defaults.options.programs.limitless ? tools)
      && !(defaults.options.programs.limitless ? slack)
      && !(defaults.options.programs.limitless ? notifications)
    ) "retired module options remain available";
    assert lib.assertMsg (
      customReadTools.mcp.servers.notion.disabled
      && effectFor customReadTools.permissions "notion_notion-fetch" "*" == "allow"
      && effectFor customReadTools.permissions "notion_notion-search" "*" == "allow"
      && lib.all (
        name:
        let
          rules = customReadTools.permissions ++ customReadTools.agents.${name}.permissions;
        in
        effectFor rules "notion_notion-fetch" "*" == "allow"
        && effectFor rules "notion_notion-search" "*" == "deny"
      ) readOnlyAgents
    ) "custom read exceptions or disabled connection settings were lost";
    assert lib.assertMsg (
      !(builtins.tryEval (
        builtins.deepSeq (rendered (evaluate {
          mcp.servers.notion = {
            preset = "notion";
            readTools = [ "*" ];
          };
        })) true
      )).success
    ) "wildcard read permissions passed option validation";
    assert lib.assertMsg (
      (plugin defaults).options.lsp.typescript.env ? TYPESCRIPT_TS_SERVER_PATH
    ) "TypeScript runtime was not configured";
    assert lib.assertMsg ((plugin noLsp).options.lsp == { }) "disabled LSP still has servers";
    assert lib.assertMsg (
      builtins.length noLsp.config.home.packages == 1
    ) "disabled LSP installs language servers";
    assert lib.assertMsg (
      (plugin custom).options.lsp.nixd.command == [
        "/custom/nixd"
        "--test"
      ]
    ) "custom LSP command was lost";
    assert lib.assertMsg (
      (plugin custom).options.lsp.nixd.env.TEST == "enabled" && (plugin custom).options.lsp ? test
    ) "LSP additions were lost";
    assert lib.assertMsg (!(rendered defaults ? lsp)) "LSP configuration has two owners";
    assert lib.assertMsg (
      (builtins.attrNames (plugin defaults).options) == [
        "agents"
        "github"
        "lsp"
        "providers"
      ]
    ) "retired integrations remain in plugin options";
    assert lib.assertMsg (
      (rendered custom).model == "openai/test" && (rendered custom).formatter
    ) "native settings were lost";
    assert lib.assertMsg (
      (rendered custom).agents.oracle-solve.description == "Custom Oracle"
      && effectFor (rendered custom).agents.oracle-solve.permissions "read" "private/file.txt" == "ask"
    ) "custom agent settings or permissions were lost";
    assert lib.assertMsg (
      builtins.length (rendered custom).plugins == 2
      && builtins.head (rendered custom).plugins == "custom-plugin"
    ) "custom plugins or Anthropic toggle were lost";
    assert lib.assertMsg (
      !(custom.config.home.file ? ".config/opencode/skills")
    ) "disabled skills were installed";
    assert lib.assertMsg (
      connectedConfig.mcp.servers.notion-work.url == connectedConfig.mcp.servers.notion-personal.url
    ) "named Notion accounts differ in endpoint";
    assert lib.assertMsg (
      connectedConfig.mcp.servers.notion-personal.timeout.execution == 10000
    ) "native MCP settings overlay was lost";
    assert lib.assertMsg (
      !(connectedConfig.mcp.servers.linear ? oauth) && !(connectedConfig.mcp.servers.linear ? headers)
    ) "Linear does not default to native OAuth";
    assert lib.assertMsg (
      connectedConfig.mcp.servers.gh.headers.Authorization == "Bearer {env:TEST_GITHUB_TOKEN}"
    ) "GitHub credential substitution changed";
    assert lib.assertMsg (
      connectedConfig.mcp.servers.custom.command == [ "test-mcp" ]
    ) "custom native MCP was lost";
    assert lib.assertMsg (lib.all
      (
        action:
        primaryEffect action == "allow"
        && lib.all (name: readOnlyEffect name action == "allow") readOnlyAgents
      )
      [
        "notion-work_notion-fetch"
        "notion-work_notion-download-skill"
        "notion-work_notion-get-session-status"
        "notion-personal_notion-search"
        "notion-personal_notion-download-attachment"
        "atlassian_getJiraIssue"
        "atlassian_listJiraBoards"
        "atlassian_getConfluenceContentPermissions"
        "atlassian_getBitbucketRepoPullRequestDiff"
        "atlassian_getCodeSymbol"
        "atlassian_getLoomVideo"
        "atlassian_getFocusAreaTypes"
        "sentry_search_issues"
        "sentry_search_sentry_tools"
        "gh_pull_request_read"
        "gh_get_file_blame"
        "gh_issue_dependency_read"
      ]
    ) "audited reads are not allowed for every agent";
    assert lib.assertMsg (lib.all
      (
        action:
        primaryEffect action == "allow"
        && lib.all (name: readOnlyEffect name action == "deny") readOnlyAgents
      )
      [
        "notion-work_notion-create-pages"
        "notion-work_new-tool"
        "notion-work_notion-fetch-and-delete"
        "notion-work_notion-spawn-session"
        "notion-personal_notion-create-attachment"
        "atlassian_editJiraIssue"
        "atlassian_exportConfluenceContent"
        "atlassian_executeRead"
        "atlassian_executeWrite"
        "atlassian_executeDestructive"
        "sentry_update_issue"
        "sentry_execute_sentry_tool"
        "sentry_analyze_issue_with_seer"
        "gh_create_pull_request"
        "gh_run_workflow"
        "linear_unknown-tool"
        "custom_write"
      ]
    ) "unknown or mutating MCP tools must be allowed for execution and denied for read-only agents";
    assert lib.assertMsg (lib.all (
      name: readOnlyEffect name "github_clone" == "allow"
    ) readOnlyAgents) "GitHub MCP policy captured the local clone tool";
    assert lib.assertMsg (
      effectFor connectedConfig.permissions "edit" ".limitless/repos/example/file.ts" == "deny"
    ) "managed checkout edit denial was lost";
    assert lib.assertMsg (lib.all (name: !valid (invalidServer name)) [
      "github"
      "lsp"
      "ast"
      "artifact"
      "browser"
      "browser_tabs"
      "opencode"
      "opencode_session"
      "bad name"
    ]) "unsafe MCP namespace passed assertions";
    assert lib.assertMsg (
      !valid (evaluate {
        mcp.servers = {
          notion.preset = "notion";
          notion_work.preset = "notion";
        };
      })
    ) "overlapping account prefixes passed assertions";
    assert lib.assertMsg (
      !valid (evaluate {
        mcp.servers.notion.preset = "notion";
        opencode.settings.mcp.servers.notion = {
          type = "remote";
          url = "https://example.com/mcp";
        };
      })
    ) "duplicate connection owners passed assertions";
    assert lib.assertMsg (
      !valid (evaluate {
        mcp.servers.gh.preset = "github";
      })
    ) "GitHub without explicit authentication passed assertions";
    assert lib.assertMsg (valid (evaluate {
      mcp.servers.gh = {
        preset = "github";
        settings.oauth.client_id = "registered-client";
      };
    })) "registered GitHub OAuth client failed assertions";
    assert lib.assertMsg (
      !valid (evaluate {
        github.enable = true;
      })
    ) "unrestricted GitHub clones were enabled implicitly";
    pkgs.runCommand "limitless-home-module-check"
      {
        nativeBuildInputs = [
          pkgs.bun
          pkgs.nodejs
        ];
      }
      ''
        mkdir -p "$out"
        cp ${
          pkgs.writeText "default-opencode.json"
            defaults.config.home.file.".config/opencode/opencode.json".text
        } "$out/default.json"
        cp ${
          pkgs.writeText "connected-opencode.json"
            connected.config.home.file.".config/opencode/opencode.json".text
        } "$out/connected.json"
        cp ${
          pkgs.writeText "custom-opencode.json" custom.config.home.file.".config/opencode/opencode.json".text
        } "$out/custom.json"
        ln -s ${
          self.packages.${pkgs.stdenv.hostPlatform.system}.limitless.dependencies
        }/packages/limitless/node_modules node_modules
        cp ${./validate-config.mjs} validate-config.mjs
        bun validate-config.mjs ${agentsPackage} "$out/default.json" "$out/connected.json" "$out/custom.json"
        cp ${./validate-plugin.mjs} validate-plugin.mjs
        node validate-plugin.mjs ${defaults.config.programs.limitless.plugins.limitless.package}
        ${lib.concatMapStringsSep "\n" (
          server: "test -x ${lib.escapeShellArg (builtins.head server.command)}"
        ) (builtins.attrValues (plugin defaults).options.lsp)}
      '';

  cli-settings =
    assert lib.assertMsg (
      defaults.config.programs.limitless.opencode.cliSettings.attention.sound
      && cliAdditional.config.programs.limitless.opencode.cliSettings.attention.sound
      && !cliCustom.config.programs.limitless.opencode.cliSettings.attention.sound
    ) "CLI sound defaults or user overrides were lost";
    assert lib.assertMsg (lib.all (home: !(home.config.home.file ? ".config/opencode/cli.json")) [
      defaults
      cliAdditional
      cliCustom
    ]) "CLI settings must preserve the editable native cli.json file";
    assert lib.assertMsg (
      cliUnwrapped.config.programs.limitless._generated.opencodePackage == cliProbePackage
    ) "disabled launcher settings create an unnecessary wrapper";
    assert lib.assertMsg (lib.all
      (
        version:
        !(builtins.tryEval
          (evaluate { plugins.anthropicAuth.claudeCodeVersion = version; })
          .config.programs.limitless.plugins.anthropicAuth.claudeCodeVersion
        ).success
      )
      [
        ""
        "latest"
        "2.1"
        "v2.1.280"
        "02.1.280"
        "2.1.280-beta"
        ("2.1." + lib.concatStrings (lib.replicate 65 "1"))
      ]
    ) "invalid Claude Code compatibility versions passed validation";
    pkgs.runCommand "limitless-cli-settings-check" { nativeBuildInputs = [ pkgs.jq ]; } ''
      mkdir -p "$out"
      unset OPENCODE_CLI_CONFIG_CONTENT OPENCODE_DISABLE_CLAUDE_CODE ANTHROPIC_CLAUDE_CODE_VERSION

      ${cliDefaults.config.programs.limitless._generated.opencodePackage}/bin/opencode \
        "path with spaces" --version > "$out/default.json"
      jq -e '
        .settings == {attention: {sound: true}}
        and .disableClaudeCode == ""
        and .claudeCodeVersion == ""
        and .arguments == ["path with spaces", "--version"]
      ' "$out/default.json"

      ${cliAdditional.config.programs.limitless._generated.opencodePackage}/bin/opencode > "$out/additional.json"
      jq -e '
        .settings == {attention: {sound: true}, session: {thinking: "show"}}
      ' "$out/additional.json"

      OPENCODE_DISABLE_CLAUDE_CODE=0 \
        ${cliCustom.config.programs.limitless._generated.opencodePackage}/bin/opencode > "$out/custom.json"
      jq -e --argjson expected ${lib.escapeShellArg (builtins.toJSON cliCustom.config.programs.limitless.opencode.cliSettings)} '
        .settings == $expected and .disableClaudeCode == "1" and .claudeCodeVersion == "2.1.281"
      ' "$out/custom.json"

      OPENCODE_CLI_CONFIG_CONTENT='{"attention":{"sound":false},"theme":{"name":"override"}}' \
        ANTHROPIC_CLAUDE_CODE_VERSION=2.1.282 \
        ${cliDefaults.config.programs.limitless._generated.opencodePackage}/bin/opencode > "$out/environment.json"
      jq -e '
        .settings == {attention: {sound: false}, theme: {name: "override"}}
        and .claudeCodeVersion == "2.1.282"
      ' "$out/environment.json"

      ${cliAuthDisabled.config.programs.limitless._generated.opencodePackage}/bin/opencode > "$out/auth-disabled.json"
      jq -e '.settings.attention.sound == true and .claudeCodeVersion == ""' "$out/auth-disabled.json"

      ${cliUnwrapped.config.programs.limitless._generated.opencodePackage}/bin/opencode > "$out/unwrapped.json"
      jq -e '.settings == null and .disableClaudeCode == "" and .claudeCodeVersion == ""' "$out/unwrapped.json"
    '';

  service =
    assert lib.assertMsg (
      defaults.config.systemd.user.services == { } && disabled.config.systemd.user.services == { }
    ) "service supervision must be opt-in";
    assert lib.assertMsg (
      (evaluate {
        enable = false;
        opencode.service.enable = true;
      }).config.systemd.user.services == { }
    ) "disabled Limitless still creates a service";
    assert lib.assertMsg (
      defaults.config.programs.limitless.opencode.service.hostname == "127.0.0.1"
      && defaults.config.programs.limitless.opencode.service.port == 49374
    ) "service defaults must match native OpenCode";
    assert lib.assertMsg (
      valid supervised == pkgs.stdenv.hostPlatform.isLinux
    ) "supervision must reject unsupported platforms";
    assert lib.assertMsg (!valid noUserManager) "supervision must require a user manager";
    assert lib.assertMsg (
      !pkgs.stdenv.hostPlatform.isLinux || builtins.length noServiceSwitching.config.warnings == 1
    ) "disabled service switching must warn about manual activation";
    assert lib.assertMsg (
      !(supervised.config.home.file ? ".config/opencode/service.json")
    ) "private native service configuration must not enter the Nix store";
    assert lib.assertMsg (
      !(builtins.tryEval (
        builtins.deepSeq
          (evaluate {
            opencode.service.port = 0;
          }).config.programs.limitless.opencode.service.port
          true
      )).success
    ) "invalid service port passed option validation";
    assert lib.assertMsg (
      !(builtins.tryEval (
        builtins.deepSeq
          (evaluate {
            opencode.service.hostname = "";
          }).config.programs.limitless.opencode.service.hostname
          true
      )).success
    ) "empty service hostname passed option validation";
    assert lib.assertMsg (
      !pkgs.stdenv.hostPlatform.isLinux
      || (
        serviceUnit.Service.Type == "exec"
        && serviceUnit.Service.Restart == "always"
        && serviceUnit.Install.WantedBy == [ "default.target" ]
        && !(serviceUnit.Service ? ExecStop)
        && serviceUnit.Unit.StartLimitIntervalSec == 0
        && builtins.length serviceUnit.Unit.X-Restart-Triggers == 4
        &&
          builtins.elem supervised.config.home.file.".config/opencode/opencode.json".source
            serviceUnit.Unit.X-Restart-Triggers
      )
    ) "supervised service lifecycle or restart triggers changed";
    pkgs.runCommand "limitless-service-check" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
      cp ${../packages/opencode-service.mjs} opencode-service.mjs
      cp ${../packages/opencode-service.test.mjs} opencode-service.test.mjs
      node --test opencode-service.test.mjs
      ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
        test -x ${serviceUnit.Service.ExecStart}
        grep -F ${lib.escapeShellArg "${supervised.config.programs.limitless._generated.opencodePackage}/bin/opencode"} ${serviceUnit.Service.ExecStart}
        grep -F '127.0.0.1 4096' ${serviceUnit.Service.ExecStart}
      ''}
      touch "$out"
    '';

  subagent-profiles =
    assert lib.assertMsg (
      (plugin defaults).options.agents.fastSubagents == [
        "oracle-solve"
        "research"
        "worker"
      ]
    ) "default Fast subagents changed";
    assert lib.assertMsg (
      (plugin (evaluate {
        agents.fastSubagents = [ "worker" ];
      })).options.agents.fastSubagents == [ "worker" ]
    ) "custom Fast subagents changed";
    assert lib.assertMsg (
      (plugin (evaluate {
        agents.fastSubagents = [ ];
      })).options.agents.fastSubagents == [ ]
    ) "empty Fast subagent list changed";
    pkgs.runCommand "limitless-subagent-profiles-check" { } ''
      sed '2d' ${agentsPackage}/limitless.md > standard.md
      sed '2d' ${agentsPackage}/limitless-fast.md > fast.md
      cmp standard.md fast.md
      grep -F 'with Standard processing for configured subagents.' ${agentsPackage}/limitless.md
      grep -F 'with Fast processing for configured subagents.' ${agentsPackage}/limitless-fast.md
      test ! -e ${agentsPackage}/gary.md
      test ! -e ${agentsPackage}/review.md
      touch "$out"
    '';
}
