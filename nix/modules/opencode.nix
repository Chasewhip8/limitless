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
  opencodeDir = ".config/opencode";
  permissionRule = action: resource: effect: { inherit action resource effect; };

  wrapperArgs =
    lib.optionals cfg.opencode.disableClaudeCode [
      "--set"
      "OPENCODE_DISABLE_CLAUDE_CODE"
      "1"
    ]
    ++ lib.optionals (cfg.opencode.cliSettings != { }) [
      "--set-default"
      "OPENCODE_CLI_CONFIG_CONTENT"
      (builtins.toJSON cfg.opencode.cliSettings)
    ]
    ++
      lib.optionals
        (cfg.plugins.anthropicAuth.enable && cfg.plugins.anthropicAuth.claudeCodeVersion != null)
        [
          "--set-default"
          "ANTHROPIC_CLAUDE_CODE_VERSION"
          cfg.plugins.anthropicAuth.claudeCodeVersion
        ];
  opencodePackage =
    if wrapperArgs != [ ] then
      pkgs.symlinkJoin {
        name = "opencode-configured";
        paths = [ cfg.opencode.package ];
        nativeBuildInputs = [ pkgs.makeWrapper ];
        postBuild = ''
          wrapProgram "$out/bin/opencode" ${lib.escapeShellArgs wrapperArgs}
        '';
      }
    else
      cfg.opencode.package;

  pluginOptions = {
    github = {
      inherit (cfg.github)
        enable
        tokenEnv
        allowedRepos
        allowUnrestrictedRepos
        ;
    }
    // lib.optionalAttrs (cfg.github.tokenFile != null) { inherit (cfg.github) tokenFile; };
    lsp = cfg._generated.lsp;
    providers = { inherit (cfg.providers) disabled; };
  };
  managedPlugins =
    lib.optional cfg.plugins.anthropicAuth.enable {
      package = "file://${cfg.plugins.anthropicAuth.package}";
    }
    ++ [
      {
        package = "file://${cfg.plugins.limitless.package}";
        options = pluginOptions;
      }
    ];

  baseConfig = builtins.fromJSON (builtins.readFile "${self}/opencode/opencode.json");
  mergedConfig = lib.recursiveUpdate baseConfig cfg.opencode.settings;
  opencodeConfig = mergedConfig // {
    default_agent = "limitless";
    permissions = cfg.opencode.permissions ++ baseConfig.permissions;
    plugins = (cfg.opencode.settings.plugins or [ ]) ++ managedPlugins;
    mcp = (mergedConfig.mcp or { }) // {
      servers = cfg._generated.mcpServers;
    };
    agents = (mergedConfig.agents or { }) // {
      research = (mergedConfig.agents.research or { }) // {
        permissions =
          (mergedConfig.agents.research.permissions or [ ]) ++ cfg._generated.readOnlyMcpPermissions;
      };
    };
  };
