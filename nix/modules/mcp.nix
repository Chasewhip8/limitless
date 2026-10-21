{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.limitless;
  jsonFormat = pkgs.formats.json { };
  presets = import ../mcp-presets.nix;
  connections = cfg.mcp.servers;
  executor = cfg.mcp.executor;
  executorTools = [
    "skills"
    "search"
    "describe"
    "call"
    "execute"
    "resume"
  ];
  executorServer = connection: mode: {
    type = "remote";
    url = "${executor.url}?connection=${connection}&elicitation_mode=${mode}";
    codemode = false;
    protocol = "legacy";
  };
  executorServers = lib.optionalAttrs executor.enable (
    {
      executor = executorServer executor.connection "model";
    }
    // lib.optionalAttrs (executor.readConnection != null) {
      executor-read = executorServer executor.readConnection "browser";
    }
  );
  presetServers = lib.mapAttrs (
    _: connection: lib.recursiveUpdate presets.${connection.preset}.settings connection.settings
  ) connections;
  nativeServers = cfg.opencode.settings.mcp.servers or { };
  servers = presetServers // nativeServers // executorServers;
  names = builtins.attrNames servers;
  normalize =
    name:
    lib.concatMapStrings (
      character: if builtins.match "[A-Za-z0-9_-]" character != null then character else "_"
    ) (lib.stringToCharacters name);
  normalizedNames = map normalize names;
  reservedActions = [
    "artifact_create"
    "artifact_list"
    "ast_grep_search"
    "ast_grep_replace"
    "lsp_diagnostics"
    "lsp_definition"
    "lsp_hover"
    "lsp_implementation"
    "lsp_call_hierarchy"
    "lsp_references"
    "lsp_symbols"
    "lsp_rename"
    "github_clone"
  ];
  rule = action: effect: {
    inherit action effect;
    resource = "*";
  };
  readRules =
    name:
    map (tool: rule "${normalize name}_${tool}" "allow") (
      if executor.enable && executor.readConnection != null && name == "executor-read" then
        executorTools
      else if builtins.hasAttr name connections then
        connections.${name}.readTools
      else
        [ ]
    );
  readOnlyPermissions = lib.concatMap (
    name: [ (rule "${normalize name}_*" "deny") ] ++ readRules name
  ) names;
  generatedOption =
    type:
    lib.mkOption {
      inherit type;
      internal = true;
      readOnly = true;
    };
  githubAuthConfigured =
    server:
    let
      oauth = server.oauth or { };
      clientID = if builtins.isAttrs oauth then oauth.client_id or "" else "";
      authorization = server.headers.Authorization or "";
    in
    (oauth == false && builtins.isString authorization && authorization != "")
    || (builtins.isString clientID && clientID != "");
