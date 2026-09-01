{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.limitless;
  jsonFormat = pkgs.formats.json { };
  inherit (pkgs.stdenv.hostPlatform) system;

  agentsText =
    builtins.readFile "${self}/opencode/AGENTS.md"
    + lib.optionalString (cfg.opencode.extraAgentsFile != null) (
      "\n\n" + builtins.readFile cfg.opencode.extraAgentsFile
    );

  opencodeDir = ".config/opencode";
  skillsDirectory = "${opencodeDir}/skills";

  enabledSkills = cfg.enable && cfg.skills.enable;
  enabledLsp = cfg.enable && cfg.lsp.enable;
  enabledLinear = cfg.enable && cfg.mcp.linear.enable;
  enabledOpencodeService = cfg.enable && cfg.opencode.service.enable;
  enabledAnthropicAuth = cfg.enable && cfg.plugins.anthropicAuth.enable;
  enabledSlack = cfg.enable && cfg.slack.enable;

  opencodePackage =
    if cfg.opencode.disableClaudeCode then
      pkgs.symlinkJoin {
        name = "opencode2-disable-claude-code";
        paths = [ cfg.opencode.package ];
        nativeBuildInputs = [ pkgs.makeWrapper ];
        postBuild = ''
          wrapProgram $out/bin/opencode2 --set OPENCODE_DISABLE_CLAUDE_CODE 1
        '';
      }
    else
      cfg.opencode.package;

  opencodeAttachCommand = "${opencodePackage}/bin/opencode2 \"$PWD\"";
  slackRepository = if cfg.slack.repository == null then "/" else cfg.slack.repository;
  slackPrepare = pkgs.writeShellScript "limitless-slack-prepare" ''
    set -eu
    : "''${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required}"
    ${pkgs.coreutils}/bin/rm -f "$XDG_RUNTIME_DIR/limitless-slack-ready"
  '';
  slackBootstrap = pkgs.writeShellScript "limitless-slack-bootstrap" ''
    set -eu
    : "''${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required}"
    ready_file="$XDG_RUNTIME_DIR/limitless-slack-ready"

    until ${opencodePackage}/bin/opencode2 api plugin.list \
      --param ${lib.escapeShellArg "location.directory=${slackRepository}"} >/dev/null 2>&1; do
      ${pkgs.coreutils}/bin/sleep 0.1
    done

    while [ ! -s "$ready_file" ]; do
      ${pkgs.coreutils}/bin/sleep 0.1
    done
  '';

  permissionRule = action: resource: effect: { inherit action resource effect; };

  defaultAgentBrowserPackage = self.packages.${system}."agent-browser";
  defaultEffectSolutionsPackage = self.packages.${system}."effect-solutions";
  defaultNotionPackage = self.packages.${system}."notion-cli";
  defaultSentryPackage = self.packages.${system}.sentry;
  defaultAcliPackage = pkgs.acli;

  enabledAcli = cfg.enable && cfg.tools.acli.enable;
  enabledAgentBrowser = cfg.enable && cfg.tools.agentBrowser.enable;
  enabledEffectSolutions = cfg.enable && cfg.tools.effectSolutions.enable;
  enabledNotion = cfg.enable && cfg.tools.notion.enable;
  enabledSentry = cfg.enable && cfg.tools.sentry.enable;
  enabledAcliSkill = enabledSkills && enabledAcli;
  enabledAgentBrowserSkill = enabledSkills && enabledAgentBrowser;
  enabledEffectSolutionsSkill = enabledSkills && enabledEffectSolutions;
  enabledNotionSkill = enabledSkills && enabledNotion;
  enabledSentrySkill = enabledSkills && enabledSentry;

  acliSkillPackage = pkgs.runCommand "limitless-atlassian-cli-skill" { } ''
    mkdir -p $out/atlassian-cli
    cp ${self}/nix/skills/atlassian-cli/SKILL.md $out/atlassian-cli/SKILL.md
  '';

  acliPackage =
    if cfg.tools.acli.tokenFile == null then
      cfg.tools.acli.package
    else
      let
        realAcli = lib.getExe cfg.tools.acli.package;
        site = lib.escapeShellArg (if cfg.tools.acli.site == null then "" else cfg.tools.acli.site);
        email = lib.escapeShellArg (if cfg.tools.acli.email == null then "" else cfg.tools.acli.email);
        tokenFile = lib.escapeShellArg cfg.tools.acli.tokenFile;
      in
      pkgs.writeShellScriptBin "acli" ''
        set -eu

        real_acli=${lib.escapeShellArg realAcli}
        site=${site}
        email=${email}
        token_file=${tokenFile}

        if [ "''${1:-}" = "jira" ]; then
          if [ -z "''${XDG_RUNTIME_DIR:-}" ]; then
            printf '%s\n' "acli: XDG_RUNTIME_DIR is required for token-file authentication" >&2
            exit 1
          fi

          runtime_dir="$XDG_RUNTIME_DIR/limitless-acli"
          ${pkgs.coreutils}/bin/install -d -m 0700 "$runtime_dir" "$runtime_dir/config"
          export ACLI_CONFIG_DIR="$runtime_dir/config"

          if [ "''${2:-}" = "auth" ] && [ "''${3:-}" = "logout" ]; then
            set +e
            "$real_acli" "$@"
            status=$?
            set -e
            ${pkgs.coreutils}/bin/rm -f "$runtime_dir/identity"
            exit "$status"
          fi

          if [ "''${2:-}" = "auth" ] && [ "''${3:-}" = "login" ]; then
            exec -a acli "$real_acli" "$@"
          fi

          (
            ${pkgs.util-linux}/bin/flock -x 9

            if [ ! -r "$token_file" ]; then
              printf 'acli: Jira API token file is not readable: %s\n' "$token_file" >&2
              exit 1
            fi

            fingerprint="$({
              printf '%s\0%s\0' "$site" "$email"
              ${pkgs.coreutils}/bin/cat "$token_file"
            } | ${pkgs.coreutils}/bin/sha256sum | ${pkgs.coreutils}/bin/cut -d ' ' -f 1)"

            current_fingerprint=""
            if [ -r "$runtime_dir/identity" ]; then
              current_fingerprint="$(${pkgs.coreutils}/bin/cat "$runtime_dir/identity")"
            fi

            if [ "$fingerprint" != "$current_fingerprint" ]; then
              if ! "$real_acli" jira auth login \
                --site "$site" \
                --email "$email" \
                --token < "$token_file" 1>&2; then
                printf '%s\n' "acli: Jira authentication failed; verify the site, email, and agenix token" >&2
                exit 1
              fi

              identity_tmp="$runtime_dir/.identity.$$"
              umask 077
              printf '%s\n' "$fingerprint" > "$identity_tmp"
              ${pkgs.coreutils}/bin/mv "$identity_tmp" "$runtime_dir/identity"
            fi
          ) 9> "$runtime_dir/auth.lock"
        fi

        exec -a acli "$real_acli" "$@"
      '';

  sentryPackage =
    if cfg.tools.sentry.tokenFile == null then
      cfg.tools.sentry.package
    else
      let
        realSentry = lib.getExe cfg.tools.sentry.package;
        tokenFile = lib.escapeShellArg cfg.tools.sentry.tokenFile;
      in
      pkgs.writeShellScriptBin "sentry" ''
        set -eu

        real_sentry=${lib.escapeShellArg realSentry}
        token_file=${tokenFile}

        if [ ! -r "$token_file" ]; then
          printf 'sentry: Sentry API token file is not readable: %s\n' "$token_file" >&2
          exit 1
        fi

        SENTRY_AUTH_TOKEN="$(${pkgs.coreutils}/bin/cat "$token_file")"
        if [ -z "$SENTRY_AUTH_TOKEN" ]; then
          printf 'sentry: Sentry API token file is empty: %s\n' "$token_file" >&2
          exit 1
        fi

        export SENTRY_AUTH_TOKEN
        export SENTRY_FORCE_ENV_TOKEN=1
        export SENTRY_CLI_NO_UPDATE_CHECK=1

        exec -a sentry "$real_sentry" "$@"
      '';

  validNotionAccountName = name: builtins.match "^[A-Za-z0-9][A-Za-z0-9_-]*$" name != null;
  notionAccounts = cfg.tools.notion.accounts;
  validNotionAccounts = lib.filterAttrs (name: _account: validNotionAccountName name) notionAccounts;
  notionAccountNames = builtins.attrNames notionAccounts;
  validNotionAccountNames = builtins.attrNames validNotionAccounts;
  notionHasAccounts = notionAccounts != { };
  notionHasValidDefault =
    cfg.tools.notion.defaultAccount != null
    && builtins.hasAttr cfg.tools.notion.defaultAccount validNotionAccounts;

  mkNotionTokenPackage =
    commandName: tokenFile:
    let
      realNotion = lib.getExe cfg.tools.notion.package;
    in
    pkgs.writeShellScriptBin commandName ''
      set -eu

      command_name=${lib.escapeShellArg commandName}
      real_notion=${lib.escapeShellArg realNotion}
      token_file=${lib.escapeShellArg tokenFile}
      if [ ! -r "$token_file" ]; then
        printf '%s: Notion API token file is not readable: %s\n' "$command_name" "$token_file" >&2
        exit 1
      fi

      NOTION_API_TOKEN="$(${pkgs.coreutils}/bin/cat "$token_file")"
      if [ -z "$NOTION_API_TOKEN" ]; then
        printf '%s: Notion API token file is empty: %s\n' "$command_name" "$token_file" >&2
        exit 1
      fi

      export NOTION_API_TOKEN
      exec -a "$command_name" "$real_notion" "$@"
    '';

  notionSinglePackage =
    if cfg.tools.notion.tokenFile == null then
      cfg.tools.notion.package
    else
      mkNotionTokenPackage "ntn" cfg.tools.notion.tokenFile;

  notionNamedPackages = lib.mapAttrsToList (
    accountName: account: mkNotionTokenPackage "ntn-${accountName}" account.tokenFile
  ) validNotionAccounts;

  notionDefaultPackages = lib.optional notionHasValidDefault (
    mkNotionTokenPackage "ntn" validNotionAccounts.${cfg.tools.notion.defaultAccount}.tokenFile
  );

  notionPackages =
    if notionHasAccounts then notionDefaultPackages ++ notionNamedPackages else [ notionSinglePackage ];

  enabledSkillsPackage = pkgs.runCommand "limitless-enabled-skills" { } ''
    copySkills() {
      if [ -d "$1" ]; then
        cp -r "$1"/. $out/
        chmod -R u+w $out
      fi
    }

    mkdir -p $out
    copySkills ${cfg.skills.package}
    ${lib.optionalString enabledAcliSkill "copySkills ${acliSkillPackage}"}
    ${lib.optionalString enabledAgentBrowserSkill "copySkills ${cfg.tools.agentBrowser.package}/share/skills"}
    ${lib.optionalString enabledEffectSolutionsSkill "copySkills ${cfg.tools.effectSolutions.package}/share/skills"}
    ${lib.optionalString enabledNotionSkill "copySkills ${cfg.tools.notion.package}/share/skills"}
    ${lib.optionalString enabledSentrySkill "copySkills ${cfg.tools.sentry.package}/share/skills"}
  '';

  mkLspServer =
    name: server:
    lib.optionalAttrs server.enable {
      ${name} = {
        command = [ server.command ] ++ server.args;
        inherit (server) extensions;
      }
      // lib.optionalAttrs (server.env != { }) {
        inherit (server) env;
      };
    };

  lspServers = lib.foldl' lib.recursiveUpdate { } [
    (mkLspServer "biome" cfg.lsp.servers.biome)
    (mkLspServer "json" cfg.lsp.servers.json)
    (mkLspServer "marksman" cfg.lsp.servers.marksman)
    (mkLspServer "nixd" cfg.lsp.servers.nixd)
    (mkLspServer "taplo" cfg.lsp.servers.taplo)
    (mkLspServer "typescript" cfg.lsp.servers.typescript)
    (mkLspServer "yaml" cfg.lsp.servers.yaml)
    cfg.lsp.extraServers
  ];

  baseOpencodeConfig = builtins.fromJSON (builtins.readFile "${self}/opencode/opencode.json");

  repositoryPermissionRules = baseOpencodeConfig.permissions;

  limitlessPluginOptions = {
    github = {
      inherit (cfg.github)
        enable
        tokenEnv
        allowedRepos
        allowUnrestrictedRepos
        ;
    }
    // lib.optionalAttrs (cfg.github.tokenFile != null) {
      inherit (cfg.github) tokenFile;
    };
    notifications = {
      inherit (cfg.notifications)
        enable
        includeChildSessions
        timeoutMs
        ;
      events = {
        inherit (cfg.notifications.events) complete permission question;
      };
    }
    // lib.optionalAttrs (cfg.notifications.command != [ ]) {
      inherit (cfg.notifications) command;
    };
    lsp = lib.optionalAttrs enabledLsp lspServers;
    providers = {
      inherit (cfg.providers) disabled;
    };
    slack = {
      inherit (cfg.slack)
        enable
        agent
        botTokenEnv
        appTokenEnv
        ;
    }
    // lib.optionalAttrs (cfg.slack.repository != null) {
      inherit (cfg.slack) repository;
    };
  };

  limitlessPlugin = {
    package = "file://${cfg.plugins.limitless.package}/limitless.js";
    options = limitlessPluginOptions;
  };

  anthropicAuthPlugin = {
    package = "file://${cfg.plugins.anthropicAuth.package}/anthropic-auth.js";
  };

  managedPlugins = lib.optional enabledAnthropicAuth anthropicAuthPlugin ++ [ limitlessPlugin ];

  defaultOpencodeConfig = lib.recursiveUpdate (removeAttrs baseOpencodeConfig [ "permissions" ]) (
    {
      permissions = cfg.opencode.permissions ++ repositoryPermissionRules;
      plugins = managedPlugins;
    }
    // lib.optionalAttrs enabledLsp {
      lsp = lspServers;
    }
    // lib.optionalAttrs enabledLinear {
      mcp.servers.linear = {
        type = "remote";
        url = "https://mcp.linear.app/mcp";
        disabled = false;
        headers.Authorization = "Bearer {env:LINEAR_API_KEY}";
        oauth = false;
      };
    }
  );

  opencodeConfig = lib.recursiveUpdate defaultOpencodeConfig cfg.opencode.settings // {
    default_agent = "limitless";
    permissions = cfg.opencode.permissions ++ repositoryPermissionRules;
    plugins = (cfg.opencode.settings.plugins or [ ]) ++ managedPlugins;
  };
  opencodeConfigText = builtins.toJSON opencodeConfig;
  opencodeConfigRestartTrigger = pkgs.writeText "limitless-opencode.json" opencodeConfigText;
  agentsRestartTrigger = pkgs.writeText "limitless-AGENTS.md" agentsText;

  lspPackages =
    lib.optional cfg.lsp.servers.biome.enable cfg.lsp.servers.biome.package
    ++ lib.optional cfg.lsp.servers.json.enable cfg.lsp.servers.json.package
    ++ lib.optional cfg.lsp.servers.marksman.enable cfg.lsp.servers.marksman.package
    ++ lib.optional cfg.lsp.servers.nixd.enable cfg.lsp.servers.nixd.package
    ++ lib.optional cfg.lsp.servers.taplo.enable cfg.lsp.servers.taplo.package
    ++ lib.optionals cfg.lsp.servers.typescript.enable [
      cfg.lsp.servers.typescript.package
      pkgs.typescript
    ]
    ++ lib.optional cfg.lsp.servers.yaml.enable cfg.lsp.servers.yaml.package
    ++ cfg.lsp.extraPackages;
