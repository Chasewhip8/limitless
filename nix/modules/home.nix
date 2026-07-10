{ self, llm-agents }:
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
  opencodePluginDir = "${opencodeDir}/plugins";
  skillsDirectory = ".agents/skills";

  enabledSkills = cfg.enable && cfg.skills.enable;
  enabledLsp = cfg.enable && cfg.lsp.enable;
  enabledLinear = cfg.enable && cfg.mcp.linear.enable;
  enabledOpencodeService = cfg.enable && cfg.opencode.service.enable;

  opencodeServiceUrl = "http://${cfg.opencode.service.hostname}:${toString cfg.opencode.service.port}";
  opencodeAttachCommand = "${cfg.opencode.package}/bin/opencode attach ${opencodeServiceUrl} --dir \"$PWD\"";

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

  defaultOpencodeConfig = {
    "$schema" = "https://opencode.ai/config.json";
    inherit (cfg.opencode) permission;
    default_agent = "limitless";
  }
  // lib.optionalAttrs enabledLsp {
    lsp = lspServers;
  };

  opencodeConfig = lib.recursiveUpdate defaultOpencodeConfig cfg.opencode.settings // {
    default_agent = "limitless";
  };

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
        command
        includeChildSessions
        timeoutMs
        ;
      events = {
        inherit (cfg.notifications.events) complete question;
      };
    };
  };

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

    opencode = {
      package = lib.mkOption {
        type = lib.types.package;
        default = llm-agents.packages.${system}.opencode;
        description = "OpenCode package to install. Defaults to the Numtide llm-agents.nix OpenCode package.";
      };

      permission = lib.mkOption {
        inherit (jsonFormat) type;
        default = {
          "*" = "allow";
          external_directory = "allow";
          edit = {
            "*" = "allow";
            ".limitless/repos" = "deny";
            ".limitless/repos/**" = "deny";
          };
          read = {
            "*" = "allow";
            # Private key and credential stores should be deliberate reads.
            "~/.ssh/**" = "ask";
            "$HOME/.ssh/**" = "ask";
            "~/.aws/**" = "ask";
            "$HOME/.aws/**" = "ask";
            "~/.gnupg/**" = "ask";
            "$HOME/.gnupg/**" = "ask";
            "~/.config/gh/hosts.yml" = "ask";
            "$HOME/.config/gh/hosts.yml" = "ask";
          };
          bash = {
            "*" = "allow";
            # History rewrites and worktree-destructive git operations are easy to lose data with.
            "git reset*" = "ask";
            "git clean*" = "ask";
            "git checkout -- *" = "ask";
            "git restore *" = "ask";
            "git rebase*" = "ask";
            "git push --force*" = "ask";
            "git push -f*" = "ask";
            "git branch -D *" = "ask";
            # Broad deletion and shredding should never happen accidentally.
            "rm -rf *" = "ask";
            "rm -fr *" = "ask";
            "trash *" = "ask";
            "shred *" = "ask";
            # Disk and partition commands can damage the host, not just the project.
            "dd *" = "ask";
            "mkfs*" = "ask";
            "fdisk*" = "ask";
            "parted*" = "ask";
            "wipefs*" = "ask";
            # Privilege escalation and recursive ownership changes can escape the workspace.
            "sudo *" = "ask";
            "su *" = "ask";
            "doas *" = "ask";
            "chmod -R *" = "ask";
            "chown -R *" = "ask";
            # Pipe-to-shell installers combine network input with immediate execution.
            "curl * | sh*" = "ask";
            "curl * | bash*" = "ask";
            "wget * | sh*" = "ask";
            "wget * | bash*" = "ask";
            # Publishing and infrastructure mutations affect systems outside the local checkout.
            "npm publish*" = "ask";
            "bun publish*" = "ask";
            "pnpm publish*" = "ask";
            "yarn publish*" = "ask";
            "docker push*" = "ask";
            "kubectl delete*" = "ask";
            "kubectl apply*" = "ask";
            "terraform apply*" = "ask";
            "terraform destroy*" = "ask";
          };
        };
        description = "Default OpenCode permission configuration.";
      };

      settings = lib.mkOption {
        type = lib.types.attrsOf jsonFormat.type;
        default = { };
        description = "Additional OpenCode settings deep-merged over generated defaults.";
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

    plugins.limitless = {
      package = lib.mkOption {
        type = lib.types.package;
        default = self.packages.${system}.limitless;
        description = "Package containing the Limitless OpenCode plugin.";
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

    notifications = {
      enable = lib.mkEnableOption "running a system command on OpenCode completion and question events";

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
          description = "Run the notification command when a top-level OpenCode session becomes idle.";
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

    mcp.linear.enable = lib.mkEnableOption "Linear MCP server configuration for OpenCode";
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
            assertion = lib.attrByPath [ "agent" "limitless" "disable" ] false cfg.opencode.settings != true;
            message = "programs.limitless keeps the limitless default agent enabled; remove opencode.settings.agent.limitless.disable.";
          }
        ];

        home = {
          packages = [ cfg.opencode.package ];
          file = {
            "${opencodeDir}/opencode.json".text = builtins.toJSON opencodeConfig;
            "${opencodeDir}/AGENTS.md".text = agentsText;
            "${opencodeDir}/agents" = {
              source = cfg.agents.package;
              recursive = true;
            };
            "${opencodePluginDir}/limitless.js".text = ''
              import plugin from "${cfg.plugins.limitless.package}/limitless.js";

              const generatedOptions = ${builtins.toJSON limitlessPluginOptions};
              const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};

              export default (input, options = {}) => {
                const base = object(options);
                const github = object(base.github);
                const notifications = object(base.notifications);
                const notificationEvents = object(notifications.events);
                return plugin(input, {
                  ...base,
                  github: {
                    ...generatedOptions.github,
                    ...github,
                  },
                  notifications: {
                    ...generatedOptions.notifications,
                    ...notifications,
                    events: {
                      ...generatedOptions.notifications.events,
                      ...notificationEvents,
                    },
                  },
                });
              };
            '';
          };
        };
      }
      (lib.mkIf enabledSkills {
        home.file."${skillsDirectory}" = {
          source = enabledSkillsPackage;
          recursive = true;
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
        systemd.user.services.opencode = {
          Unit.Description = "OpenCode server";

          Service = {
            Environment = "OPENCODE_EXPERIMENTAL_WEBSOCKETS=true";
            ExecStart = "${cfg.opencode.package}/bin/opencode serve --hostname ${cfg.opencode.service.hostname} --port ${toString cfg.opencode.service.port}";
            Restart = "on-failure";
            RestartSec = "5s";
          };

          Install.WantedBy = [ "default.target" ];
        };
      })
      (lib.mkIf enabledLinear {
        home.file."${opencodePluginDir}/linear-mcp.js" = {
          source = "${self.packages.${system}."linear-mcp"}/linear-mcp.js";
        };
      })
    ]
  );
}
