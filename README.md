# Limitless

> A Home Manager module for a ready-to-use OpenCode 2 workspace.

Limitless pins OpenCode `2.0.12`, supplies coding agents and local code-intelligence
tools, and configures optional first-party MCP connections. OpenCode owns its
service discovery, OAuth credentials, Code Mode, browser integration, and native
notification delivery. Home Manager owns packages and non-secret configuration, with
optional Linux service supervision.

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

Native browser tools are currently disabled for all agents through a shared
permission rule. They require the OpenCode desktop app's attached browser and
fail in TUI-only sessions.

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
  MCP presets with account-specific connection names and read-only research access.
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
role-based permissions, with no automatic read exceptions for research.

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

Tool access follows the agent's role:

| Agents | Access |
| --- | --- |
| `limitless`, `limitless-fast`, `solo`, `worker`, `oracle-solve`, `oracle-design` | Automatic approval for reads, writes, shell commands, and all MCP tools |
| `research` | Local read tools and audited MCP reads; deny shell, edits, AST replacement, artifact creation, and session changes |

For each configured MCP server, research receives a `deny` rule followed by
exact exceptions for audited read tools. Unknown tools, mutations, and mixed-purpose
executors are unavailable to research. Read tools such as web fetch and artifact
listing inherit the global allow rule.

Sensitive-file reads and potentially destructive shell commands no longer have
default approval prompts. Shared instructions still require explicit user direction
for destructive work. Managed-checkout edits and native browser tools remain denied.

`readTools` replaces a preset's exact read-tool list for research.
Add names only after checking their behavior and the authenticated catalog.
Wildcards are rejected. The optional `https://mcp.linear.app/mcp/readonly` endpoint
can further restrict a Linear connection at the server. Linear's read-tool list
is empty until verified names from an authenticated catalog are configured.

These rules control named-tool access. Code Mode's raw HTTP `fetch` can still send
write requests, so research's read-only profile does not provide a sandbox. Later project
configuration or agent definitions can override global permissions. Project-local
MCP additions need their own permission rules. A configured server must be trusted
to implement its advertised read operations correctly.