in
{
  options.programs.limitless = {
    enable = lib.mkEnableOption "the Limitless OpenCode suite";

    git.ignoreStorage = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Add .limitless/ to Git's global ignore file through Home Manager.";
    };

    opencode = {
      package = lib.mkOption {
        type = lib.types.package;
        default = self.packages.${system}.opencode2;
        description = "OpenCode 2.0 beta package to install. Defaults to the runtime pinned by this flake.";
      };

      disableClaudeCode = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Disable OpenCode's Claude Code integration by setting OPENCODE_DISABLE_CLAUDE_CODE=1 for the CLI and server.";
      };

      permissions = lib.mkOption {
        inherit (jsonFormat) type;
        default = [
          (permissionRule "*" "*" "allow")
        ]
        ++ map (resource: permissionRule "read" resource "ask") [
          "~/.ssh/**"
          "$HOME/.ssh/**"
          "~/.aws/**"
          "$HOME/.aws/**"
          "~/.gnupg/**"
          "$HOME/.gnupg/**"
          "~/.config/gh/hosts.yml"
          "$HOME/.config/gh/hosts.yml"
        ]
        ++ map (resource: permissionRule "shell" resource "ask") [
          "git reset*"
          "git clean*"
          "git checkout -- *"
          "git restore *"
          "git rebase*"
          "git push --force*"
          "git push -f*"
          "git branch -D *"
          "rm -rf *"
          "rm -fr *"
          "trash *"
          "shred *"
          "dd *"
          "mkfs*"
          "fdisk*"
          "parted*"
          "wipefs*"
          "sudo *"
          "su *"
          "doas *"
          "chmod -R *"
          "chown -R *"
          "curl * | sh*"
          "curl * | bash*"
          "wget * | sh*"
          "wget * | bash*"
          "npm publish*"
          "bun publish*"
          "pnpm publish*"
          "yarn publish*"
          "docker push*"
          "kubectl delete*"
          "kubectl apply*"
          "terraform apply*"
          "terraform destroy*"
        ];
        description = "Ordered native OpenCode 2 permission rules; repository edit denials are appended after these rules.";
      };

      settings = lib.mkOption {
        type = lib.types.attrsOf jsonFormat.type;
        default = { };
        description = "Additional native OpenCode 2 settings deep-merged over generated defaults.";
      };

      extraAgentsFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        example = lib.literalExpression "./AGENTS.local.md";
        description = "Optional additional AGENTS.md content appended after the packaged instructions.";
      };

      service = {
        enable = lib.mkEnableOption "a persistent OpenCode server with an attaching shell alias";

        hostname = lib.mkOption {
          type = lib.types.str;
          default = "127.0.0.1";
          description = "Hostname for the OpenCode server to bind.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 4096;
          description = "Port for the OpenCode server to listen on.";
        };

        alias = lib.mkOption {
          type = lib.types.str;
          default = "oc";
          description = "Shell alias that attaches to the OpenCode server using the current directory.";
        };
      };
    };

    skills = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Whether to install packaged agent skills.";
      };

      package = lib.mkOption {
        type = lib.types.package;
        default = self.packages.${system}.skills;
        description = "Package containing skill directories.";
      };

    };

    tools = {
      acli = {
        enable = lib.mkEnableOption "Atlassian CLI and its companion Jira skill";

        package = lib.mkOption {
          type = lib.types.package;
          default = defaultAcliPackage;
          defaultText = lib.literalExpression "pkgs.acli";
          description = "Atlassian CLI package to install.";
        };

        site = lib.mkOption {
          type = lib.types.nullOr (lib.types.strMatching "^[A-Za-z0-9.-]+$");
          default = null;
          example = "company.atlassian.net";
          description = "Jira Cloud hostname used for token-file authentication.";
        };

        email = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = "agent@example.com";
          description = "Atlassian account email used for token-file authentication.";
        };

        tokenFile = lib.mkOption {
          type = lib.types.nullOr (lib.types.strMatching "^/.*");
          default = null;
          example = "/run/agenix/atlassian-api-token";
          description = "Optional runtime file containing an Atlassian API token. The token value is never written to generated configuration or passed in process arguments.";
        };
      };

      agentBrowser = {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = cfg.skills.enable;
          defaultText = lib.literalExpression "config.programs.limitless.skills.enable";
          description = "Whether to install agent-browser and its companion skill when skill installation is enabled.";
        };

        package = lib.mkOption {
          type = lib.types.package;
          default = defaultAgentBrowserPackage;
          description = "agent-browser package to install.";
        };
      };

      effectSolutions = {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = cfg.skills.enable;
          defaultText = lib.literalExpression "config.programs.limitless.skills.enable";
          description = "Whether to install effect-solutions and its TypeScript Effect companion skill when skill installation is enabled.";
        };

        package = lib.mkOption {
          type = lib.types.package;
          default = defaultEffectSolutionsPackage;
          description = "effect-solutions package to install.";
        };
      };

      notion = {
        enable = lib.mkEnableOption "official Notion CLI and its companion skill";

        package = lib.mkOption {
          type = lib.types.package;
          default = defaultNotionPackage;
          description = "Notion CLI package to install.";
        };

        tokenFile = lib.mkOption {
          type = lib.types.nullOr (lib.types.strMatching "^/.*");
          default = null;
          example = "/run/agenix/notion-api-token";
          description = "Optional runtime file containing a single Notion API token. Mutually exclusive with accounts. The token value is never written to generated configuration or passed in process arguments.";
        };

        accounts = lib.mkOption {
          type = lib.types.attrsOf (
            lib.types.submodule {
              options.tokenFile = lib.mkOption {
                type = lib.types.strMatching "^/.*";
                example = "/run/agenix/notion-work-api-token";
                description = "Runtime file containing this Notion account's API token.";
              };
            }
          );
          default = { };
          example = lib.literalExpression ''
            {
              work.tokenFile = config.age.secrets.notion-work.path;
              personal.tokenFile = config.age.secrets.notion-personal.path;
            }
          '';
          description = "Named Notion accounts installed as ntn-<name> commands. Account names may contain letters, numbers, underscores, and hyphens.";
        };

        defaultAccount = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = "work";
          description = "Named account exposed through the unqualified ntn command. Required when accounts is non-empty.";
        };
      };

      sentry = {
        enable = lib.mkEnableOption "Sentry CLI and its companion agent skill";

        package = lib.mkOption {
          type = lib.types.package;
          default = defaultSentryPackage;
          description = "Sentry CLI package to install.";
        };

        tokenFile = lib.mkOption {
          type = lib.types.nullOr (lib.types.strMatching "^/.*");
          default = null;
          example = "/run/agenix/sentry-api-token";
          description = "Runtime file containing a Sentry API token. The token value is never written to generated configuration or passed in process arguments.";
        };
      };
    };

    agents = {
      package = lib.mkOption {
        type = lib.types.package;
        default = self.packages.${system}."opencode-agents";
        description = "Package containing OpenCode agent files.";
      };
    };

    plugins = {
      anthropicAuth = {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Enable the commit-pinned upstream Claude Pro/Max OAuth plugin. Anthropic does not officially support this use.";
        };

        package = lib.mkOption {
          type = lib.types.package;
          default = self.packages.${system}."anthropic-auth";
          description = "Package containing the upstream Anthropic OAuth plugin.";
        };
      };

      limitless = {
        package = lib.mkOption {
          type = lib.types.package;
          default = self.packages.${system}.limitless;
          description = "Package containing the Limitless OpenCode plugin.";
        };
      };
    };

    github = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Enable project-local managed GitHub clones for source research.";
      };

      tokenEnv = lib.mkOption {
        type = lib.types.str;
        default = "GITHUB_TOKEN";
        description = "Environment variable read by OpenCode for GitHub clone authentication when tokenFile is unset.";
      };

      tokenFile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "/run/agenix/github-token";
        description = "Optional runtime file containing a GitHub token. The token value is never written to generated configuration.";
      };

      allowedRepos = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [
          "owner/repo"
          "org/service"
        ];
        description = "Optional repository allowlist for managed clones and every transitive submodule.";
      };

      allowUnrestrictedRepos = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Allow managed clones to access any GitHub repository visible to the configured token when allowedRepos is empty.";
      };
    };

    providers.disabled = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "google-vertex"
        "google-vertex-anthropic"
      ];
      description = "Provider IDs that the Limitless plugin removes from OpenCode's available catalog. Vertex defaults to disabled so ambient Google ADC cannot make it selectable.";
    };

    notifications = {
      enable = lib.mkEnableOption "running a system command on OpenCode completion, permission, and question events";

      command = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [
          "notify-send"
          "OpenCode needs attention"
        ];
        description = ''
          Command argv executed by the Limitless OpenCode plugin for enabled notification events.
          The first element is executed directly without a shell and the remaining elements are
          passed as arguments.
        '';
      };

      timeoutMs = lib.mkOption {
        type = lib.types.ints.positive;
        default = 5000;
        description = "Maximum time in milliseconds to wait for the notification command.";
      };

      includeChildSessions = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Whether completion notifications should also fire for child/subagent sessions.";
      };

      events = {
        complete = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Run the notification command when a top-level OpenCode session execution terminates.";
        };

        permission = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Run the notification command when OpenCode requests permission.";
        };

        question = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Run the notification command before the OpenCode question tool prompts the user.";
        };
      };
    };

    slack = {
      enable = lib.mkEnableOption "the repository-scoped Slack bridge for OpenCode 2";

      repository = lib.mkOption {
        type = lib.types.nullOr (lib.types.strMatching "^/.*");
        default = null;
        example = "/home/me/workspace";
        description = "Absolute repository directory used for every Slack-backed OpenCode session.";
      };

      agent = lib.mkOption {
        type = lib.types.strMatching ".+";
        default = "gary";
        description = "OpenCode agent selected for Slack-backed turns.";
      };

      botTokenEnv = lib.mkOption {
        type = lib.types.strMatching "^[A-Za-z_][A-Za-z0-9_]*$";
        default = "SLACK_BOT_TOKEN";
        description = "Environment variable containing the Slack bot token.";
      };

      appTokenEnv = lib.mkOption {
        type = lib.types.strMatching "^[A-Za-z_][A-Za-z0-9_]*$";
        default = "SLACK_APP_TOKEN";
        description = "Environment variable containing the Slack Socket Mode app token.";
      };

      environmentFile = lib.mkOption {
        type = lib.types.nullOr (lib.types.strMatching "^/.*");
        default = null;
        example = "/run/agenix/limitless-slack-environment";
        description = "Optional runtime EnvironmentFile that supplies Slack tokens to the OpenCode user service without copying values into the Nix store.";
      };
    };

    lsp = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Whether to install and configure default OpenCode language servers.";
      };

      extraServers = lib.mkOption {
        type = lib.types.attrsOf jsonFormat.type;
        default = { };
        description = "Additional OpenCode LSP server configuration merged with defaults.";
      };

      extraPackages = lib.mkOption {
        type = lib.types.listOf lib.types.package;
        default = [ ];
        description = "Additional packages installed when LSP support is enabled.";
      };

      servers = {
        biome = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable Biome LSP.";
          };
          package = lib.mkOption {
            type = lib.types.package;
            default = pkgs.biome;
            description = "Biome package.";
          };
          command = lib.mkOption {
            type = lib.types.str;
            default = "${cfg.lsp.servers.biome.package}/bin/biome";
            description = "Biome LSP command.";
          };
          args = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ "lsp-proxy" ];
            description = "Biome LSP arguments.";
          };
          extensions = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [
              ".js"
              ".jsx"
              ".mjs"
              ".cjs"
              ".ts"
              ".tsx"
              ".mts"
              ".cts"
              ".json"
              ".jsonc"
            ];
            description = "File extensions handled by Biome LSP.";
          };
          env = lib.mkOption {
            type = lib.types.attrsOf lib.types.str;
            default = { };
            description = "Biome LSP environment.";
          };
        };

        json = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable JSON LSP.";
          };
          package = lib.mkOption {
            type = lib.types.package;
            default = pkgs.vscode-langservers-extracted;
            description = "JSON LSP package.";
          };
          command = lib.mkOption {
            type = lib.types.str;
            default = "${cfg.lsp.servers.json.package}/bin/vscode-json-language-server";
            description = "JSON LSP command.";
          };
          args = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ "--stdio" ];
            description = "JSON LSP arguments.";
          };
          extensions = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [
              ".json"
              ".jsonc"
            ];
            description = "File extensions handled by JSON LSP.";
          };
          env = lib.mkOption {
            type = lib.types.attrsOf lib.types.str;
            default = { };
            description = "JSON LSP environment.";
          };
        };

        marksman = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable Marksman Markdown LSP.";
          };
          package = lib.mkOption {
            type = lib.types.package;
            default = pkgs.marksman;
            description = "Marksman package.";
          };
          command = lib.mkOption {
            type = lib.types.str;
            default = "${cfg.lsp.servers.marksman.package}/bin/marksman";
            description = "Marksman LSP command.";
          };
          args = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ "server" ];
            description = "Marksman LSP arguments.";
          };
          extensions = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [
              ".md"
              ".markdown"
            ];
            description = "File extensions handled by Marksman.";
          };
          env = lib.mkOption {
            type = lib.types.attrsOf lib.types.str;
            default = { };
            description = "Marksman LSP environment.";
          };
        };

        nixd = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable nixd LSP.";
          };
          package = lib.mkOption {
            type = lib.types.package;
            default = pkgs.nixd;
            description = "nixd package.";
          };
          command = lib.mkOption {
            type = lib.types.str;
            default = "${cfg.lsp.servers.nixd.package}/bin/nixd";
            description = "nixd LSP command.";
          };
          args = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ];
            description = "nixd LSP arguments.";
          };
          extensions = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ".nix" ];
            description = "File extensions handled by nixd.";
          };
          env = lib.mkOption {
            type = lib.types.attrsOf lib.types.str;
            default = { };
            description = "nixd LSP environment.";
          };
        };

        taplo = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable Taplo TOML LSP.";
          };
          package = lib.mkOption {
            type = lib.types.package;
            default = pkgs.taplo;
            description = "Taplo package.";
          };
          command = lib.mkOption {
            type = lib.types.str;
            default = "${cfg.lsp.servers.taplo.package}/bin/taplo";
            description = "Taplo LSP command.";
          };
          args = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [
              "lsp"
              "stdio"
            ];
            description = "Taplo LSP arguments.";
          };
          extensions = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ".toml" ];
            description = "File extensions handled by Taplo.";
          };
          env = lib.mkOption {
            type = lib.types.attrsOf lib.types.str;
            default = { };
            description = "Taplo LSP environment.";
          };
        };

        typescript = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable TypeScript LSP.";
          };
          package = lib.mkOption {
            type = lib.types.package;
            default = pkgs.typescript-language-server;
            description = "TypeScript language server package.";
          };
          command = lib.mkOption {
            type = lib.types.str;
            default = "${cfg.lsp.servers.typescript.package}/bin/typescript-language-server";
            description = "TypeScript LSP command.";
          };
          args = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ "--stdio" ];
            description = "TypeScript LSP arguments.";
          };
          extensions = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [
              ".ts"
              ".tsx"
              ".mts"
              ".cts"
              ".js"
              ".jsx"
              ".mjs"
              ".cjs"
            ];
            description = "File extensions handled by TypeScript LSP.";
          };
          env = lib.mkOption {
            type = lib.types.attrsOf lib.types.str;
            default.TYPESCRIPT_TS_SERVER_PATH = "${pkgs.typescript}/lib/node_modules/typescript/lib/tsserver.js";
            description = "TypeScript LSP environment.";
          };
        };

        yaml = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable YAML LSP.";
          };
          package = lib.mkOption {
            type = lib.types.package;
            default = pkgs.vscode-langservers-extracted;
            description = "YAML LSP package.";
          };
          command = lib.mkOption {
            type = lib.types.str;
            default = "${cfg.lsp.servers.yaml.package}/bin/vscode-yaml-language-server";
            description = "YAML LSP command.";
          };
          args = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ "--stdio" ];
            description = "YAML LSP arguments.";
          };
          extensions = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [
              ".yaml"
              ".yml"
            ];
            description = "File extensions handled by YAML LSP.";
          };
          env = lib.mkOption {
            type = lib.types.attrsOf lib.types.str;
            default = { };
            description = "YAML LSP environment.";
          };
        };
      };
    };

    mcp.linear.enable = lib.mkEnableOption "Linear MCP server configuration for OpenCode 2";
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        assertions = [
          {
            assertion = !enabledOpencodeService || pkgs.stdenv.isLinux;
            message = "programs.limitless.opencode.service.enable currently requires Linux systemd user services.";
          }
          {
            assertion =
              !cfg.github.enable || cfg.github.allowedRepos != [ ] || cfg.github.allowUnrestrictedRepos;
            message = "programs.limitless.github.allowedRepos must be non-empty unless programs.limitless.github.allowUnrestrictedRepos is true.";
          }
          {
            assertion = !cfg.notifications.enable || cfg.notifications.command != [ ];
            message = "programs.limitless.notifications.command must be non-empty when notifications are enabled.";
          }
          {
            assertion = !enabledSlack || cfg.opencode.service.enable;
            message = "programs.limitless.slack.enable requires programs.limitless.opencode.service.enable.";
          }
          {
            assertion = !enabledSlack || cfg.slack.repository != null;
            message = "programs.limitless.slack.repository must be set when Slack support is enabled.";
          }
          {
            assertion = !enabledSlack || pkgs.stdenv.isLinux;
            message = "programs.limitless Slack service integration currently requires Linux.";
          }
          {
            assertion =
              cfg.tools.acli.tokenFile == null
              || (cfg.tools.acli.enable && cfg.tools.acli.site != null && cfg.tools.acli.email != null);
            message = "programs.limitless.tools.acli token-file authentication requires enable = true plus non-null site and email values.";
          }
          {
            assertion = cfg.tools.notion.tokenFile == null || enabledNotion;
            message = "programs.limitless.tools.notion.tokenFile requires programs.limitless.tools.notion.enable = true.";
          }
          {
            assertion = !notionHasAccounts || enabledNotion;
            message = "programs.limitless.tools.notion.accounts requires programs.limitless.tools.notion.enable = true.";
          }
          {
            assertion = cfg.tools.notion.tokenFile == null || !notionHasAccounts;
            message = "programs.limitless.tools.notion.tokenFile and programs.limitless.tools.notion.accounts are mutually exclusive.";
          }
          {
            assertion = notionAccountNames == validNotionAccountNames;
            message = "programs.limitless.tools.notion account names may contain only letters, numbers, underscores, and hyphens and must start with a letter or number.";
          }
          {
            assertion = notionHasAccounts || cfg.tools.notion.defaultAccount == null;
            message = "programs.limitless.tools.notion.defaultAccount requires a non-empty accounts set.";
          }
          {
            assertion = !notionHasAccounts || notionHasValidDefault;
            message = "programs.limitless.tools.notion.defaultAccount must name an entry in programs.limitless.tools.notion.accounts.";
          }
          {
            assertion = cfg.tools.acli.tokenFile == null || pkgs.stdenv.isLinux;
            message = "programs.limitless.tools.acli.tokenFile currently requires Linux and XDG_RUNTIME_DIR.";
          }
          {
            assertion = !enabledSentry || cfg.tools.sentry.tokenFile != null;
            message = "programs.limitless.tools.sentry.tokenFile must be set when Sentry CLI support is enabled.";
          }
          {
            assertion = lib.attrByPath [ "agents" "limitless" "disabled" ] false cfg.opencode.settings != true;
            message = "programs.limitless keeps the limitless default agent enabled; remove opencode.settings.agents.limitless.disabled.";
          }
        ];

        home = {
          packages = [ opencodePackage ];
          file = {
            "${opencodeDir}/opencode.json".text = opencodeConfigText;
            "${opencodeDir}/AGENTS.md".text = agentsText;
            "${opencodeDir}/agents" = {
              source = cfg.agents.package;
              recursive = true;
            };
          };
        };
      }
      (lib.mkIf enabledSkills {
        home.file."${skillsDirectory}" = {
          source = enabledSkillsPackage;
          recursive = true;
        };
      })
      (lib.mkIf cfg.git.ignoreStorage {
        programs.git = {
          enable = lib.mkDefault true;
          ignores = [ ".limitless/" ];
        };
      })
      (lib.mkIf enabledAgentBrowser {
        home.packages = [ cfg.tools.agentBrowser.package ];
      })
      (lib.mkIf enabledAcli {
        home.packages = [ acliPackage ];
      })
      (lib.mkIf enabledEffectSolutions {
        home.packages = [ cfg.tools.effectSolutions.package ];
      })
      (lib.mkIf enabledNotion {
        home.packages = notionPackages;
      })
      (lib.mkIf enabledSentry {
        home.packages = [ sentryPackage ];
      })
      (lib.mkIf enabledLsp {
        home.packages = lspPackages;
      })
      (lib.mkIf enabledOpencodeService {
        home.shellAliases.${cfg.opencode.service.alias} = lib.mkDefault opencodeAttachCommand;
      })
      (lib.mkIf (enabledOpencodeService && pkgs.stdenv.isLinux) {
        systemd.user.services.opencode2 = {
          Unit = {
            Description = "OpenCode 2 beta server";
            X-Restart-Triggers = [
              opencodeConfigRestartTrigger
              agentsRestartTrigger
              config.home.file."${opencodeDir}/agents".source
              cfg.plugins.limitless.package
            ]
            ++ lib.optional enabledAnthropicAuth cfg.plugins.anthropicAuth.package
            ++ lib.optional enabledSkills config.home.file."${skillsDirectory}".source;
          };

          Service = {
            Environment =
              lib.optional cfg.opencode.disableClaudeCode "OPENCODE_DISABLE_CLAUDE_CODE=1"
              ++ lib.optional enabledSlack "LIMITLESS_SLACK_SERVICE=1";
            ExecStart = "${opencodePackage}/bin/opencode2 serve --service --hostname ${cfg.opencode.service.hostname} --port ${toString cfg.opencode.service.port}";
            Restart = "on-failure";
            RestartSec = "5s";
          }
          // lib.optionalAttrs enabledSlack {
            WorkingDirectory = slackRepository;
            ExecStartPre = slackPrepare;
            ExecStartPost = slackBootstrap;
            TimeoutStartSec = "90s";
          }
          // lib.optionalAttrs (enabledSlack && cfg.slack.environmentFile != null) {
            EnvironmentFile = [ cfg.slack.environmentFile ];
          };

          Install.WantedBy = [ "default.target" ];
        };
      })
    ]
  );
}
