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
      home = {
        file = lib.mkOption {
          type = lib.types.attrsOf lib.types.attrs;
          default = { };
        };
        packages = lib.mkOption {
          type = lib.types.listOf lib.types.package;
          default = [ ];
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
  evaluate =
    settings:
    lib.evalModules {
      specialArgs = { inherit pkgs; };
      modules = [
        (import ../modules/home.nix { inherit self; })
        homeStubs
        { programs.limitless = lib.recursiveUpdate { enable = true; } settings; }
      ];
    };
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
  researchEffect =
    action:
    effectFor (connectedConfig.permissions ++ connectedConfig.agents.research.permissions) action "*";
  invalidServer = name: evaluate { mcp.servers.${name}.preset = "notion"; };
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
    assert lib.assertMsg (
      !(defaults.options.programs.limitless ? tools)
      && !(defaults.options.programs.limitless ? slack)
      && !(defaults.options.programs.limitless ? notifications)
      && !(defaults.options.programs.limitless.opencode ? service)
    ) "retired module options remain available";
    assert lib.assertMsg (
      customReadTools.mcp.servers.notion.disabled
      && effectFor customReadTools.permissions "notion_notion-fetch" "*" == "allow"
      && effectFor customReadTools.permissions "notion_notion-search" "*" == "ask"
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
      (action: primaryEffect action == "allow" && researchEffect action == "allow")
      [
        "notion-work_notion-fetch"
        "notion-personal_notion-search"
        "atlassian_getJiraIssue"
        "sentry_search_issues"
        "gh_pull_request_read"
      ]
    ) "audited reads are not allowed for both agents";
    assert lib.assertMsg (lib.all
      (action: primaryEffect action == "ask" && researchEffect action == "deny")
      [
        "notion-work_notion-create-pages"
        "notion-work_new-tool"
        "notion-work_notion-fetch-and-delete"
        "atlassian_editJiraIssue"
        "sentry_update_issue"
        "sentry_execute_sentry_tool"
        "gh_create_pull_request"
        "linear_unknown-tool"
        "custom_write"
      ]
    ) "unknown or mutating MCP tools escape the policy";
    assert lib.assertMsg (
      researchEffect "github_clone" == "allow"
    ) "GitHub MCP policy captured the local clone tool";
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
    pkgs.runCommand "limitless-home-module-check" { nativeBuildInputs = [ pkgs.bun ]; } ''
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
      bun validate-config.mjs "$out/default.json" "$out/connected.json" "$out/custom.json"
      ${lib.concatMapStringsSep "\n" (
        server: "test -x ${lib.escapeShellArg (builtins.head server.command)}"
      ) (builtins.attrValues (plugin defaults).options.lsp)}
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
