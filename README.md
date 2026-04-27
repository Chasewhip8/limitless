# Abilities

Nix/Home Manager flake for a batteries-included OpenCode agent environment.

`programs.limitless.enable = true` installs OpenCode, agent prompts, reusable skills, local code-intelligence tools, browser automation support, default MCP configuration, and language servers for common project types.

## Contents

| Area | What is included |
| --- | --- |
| Home Manager module | `programs.limitless` with OpenCode, agents, skills, plugins, MCPs, and LSP defaults |
| OpenCode agents | `limitless`, `engineer`, `frontend`, `explore`, `strategy`, `review`, `mapper`, `librarian`, `critique` |
| Skills | architecture docs, Effect patterns, design grilling, service design, TypeScript patterns, browser automation |
| Plugins | Limitless local tooling plugin; optional Linear MCP plugin |
| Nix packages | `abilities-skills`, `abilities-opencode-agents`, `opencode-limitless`, `linear-mcp`, `agent-browser`, `effect-solutions` |

## Quick start

```nix
{
  inputs.abilities.url = "github:your-org/abilities";

  outputs = { home-manager, abilities, ... }: {
    homeConfigurations.me = home-manager.lib.homeManagerConfiguration {
      modules = [
        abilities.homeModules.default
        {
          programs.limitless.enable = true;
        }
      ];
    };
  };
}
```

## Defaults

Enabling `programs.limitless` configures:

- `pkgs.opencode` as the OpenCode package.
- `~/.config/opencode/opencode.json` with `limitless` as the default agent.
- packaged OpenCode agents in `~/.config/opencode/agents`.
- packaged skills in `~/.agents/skills`, including CLI-backed skills from their owning packages.
- the Limitless plugin in `~/.config/opencode/plugins`.
- Context7 MCP as a remote MCP server.
- language servers for TypeScript, Biome, Markdown, TOML, Nix, JSON, and YAML.
- `agent-browser` and `effect-solutions` helper CLIs.

The default OpenCode permissions are intentionally agent-friendly: broad read/edit/bash access with prompts for known destructive, credential-sensitive, publishing, and infrastructure commands. Override `programs.limitless.opencode.permission` for stricter environments.

## Common configuration

### Pin or override OpenCode

```nix
programs.limitless = {
  enable = true;
  opencode.package = pkgs.opencode;
};
```

### Extend generated OpenCode settings

`opencode.settings` is deep-merged over module defaults.

```nix
programs.limitless.opencode.settings = {
  permission.bash."git push --force*" = "deny";
};
```

### Enable Linear MCP

```nix
programs.limitless.mcp.linear.enable = true;
```

The Linear plugin reads `LINEAR_API_KEY` from the OpenCode process environment.

### Customize LSPs

```nix
programs.limitless.lsp = {
  enable = true;
  servers.yaml.enable = false;
  extraServers.rust = {
    command = "${pkgs.rust-analyzer}/bin/rust-analyzer";
    args = [];
  };
  extraPackages = [ pkgs.rust-analyzer ];
};
```

Every built-in LSP exposes `enable`, `package`, `command`, `args`, `extensions`, and `env`.

## Flake exports

- `homeModules.default` — Home Manager module for `programs.limitless`.
- `overlays.default` — overlay exposing packaged agents, skills, plugins, and tools.
- `packages.${system}.skills`
- `packages.${system}.opencode-agents`
- `packages.${system}.limitless`
- `packages.${system}.linear-mcp`
- `packages.${system}.agent-browser`
- `packages.${system}.effect-solutions`

## Development

```sh
nix develop
bun install
bun run lint
bun run format
bun run typecheck
bun run test
bun run build
```

Use the Nix dev shell for Bun, Node, lint/format tools, packaging dependencies, `agent-browser`, and `effect-solutions`.

Quality gates:

- `bun run lint` checks Biome-supported files, Nix formatting/lints/dead code, and Markdown structure.
- `bun run format` applies Biome and `nixfmt` formatting.
- `bun run ci` runs lint, typecheck, tests, `nix flake check`, and package builds.

Run the full local CI equivalent with:

```sh
bun run ci
```
