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
- **Default agent workflow**: OpenCode starts with `limitless` as the primary agent; planning stays in the main context while specialist subagents handle research, Oracle second opinions, and implementation.
- **Reusable skills**: generic local skills are copied from the top-level `skills/` directory, while companion tool skills are installed alongside supported CLIs.
- **Local code intelligence**: the Limitless plugin adds ast-grep search/replace, TypeScript/Biome diagnostics, and LSP-powered references, symbols, and rename previews.
- **Project-scoped artifacts**: durable `.limitless/artifacts/` workspaces can be empty or hold notes, source files, assets, and generated outputs.
- **Global Git hygiene**: Home Manager adds `.limitless/` to Git's global ignore file by default, so project-local clones and artifacts stay out of repository status.
- **Typst document generation**: create artifacts from built-in Typst templates and compile them to PDF with the packaged Typst binary.
- **Unified research agent**: the read-only `research` agent handles local repo discovery, docs, APIs, current references, and optional project-cached GitHub source research in one place.
- **Ready language servers**: common TypeScript, Biome, Markdown, TOML, Nix, JSON, and YAML language servers are configured by default.
- **Optional Linear MCP**: Linear remains opt-in and reads `LINEAR_API_KEY` from the OpenCode process environment.
- **Optional Sentry CLI**: install Sentry's agent-oriented CLI and companion skill with lazy agenix token-file authentication.
- **Native attention hooks**: optionally run a system command when a session completes or the question tool prompts the user.
- **Optional Slack bridge**: connect one repository and configurable agent to mentioned Slack channel threads over Socket Mode, including progress updates, images, and cancellation.
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

`tools.agentBrowser.enable` and `tools.effectSolutions.enable` default to `skills.enable`. Set either tool explicitly to install the CLI without installing skills. `tools.acli.enable` is opt-in because Atlassian CLI is proprietary; enabling it also installs a brief Jira orientation skill when skills are enabled. `tools.sentry.enable` is also opt-in and installs Sentry's official `sentry` CLI plus a concise Limitless companion skill when skills are enabled.

For non-interactive Jira Cloud authentication, set `tools.acli.site`, `tools.acli.email`, and `tools.acli.tokenFile`. The token file may be an agenix runtime path and is read lazily on the first Jira command without copying the value into the Nix store or process arguments. ACLI may retain its credential in the operating-system keyring; its generated profile configuration is kept under the per-user runtime directory. The wrapper reauthenticates after a reboot or token-file change. OpenCode shell permissions remain authoritative and Limitless does not add ACLI-specific prompts.

Sentry support requires a runtime token file:

```nix
programs.limitless.tools.sentry = {
  enable = true;
  tokenFile = config.age.secrets.sentry-api-token.path;
};
```

The wrapper reads the file for every `sentry` command, exports the value as `SENTRY_AUTH_TOKEN` in the CLI process, and forces that token to take precedence over stored OAuth credentials. The packaged CLI scrubs Sentry token variables from child-process environments. The value is never copied into the Nix store, generated configuration, or process arguments. Limitless sets no global organization or project; the CLI still applies its normal precedence across ambient environment variables, global and repository `.sentryclirc` files, persistent defaults, and DSN detection. Keep global defaults clear when relying on repository detection, and provision the token with the least privileges those repositories need. The companion skill permits routine investigation but requires explicit user intent and verified targets for mutations, including Seer analysis or plan generation. Sentry's CLI is distributed under FSL-1.1-Apache-2.0, which Nixpkgs classifies as unfree; this flake allowlists only its own `sentry` derivation rather than enabling unfree packages generally.

`git.ignoreStorage` enables Home Manager's Git module by default and adds `.limitless/` to the global ignore file. Set it to `false` if a repository should manage that directory itself.

Set `opencode.disableClaudeCode = true` to launch both the installed OpenCode CLI and the optional server with `OPENCODE_DISABLE_CLAUDE_CODE=1`.

The checked-in `opencode/opencode.json` is the base OpenCode configuration. Limitless deep-merges generated permissions and enabled language servers over that base, then deep-merges `opencode.settings` last. The `limitless` default agent remains enforced.

