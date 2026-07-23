# Limitless

> A Home Manager module for a ready-to-use OpenCode 2.0 beta agent workspace.

Limitless is decisively cut over to the volatile OpenCode 2.0 beta at
`0.0.0-next-16040`. It has no OpenCode 1 runtime, configuration, plugin, or
session-migration path. Existing OpenCode 1 sessions may be unavailable after
switching.

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

- **One module to enable**: `programs.limitless.enable = true` wires `opencode2`, agents, skills, plugins, MCPs, and language servers together.
- **Default agent workflow**: OpenCode starts with `limitless` as the primary agent; planning stays in the main context while specialist subagents handle research, Oracle second opinions, and implementation.
- **Reusable skills**: generic local skills are copied from the top-level `skills/` directory, while companion tool skills are installed with their tools for Effect guidance and browser automation.
- **Local code intelligence**: the Limitless plugin adds ast-grep search/replace, TypeScript/Biome diagnostics, and LSP-powered references, symbols, and rename previews.
- **Project-scoped artifacts**: durable `.limitless/artifacts/` workspaces can be empty or hold notes, source files, assets, and generated outputs.
- **Global Git hygiene**: Home Manager adds `.limitless/` to Git's global ignore file by default, so project-local clones and artifacts stay out of repository status.
- **Typst document generation**: create artifacts from built-in Typst templates and compile them to PDF with the packaged Typst binary.
- **Unified research agent**: the read-only `research` agent handles local repo discovery, docs, APIs, current references, and optional project-cached GitHub source research in one place.
- **Ready language servers**: common TypeScript, Biome, Markdown, TOML, Nix, JSON, and YAML language servers are configured by default.
- **Optional Linear MCP**: Home Manager writes the remote Linear MCP entry directly when enabled; OpenCode reads `LINEAR_API_KEY` from its process environment.
- **Claude subscription OAuth**: the Limitless plugin registers a native OpenCode 2 Claude Pro/Max connection method by default, with an explicit opt-out.
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

  git.ignoreStorage = true;

  anthropicSubscriptionAuth.enable = true;

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
      permission = true;
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

`git.ignoreStorage` enables Home Manager's Git module by default and adds `.limitless/` to the global ignore file. Set it to `false` if a repository should manage that directory itself.

### Claude Pro/Max subscription authentication

`anthropicSubscriptionAuth.enable` defaults to `true`. After activating the Home Manager configuration, fully restart OpenCode, select the Anthropic integration's **Claude Pro/Max subscription** method, complete the browser flow, and paste the returned authorization code. This OpenCode 2 adapter deliberately does not migrate OpenCode 1 credentials, so one fresh login is required. OpenCode owns the credential and durably persists refresh-token rotation through its native integration lifecycle; Limitless does not create a private credential file.

The adapter supports only Claude Pro/Max subscription OAuth. OpenCode's normal Anthropic API-key connection remains available and is not transformed; Limitless does not add manual-key or console API-key creation methods. To turn the adapter off, first disconnect/remove its existing **Claude Pro/Max subscription** connection in OpenCode, then set `anthropicSubscriptionAuth.enable = false` and fully restart OpenCode. If the option is disabled while that OAuth connection still exists, Limitless warns and blocks Anthropic models so the lingering OAuth access token cannot be sent through the normal API-key path as `x-api-key`.

> [!WARNING]
> Anthropic has stated that using Claude Pro/Max subscriptions through third-party clients may violate its terms of service. Enable or leave this integration enabled only after evaluating that risk; Anthropic may change or block the flow without notice.

