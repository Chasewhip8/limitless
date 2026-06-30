# Limitless

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
- **Default agent workflow**: OpenCode starts with `limitless` as the primary agent; planning stays in the main context while specialist subagents handle research, advisor pushback, implementation, and final review.
- **Reusable skills**: generic local skills are copied from the top-level `skills/` directory, while companion tool skills are installed with their tools for Effect guidance and browser automation.
- **Local code intelligence**: the Limitless plugin adds ast-grep search/replace, TypeScript/Biome diagnostics, and LSP-powered references, symbols, and rename previews.
- **Project-scoped artifacts**: durable `.limitless/artifacts/` workspaces replace session-scoped scratchpads and can hold notes, source files, assets, and generated outputs.
- **Typst document generation**: create document artifacts from built-in Typst templates and compile them to PDF with the packaged Typst binary.
- **Unified research agent**: the read-only `research` agent handles local repo discovery, docs, APIs, current references, and optional GitHub source-code research in one place.
- **Ready language servers**: common TypeScript, Biome, Markdown, TOML, Nix, JSON, and YAML language servers are configured by default.
- **MCP defaults**: Context7 is enabled out of the box; Linear MCP remains opt-in and reads `LINEAR_API_KEY` from the OpenCode process environment.
- **Native attention hooks**: optionally run a system command when a session completes or the question tool prompts the user.
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

  tools = {
    agentBrowser.enable = true;
    effectSolutions.enable = true;
  };

  agents.enable = true;
  plugins.limitless.enable = true;

  github = {
    enable = false;
    tokenEnv = "GITHUB_TOKEN";
    tokenFile = null;
    allowedRepos = [];
    allowUnrestrictedRepos = false;
  };

  notifications = {
    enable = false;
    command = [];
    timeoutMs = 5000;
    includeChildSessions = false;
    events = {
      complete = true;
      question = true;
    };
  };

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
    linear.enable = false;
  };
};
```

`tools.agentBrowser.enable` and `tools.effectSolutions.enable` default to `skills.enable`. Set either tool explicitly to install the CLI without installing skills.

## Research and remote source code

`research` is read-only and researches local code, tests, docs, configuration, APIs, standards, current external facts, implementation source, official examples, and configured private GitHub repositories. It does not edit files or run shell commands.

Enable optional GitHub source tools with:

```nix
programs.limitless.github = {
  enable = true;
  tokenEnv = "GITHUB_TOKEN";
  tokenFile = null;
  allowedRepos = [ "owner/repo" ];
  allowUnrestrictedRepos = false;
};
```

Provide the token through either the named environment variable, for example `GITHUB_TOKEN`, or a runtime token file such as `/run/agenix/github-token`, for private repositories, higher rate limits, and GitHub code search. When `tokenFile` is set, Limitless reads that file instead of `tokenEnv`. Limitless writes only the environment variable name, optional token file path, and repository allowlist into generated configuration, never the token value.

`allowedRepos` must be non-empty when GitHub tools are enabled unless you explicitly set `allowUnrestrictedRepos = true`. Use fine-grained read-only tokens. File reads and repo-tree requests without an explicit `ref` use GitHub's default branch, so results report that caveat. GitHub auth failures and rate limits are returned as explicit gaps.

## Attention notifications

Enable a native Limitless command hook without adding a separate OpenCode notifier plugin:

```nix
programs.limitless.notifications = {
  enable = true;
  command = [ "notify-send" "OpenCode needs attention" ];
  events.complete = true;
  events.question = true;
};
```

The command is executed directly, without a shell. Completion notifications fire when a top-level OpenCode session becomes idle; question notifications fire before the OpenCode `question` tool prompts the user. Child/subagent completion notifications are skipped by default.

## Artifacts and documents

Limitless stores durable project-local work products under `.limitless/artifacts/`. The old session-scoped scratchpad concept is unified into artifact workspaces: create a `scratchpad` artifact for notes, a `document` artifact for Typst-backed PDFs, or a `generic` artifact for ad hoc files. Artifacts are scoped to the current worktree, not the current chat session; the creating session is recorded only in the manifest metadata.

The Limitless plugin exposes:

- `artifact_create`: create a durable artifact workspace.
- `artifact_list`: list artifact workspaces for the current project.
- `typst_templates_list`: inspect built-in Typst templates.
- `typst_compile`: compile a document artifact to PDF.

Document artifacts keep editable `main.typ` and `data.json` sources alongside generated files in `dist/`.

## Maintainers

Use `nix develop`, then run the scripts in `package.json`. `bun run ci` is the full local gate.

For structure and implementation details, see `ARCHITECTURE.md` and the module options in `nix/modules/home.nix`.