The packaged GPT-5.6 Luna, Sol, and Terra models use the 400k short-context limits by default. Separate `-long` and `-fast-long` aliases advertise a conservative 500k context limit to OpenCode so compaction starts before the provider's full 1.05M window is exhausted. OpenAI does not officially support long context with Priority processing, so a Fast Long request may be downgraded to the default service tier.

Limitless raises OpenCode's OpenAI response-header timeout from 10 seconds to 60 seconds. Large auto-compaction requests can take longer than the upstream default to be accepted; timing them out leaves a pending compaction that is only retried when the session runs again. Override `provider.openai.options.headerTimeout` through `opencode.settings` if a different bound is needed.

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

## Deterministic review skill

The packaged `review-general` skill checks repository-defined formatting, lint, compilation, type safety, tests, and diff hygiene when explicitly named. It treats checked-in scripts and CI as authoritative and does not invent subjective standards. Add narrower review skills for framework, security, accessibility, or domain-specific rules.

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

## Slack bridge

The optional Slack bridge runs inside the persistent OpenCode service and maps one deployment to one repository and one configured agent. It uses Slack Socket Mode, so the VM needs outbound network access but no public HTTP endpoint. Enable it with:

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

The optional environment file is read by the systemd user service at runtime and is not copied into generated OpenCode configuration or the Nix store. It must define the configured token variables, which default to:

```sh
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

Create an internal Slack app with Socket Mode enabled. Subscribe to the `app_mention` bot event and grant the app-level token `connections:write`. The bot token needs `app_mentions:read`, `chat:write`, `channels:history`, `groups:history` for private channels, and `files:read`. Install the bot to the workspace and invite it to every channel where it should respond.

Slack turns use the hidden `gary` primary agent by default. Gary mirrors the normal Limitless agent but carries the Slack transport, clarification, shared-checkout, and transcript-trust instructions in its own prompt. The bridge still disables the blocking `question` tool as a transport safety constraint. Set `slack.agent` explicitly to select a different agent.

Every turn requires an explicit bot mention. On each mention the bridge imports all unseen thread messages, including unmentioned intervening replies, into the thread's OpenCode session. The bridge supports message text and up to four Slack-hosted PNG, JPEG, WebP, or GIF images per turn, with a 10 MiB limit per image. Unsupported and excess attachments are represented by omission notes in agent context.

The bridge posts a `🧠 Thinking…` trace for each mention. The selected agent appends milestones to the latest trace through `slack_status`; prior traces remain frozen in place. A mention received while the agent is working immediately steers all unread thread messages into the active OpenCode run and moves subsequent status updates to a new trace below those messages. Final responses, cancellations, and errors are posted separately, and Markdown responses that exceed Slack's 12,000-character field limit are split into ordered messages. Mention `@bot cancel` or `@bot stop` to abort the active run and discard locally pending mentions in that thread. The built-in OpenCode question tool is disabled for Slack turns; the agent asks for clarification in its final reply and continues after the next mention. Permission prompts raised by a Slack turn or its child sessions are denied rather than left waiting for a nonexistent local UI.

Message admission is serialized within a Slack thread, while follow-up mentions steer the active run at OpenCode's next safe boundary. Completed responses are delivered in transcript order even when steering keeps the OpenCode session busy, and a mention that arrives during final publication starts the next turn instead. Different threads intentionally run concurrently against the same checkout, so the configured agent must account for shared mutable repository state. Thread-to-session mappings and delivery cursors are process-local: after a service restart, the next mention creates a fresh OpenCode session and re-imports the visible Slack transcript. Direct messages, durable delivery state, arbitrary files, channel/user allowlists, worktrees, and per-thread runtime isolation are not included.

Slack performs transport authentication, but Limitless intentionally accepts every mention the installed bot can receive. A broadly privileged configured agent therefore grants repository and VM command authority to those Slack users. Isolate the VM, limit its credentials and repository access, and configure the selected agent with deliberate allow/deny permissions. Slack support currently requires Linux because it depends on the managed systemd user service.

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
