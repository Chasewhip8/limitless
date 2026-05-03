# Abilities

> A Home Manager module for a ready-to-use OpenCode agent workspace.

## Use it

```nix
{
  inputs.abilities.url = "github:your-org/abilities";

  outputs = { home-manager, abilities, ... }: {
    homeConfigurations.me = home-manager.lib.homeManagerConfiguration {
      modules = [
        abilities.homeModules.default
        { programs.limitless.enable = true; }
      ];
    };
  };
}
```

## Features

- **One module to enable**: `programs.limitless.enable = true` wires OpenCode, agents, skills, plugins, MCPs, and language servers together.
- **Default agent workflow**: OpenCode starts with `limitless` as the primary agent and installs the packaged specialist subagents for implementation, research, planning, critique, and review.
- **Reusable skills**: local skills and CLI-backed skills are installed into the agent skills directory for architecture docs, TypeScript/service patterns, Effect guidance, and browser automation.
- **Local code intelligence**: the Limitless plugin adds ast-grep search/replace, TypeScript/Biome diagnostics, and LSP-powered references, symbols, and rename previews.
- **Ready language servers**: common TypeScript, Biome, Markdown, TOML, Nix, JSON, and YAML language servers are configured by default.
- **MCP defaults**: Context7 is enabled out of the box; Linear MCP remains opt-in and reads `LINEAR_API_KEY` from the OpenCode process environment.
- **Safer agent permissions**: common work is allowed, while credential access, destructive git operations, broad deletion, publishing, privilege escalation, and infrastructure mutations ask first.
- **Optional service mode**: OpenCode can run as a user service with a shell alias that attaches from the current directory.

## Default configuration

```nix
programs.limitless = {
  enable = true;

  opencode = {
    configDir = ".config/opencode";
    extraAgentsFile = null;
    settings = {};
    service = {
      enable = false;
      hostname = "127.0.0.1";
      port = 4096;
      alias = "oc";
    };
  };

  skills = {
    enable = true;
    directory = ".agents/skills";
  };

  agents.enable = true;
  plugins.limitless.enable = true;

  lsp = {
    enable = true;
    extraServers = {};
    extraPackages = [];
    servers = {
      biome.enable = true;
      json.enable = true;
      marksman.enable = true;
      nixd.enable = true;
      taplo.enable = true;
      typescript.enable = true;
      yaml.enable = true;
    };
  };

  mcp = {
    context7.enable = true;
    linear.enable = false;
  };
};
```

## Maintainers

Use `nix develop`, then run the scripts in `package.json`. `bun run ci` is the full local gate.

For structure and implementation details, see `ARCHITECTURE.md` and the module options in `nix/modules/home.nix`.
