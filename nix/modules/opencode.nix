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

  opencodePackage =
    if cfg.opencode.disableClaudeCode then
      pkgs.symlinkJoin {
        name = "opencode-disable-claude-code";
        paths = [ cfg.opencode.package ];
        nativeBuildInputs = [ pkgs.makeWrapper ];
        postBuild = ''
          wrapProgram $out/bin/opencode --set OPENCODE_DISABLE_CLAUDE_CODE 1
        '';
      }
    else
      cfg.opencode.package;

  pluginOptions = {
    agents = { inherit (cfg.agents) fastSubagents; };
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
    permissions = cfg.opencode.permissions ++ cfg._generated.mcpPermissions ++ baseConfig.permissions;
    plugins = (cfg.opencode.settings.plugins or [ ]) ++ managedPlugins;
    mcp = (mergedConfig.mcp or { }) // {
      servers = cfg._generated.mcpServers;
    };
    agents = (mergedConfig.agents or { }) // {
      research = (mergedConfig.agents.research or { }) // {
        permissions =
          (mergedConfig.agents.research.permissions or [ ]) ++ cfg._generated.researchMcpPermissions;
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
      extraAgentsFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        description = "Additional instructions appended to the packaged AGENTS.md.";
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
        description = "Ordered native permissions. MCP policies, managed-repository edit denials, and the browser denial are appended.";
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
      fastSubagents = lib.mkOption {
        type = lib.types.listOf lib.types.nonEmptyStr;
        default = [
          "oracle-solve"
          "research"
          "worker"
        ];
        description = "OpenAI subagents whose processing tier follows the root Limitless profile. An empty list disables tier overrides.";
      };
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
  };

  config = lib.mkIf cfg.enable {
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
