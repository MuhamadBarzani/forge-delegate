# forge-delegate

MCP server that delegates coding work from your primary agent (**Claude Code, Codex, or opencode**)
to other AI models, so your main agent's context stays small. The high-volume typing happens in
another model's context, usually a cheaper or free one, and only a summary comes back. Full agentic
delegation via [opencode](https://opencode.ai) for real work; direct API calls for second opinions.

Your main agent (the expensive one) keeps architecture, critical logic, and hard decisions.
The cheap model grinds through the high-volume, low-risk work (boilerplate, repetitive edits,
tests, lint/type fixes) and reports back.

```
┌──────────────────┐   MCP (stdio)   ┌──────────────────┐   opencode run   ┌──────────────────┐
│ Claude / Codex / │ ──────────────► │ forge-delegate   │ ───────────────► │ opencode + cheap  │
│ opencode (primary)│                │  (this server)   │    --model cheap │      model        │
└──────────────────┘ ◄────────────── └──────────────────┘ ◄─────────────── └──────────────────┘
        result: text + session + token usage
```

## Quick start

**Web configurator** — pick model/targets/scope and get a ready-to-paste command
(https://muhamadbarzani.github.io/forge-delegate/). The model picker is backed by the live
[models.dev](https://models.dev) catalog — searchable, with free/cheap filters and real prices,
so you're picking from actual available models rather than guessing.

**npx (recommended — works everywhere, no bash needed):**

```bash
npx -y forge-delegate setup --model "opencode/deepseek-v4.1-flash-free" --targets "claude,codex,opencode"
```

That's it — npx bootstraps the package, and `setup` registers the MCP server with the agents
you chose, sets your default model, and installs a small launcher that keeps the server up to
date. Works on Windows (cmd/PowerShell), macOS, and Linux — no bash needed.

Run `setup` **without flags** and it walks you through the choices interactively (defaults in
`[brackets]`, Enter accepts); pass any of the flags to skip that prompt. In an automated/non-terminal
run it just uses sensible defaults.

> GitHub Pages: enable it with *Settings → Pages → Deploy from a branch → `main` / `/docs`*.
> The configurator lives at `docs/index.html`. `install.sh`'s `FORGE_DELEGATE_REPO` default
> (and the raw URL inside it) matters only if you self-host the fallback installer.
>
> Working on a checkout yourself? `node cli.mjs setup` does the same thing.

`setup` will:
1. Register the MCP server with each agent you chose (`--targets claude,codex,opencode`).
2. Set your default model (`--model`) so calls can omit `model`.
3. Install the auto-update launcher (published installs; skipped for a git checkout).
4. For Codex, raise the MCP timeouts (`startup_timeout_sec`, `tool_timeout_sec`) above Codex's
   10s/60s defaults so inline delegations aren't cut off.

Routing and cost-policy guidance is injected by the MCP server itself into the agent's context
via MCP `instructions` — no memory-file (`CLAUDE.md`/`AGENTS.md`) editing needed.

Then restart your agent and confirm the server is connected: `/mcp` in Claude Code,
`codex mcp`, or `opencode`.

### What you need

- **Node.js ≥ 18** and **opencode v2 or newer** installed (the installer can fetch opencode for you).
  v2 removed the CLI flags older versions relied on for working directories and variants, and an
  unknown flag makes `opencode run` print help and exit successfully — so a pre-v2 binary fails
  silently. The server checks at startup and warns instead.
- **Free `opencode/*` models** (e.g. `opencode/deepseek-v4.1-flash-free`) need no auth — zero setup.
- **Any other provider** (deepseek, openai, google, ollama, …) must be logged into **your**
  opencode first — that's a step *you* do in your own opencode, not something forge-delegate
  handles: `opencode auth login <provider>`. forge-delegate reuses your opencode's credentials
  and never stores API keys. (Ollama needs no key, just the Ollama app running.)

### Windows

Use the `npx` route — no bash needed (works in cmd/PowerShell). All three targets, including
native Windows Codex CLI, are supported.

### Scope

| `--scope` | Claude Code | Codex | opencode |
|---|---|---|---|
| `user` (default) | `~/.claude.json` — all projects | `~/.codex/config.toml` — all projects | `~/.config/opencode/opencode.json` — all projects |
| `project` | `.mcp.json` in the project (needs one-time approval) | `.codex/config.toml` in the project (loads for trusted projects only) | `opencode.json` in the project |

### Try it free — zero signup

opencode ships free no-auth models under `opencode/`:

```bash
npx -y forge-delegate setup --model "opencode/deepseek-v4.1-flash-free" --targets "claude,codex"
```

Other free options: `opencode/mimo-v2.6-flash-free`, `opencode/nemotron-3.5-lightning-free`. Free tiers are
rate-limited; switch anytime with `forge-delegate config set --model <m>`.

## Tools

| Tool | What it does | Context cost |
|---|---|---|
| `ask_model` | Second opinion from another model (direct API, no file access) | Small |
| `delegate` | Model works **autonomously** via opencode's own tool loop — inline by default; `background:true` returns a job id to poll via `check_delegation` | Tiny→Medium |
| `check_delegation` | Poll a background job (or list all with no id) | Tiny |
| `list_models` | List local/keyless, direct-API, and agentic models | Small |
| `get_delegate_config` | Read current configuration (default model, directory, autoApprove, profiles) | Tiny |
| `set_delegate_config` | Change configuration at runtime — no reinstall | Tiny |

`delegate` is the context-saver: the external model gets its own tool loop executed by
opencode locally. File contents never touch your main agent's context. Fast tasks return
inline; long ones are auto-backgrounded by Claude Code (past ~2 min). Other hosts wait for an
inline call, so the agent is told to pass `background:true` there for anything long.

## When to delegate

| ✅ Delegate — high volume, low risk | ⛔ Keep on the primary agent |
|---|---|
| Tests for well-specified behavior | Architecture, system design, choosing abstractions |
| Boilerplate & scaffolding (CRUD, DTOs, fixtures, mocks) | Security-sensitive code (auth, crypto, secrets, permissions) |
| Mechanical edits across many files (renames, prop propagation, imports) | Concurrency, performance-critical paths, subtle correctness |
| Lint / formatting / type-error fixes | Ambiguous / underspecified requirements needing judgment |
| Docstrings, comments, README / changelog sections | Public API / interface design, breaking changes |
| Straightforward data transforms / migrations with a clear spec | Debugging unknown root causes |
| Obvious glue code / format conversions | Anything costly or hard to detect if wrong |

Full guide: [docs/DELEGATION.md](docs/DELEGATION.md)

### The `delegate-work` skill

Setup also installs the skill for Claude Code (`~/.claude/skills/delegate-work/`, or
`<project>/.claude/skills/` under `--scope project`) and for Codex (`~/.agents/skills/delegate-work/`,
or `<project>/.agents/skills/`). Skip it with `--no-skill`.

It exists because MCP server `instructions` are injected once at session start and
get buried as the context fills — by turn 30 they lose to whatever is in front of the
model. A skill description is re-matched against every user turn, so the delegation
triggers ("write tests for", "rename X everywhere", "fix the lint errors") stay live
for the whole session instead of decaying.

## Configuration

Stored in `~/.forge-delegate/config.json`, read fresh on every call — change it anytime without
reinstalling. Four ways:

1. **From your agent** via the MCP tools `get_delegate_config` / `set_delegate_config`.
2. **Terminal CLI**: `forge-delegate config get`, `forge-delegate config set --model <m> --timeout <s> --dir <path> --autoApprove false`, `forge-delegate config path`.
3. **`setup` flags**: `--model`, `--targets`, `--scope`, `--project-dir`.
4. **Edit the file** directly.

| Field | Description | Default |
|---|---|---|
| `defaultModel` | provider/model used when a call omits `model` | unset |
| `defaultAgent` | opencode agent used for delegations | unset |
| `defaultVariant` | default reasoning-effort variant | unset |
| `autoApprove` | auto-approve permissions so headless delegations don't block | `true` |
| `timeoutMs` | per-delegation timeout | `900000` (env `FORGE_OPENCODE_TIMEOUT`) |
| `defaultDirectory` | default working directory for delegations | unset (server cwd) |
| `profiles` | named presets `{ name: { model, agent, variant, autoApprove, directory } }` | `{}` |

Every delegation tool also accepts per-call `model`, `directory`, `agent`, `autoApprove`, and
`profile` overrides. Per-call values beat profile values beat config defaults.

## Models

- **opencode provider** — free no-auth models (`opencode/deepseek-v4.1-flash-free`, ...) plus
  anything you have logged in via `opencode auth login <provider>`.
- **Direct API from opencode logins** — `provider/model` for OpenAI-compatible providers.
- **Custom providers** — OpenAI-compatible providers defined in `opencode.json`
  (`@ai-sdk/openai-compatible` + `baseURL`), callable as `provider/model`.
- **Ollama (local)** — `ollama:llama3`, `local:qwen2.5-coder`, no key needed.

## Safety notes

- `autoApprove: true` runs delegations non-interactively with tool permissions granted — point
  them at repositories you trust and review the diffs. Set `autoApprove: false` to require
  manual approval.
- This server never stores API keys — provider auth lives in opencode's own auth store.
- Usage is logged to `~/.forge-delegate/usage.jsonl`; see `forge-delegate stats`.

## CLI

```text
forge-delegate --version  Print the installed version
forge-delegate setup      Register with Claude Code / Codex / opencode
forge-delegate serve      Start the MCP server (used internally)
forge-delegate config     get | set | path
forge-delegate status     Show version, update mode, opencode logins, usage
forge-delegate stats      Show detailed usage statistics
```

`setup` on a published install writes `~/.forge-delegate/launcher.mjs` and registers that path
instead of `npx`. The launcher keeps a private install under `~/.forge-delegate/pkg`, asks npm
for the newest release at most every 6 hours, and installs newer **same-major** versions
automatically. Installs use `npm install --ignore-scripts`, go through a staging directory, and
fall back to the last good version if anything fails. A new version lands on the next agent
start; the download itself happens in the background so startup is never delayed.

Disable automatic updates with `FORGE_AUTO_UPDATE=0`. A major release (`2.0.0`) is never
installed automatically — re-run `npx -y forge-delegate setup` to take it deliberately.

The launcher is also the CLI entry point: `node ~/.forge-delegate/launcher.mjs status` reports
the running version and update mode, and `--version` prints the version.

npx installs configured by hand are not covered by the launcher: npx keeps its cached copy
forever, so clear it with `rm -rf ~/.npm/_npx` and restart. Running
`npx -y forge-delegate@latest setup` migrates an npx install to the launcher; `@latest` gets its
own npx cache slot, and if it still starts an old version, clear the cache first.

## Publishing (npm)

The primary install is `npx -y forge-delegate setup`, so the package must be on npm. Checklist:

1. `npm run prepublishOnly` — syntax-checks all entry files (runs automatically on publish).
2. `npm pack --dry-run` — confirm the tarball contains only `launcher.mjs`, `cli.mjs`, `server.mjs`,
   `lib.mjs`, `install.sh`, `docs/`, `skills/`, `README.md` (via the `files` field), not `node_modules`.
3. Bump `version` in `package.json` (and the root `version` in `package-lock.json`).
4. `npm login && npm publish` — the `bin` field makes `npx forge-delegate …` work.

Also make sure the GitHub repo exists at `MuhamadBarzani/forge-delegate` with Pages enabled on
`/docs` (configurator) — the `raw.githubusercontent.com` install URL and the configurator's
hardcoded URL point there.

## License

MIT