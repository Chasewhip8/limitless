# Limitless

> A Home Manager module for a ready-to-use OpenCode 2 workspace.

Limitless pins OpenCode `2.0.12`, supplies coding agents and local code-intelligence
tools, and configures optional first-party MCP connections. OpenCode owns its
background service, OAuth credentials, Code Mode, browser integration, and TUI
notifications. Home Manager owns packages and non-secret configuration.

## Use it

```nix
{
  inputs.limitless.url = "github:your-org/limitless";

  outputs = { home-manager, limitless, ... }: {
    homeConfigurations.me = home-manager.lib.homeManagerConfiguration {
      modules = [
        limitless.homeModules.default
        { programs.limitless.enable = true; }
      ];
    };
  };
}
```

Run `opencode` from a project. It discovers or starts its native background
service. Connect model providers through `/connect`.

## Included capabilities

- **Agents:** `limitless`, `limitless-fast`, and `solo`, with research, technical
  and design Oracle advisers, and a worker for mechanical transformations.
- **Code intelligence:** ast-grep search and replacement, TypeScript/Biome
  diagnostics, and seven LSP tools for definitions, hover, implementations,
  call hierarchy, references, symbols, and rename previews.
- **Language servers:** TypeScript, Biome, JSON, YAML, Markdown, TOML, and Nix.
- **Artifacts:** project-scoped folders under `.limitless/artifacts/`.
- **Source research:** optional guarded GitHub checkouts under `.limitless/repos/`.
- **Service integrations:** optional Atlassian, Notion, Sentry, Linear, and GitHub
  MCP presets with account-specific connection names and conservative permissions.
- **Anthropic subscription authentication:** a pinned Claude Pro/Max plugin.
- **Git hygiene:** `.limitless/` is globally ignored by default.

The plugin exposes 13 core tools directly with `codemode = false`. MCP tools use
OpenCode's native Code Mode. Every Limitless tool resolves the invoking session's
`location.directory` as its project root.

## MCP connections

Each entry names one connection. Enable only the services you use:

```nix
programs.limitless.mcp.servers = {
  atlassian.preset = "atlassian";
  notion-work.preset = "notion";
  notion-personal.preset = "notion";
  sentry.preset = "sentry";
  linear.preset = "linear";
};
```

After applying Home Manager, run `/mcps`, select each connection, and sign in.
Connections are ready only when OpenCode reports them as connected. Notion work
and personal entries have separate OAuth identities even though their URLs match;
authorize the intended workspace for each. Renaming a connection creates a new
credential identity. Token refresh and OAuth state belong to OpenCode.

`settings` overlays the preset using native OpenCode V2 server fields. For example:

```nix
programs.limitless.mcp.servers.sentry = {
  preset = "sentry";
  settings.timeout.execution = 120000;
};
```

Set `settings.disabled = true` to retain a configured connection without connecting
it. Additional servers can use `programs.limitless.opencode.settings.mcp.servers`.
Use one configuration path per server name. Native-only servers receive the same
approval policy, with no automatic read exceptions.

### GitHub authentication

The hosted GitHub server requires an explicitly configured registered OAuth client
or a PAT. Generic OAuth discovery alone is insufficient. For a registered client:

```nix
programs.limitless.mcp.servers.gh = {
  preset = "github";
  settings.oauth.client_id = "{env:GITHUB_MCP_CLIENT_ID}";
};
```

Include the native `oauth.client_secret` and callback settings when required by
your registered application. Alternatively, supply a PAT through the OpenCode
process environment:

```nix
programs.limitless.mcp.servers.gh = {
  preset = "github";
  settings = {
    oauth = false;
    headers.Authorization = "Bearer {env:GITHUB_MCP_TOKEN}";
  };
};
```

Keep token values out of Nix expressions and generated files. Ensure the credential
is available to the background service; exporting a variable in a new terminal
does not change an already-running service's environment. The preset enables
context, repository, issue, pull-request, and Actions toolsets. GitHub MCP
authentication is separate from Git clone/fetch/push credentials and the guarded
research clone configuration below. Limitless does not install `gh`.

Use `gh` or `github-mcp` as the connection name. The name `github` overlaps the
local `github_clone` tool. The module rejects overlapping tool namespaces and
account prefixes such as `notion` plus `notion_work`; use `notion-work` instead.

### Permissions and coverage

For every configured MCP server, Limitless appends an `ask` rule and then exact
exceptions for audited read tools. The research agent receives `deny` followed by
the same read exceptions. New tools, mutations, and indirect tool executors require
approval for the primary agent and are unavailable to research. Research also
denies shell execution and edits.