in
{
  options.programs.limitless = {
    mcp.executor = {
      enable = lib.mkEnableOption "scoped Executor MCP connections";
      url = lib.mkOption {
        type = lib.types.strMatching "https://[A-Za-z0-9.-]+(:[0-9]+)?/mcp";
        default = "https://mcp.executor.sh/mcp";
        description = "HTTPS MCP endpoint without query parameters. Credentials remain in OpenCode's runtime store.";
      };
      connection = lib.mkOption {
        type = lib.types.strMatching "[A-Za-z0-9_-]{0,64}";
        default = "";
        description = "Required scoped connection ID for the primary agent. Exclude Executor administration apps.";
      };
      readConnection = lib.mkOption {
        type = lib.types.nullOr (lib.types.strMatching "[A-Za-z0-9_-]{1,64}");
        default = null;
        description = "Optional distinct scoped connection with exact audited read tools selected in Executor. Null denies all Executor tools to support agents.";
      };
    };
    mcp.servers = lib.mkOption {
      default = { };
      description = "Named first-party MCP connections. Each name has separate OpenCode OAuth state.";
      type = lib.types.attrsOf (
        lib.types.submodule (
          { config, ... }: {
            options = {
              preset = lib.mkOption {
                type = lib.types.enum (builtins.attrNames presets);
                description = "First-party service whose endpoint and read-tool defaults to use.";
              };
              settings = lib.mkOption {
                type = lib.types.attrsOf jsonFormat.type;
                default = { };
                description = "Native MCP server settings merged over the preset. Use environment substitutions for credentials.";
              };
              readTools = lib.mkOption {
                type = lib.types.listOf (lib.types.strMatching "[A-Za-z0-9_-]+");
                default = presets.${config.preset}.readTools;
                description = "Exact read-only tool names available to research and Oracle agents. Replaces the preset list.";
              };
            };
          }
        )
      );
    };
    _generated = {
      mcpServers = generatedOption (lib.types.attrsOf jsonFormat.type);
      readOnlyMcpPermissions = generatedOption (lib.types.listOf jsonFormat.type);
      primaryMcpPermissions = generatedOption (lib.types.listOf jsonFormat.type);
    };
  };

  config = {
    home.file.".config/limitless/executor-read-tools.json" = lib.mkIf (cfg.enable && executor.enable) {
      text = builtins.toJSON (lib.mapAttrs (_: preset: preset.readTools) presets);
    };
    programs.limitless._generated = {
      mcpServers = servers;
      readOnlyMcpPermissions = readOnlyPermissions;
      primaryMcpPermissions = lib.optional (executor.enable && executor.readConnection != null) (
        rule "executor-read_*" "deny"
      );
    };
    assertions = lib.mkIf cfg.enable (
      [
        {
          assertion = !executor.enable || executor.connection != "";
          message = "Executor requires a scoped connection ID; unscoped full-consent access is not supported.";
        }
        {
          assertion = !executor.enable || executor.readConnection != executor.connection;
          message = "Executor primary and read connections must be distinct, separately scoped connections.";
        }
        {
          assertion =
            lib.intersectLists (builtins.attrNames executorServers) (
              builtins.attrNames presetServers ++ builtins.attrNames nativeServers
            ) == [ ];
          message = "Managed Executor connections must not also appear in mcp.servers or opencode.settings.mcp.servers.";
        }
        {
          assertion =
            lib.intersectLists (builtins.attrNames presetServers) (builtins.attrNames nativeServers) == [ ];
          message = "Configure each MCP server name in either programs.limitless.mcp.servers or opencode.settings.mcp.servers, not both.";
        }
        {
          assertion = lib.all (name: builtins.match "[A-Za-z0-9_-]+" name != null) names;
          message = "Limitless MCP names must use letters, numbers, underscores, and hyphens so permission actions stay unambiguous.";
        }
        {
          assertion =
            builtins.length (lib.unique normalizedNames) == builtins.length names
            && lib.all (
              name: lib.all (other: name == other || !lib.hasPrefix "${name}_" other) normalizedNames
            ) normalizedNames;
          message = "MCP names must have distinct permission prefixes; use hyphens to distinguish accounts (for example notion-work).";
        }
        {
          assertion = lib.all (
            name:
            !lib.any (namespace: name == namespace || lib.hasPrefix "${namespace}_" name) [
              "browser"
              "opencode"
            ]
            && !lib.any (action: lib.hasPrefix "${name}_" action) reservedActions
          ) normalizedNames;
          message = "An MCP name overlaps an OpenCode or Limitless tool namespace. Use gh or github-mcp for GitHub.";
        }
        {
          assertion = lib.all (name: name != "t3-code" && !lib.hasPrefix "t3-code-" name) names;
          message = "The t3-code namespace is reserved for opencode-t3 thread connections. Use t3-external for an independently configured T3 OAuth connection.";
        }
      ]
      ++ lib.mapAttrsToList (name: connection: {
        assertion = connection.preset != "github" || githubAuthConfigured presetServers.${name};
        message = "GitHub MCP ${name} needs settings.oauth.client_id for a registered OAuth client, or settings.oauth = false and settings.headers.Authorization = \"Bearer {env:YOUR_GITHUB_MCP_TOKEN}\".";
      }) connections
    );
  };
}
