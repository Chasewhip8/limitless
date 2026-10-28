{
  pkgs,
  self,
  agentsPackage,
}:
let
  inherit (pkgs) lib;
  fileOption = lib.mkOption {
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
  homeStubs = { config, ... }: {
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
        file = fileOption;
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
      xdg =
        lib.genAttrs [ "configHome" "dataHome" "stateHome" "cacheHome" ] (
          name:
          lib.mkOption {
            type = lib.types.str;
            default = "/home/test/${name}";
          }
        )
        // {
          configFile = fileOption;
        };
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
    config.home.file = lib.mapAttrs' (
      name: file: lib.nameValuePair "${config.xdg.configHome}/${name}" file
    ) config.xdg.configFile;
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
  opencodeJson = home: home.config.xdg.configFile."opencode/opencode.json".text;
  rendered = home: builtins.fromJSON (builtins.unsafeDiscardStringContext (opencodeJson home));
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
  desktopSettings = {
    opencode.desktop.enable = true;
    t3.desktop.enable = true;
    paseo.desktop.enable = true;
  };
  desktopsOnly = evaluate (desktopSettings // { enable = false; });
  desktopMismatch = pkgs.runCommand "desktop-mismatch-0" { version = "0"; } ''
    mkdir -p "$out"
  '';
  disabled = evaluate { enable = false; };
  connected = evaluate {
    opencode.settings.plugins = [
      "*"
      "opencode.browser"
    ];
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
  readWriteAgents = [
    "limitless"
    "oracle-solve"
    "oracle-design"
  ];
  supportAgents = [
    "research"
    "oracle-solve"
    "oracle-design"
  ];
  connectedEffect =
    name: action:
    effectFor (connectedConfig.permissions ++ connectedConfig.agents.${name}.permissions) action "*";
  withServers = servers: evaluate { mcp.servers = servers; };

  executorSettings = {
    enable = true;
    url = "https://athena.example.ts.net:9443/mcp";
    connection = "primary-connection";
    readConnection = "read-connection";
  };
  executorHome = evaluate { mcp.executor = executorSettings; };
  executorConfig = rendered executorHome;
  executorWithDirect = evaluate {
    mcp = {
      executor = executorSettings;
      servers.notion-work.preset = "notion";
    };
  };
  executorFull = evaluate {
    mcp.executor = {
      enable = true;
      fullAccess = true;
      inherit (executorSettings) url;
      callbackPort = 19876;
    };
  };
  executorPrimaryOnly = evaluate {
    mcp.executor = executorSettings // {
      readConnection = null;
    };
  };
  executorEffect =
    agent: action:
    effectFor (executorConfig.permissions ++ executorConfig.agents.${agent}.permissions) action "*";
  executorAcceptsPort =
    name: value:
    (builtins.tryEval (
      builtins.deepSeq (rendered (evaluate {
        mcp.executor = executorSettings // {
          ${name} = value;
        };
      })) true
    )).success;
  executorAcceptsUrl =
    url:
    (builtins.tryEval (
      builtins.deepSeq (rendered (evaluate {
        mcp.executor = executorSettings // {
          inherit url;
        };
      })) true
    )).success;

  supervised = evaluate {
    opencode.service = {
      enable = true;
      port = 4096;
    };
  };
  serviceUnit = supervised.config.systemd.user.services.opencode;
  supervisedWithoutSkills = evaluate {
    opencode.service.enable = true;
    skills.enable = false;
  };
  customXdg = evaluateWith { opencode.service.enable = pkgs.stdenv.hostPlatform.isLinux; } [
    { xdg.configHome = "/home/test/preferences"; }
  ];
  executorServiceUnit =
    (evaluate {
      opencode.service.enable = true;
      mcp.executor = executorSettings;
    }).config.systemd.user.services.opencode;
  t3Supervised = evaluate {
    t3.enable = true;
    opencode.service.enable = true;
  };
  t3Unit = t3Supervised.config.systemd.user.services.t3code;
  t3Standalone = evaluate { t3.enable = true; };
  paseoSupervised = evaluate {
    paseo.enable = true;
    opencode.service.enable = true;
  };
  paseoUnit = paseoSupervised.config.systemd.user.services.paseo;
  paseoCustom = evaluate {
    paseo = {
      enable = true;
      port = 7777;
      home = "/home/test/Paseo data";
      browserTools = false;
      hostnames = [
        "pc.example.ts.net"
        ".lan.example"
      ];
    };
    opencode.service.enable = true;
  };
  paseoPluginOf =
    home:
    builtins.filter (
      entry: builtins.isAttrs entry && lib.hasSuffix "/paseo" entry.package
    ) (rendered home).plugins;
  paseoLauncherOf =
    home: lib.findFirst (package: package.name == "opencode-paseo") null home.config.home.packages;
  t3Custom = evaluate {
    t3 = {
      enable = true;
      port = 3883;
      baseDir = "/home/test/T3 data";
      opencode.enable = false;
    };
    opencode.service.enable = true;
  };

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
  t3Launcher = lib.findFirst (
    package: package.name == "opencode-t3"
  ) (throw "Missing opencode-t3 launcher") defaults.config.home.packages;
  paseoLauncher = paseoLauncherOf paseoSupervised;