`readTools` replaces a preset's exact read-tool list. Add names only after checking
their behavior and the authenticated catalog. Wildcards are rejected. Linear does
not publish a canonical tool inventory, so its preset starts with an empty list:
all primary-agent calls ask, and research has no Linear tools until verified names
are configured. The optional `https://mcp.linear.app/mcp/readonly` endpoint can
further restrict a connection at the server.

These are agent permission defaults, not an operating-system sandbox. Later
project configuration or agent definitions can override global permissions.
Project-local MCP additions need their own permission rules. A configured server
must be trusted to implement its advertised read operations correctly.

| Preset | Daily workflows | Coverage limits |
| --- | --- | --- |
| [Atlassian](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/) | Jira and Confluence search, reads, edits, comments, transitions | Organization policies and enabled tool groups determine access. Uses the v2 flat catalog. |
| [Notion](https://developers.notion.com/guides/mcp/mcp-supported-tools) | Pages, databases, comments, queries, uploads | Workers deployment and generic API administration are outside this preset. Tools can depend on plan. |
| [Sentry](https://docs.sentry.io/product/sentry-mcp/) | Issues, events, traces, debugging | Release/symbol uploads and broad administration require dedicated tooling. Indirect catalog execution asks. |
| [Linear](https://linear.app/docs/mcp) | Issues, projects, comments | Exact read exceptions require authenticated discovery. |
| [GitHub](https://github.com/github/github-mcp-server) | Repositories, issues, PRs, reviews, Actions | Local Git and release uploads require separate tooling and authentication. |

Before relying on a new connection, verify account identity, a representative read,
an explicitly approved write, mutation denial in research, and token refresh. The
repository checks generated configuration and policy behavior; account entitlements
and live upstream tool catalogs require this authenticated verification.

## Configuration and layout

```text
nix/modules/
├── home.nix       # composition and Git hygiene
├── opencode.nix   # runtime, agents, plugins, and configuration assembly
├── lsp.nix        # language-server packages and plugin configuration
└── mcp.nix        # named connections and permission generation
nix/mcp-presets.nix # first-party endpoints and audited read-tool names
opencode/          # native defaults, agents, and shared instructions
packages/limitless/ # code-intelligence tools, artifacts, source research, policies
```

Native server settings go in `programs.limitless.opencode.settings`. Limitless
enforces the default agent, managed plugins, ordered permissions, generated MCP
policies, and the managed-checkout edit denial. `opencode.extraAgentsFile` appends
additional instructions. `opencode.disableClaudeCode = true` wraps the executable
with `OPENCODE_DISABLE_CLAUDE_CODE=1`.

Configure language servers through `programs.limitless.lsp`: `enable`,
`servers.<name>.{enable,package,command,args,extensions,env}`, `extraServers`, and
`extraPackages`. Limitless owns these definitions in plugin `options.lsp`.
Project-local OpenCode `lsp` settings do not change Limitless's tools.

`skills.package` can supply your own skill directories; `skills.enable = false`
disables installation. The default package copies a top-level `skills/` directory
when present and is otherwise empty. OpenCode's built-in skills remain available.

## Agents and models

`limitless` uses Standard processing for eligible OpenAI subagents;
`limitless-fast` uses Fast processing. Both default to `openai/gpt-6-astra#xhigh`,
and the main model remains independently selectable. `solo` denies delegation.
OpenCode remembers a model per primary agent.

`agents.fastSubagents` defaults to `[ "oracle-solve" "research" "worker" ]`.
An empty list disables the overrides. Research and worker use
`openai/gpt-5.6-sol#medium`; the technical Oracle uses Astra; the design Oracle uses
Fable. Planning stays in the primary context, research gathers evidence, Oracle
agents advise, and worker performs specified mechanical transformations.

The plugin resolves the root profile on every eligible child request, including
nested and resumed sessions. Context, compaction, and transient generation hooks
set the service tier without changing the stored model reference. Requests already
dispatched retain their tier. Fast processing depends on provider availability and
pricing. Other primary agents and unlisted subagents retain their configured tier.

The model defaults retain short/long-context Luna and Terra aliases and Astra's
full 1.05M context window. `providers.disabled` defaults to
`[ "google-vertex" "google-vertex-anthropic" ]` to avoid ambient Vertex selection.

## Anthropic subscription authentication

Run `/connect`, select Anthropic, and choose **Claude Pro/Max**. The plugin is pinned
to [`ex-machina-co/opencode-anthropic-auth`](https://github.com/ex-machina-co/opencode-anthropic-auth)
commit `c6921e486e9d180b1c2ace318211f7156a5f09b0`. API-key authentication retains
standard Anthropic request behavior.

> [!WARNING]
> Anthropic does not officially support using Claude Pro/Max through OpenCode.
> This compatibility path may violate its terms or put an account at risk.
> Disable it with `programs.limitless.plugins.anthropicAuth.enable = false`.

Connecting Max replaces the saved Anthropic API-key credential and vice versa.
Credentials from the earlier experimental Limitless plugin require signing in
again. OpenCode continues to display API prices for subscription models.
The upstream plugin targets SDK `2.0.4` and identifies as Claude Code `2.1.258`;
`ANTHROPIC_CLAUDE_CODE_VERSION` can update that compatibility identifier. Refresh
rotation is deduplicated within a process. `ANTHROPIC_BASE_URL` can override the
endpoint; `ANTHROPIC_INSECURE` cannot disable TLS verification.

## Guarded source research

```nix
programs.limitless.github = {
  enable = true;
  allowedRepos = [ "owner/repo" ];
  tokenFile = "/run/agenix/github-read-token";
};
```

Without `tokenFile`, the tool reads `tokenEnv`, which defaults to `GITHUB_TOKEN`.
Use a fine-grained read-only token for private repositories. The token is passed
to Git through ephemeral github.com-scoped environment configuration and never
written to URLs, arguments, tool results, or repository configuration.

`allowedRepos` must be nonempty unless `allowUnrestrictedRepos = true`. The policy
also covers every transitive submodule; non-GitHub hosts are rejected. Clones are
depth-one, project-local snapshots. Default-branch requests refresh immediately;
explicit branches, tags, and SHAs use distinct deterministic paths. Dirty checkouts
are never overwritten. New clones are staged and published atomically. LFS objects
are not materialized.

Managed repositories are read-only supporting source. The edit policy denies
normal writes below `.limitless/repos/`; shell access is not sandboxed. Set
`git.ignoreStorage = false` if the repository should manage `.limitless/` itself.

## Artifacts

`artifact_create` creates a project-local folder under `.limitless/artifacts/` with
a manifest recording its slug, optional title, timestamp, and creating session.
Use normal file tools to add notes, source, assets, or generated outputs.
`artifact_list` reports valid artifacts and folders with invalid/missing manifests.
Explicit duplicate slugs fail; generated slugs include a random suffix. Failed
creation cleans up only its own incomplete manifest and empty folder.

## Native service, notifications, and browser

Use `opencode service status` and `opencode service restart` to manage the native
background service. TUI preferences remain in `~/.config/opencode/cli.json`.
Enable attention notifications through the TUI settings or merge this into that
file:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "attention": { "notifications": true }
}
```

Native browser tools require the session to be open in the desktop app with the
experimental browser setting enabled. A TUI-only session has no attached browser.

## Migration from the previous Limitless layout

This release removes these options and packages:

| Removed | Migration |
| --- | --- |
| `slack.*`, Gary, Slack tools | Remove Slack configuration and retire its bot credentials when no longer used. |
| `tools.agentBrowser.*`, `agent-browser` package/skill | Use OpenCode's desktop-backed browser when needed. |
| `tools.acli.*`, Atlassian CLI skill | Add an `atlassian` MCP connection and authorize it. |
| `tools.notion.*`, `notion-cli` package/skill | Add separately named `notion` MCP connections for each workspace. |
| `tools.sentry.*`, `sentry` package/skill | Add a `sentry` MCP connection. Install specialized release tooling separately if required. |
| `mcp.linear.enable` | Set `mcp.servers.linear.preset = "linear"` and sign in through `/mcps`. |
| `notifications.*` | Use native TUI attention settings; arbitrary command hooks are retired. |
| `opencode.service.*` and its attach alias | Use native OpenCode service discovery and service commands. |

If the old `opencode.service` systemd unit is running, stop it before applying the
new Home Manager generation. Remove the retired option definitions, apply the
generation, then launch OpenCode and check `opencode service status`. Do not run
both service owners concurrently. This repository does not activate Home Manager,
stop running sessions, migrate OAuth grants, or delete existing credential files.

For an existing Linear API key, the connection's native settings can explicitly
set `oauth = false` and `headers.Authorization = "Bearer {env:LINEAR_API_KEY}"`.
Default connections use OAuth. Former CLI token files are not imported into MCP
authentication; authorize and verify each new connection before retiring tokens.

OpenCode 1 sessions are not migrated. Back up OpenCode state and record your flake
revision before switching major versions. Rollback requires the matching runtime
and state backup; never run V1 and V2 against the same writable state directory.

## Development

Use `nix develop`, then `bun install --frozen-lockfile` and `bun run ci`. The gate
runs formatting/lint checks, TypeScript, tests, module checks, and all five package
builds. Nix module checks exercise named accounts, native settings, authentication
requirements, namespace collisions, and read/write permission outcomes.

Runtime, Limitless plugin SDK, and schema are pinned to `2.0.12`, with
`effect@4.0.0-rc.112`; update them together. Re-audit native capabilities and MCP
read exceptions when upgrading. Vendor references for the current allowlists are
linked in the integration table above.
