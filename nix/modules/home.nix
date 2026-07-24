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

  opencodeAttachCommand = "${cfg.opencode.package}/bin/opencode2 \"$PWD\"";

  permissionRule = action: resource: effect: { inherit action resource effect; };

  defaultAgentBrowserPackage = self.packages.${system}."agent-browser";
  defaultEffectSolutionsPackage = self.packages.${system}."effect-solutions";

  enabledAgentBrowser = cfg.enable && cfg.tools.agentBrowser.enable;
  enabledEffectSolutions = cfg.enable && cfg.tools.effectSolutions.enable;
  enabledAgentBrowserSkill = enabledSkills && enabledAgentBrowser;
  enabledEffectSolutionsSkill = enabledSkills && enabledEffectSolutions;

  enabledSkillsPackage = pkgs.runCommand "limitless-enabled-skills" { } ''
    copySkills() {
      if [ -d "$1" ]; then
        cp -r "$1"/. $out/
        chmod -R u+w $out
      fi
    }

    mkdir -p $out
    copySkills ${cfg.skills.package}
    ${lib.optionalString enabledAgentBrowserSkill "copySkills ${cfg.tools.agentBrowser.package}/share/skills"}
    ${lib.optionalString enabledEffectSolutionsSkill "copySkills ${cfg.tools.effectSolutions.package}/share/skills"}
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
        description = "OpenCode 2.0 beta package to install. Defaults to the pinned Numtide llm-agents.nix opencode2 package.";
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
          description = "Enable the reverse-engineered Claude Pro/Max OAuth plugin and native Anthropic provider adapter. Anthropic does not officially support this use.";
        };

        package = lib.mkOption {
          type = lib.types.package;
          default = self.packages.${system}."anthropic-auth";
          description = "Package containing the Anthropic OAuth plugin and provider adapter.";
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
            assertion = lib.attrByPath [ "agents" "limitless" "disabled" ] false cfg.opencode.settings != true;
            message = "programs.limitless keeps the limitless default agent enabled; remove opencode.settings.agents.limitless.disabled.";
          }
        ];

        home = {
          packages = [ cfg.opencode.package ];
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
      (lib.mkIf enabledEffectSolutions {
        home.packages = [ cfg.tools.effectSolutions.package ];
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
            ExecStart = "${cfg.opencode.package}/bin/opencode2 serve --service --hostname ${cfg.opencode.service.hostname} --port ${toString cfg.opencode.service.port}";
            Restart = "on-failure";
            RestartSec = "5s";
          };

          Install.WantedBy = [ "default.target" ];
        };
      })
    ]
  );
}