in
{
  executor-client =
    assert lib.assertMsg (
      valid executorHome && valid executorPrimaryOnly && valid executorFull
    ) "Scoped Executor configuration must be valid";
    assert lib.assertMsg (
      (rendered executorFull).mcp.servers.executor.url == "https://athena.example.ts.net:9443/mcp"
      && (rendered executorFull).mcp.servers.executor.oauth == { callback_port = 19876; }
      && !(executorConfig.mcp.servers.executor ? oauth)
      && !((rendered executorFull).mcp.servers ? executor-read)
      && lib.all (
        agent:
        let
          c = rendered executorFull;
        in
        effectFor (c.permissions ++ c.agents.${agent}.permissions) "executor_execute" "*"
        == (if agent == "research" then "deny" else "allow")
      ) (readWriteAgents ++ [ "research" ])
      && !(valid (evaluate {
        mcp.executor = executorSettings // {
          fullAccess = true;
        };
      }))
    ) "Full Executor access must be an exclusive opt-in and must never grant Research access";
    assert lib.assertMsg (
      let
        fixed = evaluate {
          mcp.executor = executorSettings // {
            callbackPort = 19876;
            readCallbackPort = 19877;
          };
        };
      in
      valid fixed
      && (rendered fixed).mcp.servers.executor-read.oauth == { callback_port = 19877; }
      && !(valid (evaluate {
        mcp.executor = executorSettings // {
          callbackPort = 19876;
          readCallbackPort = 19876;
        };
      }))
    ) "Remote onboarding must expose only callback_port and reject conflicting fixed listeners";
    assert lib.assertMsg (lib.all
      (
        name:
        lib.all (value: !executorAcceptsPort name value) [
          0
          (-1)
          65536
        ]
      )
      [
        "callbackPort"
        "readCallbackPort"
      ]
    ) "OAuth callback ports must match OpenCode's 1–65535 range";
    assert lib.assertMsg (lib.all (url: !executorAcceptsUrl url) [
      "http://example.test/mcp"
      "https://example.test/mcp?connection=unscoped"
      "https://user:password@example.test/mcp"
      "https://example.test/mcp#fragment"
    ]) "Executor endpoints must be HTTPS without embedded credentials or query overrides";
    assert lib.assertMsg (
      executorConfig.mcp.servers.executor.url
      == "https://athena.example.ts.net:9443/mcp?connection=primary-connection"
      &&
        executorConfig.mcp.servers.executor-read.url
        == "https://athena.example.ts.net:9443/mcp?connection=read-connection&elicitation_mode=browser"
      && !executorConfig.mcp.servers.executor.codemode
      && !executorConfig.mcp.servers.executor-read.codemode
      && executorConfig.mcp.servers.executor.protocol == "legacy"
      && !((rendered executorPrimaryOnly).mcp.servers ? executor-read)
    ) "Executor must use scoped OAuth URLs and expose its wrappers without double Code Mode";
    assert lib.assertMsg (lib.all
      (
        tool:
        lib.all (
          agent:
          executorEffect agent "executor_${tool}" == "allow"
          && executorEffect agent "executor-read_${tool}" == "deny"
          && executorEffect agent "executor-read_unknown" == "deny"
        ) readWriteAgents
        && executorEffect "research" "executor_${tool}" == "deny"
        && executorEffect "research" "executor-read_${tool}" == "allow"
        && executorEffect "research" "executor-read_unknown" == "allow"
      )
      [
        "skills"
        "search"
        "describe"
        "call"
        "execute"
        "resume"
      ]
    ) "Executor role permissions must route each agent only to its selected server-side policy";
    assert lib.assertMsg (
      let
        c = rendered executorWithDirect;
        access = agent: action: effectFor (c.permissions ++ c.agents.${agent}.permissions) action "*";
      in
      access "research" "notion-work_notion-fetch" == "deny"
      && access "research" "notion-work_notion-create-pages" == "deny"
      && lib.all (
        agent:
        access agent "notion-work_notion-fetch" == "allow"
        && access agent "notion-work_notion-create-pages" == "allow"
      ) readWriteAgents
    ) "Executor mode must not let Research fall back to directly authenticated MCP servers";
    assert lib.assertMsg (lib.all
      (
        agent:
        let
          c = rendered executorPrimaryOnly;
        in
        effectFor (c.permissions ++ c.agents.${agent}.permissions) "executor_execute" "*"
        == (if agent == "research" then "deny" else "allow")
      )
      (readWriteAgents ++ [ "research" ])
    ) "Without a read connection Research must have no Executor access";
    assert lib.assertMsg (
      !(valid (evaluate {
        mcp.executor = executorSettings // {
          connection = "";
        };
      }))
      && !(valid (evaluate {
        mcp.executor = executorSettings // {
          readConnection = "primary-connection";
        };
      }))
      && !(valid (evaluate {
        mcp.executor = executorSettings;
        opencode.settings.mcp.servers.executor = {
          type = "remote";
          url = "https://example.test/mcp";
        };
      }))
      && !(valid (evaluate {
        mcp.executor = executorSettings;
        mcp.servers.executor-read.preset = "notion";
      }))
    ) "Executor must reject unscoped, shared-role, or conflicting connections";
    assert lib.assertMsg (
      !(executorHome.config.xdg.configFile ? "limitless/executor-read-tools.json")
    ) "Executor read policy must not be duplicated into a generated per-tool list";
    pkgs.runCommand "executor-client-check" { } ''touch "$out"'';
  home-module =
    assert lib.assertMsg (valid defaults && valid connected) "valid configuration failed assertions";
    assert lib.assertMsg (
      disabled.config.home.file == { }
      && disabled.config.home.packages == [ ]
      && disabled.config.home.shellAliases == { }
      && disabled.config.systemd.user.services == { }
    ) "a disabled module changed the home configuration";
    assert lib.assertMsg (lib.all
      (action: lib.all (name: connectedEffect name action == "allow") ([ "limitless" ] ++ supportAgents))
      [
        "notion-work_notion-fetch"
        "atlassian_getJiraIssue"
        "sentry_search_issues"
        "gh_pull_request_read"
        "github_clone"
      ]
    ) "audited MCP reads and local investigation tools must stay available to support agents";
    assert lib.assertMsg (lib.all
      (
        action:
        lib.all (name: connectedEffect name action == "allow") readWriteAgents
        && connectedEffect "research" action == "deny"
      )
      [
        "notion-work_notion-create-pages"
        "notion-work_new-tool"
        "atlassian_editJiraIssue"
        "sentry_execute_sentry_tool"
        "gh_create_pull_request"
        "linear_unknown-tool"
        "custom_write"
      ]
    ) "MCP mutations and unaudited tools must be available to main and Oracles, but denied to Research";
    assert lib.assertMsg (lib.all
      (
        name:
        !valid (withServers {
          ${name}.preset = "notion";
        })
      )
      [
        "github"
        "artifact"
        "browser"
        "opencode"
        "t3-code"
        "t3-code-custom"
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
    assert lib.assertMsg (
      defaults.config.xdg.configFile."opencode/plugins/limitless-cache-status".source
      == "${defaults.config.programs.limitless.plugins.limitless.package}/cache-status"
      && !(
        (evaluate { plugins.limitless.cacheStatus.enable = false; }).config.xdg.configFile
        ? "opencode/plugins/limitless-cache-status"
      )
    ) "the cache-status TUI plugin must follow its enable option";
    pkgs.runCommand "limitless-home-module-check"
      {
        nativeBuildInputs = [
          pkgs.bun
          pkgs.nodejs
        ];
      }
      ''
        mkdir -p "$out"
        test -f ${self.packages.${pkgs.stdenv.hostPlatform.system}.skills}/pull-request/SKILL.md
        test -f ${self.packages.${pkgs.stdenv.hostPlatform.system}.skills}/repository-setup/SKILL.md
        cp ${pkgs.writeText "default-opencode.json" (opencodeJson defaults)} "$out/default.json"
        cp ${pkgs.writeText "connected-opencode.json" (opencodeJson connected)} "$out/connected.json"
        cp ${pkgs.writeText "executor-opencode.json" (opencodeJson executorHome)} "$out/executor.json"
        cp ${pkgs.writeText "executor-full-opencode.json" (opencodeJson executorFull)} "$out/executor-full.json"
        cp ${pkgs.writeText "executor-direct-opencode.json" (opencodeJson executorWithDirect)} "$out/executor-direct.json"
        ln -s ${
          self.packages.${pkgs.stdenv.hostPlatform.system}.limitless.dependencies
        }/packages/limitless/node_modules node_modules
        cp ${./validate-config.mjs} validate-config.mjs
        bun validate-config.mjs ${agentsPackage} "$out/default.json" "$out/connected.json" "$out/executor.json" "$out/executor-full.json" "$out/executor-direct.json"
        cp ${./validate-plugin.mjs} validate-plugin.mjs
        # Node needs fixture dependencies beside hosted artifacts. The runtime
        # check separately loads the original store package in real OpenCode.
        cp -r ${defaults.config.programs.limitless.plugins.limitless.package} plugin
        node validate-plugin.mjs "$PWD/plugin"
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

  t3-runtime =
    pkgs.runCommand "limitless-t3-runtime-check"
      {
        nativeBuildInputs = [ pkgs.bun ];
      }
      ''
        cp ${./validate-t3-runtime.mjs} validate-t3-runtime.mjs
        cp ${./t3-fake-mcp.mjs} t3-fake-mcp.mjs
        export HOME="$TMPDIR/home"
        mkdir -p "$HOME"
        test "$(${lib.getExe t3Launcher} --version)" = "$(${launcherOf defaults} --version)"
        if OPENCODE_PASSWORD=check ${lib.getExe t3Launcher} serve --port=0 >launch.out 2>launch.err; then
          echo "opencode-t3 started without a managed service" >&2
          exit 1
        fi
        grep -q 'managed OpenCode service is unavailable' launch.err
        if grep -q 'listening' launch.out; then
          echo "opencode-t3 announced a server without a managed service" >&2
          exit 1
        fi
        bun validate-t3-runtime.mjs \
          ${self.packages.${pkgs.stdenv.hostPlatform.system}.limitless} \
          ${lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.opencode} \
          ${self}/packages/limitless/test/fixtures/t3-tool-names.json \
          ${lib.escapeShellArg self.packages.${pkgs.stdenv.hostPlatform.system}.opencode.version}
        touch "$out"
      '';

  paseo-runtime =
    pkgs.runCommand "limitless-paseo-runtime-check"
      {
        nativeBuildInputs = [ pkgs.bun ];
      }
      ''
        cp ${./validate-paseo-runtime.mjs} validate-paseo-runtime.mjs
        export HOME="$TMPDIR/home"
        mkdir -p "$HOME"
        test "$(${lib.getExe paseoLauncher} --version)" = "$(${launcherOf paseoSupervised} --version)"
        if OPENCODE_PASSWORD=check ${lib.getExe paseoLauncher} serve --hostname 127.0.0.1 --port 0 >launch.out 2>launch.err; then
          echo "opencode-paseo started without a managed service" >&2
          exit 1
        fi
        grep -q 'managed OpenCode service is unavailable' launch.err
        if grep -q 'listening' launch.out; then
          echo "opencode-paseo announced a server without a managed service" >&2
          exit 1
        fi
        bun validate-paseo-runtime.mjs \
          ${self.packages.${pkgs.stdenv.hostPlatform.system}.limitless} \
          ${lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.opencode} \
          ${lib.escapeShellArg self.packages.${pkgs.stdenv.hostPlatform.system}.opencode.version}
        touch "$out"
      '';

  paseo-service =
    assert lib.assertMsg (
      !(defaults.config.systemd.user.services ? paseo)
      && paseoPluginOf defaults == [ ]
      && paseoLauncherOf defaults == null
      && !valid (evaluate {
        enable = false;
        paseo.enable = true;
      })
      && !valid (evaluate {
        paseo.enable = true;
      })
      && !valid (evaluate {
        paseo.enable = true;
        paseo.package = null;
        opencode.service.enable = true;
      })
    ) "Paseo must be opt-in and require an enabled workspace, package and managed OpenCode service";
    assert lib.assertMsg (
      paseoPluginOf paseoSupervised == [
        { package = "file://${paseoSupervised.config.programs.limitless.plugins.limitless.package}/paseo"; }
      ]
      && paseoLauncher != null
    ) "Enabling Paseo must load the paseo plugin and install opencode-paseo";
    assert lib.assertMsg (
      if pkgs.stdenv.hostPlatform.isLinux then
        valid paseoSupervised
        && valid paseoCustom
        && paseoUnit.Unit.Wants == [ "opencode.service" ]
        && paseoUnit.Unit.After == [ "opencode.service" ]
        && paseoUnit.Unit.X-SwitchMethod == "keep-old"
        && paseoUnit.Service.Type == "exec"
        && lib.hasSuffix "/bin/paseo-server" paseoUnit.Service.ExecStart
        && builtins.elem "PASEO_HOME=/home/test/.paseo" paseoUnit.Service.Environment
        && lib.any (lib.hasPrefix "PATH=/run/wrappers/bin:") paseoUnit.Service.Environment
        && builtins.elem "PASEO_HOME=/home/test/Paseo data" paseoCustom.config.systemd.user.services.paseo.Service.Environment
        && paseoUnit.Install.WantedBy == [ "default.target" ]
        && !(lib.any (lib.hasPrefix "PASEO_HOSTNAMES=") paseoUnit.Service.Environment)
        && builtins.elem "PASEO_HOSTNAMES=pc.example.ts.net,.lan.example" paseoCustom.config.systemd.user.services.paseo.Service.Environment
        && !valid (
          evaluateWith {
            paseo.enable = true;
            opencode.service.enable = true;
          } [ { systemd.user.enable = false; } ]
        )
      else
        !valid paseoSupervised && !(paseoSupervised.config.systemd.user.services ? paseo)
    ) "Paseo supervision, platform constraints or OpenCode dependency changed";
    assert lib.assertMsg (
      !(builtins.tryEval (evaluate { paseo.home = "relative"; }).config.programs.limitless.paseo.home)
      .success
    ) "Paseo homes must be absolute";
    assert lib.assertMsg (lib.all
      (
        name:
        !(builtins.tryEval (
          builtins.deepSeq
            (evaluate { paseo.hostnames = [ name ]; }).config.programs.limitless.paseo.hostnames
            true
        )).success
      )
      [
        "https://pc.example"
        "pc.example:10443"
        "pc.example."
        "true"
        "TRUE"
        "a,b"
        ""
        "pc example"
      ]
    ) "Paseo hostnames must not accept URLs, ports, trailing dots or the allow-all sentinel";
    pkgs.runCommand "limitless-paseo-service-check" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
      cp ${../packages/paseo-settings.mjs} paseo-settings.mjs
      cp ${../packages/paseo-settings.test.mjs} paseo-settings.test.mjs
      node --test paseo-settings.test.mjs
      ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
        test -x ${paseoUnit.Service.ExecStartPre}
        grep -F "/home/test/.paseo 127.0.0.1:6767 /home/test/.nix-profile/bin/opencode-paseo true" ${paseoUnit.Service.ExecStartPre}
        grep -F "'/home/test/Paseo data' 127.0.0.1:7777 /home/test/.nix-profile/bin/opencode-paseo false" ${paseoCustom.config.systemd.user.services.paseo.Service.ExecStartPre}
        test "$(HOME="$TMPDIR" ${lib.getExe' paseoSupervised.config.programs.limitless.paseo.package "paseo"} --version)" = '${paseoSupervised.config.programs.limitless.paseo.package.version}'
      ''}
      touch "$out"
    '';

  t3-service =
    assert lib.assertMsg (
      !(defaults.config.systemd.user.services ? t3code)
      && !valid (evaluate {
        enable = false;
        t3.enable = true;
      })
      && !valid (evaluate {
        t3.enable = true;
        t3.package = null;
      })
    ) "T3 must be opt-in and require an enabled workspace and package";
    assert lib.assertMsg (
      if pkgs.stdenv.hostPlatform.isLinux then
        valid t3Supervised
        && valid t3Standalone
        && valid t3Custom
        && t3Unit.Unit.Wants == [ "opencode.service" ]
        && t3Unit.Unit.After == [ "opencode.service" ]
        && !(t3Unit.Unit ? Requires)
        && !(t3Unit.Unit ? PartOf)
        && !(t3Unit.Unit ? X-SwitchMethod)
        && t3Standalone.config.warnings == [ ]
        &&
          builtins.length
            (evaluateWith { t3.enable = true; } [
              { systemd.user.startServices = false; }
            ]).config.warnings == 1
        && t3Unit.Service.Type == "exec"
        && lib.hasInfix "--host 127.0.0.1 --port 3773 --base-dir /home/test/.t3" t3Unit.Service.ExecStart
        && builtins.elem "T3CODE_TAILSCALE_SERVE=false" t3Unit.Service.Environment
        &&
          lib.all
            (
              name: builtins.elem "XDG_${lib.toUpper name}_HOME=/home/test/${name}Home" t3Unit.Service.Environment
            )
            [
              "config"
              "data"
              "state"
              "cache"
            ]
        && t3Unit.Install.WantedBy == [ "default.target" ]
        && !(t3Standalone.config.systemd.user.services.t3code.Unit ? Wants)
        && !(t3Custom.config.systemd.user.services.t3code.Unit ? Wants)
        && lib.hasInfix "--port 3883 --base-dir '/home/test/T3 data'" t3Custom.config.systemd.user.services.t3code.Service.ExecStart
        && !valid (evaluateWith { t3.enable = true; } [ { systemd.user.enable = false; } ])
      else
        !valid t3Supervised && !(t3Supervised.config.systemd.user.services ? t3code)
    ) "T3 supervision, platform constraints or OpenCode dependency changed";
    assert lib.assertMsg (
      !(builtins.tryEval
        (evaluate { t3.baseDir = "/home/test/.t3 "; }).config.programs.limitless.t3.baseDir
      ).success
    ) "T3 homes with surrounding whitespace must be rejected";
    pkgs.runCommand "limitless-t3-service-check" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
      cp ${../packages/t3-settings.mjs} t3-settings.mjs
      cp ${../packages/t3-settings.test.mjs} t3-settings.test.mjs
      node --test t3-settings.test.mjs
      ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
        test -x ${t3Unit.Service.ExecStartPre}
        grep -F '/home/test/.nix-profile/bin/opencode-t3' ${t3Unit.Service.ExecStartPre}
        grep -F -- '--no-opencode' ${t3Custom.config.systemd.user.services.t3code.Service.ExecStartPre}
        test "$(${lib.getExe t3Supervised.config.programs.limitless.t3.package} --version)" = 't3 v${t3Supervised.config.programs.limitless.t3.package.version}'
      ''}
      touch "$out"
    '';

  desktops =
    assert lib.assertMsg (lib.all (name: !defaults.config.programs.limitless.${name}.desktop.enable) [
      "opencode"
      "t3"
      "paseo"
    ]) "Desktops must be opt-in";
    assert lib.assertMsg (
      !valid (evaluate {
        enable = false;
        opencode.desktop = {
          enable = true;
          package = null;
        };
      })
    ) "An enabled desktop needs a package";
    assert lib.assertMsg (
      if pkgs.stdenv.hostPlatform.system == "x86_64-linux" then
        valid desktopsOnly
        &&
          map lib.getName desktopsOnly.config.home.packages == [
            "opencode-desktop"
            "t3-desktop"
            "paseo-desktop"
          ]
        && desktopsOnly.config.home.file == { }
        && desktopsOnly.config.systemd.user.services == { }
        && desktopsOnly.config.warnings == [ ]
        && valid (
          evaluate (
            lib.recursiveUpdate desktopSettings {
              opencode.service.enable = true;
              t3.enable = true;
              paseo.enable = true;
            }
          )
        )
        && !valid (evaluate {
          opencode.desktop.enable = true;
          opencode.package = desktopMismatch;
        })
        && valid (evaluate {
          enable = false;
          opencode.desktop.enable = true;
          opencode.package = desktopMismatch;
        })
        && builtins.length (evaluate { opencode.desktop.enable = true; }).config.warnings == 1
        &&
          (evaluate {
            opencode.desktop.enable = true;
            opencode.service.enable = true;
          }).config.warnings == [ ]
        &&
          lib.getVersion self.packages.${pkgs.stdenv.hostPlatform.system}.t3-desktop
          == lib.getVersion self.packages.${pkgs.stdenv.hostPlatform.system}.t3
        &&
          lib.getVersion self.packages.${pkgs.stdenv.hostPlatform.system}.paseo-desktop
          == lib.getVersion self.packages.${pkgs.stdenv.hostPlatform.system}.paseo
      else
        !valid desktopsOnly && desktopsOnly.config.home.packages == [ ]
    ) "Desktop installation, standalone use, platform limits or version checks changed";
    pkgs.runCommand "limitless-desktops-check" { } ''
      touch "$out"
    '';

  service =
    assert lib.assertMsg (
      let
        rules =
          (rendered (evaluate {
            opencode.permissions = [
              {
                action = "shell";
                resource = "*";
                effect = "ask";
              }
              {
                action = "edit";
                resource = "docs/**";
                effect = "ask";
              }
              {
                action = "edit";
                resource = "secrets/**";
                effect = "deny";
              }
              {
                action = "edit";
                resource = ".limitless/repos/**";
                effect = "allow";
              }
              {
                action = "t3-code-*";
                resource = "*";
                effect = "allow";
              }
            ];
          })).permissions;
        denied =
          (rendered (evaluate {
            opencode.permissions = [
              {
                action = "edit";
                resource = "*";
                effect = "deny";
              }
            ];
          })).permissions;
      in
      effectFor rules "edit" "src/a.ts" == "allow"
      && effectFor rules "shell" "bun test" == "ask"
      && effectFor rules "edit" "docs/a.md" == "ask"
      && effectFor rules "edit" "secrets/key" == "deny"
      && effectFor rules "edit" ".limitless/repos/owner/file.ts" == "deny"
      && effectFor rules "t3-code-thread_tool" "*" == "deny"
      && effectFor denied "edit" "src/a.ts" == "deny"
    ) "Caller permissions must override default edit access without overriding managed denials";
    assert lib.assertMsg
      (
        lib.all
          (
            name:
            customXdg.config.home.file."/home/test/preferences/opencode/${name}"
            == customXdg.config.xdg.configFile."opencode/${name}"
          )
          [
            "opencode.json"
            "AGENTS.md"
            "agents"
            "skills"
            "plugins/limitless-cache-status"
          ]
        && !(customXdg.config.home.file ? ".config/opencode/opencode.json")
      )
      "OpenCode configuration, instructions, agents, skills, and TUI plugins must follow XDG_CONFIG_HOME";
    assert lib.assertMsg (
      if pkgs.stdenv.hostPlatform.isLinux then
        valid supervised
        &&
          serviceUnit.Unit.X-Restart-Triggers
          == map (name: supervised.config.xdg.configFile."opencode/${name}".source) [
            "opencode.json"
            "AGENTS.md"
            "agents"
            "skills"
          ]
        &&
          supervisedWithoutSkills.config.systemd.user.services.opencode.Unit.X-Restart-Triggers
          == map (name: supervisedWithoutSkills.config.xdg.configFile."opencode/${name}".source) [
            "opencode.json"
            "AGENTS.md"
            "agents"
          ]
        && builtins.elem "XDG_CONFIG_HOME=/home/test/preferences" customXdg.config.systemd.user.services.opencode.Service.Environment
        &&
          builtins.elem customXdg.config.xdg.configFile."opencode/opencode.json".source
            customXdg.config.systemd.user.services.opencode.Unit.X-Restart-Triggers
        && serviceUnit.Service.Type == "exec"
        && serviceUnit.Service.Restart == "always"
        && !valid (evaluateWith { opencode.service.enable = true; } [ { systemd.user.enable = false; } ])
      else
        !valid supervised
    ) "Supervision must enforce its platform, follow XDG paths, and restart for every managed input";
    assert lib.assertMsg (
      !pkgs.stdenv.hostPlatform.isLinux
      || (!(serviceUnit.Service ? ExecStartPre) && executorServiceUnit.Service ? ExecStartPre)
    ) "Only Executor clients wait for the Executor host before starting OpenCode";
    assert lib.assertMsg (
      !pkgs.stdenv.hostPlatform.isLinux
      || lib.any (lib.hasPrefix "PATH=/run/wrappers/bin:") serviceUnit.Service.Environment
    ) "Agent shells must find NixOS setuid wrappers such as sudo before unwrapped binaries";
    pkgs.runCommand "limitless-service-check" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
      cp ${../packages/opencode-service.mjs} opencode-service.mjs
      cp ${../packages/opencode-service.test.mjs} opencode-service.test.mjs
      node --test opencode-service.test.mjs
      ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
        test -x ${serviceUnit.Service.ExecStart}
        grep -F ${lib.escapeShellArg (launcherOf supervised)} ${serviceUnit.Service.ExecStart}
        grep -F '127.0.0.1 4096' ${serviceUnit.Service.ExecStart}
        test -x ${executorServiceUnit.Service.ExecStartPre}
        grep -F 'https://athena.example.ts.net:9443/mcp' ${executorServiceUnit.Service.ExecStartPre}
      ''}
      touch "$out"
    '';
}
