{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.limitless;
  jsonFormat = pkgs.formats.json { };
  defaults = {
    biome = {
      package = pkgs.biome;
      executable = "biome";
      args = [ "lsp-proxy" ];
      extensions = [
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
    };
    json = {
      package = pkgs.vscode-langservers-extracted;
      executable = "vscode-json-language-server";
      args = [ "--stdio" ];
      extensions = [
        ".json"
        ".jsonc"
      ];
    };
    marksman = {
      package = pkgs.marksman;
      executable = "marksman";
      args = [ "server" ];
      extensions = [
        ".md"
        ".markdown"
      ];
    };
    nixd = {
      package = pkgs.nixd;
      executable = "nixd";
      args = [ ];
      extensions = [ ".nix" ];
    };
    taplo = {
      package = pkgs.taplo;
      executable = "taplo";
      args = [
        "lsp"
        "stdio"
      ];
      extensions = [ ".toml" ];
    };
    typescript = {
      package = pkgs.typescript-language-server;
      executable = "typescript-language-server";
      args = [ "--stdio" ];
      extensions = [
        ".ts"
        ".tsx"
        ".mts"
        ".cts"
        ".js"
        ".jsx"
        ".mjs"
        ".cjs"
      ];
      env.TYPESCRIPT_TS_SERVER_PATH = "${pkgs.typescript}/lib/node_modules/typescript/lib/tsserver.js";
    };
    yaml = {
      package = pkgs.yaml-language-server;
      executable = "yaml-language-server";
      args = [ "--stdio" ];
      extensions = [
        ".yaml"
        ".yml"
      ];
    };
  };

  serverOptions = name: server: {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Enable the ${name} language server for Limitless tools.";
    };
    package = lib.mkOption {
      type = lib.types.package;
      default = server.package;
      description = "Package providing the ${name} language server.";
    };
    command = lib.mkOption {
      type = lib.types.str;
      default = "${cfg.lsp.servers.${name}.package}/bin/${server.executable}";
      description = "Executable for the ${name} language server.";
    };
    args = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = server.args;
      description = "Arguments for the ${name} language server.";
    };
    extensions = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = server.extensions;
      description = "File extensions handled by the ${name} language server.";
    };
    env = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = server.env or { };
      description = "Environment for the ${name} language server.";
    };
  };

  enabledServers = lib.filterAttrs (_: server: server.enable) cfg.lsp.servers;
  serverConfig = lib.mapAttrs (
    _: server:
    {
      command = [ server.command ] ++ server.args;
      inherit (server) extensions;
    }
    // lib.optionalAttrs (server.env != { }) { inherit (server) env; }
  ) enabledServers;
in
{
  options.programs.limitless = {
    lsp = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Install and configure language servers for Limitless tools.";
      };
      extraServers = lib.mkOption {
        type = lib.types.attrsOf jsonFormat.type;
        default = { };
        description = "Additional Limitless language-server definitions, merged over the defaults.";
      };
      extraPackages = lib.mkOption {
        type = lib.types.listOf lib.types.package;
        default = [ ];
        description = "Additional packages installed when language-server support is enabled.";
      };
      servers = lib.mapAttrs serverOptions defaults;
    };
    _generated.lsp = lib.mkOption {
      type = lib.types.attrsOf jsonFormat.type;
      internal = true;
      readOnly = true;
      description = "Language-server configuration consumed by the Limitless plugin.";
    };
  };

  config = {
    programs.limitless._generated.lsp = lib.optionalAttrs cfg.lsp.enable (
      lib.recursiveUpdate serverConfig cfg.lsp.extraServers
    );
    home.packages = lib.mkIf (cfg.enable && cfg.lsp.enable) (
      map (server: server.package) (builtins.attrValues enabledServers)
      ++ lib.optional cfg.lsp.servers.typescript.enable pkgs.typescript
      ++ cfg.lsp.extraPackages
    );
  };
}