The OAuth and request-compatibility implementation is derived from [`@ex-machina/opencode-anthropic-auth` 1.8.1](https://github.com/ex-machina-co/opencode-anthropic-auth), copyright 2026 Ex Machina, under the MIT License. Limitless owns the OpenCode 2 port and retains the upstream license at `packages/limitless/integrations/anthropic-auth/LICENSE.ex-machina`; it neither deep-imports that package nor carries it as a runtime dependency.

The checked-in `opencode/opencode.json` and generated Home Manager file use only native OpenCode 2 fields. Limitless deep-merges native `opencode.settings`, then enforces the `limitless` default agent, the ordered `opencode.permissions` rules, the managed-repository edit denial, and the direct Effect plugin declaration.

When `mcp.linear.enable` is true, Home Manager adds Linear at `mcp.servers.linear` with `disabled = false`, `oauth = false`, and `Authorization = "Bearer {env:LINEAR_API_KEY}"`. No Linear plugin or generated secret is involved; `LINEAR_API_KEY` must be present in the `opencode2` process environment at runtime.

The Limitless plugin uses `Plugin.define`, `Tool.make`, Effect Schema contracts, scoped event and process lifecycles, and native Effect interruption. All 16 tools are registered directly with `codemode = false`. Every call resolves its OpenCode session and uses exactly `session.location.directory` as the project root; Limitless does not discover a Git root or expose a root override.

Language-server definitions for Limitless tools come only from validated Home Manager-generated plugin `options.lsp`. The tools intentionally do not read or merge effective OpenCode configuration, so project-local `lsp` overrides can affect OpenCode's own LSP behavior but are not observed by Limitless tools.

Home Manager installs skills in the native global OpenCode 2 location, `~/.config/opencode/skills`. Service mode runs `opencode2 serve --service`, which registers its generated credential in OpenCode's state directory; the shell alias uses normal managed-service discovery to connect with that credential.

The packaged GPT-5.6 Luna, Sol, and Terra models use the 400k short-context limits by default. Separate `-long` and `-fast-long` aliases advertise a conservative 500k context limit to OpenCode so compaction starts before the provider's full 1.05M window is exhausted. OpenAI does not officially support long context with Priority processing, so a Fast Long request may be downgraded to the default service tier.

OpenCode 2 has no native equivalent for the former OpenAI response-header timeout option. Limitless therefore drops the old 60-second override rather than placing an unsupported value in provider settings. This is the narrow beta cutover decision until OpenCode 2 exposes a supported equivalent.

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

`github_clone` is available to every agent. It creates depth-one snapshots under the active session directory's `.limitless/repos/` directory and returns both relative and absolute paths plus the resolved commit. Calls without `ref` use a stable `github-owner-repo` directory and refresh the repository's current default branch every time. Branches, tags, and commit SHAs use deterministic ref-suffixed directories, so snapshots for different refs do not collide. Existing checkouts are refreshed only when their identity, clean HTTPS origin, tracked files, untracked files, and recursively initialized submodules are clean; dirty state is never overwritten. Initial clones are assembled in a same-directory staging path and atomically published, so a failed first clone leaves no final checkout.

Accepted submodules are rewritten to clean HTTPS origins locally and initialized one level at a time with shallow fetches so each transitive repository is validated before Git can access it. Managed repositories are read-only supporting source: clone first, then use local read, glob, grep, or ast-grep search against the returned path. The generated OpenCode `edit` policy denies normal edit, write, and patch operations beneath `.limitless/repos/`; this is an agent guardrail rather than an operating-system sandbox, so unrestricted shell commands remain capable of bypassing it. Git LFS smudging is disabled, so pointer files are present but LFS objects are not downloaded or materialized.

## Deterministic review skill

The packaged `review-general` skill checks repository-defined formatting, lint, compilation, type safety, tests, and diff hygiene when explicitly named. It treats checked-in scripts and CI as authoritative and does not invent subjective standards. Add narrower review skills for framework, security, accessibility, or domain-specific rules.

## Attention notifications

Enable a native Limitless command hook without adding a separate OpenCode notifier plugin:

```nix
programs.limitless.notifications = {
  enable = true;
  command = [ "notify-send" "OpenCode needs attention" ];
  events.complete = true;
  events.permission = true;
  events.question = true;
};
```

The command is executed directly, without a shell. Permission and question notifications consume `permission.v2.asked` and `question.v2.asked`. Completion notifications consume all terminal execution events: succeeded, failed, and interrupted executions all require attention. Child/subagent terminal notifications are skipped by default after resolving the session's `parentID`.

## Artifacts and documents

Limitless stores durable project-local work products under `.limitless/artifacts/`. Create an empty artifact for ad hoc notes or files, or instantiate one from a top-level `templates/<name>/` folder. Artifacts are rooted at the active session's `location.directory`; the creating session is also recorded in the manifest metadata.

The Limitless plugin exposes:

- `artifact_create`: create a durable artifact workspace.
- `artifact_list`: list artifact workspaces for the current project.
- `artifact_templates_list`: inspect built-in artifact templates.
- `artifact_template_read`: read a built-in template file without creating an artifact (e.g. the `sphere-showcase` authoring reference).
- `typst_compile`: compile a document artifact to PDF.

Artifact templates are plain directories with a small `manifest.json`; `artifact_create` copies the folder contents into a new artifact and writes the artifact manifest. A template may declare a `framework` (a directory under top-level `frameworks/<name>/`); its files are composed into the artifact first, so document workspaces stay fully self-contained and keep compiling identically even after the plugin updates. Typst is handled separately by `typst_compile`, which compiles an artifact entry such as `main.typ` into `dist/`.

Document artifacts are source-first: edit `main.typ` directly, compose with framework `.typ` modules such as `sphere.typ` and its `sphere/` files when present, and place charts/images/assets under `assets/`. The Sphere framework is opinionated about assembly: cards, charts, and panels placed in a `sphere-grid` or `sphere-two-column` are measured and stretched to equal heights per row, charts auto-scale, and every evidence-bearing component takes a `source:` that feeds the `sphere-lint()` QA page. Built-in templates: `brief` (plain default), `sphere` (Sphere-branded institutional starter on the shared `sphere` framework), and `sphere-showcase` (a complete example institutional document — cover, executive summary, market, architecture, comparison, proof, roadmap, risk, and QA pages — that doubles as the component reference). New Sphere document types (PRDs, PR/FAQs, memos) are added by dropping a new `templates/<name>/` folder that reuses the framework.

## Maintainers

Use `nix develop`, then run the scripts in `package.json`. `bun run ci` is the full local gate. Runtime, plugin SDK, schema, and Effect are pinned to `opencode2`/`@opencode-ai/*@0.0.0-next-16040` and `effect@4.0.0-beta.98`; update them together because beta APIs and storage remain volatile.

For structure and implementation details, see the module options in `nix/modules/home.nix`.