| Preset | Daily workflows | Coverage limits |
| --- | --- | --- |
| [Atlassian](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/) | Jira and Confluence search, reads, edits, comments, transitions | Organization policies and enabled tool groups determine access. Uses the v2 flat catalog. |
| [Notion](https://developers.notion.com/guides/mcp/mcp-supported-tools) | Pages, databases, comments, queries, uploads | Workers deployment and generic API administration are outside this preset. Tools can depend on plan. |
| [Sentry](https://docs.sentry.io/product/sentry-mcp/) | Issues, events, traces, debugging | Release/symbol uploads and broad administration require dedicated tooling. Mixed-purpose catalog execution is unavailable to research. |
| [Linear](https://linear.app/docs/mcp) | Issues, projects, comments | Exact read exceptions require authenticated discovery. |
| [GitHub](https://github.com/github/github-mcp-server) | Repositories, issues, PRs, reviews, Actions | Local Git and release uploads require separate tooling and authentication. |

Before relying on a new connection, verify account identity, a representative read,
an explicitly requested write, mutation denial in research, and token
refresh. The repository checks generated configuration and policy behavior;
account entitlements and live upstream tool catalogs require this authenticated
verification.

## Configuration and layout

```text
nix/modules/
├── home.nix       # composition and Git hygiene
├── opencode.nix   # runtime, agents, plugins, and configuration assembly
├── service.nix    # optional Linux supervision and native service binding
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

Native terminal settings go in `programs.limitless.opencode.cliSettings`. The
launcher supplies them through `OPENCODE_CLI_CONFIG_CONTENT`; declared values
override matching preferences in `~/.config/opencode/cli.json`. An explicitly
supplied `OPENCODE_CLI_CONFIG_CONTENT` replaces the generated override. Apply
Home Manager and relaunch the TUI after changing these Nix settings.

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
release `v2.0.0-next.3`, commit `e03f023c8ea1771a829cee51024b8675ffede24c`. API-key authentication retains
standard Anthropic request behavior.

> [!WARNING]
> Anthropic does not officially support using Claude Pro/Max through OpenCode.
> This compatibility path may violate its terms or put an account at risk.
> Disable it with `programs.limitless.plugins.anthropicAuth.enable = false`.

Connecting Max replaces the saved Anthropic API-key credential and vice versa.
Credentials from the earlier experimental Limitless plugin require signing in
again. OpenCode continues to display API prices for subscription models.
The upstream plugin targets SDK `2.0.4` and reports Claude Code compatibility
version `2.1.280`. When Anthropic returns a structured newer-version requirement,
it adopts that exact minimum and permits one retry for the affected session,
agent, and model. Ordinary errors and rate limits do not trigger this recovery.

An optional override is available when an explicit version is required:

```nix
programs.limitless.plugins.anthropicAuth.claudeCodeVersion = "2.1.280";
```

The option defaults to `null`, preserving the bundled version and automatic
recovery. Setting a version supplies `ANTHROPIC_CLAUDE_CODE_VERSION` to both managed
and on-demand OpenCode servers and disables automatic version adoption. An
explicit environment value takes precedence. The plugin reads it at startup and
uses it for both the user-agent and billing metadata; apply Home Manager and restart
the OpenCode server after changing it. This setting controls the plugin's reported
compatibility version, independently of any installed Claude Code executable.

Refresh rotation is deduplicated within a process. `ANTHROPIC_BASE_URL` can override
the endpoint; `ANTHROPIC_INSECURE` cannot disable TLS verification.

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

## Native service and Tailscale

OpenCode starts its native background service on demand by default. Use
`opencode service status` and `opencode service restart` to inspect and manage it.

For automatic startup at user login and process supervision on Linux, enable the
Home Manager systemd user service:

```nix
programs.limitless.opencode.service = {
  enable = true;
  hostname = "127.0.0.1";
  port = 4096;
};
```

`hostname` defaults to `127.0.0.1`; `port` defaults to OpenCode's native `49374`.
Declare `4096` explicitly to retain an existing Tailscale proxy target:

```text
Tailscale HTTPS → 127.0.0.1:4096 → OpenCode
```

Reuse the declared port in your proxy configuration. The listener stays on
loopback, and OpenCode's native authentication still applies through the proxy.

The service persists hostname and port through native `opencode service` commands
when they differ, stops any existing native daemon, then runs `serve --service`
in the foreground. It preserves the private password, CORS configuration, and
configured service environment. Private service files remain writable and outside
the Nix store. Disabling supervision leaves the last persisted binding in place.

**Enabling, starting, or restarting this unit can interrupt active work and
persistent terminals.** The unit takes ownership of the shared native daemon.
While enabled, use systemd for lifecycle commands:

```sh
systemctl --user status opencode
systemctl --user restart opencode
systemctl --user stop opencode
```

`opencode service stop` is normally undone by supervision. A local OpenCode client
can still start a native daemon after the unit is stopped. Keep local clients on
the configured OpenCode version; clients that replace the daemon with another
version can conflict with supervision. Restarting a failed process is automatic;
this unit does not detect a live but unhealthy process.

Home Manager applies changed units automatically when `systemd.user.startServices`
is enabled. Changes to the runtime, binding, configuration, agents, or installed
skills trigger a restart. With service switching disabled, apply the suggested
systemd commands yourself.

The unit starts with the systemd user manager, normally at login. Boot startup is
optional: user lingering starts that manager before login and keeps it running
after logout. To opt in, set this in your **NixOS system configuration**:

```nix
users.users."your-user".linger = true;
```

On other systemd distributions, an administrator can enable lingering with
`loginctl enable-linger <your-user>`. Tailscale's proxy must also start at boot.

## Notifications and browser

Limitless enables sound by default and supplies a TUI handler that dings for:

- A newly completed final assistant response in a top-level session.
- A permission request.
- A question or other input prompt.

Completion requires successful execution, a normally finished answer, and an empty
inbox. Child completion, errors, interruptions, and compaction-only runs are silent.
A later background result can resume the main session and produce another response.
The handler uses OpenCode's native sound playback and preserves visual notifications
and error toasts. Configure sound, volume, and visual notifications through the
native CLI settings:

```nix
programs.limitless.opencode.cliSettings.attention = {
  sound = true;
  volume = 0.4;
  notifications = true;
};
```

Set `opencode.cliSettings.attention.sound = false` to disable the ding. Sound and
visual notifications are independent; visual notifications normally appear when
the terminal is unfocused. Preferences omitted from `cliSettings` can be changed
through the TUI and stored in `~/.config/opencode/cli.json`.

The package's `./tui` entry replaces the pinned built-in `opencode.notifications`
handler by ID. Existing `-opencode.notifications` directives also disable this
handler. OpenCode loads the TUI entry automatically from the Limitless plugin.

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
| `notifications.*` | Use `opencode.cliSettings.attention`; sound defaults to enabled, and visual notifications are configured independently. Arbitrary command hooks are retired. |
| `opencode.service.alias` and its attach alias | Use native OpenCode service discovery. Optional Linux supervision uses `opencode.service.{enable,hostname,port}`. |

If migrating from the old systemd service, remove `opencode.service.alias` and
declare `port = 4096` to preserve its old default. Applying the generation with
supervision enabled replaces the old unit and takes over any native daemon. If
using native on-demand startup instead, disable the unit before launching OpenCode.
Do not keep a separate OpenCode supervisor alongside this unit. Applying these
settings is a Home Manager operation; repository checks use isolated fixtures.

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
requirements, namespace collisions, read/write permission outcomes, and native
service configuration and supervision.

Runtime, Limitless plugin SDK, and schema are pinned to `2.0.12`, with
`effect@4.0.0-rc.112`; update them together. Re-audit native capabilities and MCP
read exceptions when upgrading. Vendor references for the current allowlists are
linked in the integration table above.

When upgrading OpenCode, verify that the TUI still replaces a built-in handler with
a later external definition of the same ID, that the built-in notifications ID is
still `opencode.notifications`, and that execution events still project matching
idle-message boundaries. The sound filter depends on these pinned behaviors.
