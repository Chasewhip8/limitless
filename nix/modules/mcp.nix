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
  presetServers = lib.mapAttrs (
    _: connection: lib.recursiveUpdate presets.${connection.preset}.settings connection.settings
  ) connections;
  nativeServers = cfg.opencode.settings.mcp.servers or { };
  servers = presetServers // nativeServers;
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
      if builtins.hasAttr name connections then connections.${name}.readTools else [ ]
    );
  permissionRules =
    effect: lib.concatMap (name: [ (rule "${normalize name}_*" effect) ] ++ readRules name) names;
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
                description = "Exact read-only tool names allowed without approval and available to research. Replaces the preset list.";
              };
            };
          }
        )
      );
    };
    _generated = {
      mcpServers = generatedOption (lib.types.attrsOf jsonFormat.type);
      mcpPermissions = generatedOption (lib.types.listOf jsonFormat.type);
      researchMcpPermissions = generatedOption (lib.types.listOf jsonFormat.type);
    };
  };

  config = {
    programs.limitless._generated = {
      mcpServers = servers;
      mcpPermissions = permissionRules "ask";
      researchMcpPermissions = permissionRules "deny";
    };
    assertions = lib.mkIf cfg.enable (
      [
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
      ]
      ++ lib.mapAttrsToList (name: connection: {
        assertion = connection.preset != "github" || githubAuthConfigured presetServers.${name};
        message = "GitHub MCP ${name} needs settings.oauth.client_id for a registered OAuth client, or settings.oauth = false and settings.headers.Authorization = \"Bearer {env:YOUR_GITHUB_MCP_TOKEN}\".";
      }) connections
    );
  };
}
