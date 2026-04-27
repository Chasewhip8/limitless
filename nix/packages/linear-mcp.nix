{ pkgs, self }:
pkgs.stdenvNoCC.mkDerivation {
  pname = "linear-mcp";
  version = "1.0.0";

  src = self;
  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
        mkdir -p "$out/lib/opencode/linear-mcp"
        install -m644 "$src/packages/linear-mcp/index.mjs" "$out/lib/opencode/linear-mcp/index.mjs"

    printf '%s\n' \
      'import plugin from "'$out'/lib/opencode/linear-mcp/index.mjs";' \
      'export default plugin;' \
      > "$out/linear-mcp.js"
  '';

  meta = with pkgs.lib; {
    description = "OpenCode plugin that adds Linear MCP server configuration";
    platforms = platforms.all;
  };
}
