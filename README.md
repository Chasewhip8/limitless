# Limitless

> A Home Manager module for a ready-to-use OpenCode 2.0 beta agent workspace.

Limitless is decisively cut over to the volatile OpenCode 2.0 beta at
`0.0.0-beta-19124`. It has no OpenCode 1 runtime, configuration, plugin, or
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
- **Anthropic subscription authentication**: a native OpenCode 2 plugin adds Claude Pro/Max OAuth while preserving normal `anthropic/*` models and API-key behavior.
- **No ambient Vertex selection**: `google-vertex` and `google-vertex-anthropic` are disabled by default so credentials discovered through Google ADC cannot make them selectable; set `programs.limitless.providers.disabled = [ ];` to opt back in.
- **Default agent workflow**: OpenCode starts with `limitless` as the primary agent; planning stays in the main context while specialist subagents handle research, Oracle second opinions, read-only review, and mechanical execution. Native nested delegation is capped at depth 2.
- **Reusable skills**: generic local skills are copied from the top-level `skills/` directory, while companion tool skills are installed with their tools for Effect guidance and browser automation.
- **Local code intelligence**: the Limitless plugin adds ast-grep search/replace, TypeScript/Biome diagnostics, and LSP-powered references, symbols, and rename previews.
- **Project-scoped artifacts**: durable `.limitless/artifacts/` workspaces can be empty or hold notes, source files, assets, and generated outputs.
- **Global Git hygiene**: Home Manager adds `.limitless/` to Git's global ignore file by default, so project-local clones and artifacts stay out of repository status.
- **Typst document generation**: create artifacts from built-in Typst templates and compile them to PDF with the packaged Typst binary.
- **Unified research agent**: the read-only `research` agent handles local repo discovery, docs, APIs, current references, and optional project-cached GitHub source research in one place.
- **Ready language servers**: common TypeScript, Biome, Markdown, TOML, Nix, JSON, and YAML language servers are configured by default.
- **Optional Linear MCP**: Home Manager writes the remote Linear MCP entry directly when enabled; OpenCode reads `LINEAR_API_KEY` from its process environment.
- **Optional Atlassian, Notion, and Sentry CLIs**: install each CLI with its companion skill and runtime token-file authentication.
- **Native attention hooks**: optionally run a system command when a session completes or the question tool prompts the user.
- **Optional Slack bridge**: connect one repository and configurable agent to mentioned Slack threads over Socket Mode, including progress updates, attachments, steering, and cancellation.
- **Safer agent permissions**: common work is allowed, while credential access, destructive git operations, broad deletion, publishing, privilege escalation, and infrastructure mutations ask first.
- **Optional service mode**: OpenCode can run as a user service with a shell alias that attaches from the current directory.

## Default configuration

