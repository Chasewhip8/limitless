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
- **Default agent workflow**: OpenCode starts with `limitless` as the primary agent; planning stays in the main context while specialist subagents handle research, Oracle second opinions, implementation, and skill-directed review.
- **Reusable skills**: generic local skills are copied from the top-level `skills/` directory, while companion tool skills are installed with their tools for Effect guidance and browser automation.
- **Local code intelligence**: the Limitless plugin adds ast-grep search/replace, TypeScript/Biome diagnostics, and LSP-powered references, symbols, and rename previews.
- **Project-scoped artifacts**: durable `.limitless/artifacts/` workspaces can be empty or hold notes, source files, assets, and generated outputs.
- **Typst document generation**: create artifacts from built-in Typst templates and compile them to PDF with the packaged Typst binary.
- **Unified research agent**: the read-only `research` agent handles local repo discovery, docs, APIs, current references, and optional project-cached GitHub source research in one place.
- **Ready language servers**: common TypeScript, Biome, Markdown, TOML, Nix, JSON, and YAML language servers are configured by default.
- **Optional Linear MCP**: Linear remains opt-in and reads `LINEAR_API_KEY` from the OpenCode process environment.
- **Native attention hooks**: optionally run a system command when a session completes or the question tool prompts the user.
- **Safer agent permissions**: common work is allowed, while credential access, destructive git operations, broad deletion, publishing, privilege escalation, and infrastructure mutations ask first.
- **Optional service mode**: OpenCode can run as a user service with a shell alias that attaches from the current directory.

## Default configuration

```nix
programs.limitless = {
  enable = true;

  opencode = {
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
  };

  tools = {
    agentBrowser.enable = true;
    effectSolutions.enable = true;
  };

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

`oracle` is the high-reasoning question-answering subagent. Limitless uses it for difficult architecture, debugging, planning, explanation, and tradeoff questions that benefit from an independent second opinion; Oracle may delegate broad evidence gathering to `research`. It inherits the normal broad tool access but cannot use the standard edit or structured-replacement tools.

Enable the optional `github_clone` source tool with:

```nix
programs.limitless.github = {
  enable = true;
  tokenEnv = "GITHUB_TOKEN";
  tokenFile = null;
  allowedRepos = [ "owner/repo" ];
  allowUnrestrictedRepos = false;
};
```

Provide a token through either the named environment variable, for example `GITHUB_TOKEN`, or a runtime token file such as `/run/agenix/github-token` when cloning private repositories. When `tokenFile` is set, Limitless reads that file instead of `tokenEnv`. The token is passed to Git only through ephemeral, github.com-scoped environment configuration: it is never placed in a URL, command argument, tool result, generated configuration, or repository config. Limitless writes only the environment variable name, optional token file path, and repository policy into generated configuration.

`allowedRepos` must be non-empty when GitHub support is enabled unless you explicitly set `allowUnrestrictedRepos = true`. The same policy is enforced independently for every transitive submodule, and non-GitHub submodule hosts are rejected. Use fine-grained read-only tokens.

`github_clone` is available to every agent. It creates depth-one snapshots under the current worktree's `.limitless/repos/` directory and returns both relative and absolute paths plus the resolved commit. Calls without `ref` use a stable `github-owner-repo` directory and refresh the repository's current default branch every time. Branches, tags, and commit SHAs use deterministic ref-suffixed directories, so snapshots for different refs do not collide. Existing checkouts are refreshed only when their identity, clean HTTPS origin, tracked files, untracked files, and recursively initialized submodules are clean; dirty state is never overwritten. Initial clones are assembled in a same-directory staging path and atomically published, so a failed first clone leaves no final checkout.

Accepted submodules are rewritten to clean HTTPS origins locally and initialized one level at a time with shallow fetches so each transitive repository is validated before Git can access it. Managed repositories are read-only supporting source: clone first, then use local read, glob, grep, or ast-grep search against the returned path. The generated OpenCode `edit` policy denies normal edit, write, and patch operations beneath `.limitless/repos/`; this is an agent guardrail rather than an operating-system sandbox, so unrestricted shell commands remain capable of bypassing it. Git LFS smudging is disabled, so pointer files are present but LFS objects are not downloaded or materialized.

## Deterministic review

The `review` subagent operates only against explicitly named `review-*` skills. The packaged `review-general` example checks repository-defined formatting, lint, compilation, type safety, tests, and diff hygiene; it treats checked-in scripts and CI as authoritative and does not invent subjective standards. Add narrower review skills for framework, security, accessibility, or domain-specific rules.

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

Limitless stores durable project-local work products under `.limitless/artifacts/`. Create an empty artifact for ad hoc notes or files, or instantiate one from a top-level `templates/<name>/` folder. Artifacts are scoped to the current worktree, not the current chat session; the creating session is recorded only in the manifest metadata.

The Limitless plugin exposes:

- `artifact_create`: create a durable artifact workspace.
- `artifact_list`: list artifact workspaces for the current project.
- `artifact_templates_list`: inspect built-in artifact templates.
- `artifact_template_read`: read a built-in template file without creating an artifact (e.g. the `sphere-showcase` authoring reference).
- `typst_compile`: compile a document artifact to PDF.

Artifact templates are plain directories with a small `manifest.json`; `artifact_create` copies the folder contents into a new artifact and writes the artifact manifest. A template may declare a `framework` (a directory under top-level `frameworks/<name>/`); its files are composed into the artifact first, so document workspaces stay fully self-contained and keep compiling identically even after the plugin updates. Typst is handled separately by `typst_compile`, which compiles an artifact entry such as `main.typ` into `dist/`.

Document artifacts are source-first: edit `main.typ` directly, compose with framework `.typ` modules such as `sphere.typ` and its `sphere/` files when present, and place charts/images/assets under `assets/`. The Sphere framework is opinionated about assembly: cards, charts, and panels placed in a `sphere-grid` or `sphere-two-column` are measured and stretched to equal heights per row, charts auto-scale, and every evidence-bearing component takes a `source:` that feeds the `sphere-lint()` QA page. Built-in templates: `brief` (plain default), `sphere` (Sphere-branded institutional starter on the shared `sphere` framework), and `sphere-showcase` (a complete example institutional document — cover, executive summary, market, architecture, comparison, proof, roadmap, risk, and QA pages — that doubles as the component reference). New Sphere document types (PRDs, PR/FAQs, memos) are added by dropping a new `templates/<name>/` folder that reuses the framework.

## Maintainers

Use `nix develop`, then run the scripts in `package.json`. `bun run ci` is the full local gate.

For structure and implementation details, see the module options in `nix/modules/home.nix`.