in
{
  options.programs.limitless = {
    opencode = {
      package = lib.mkOption {
        type = lib.types.package;
        default = self.packages.${system}.opencode;
        description = "Pinned OpenCode V2 runtime.";
      };
      disableClaudeCode = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Launch OpenCode with OPENCODE_DISABLE_CLAUDE_CODE=1.";
      };
      settings = lib.mkOption {
        type = lib.types.attrsOf jsonFormat.type;
        default = { };
        description = "Native OpenCode V2 settings. Limitless enforces its default agent, managed plugins, and permission rules.";
      };
      cliSettings = lib.mkOption {
        type = lib.types.attrsOf jsonFormat.type;
        default = { };
        example = {
          attention = {
            sound = true;
            volume = 0.4;
          };
        };
        description = "Native OpenCode CLI settings supplied through OPENCODE_CLI_CONFIG_CONTENT. Override cli.json without managing that file. An explicit environment value replaces these settings. Sound is enabled by default.";
      };
      extraAgentsFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        description = "Additional instructions appended to the packaged AGENTS.md.";
      };
      permissions = lib.mkOption {
        inherit (jsonFormat) type;
        default = [
          (permissionRule "*" "*" "allow")
        ];
        description = "Ordered native permissions. Defaults to automatic approval for all tools. Managed-repository edit denials and the browser denial are appended; research receives read-only MCP rules.";
      };
    };

    skills = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Install the configured skill package.";
      };
      package = lib.mkOption {
        type = lib.types.package;
        default = self.packages.${system}.skills;
        description = "Package containing user-supplied skill directories.";
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
          description = "Enable the pinned Claude Pro/Max OAuth plugin. Anthropic does not officially support this use.";
        };
        claudeCodeVersion = lib.mkOption {
          type = lib.types.nullOr (
            lib.types.addCheck (lib.types.strMatching "(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)") (
              version: builtins.stringLength version <= 64
            )
          );
          default = null;
          example = "2.1.280";
          description = "Optional Claude Code compatibility version override for the OAuth plugin. Null uses the bundled version and permits automatic recovery from a newer Anthropic version requirement. A version sets ANTHROPIC_CLAUDE_CODE_VERSION and disables that recovery; an explicit environment value takes precedence. Restart the server after changing it.";
        };
        package = lib.mkOption {
          type = lib.types.package;
          default = self.packages.${system}."anthropic-auth";
          description = "Package containing the Anthropic OAuth plugin.";
        };
      };
      limitless.package = lib.mkOption {
        type = lib.types.package;
        default = self.packages.${system}.limitless;
        description = "Package containing the Limitless plugin.";
      };
    };

    github = {
      enable = lib.mkEnableOption "guarded project-local GitHub research checkouts";
      tokenEnv = lib.mkOption {
        type = lib.types.str;
        default = "GITHUB_TOKEN";
        description = "Environment variable used for Git authentication when tokenFile is unset.";
      };
      tokenFile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Runtime token file for Git authentication. Its contents never enter generated configuration.";
      };
      allowedRepos = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Repository allowlist enforced for clones and every transitive submodule.";
      };
      allowUnrestrictedRepos = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Allow any GitHub repository visible to the token when allowedRepos is empty.";
      };
    };

    providers.disabled = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "google-vertex"
        "google-vertex-anthropic"
      ];
      description = "Providers removed from the catalog. Vertex defaults to disabled to prevent ambient Google ADC selection.";
    };

    _generated.opencodePackage = lib.mkOption {
      type = lib.types.package;
      internal = true;
      readOnly = true;
      description = "Configured OpenCode executable with CLI settings and optional Claude Code integration disablement.";
    };
  };

  config = lib.mkIf cfg.enable {
    programs.limitless.opencode.cliSettings.attention.sound = lib.mkDefault true;
    programs.limitless._generated.opencodePackage = opencodePackage;
    assertions = [
      {
        assertion =
          !cfg.github.enable || cfg.github.allowedRepos != [ ] || cfg.github.allowUnrestrictedRepos;
        message = "programs.limitless.github.allowedRepos must be non-empty unless allowUnrestrictedRepos is true.";
      }
      {
        assertion = lib.attrByPath [ "agents" "limitless" "disabled" ] false cfg.opencode.settings != true;
        message = "programs.limitless keeps the limitless default agent enabled.";
      }
    ];
    home = {
      packages = [ opencodePackage ];
      shellAliases.oc = "opencode";
      file = {
        "${opencodeDir}/opencode.json".text = builtins.toJSON opencodeConfig;
        "${opencodeDir}/AGENTS.md".text =
          builtins.readFile "${self}/opencode/AGENTS.md"
          + lib.optionalString (cfg.opencode.extraAgentsFile != null) (
            "\n\n" + builtins.readFile cfg.opencode.extraAgentsFile
          );
        "${opencodeDir}/agents" = {
          source = cfg.agents.package;
          recursive = true;
        };
      }
      // lib.optionalAttrs cfg.skills.enable {
        "${opencodeDir}/skills" = {
          source = cfg.skills.package;
          recursive = true;
        };
      };
    };
  };
}