```nix
programs.limitless = {
  enable = true;

  opencode = {
    disableClaudeCode = false;
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

  plugins.anthropicAuth.enable = true;

  git.ignoreStorage = true;

  tools = {
    acli = {
      enable = false;
      site = null;
      email = null;
      tokenFile = null;
    };
    agentBrowser.enable = true;
    effectSolutions.enable = true;
    notion = {
      accounts = {};
      defaultAccount = null;
      enable = false;
      tokenFile = null;
    };
    sentry = {
      enable = false;
      tokenFile = null;
    };
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

  slack = {
    enable = false;
    repository = null;
    agent = "gary";
    botTokenEnv = "SLACK_BOT_TOKEN";
    appTokenEnv = "SLACK_APP_TOKEN";
    environmentFile = null;
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

`tools.agentBrowser.enable` and `tools.effectSolutions.enable` default to `skills.enable`. Set either tool explicitly to install the CLI without installing skills. Atlassian CLI, Notion CLI, and Sentry are opt-in; enabling one also installs its companion skill when skills are enabled.

For non-interactive Jira Cloud authentication, set `tools.acli.site`, `tools.acli.email`, and `tools.acli.tokenFile`. The token file is read lazily and never copied into the Nix store or process arguments. The wrapper keeps ACLI's generated profile under the per-user runtime directory and reauthenticates after a reboot or token-file change.

Notion support uses the official beta `ntn` CLI. Enable it with:

```nix
programs.limitless.tools.notion = {
  enable = true;
  tokenFile = config.age.secrets.notion-api-token.path;
};
```

The wrapper reads `tokenFile` for each command and passes it through the CLI environment as `NOTION_API_TOKEN`; it is never copied into the Nix store, generated OpenCode configuration, or process arguments. Without `tokenFile`, authenticate interactively with `ntn login`. The companion skill prefers Markdown page operations and bounded JSON queries, and requires reading pages before destructive replacements or trashing.

For separate Notion accounts, configure named token files instead of the single `tokenFile`:

```nix
programs.limitless.tools.notion = {
  enable = true;
  accounts = {
    work.tokenFile = config.age.secrets.notion-work.path;
    personal.tokenFile = config.age.secrets.notion-personal.path;
  };
  defaultAccount = "work";
};
```

This installs `ntn-work` and `ntn-personal`; the unqualified `ntn` command uses `defaultAccount`. Named account commands read only their own token file. Account names may contain letters, numbers, underscores, and hyphens and must start with a letter or number.

Sentry support requires a runtime token file:

```nix
programs.limitless.tools.sentry = {
  enable = true;
  tokenFile = config.age.secrets.sentry-api-token.path;
};
```

The wrapper reads the file for each `sentry` command, exports it only to the CLI process, disables update checks, and prevents stored OAuth credentials from taking precedence. The packaged CLI scrubs token variables from child-process environments. Sentry's CLI is distributed under FSL-1.1-Apache-2.0, which Nixpkgs classifies as unfree; this flake allowlists only its own `sentry` derivation.

`git.ignoreStorage` enables Home Manager's Git module by default and adds `.limitless/` to the global ignore file. Set it to `false` if a repository should manage that directory itself.

Set `opencode.disableClaudeCode = true` to launch both the installed OpenCode 2 CLI and optional server with `OPENCODE_DISABLE_CLAUDE_CODE=1`.

The checked-in `opencode/opencode.json` and generated Home Manager file use only native OpenCode 2 fields. Limitless deep-merges native `opencode.settings`, then enforces the `limitless` default agent, the ordered `opencode.permissions` rules, the managed-repository edit denial, and direct Effect plugin declarations.

## Anthropic subscription authentication

Anthropic authentication is enabled by default. Run `/connect`, select Anthropic, and choose **Claude Pro/Max** to complete the hosted PKCE code flow. Limitless packages the OpenCode 2 implementation from [`ex-machina-co/opencode-anthropic-auth` PR 211](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/211), pinned to commit `f043583c24085c60fc7f95059f2d6f36f44f4a8e`. Subscription credentials use its Claude Code-compatible request hooks, while API keys and `ANTHROPIC_API_KEY` retain standard Anthropic request behavior.

> [!WARNING]
> Anthropic does not officially support using Claude Pro/Max subscriptions through OpenCode. This reverse-engineered compatibility path may violate Anthropic's terms or put an account at risk. Disable it with `programs.limitless.plugins.anthropicAuth.enable = false` if you do not accept that risk.

OpenCode 2 stores one saved credential per integration. Connecting Max replaces a saved Anthropic API key, and reconnecting a key replaces Max; environment and configured keys remain fallbacks when no saved credential is active. The V1 plugin's OAuth-based **Create an API Key** method is intentionally omitted because the V2 public integration API cannot faithfully persist a key from an OAuth callback. OpenCode continues to display Anthropic API prices for subscription-backed models because the upstream V2 plugin does not rewrite the model catalog.

OAuth credentials created by the earlier experimental Limitless integration use a different method ID and are not recognized by the upstream plugin. Reconnect **Claude Pro/Max** once after upgrading.

PR 211 targets `@opencode-ai/plugin@0.0.0-next-17444`. The compatibility profile identifies as Claude Code `2.1.87`, and refresh rotation is deduplicated within one OpenCode process. `ANTHROPIC_BASE_URL` can override the request endpoint. `ANTHROPIC_INSECURE` cannot disable TLS verification through the V2 hooks and only produces a warning.

When `mcp.linear.enable` is true, Home Manager adds Linear at `mcp.servers.linear` with `disabled = false`, `oauth = false`, and `Authorization = "Bearer {env:LINEAR_API_KEY}"`. No Linear plugin or generated secret is involved; `LINEAR_API_KEY` must be present in the `opencode2` process environment at runtime.

The Limitless plugin uses `Plugin.define`, `Tool.make`, Effect Schema contracts, scoped event and process lifecycles, and native Effect interruption. Its 16 core tools and two Slack transport tools are registered directly with `codemode = false`. Every call resolves its OpenCode session and uses exactly `session.location.directory` as the project root; Limitless does not discover a Git root or expose a root override.

Language-server definitions for Limitless tools come only from validated Home Manager-generated plugin `options.lsp`. The tools intentionally do not read or merge effective OpenCode configuration, so project-local `lsp` overrides can affect OpenCode's own LSP behavior but are not observed by Limitless tools.

Home Manager installs skills in the native global OpenCode 2 location, `~/.config/opencode/skills`. Service mode runs `opencode2 serve --service`, which registers its generated credential in OpenCode's state directory; the shell alias uses normal managed-service discovery to connect with that credential.

The packaged GPT-5.6 Luna and Terra models use the 400k short-context limits by default. Separate `-long` and `-fast-long` aliases advertise a conservative 500k context limit to OpenCode so compaction starts before the provider's full 1.05M window is exhausted. GPT-6 Astra uses its full 1.05M context window for both Standard and Fast processing; Codex subscription usage does not apply an additional long-context multiplier above 272k input tokens, so Astra does not need separate long-context aliases.

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

The command is executed directly, without a shell. Permission notifications consume `permission.asked`; question and other interactive-form notifications consume `form.created`. Completion notifications consume all terminal execution events: succeeded, failed, and interrupted executions all require attention. Child/subagent terminal notifications are skipped by default after resolving the session's `parentID`.

## Slack bridge

The optional Slack bridge runs inside the persistent OpenCode 2 service and maps one deployment to one repository and one configured agent. It uses Slack Socket Mode, so the host needs outbound network access but no public HTTP endpoint.

```nix
programs.limitless = {
  opencode.service.enable = true;

  slack = {
    enable = true;
    repository = "/home/me/workspace";
    agent = "gary";
    environmentFile = "/run/agenix/limitless-slack-environment";
  };
};
```

The optional environment file is read by the systemd user service at runtime and is not copied into generated OpenCode configuration or the Nix store. It must define the configured token variables, which default to `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`.

Create an internal Slack app with Socket Mode enabled. Subscribe to the `app_mention` bot event and grant the app-level token `connections:write`. The bot token needs `app_mentions:read`, `chat:write`, `channels:history`, `groups:history` for private channels, `files:read`, and `files:write`. Install the bot and invite it to each channel where it should respond.

Slack turns use the hidden `gary` primary agent by default. Gary mirrors the normal Limitless workflow but carries Slack-specific transport, clarification, shared-checkout, and transcript-trust instructions. Its V2 permissions deny the blocking `question` tool, allow the Slack status and attachment tools, and restrict subagents to the configured specialists. Set `slack.agent` explicitly to select a different agent with an equivalent noninteractive policy.

Every turn requires an explicit bot mention. The bridge imports unseen thread messages, including unmentioned intervening replies, into the thread's OpenCode session. It accepts bounded PNG, JPEG, WebP, and GIF images; PDF documents; and UTF-8 text, Markdown, source, configuration, structured-data, log, and diff files. Unsupported, invalid, oversized, duplicate, and excess attachments become omission notes in agent context.

The bridge posts a `🧠 Thinking…` trace for each mention. The agent appends milestones through `slack_status`; follow-up mentions steer unread messages into the active V2 session. Final responses stream from terminal assistant-step events, while succeeded, failed, interrupted, and deleted execution events settle the turn. Mention `@bot cancel` or `@bot stop` to interrupt the active session, wait for OpenCode to confirm it is idle, and discard pending mentions in that thread. Permission requests from an active Slack session or child session are interrupted rather than left waiting for a local UI.

The Slack agent can use `slack_attach_file` to snapshot a readable local file and queue it for upload after the final text. Reattaching a path replaces its snapshot; cancellation and terminal failures discard queued files. This allows Slack users who can direct the configured agent to disclose any host file readable by the service account, including credentials and system configuration. Isolate that account accordingly.

Message admission is serialized within a Slack thread; different threads intentionally run concurrently against the same checkout. Thread-to-session mappings and delivery cursors are process-local, so a service restart starts fresh OpenCode sessions and reimports the visible Slack transcript. Slack authenticates the transport but Limitless accepts every mention the installed bot can receive. Limit workspace membership, bot channel access, host credentials, and repository permissions accordingly. Slack service integration currently requires Linux systemd user services.

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

Use `nix develop`, then run the scripts in `package.json`. `bun run ci` is the full local gate. Runtime, plugin SDK, native provider API, schema, and Effect are pinned to `opencode2`/`@opencode-ai/*@0.0.0-beta-19124` and `effect@4.0.0-rc.112`; update them together because beta APIs and storage remain volatile.

For structure and implementation details, see the module options in `nix/modules/home.nix`.
