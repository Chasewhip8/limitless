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

  opencodeDir = cfg.opencode.configDir;
  opencodePluginDir = "${opencodeDir}/plugins";

  enabledSkills = cfg.enable && cfg.skills.enable;
  enabledAgents = cfg.enable && cfg.agents.enable;
  enabledLimitless = cfg.enable && cfg.plugins.limitless.enable;
  enabledLsp = cfg.enable && cfg.lsp.enable;
  enabledContext7 = cfg.enable && cfg.mcp.context7.enable;
  enabledLinear = cfg.enable && cfg.mcp.linear.enable;

  agentBrowserPackage = self.packages.${system}."agent-browser";
  effectSolutionsPackage = self.packages.${system}."effect-solutions";

  enabledSkillsPackage = pkgs.runCommand "limitless-enabled-skills" { } ''
    mkdir -p $out
    cp -r ${cfg.skills.package}/. $out/

    if [ -d ${agentBrowserPackage}/share/skills ]; then
      cp -r ${agentBrowserPackage}/share/skills/. $out/
    fi

    if [ -d ${effectSolutionsPackage}/share/skills ]; then
      cp -r ${effectSolutionsPackage}/share/skills/. $out/
    fi
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
  }
  // lib.optionalAttrs enabledContext7 {
    mcp.context7 = {
      type = "remote";
      url = "https://mcp.context7.com/mcp";
      enabled = true;
    };
  };

  opencodeConfig = lib.recursiveUpdate defaultOpencodeConfig cfg.opencode.settings;

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
        default = pkgs.opencode;
        description = "OpenCode package to install.";
      };

      configDir = lib.mkOption {
        type = lib.types.str;
        default = ".config/opencode";
        description = "Directory relative to $HOME for OpenCode configuration.";
      };

      permission = lib.mkOption {
        inherit (jsonFormat) type;
        default = {
          "*" = "allow";
          external_directory = "allow";
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

      directory = lib.mkOption {
        type = lib.types.str;
        default = ".agents/skills";
        description = "Directory relative to $HOME for skill installation.";
      };
    };

    agents = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Whether to install packaged OpenCode agents.";
      };

      package = lib.mkOption {
        type = lib.types.package;
        default = self.packages.${system}."opencode-agents";
        description = "Package containing OpenCode agent files.";
      };
    };

    plugins.limitless = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Whether to install the Limitless OpenCode plugin.";
      };

      package = lib.mkOption {
        type = lib.types.package;
        default = self.packages.${system}.limitless;
        description = "Package containing the Limitless OpenCode plugin.";
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

    mcp = {
      context7.enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Whether to configure the Context7 MCP server.";
      };

      linear.enable = lib.mkEnableOption "Linear MCP server configuration for OpenCode";
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        home = {
          packages = [ cfg.opencode.package ];
          file = {
            "${opencodeDir}/opencode.json".text = builtins.toJSON opencodeConfig;
            "${opencodeDir}/AGENTS.md".text = agentsText;
          };
        };
      }
      (lib.mkIf enabledSkills {
        home.file."${cfg.skills.directory}" = {
          source = enabledSkillsPackage;
          recursive = true;
        };

        home.packages = [
          agentBrowserPackage
          effectSolutionsPackage
        ];
      })
      (lib.mkIf enabledAgents {
        home.file."${opencodeDir}/agents" = {
          source = cfg.agents.package;
          recursive = true;
        };
      })
      (lib.mkIf enabledLimitless {
        home = {
          packages = [ pkgs.ast-grep ];
          file = {
            "${opencodeDir}/package.json".text = builtins.toJSON {
              type = "module";
              dependencies."@opencode-ai/plugin" = "1.14.25";
            };
            "${opencodePluginDir}/package.json".text = ''{"type":"module"}'';
            "${opencodePluginDir}/limitless.js".source = "${cfg.plugins.limitless.package}/limitless.js";
          };
        };
      })
      (lib.mkIf enabledLsp {
        home.packages = lspPackages;
      })
      (lib.mkIf enabledLinear {
        home.file."${opencodePluginDir}/package.json".text = ''{"type":"module"}'';

        home.file."${opencodePluginDir}/linear-mcp.js" = {
          source = "${self.packages.${system}."linear-mcp"}/linear-mcp.js";
        };
      })
    ]
  );
}
