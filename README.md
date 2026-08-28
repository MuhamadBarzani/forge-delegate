# forge-delegate

MCP server that delegates coding work from your primary agent (**Claude Code, Codex, or opencode**)
to other — usually cheaper or free — AI models, so your main agent's context stays small and your
token bill stays low. Direct API calls for quick questions; full agentic delegation via
[opencode](https://opencode.ai) for real work.

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

**One-line installer** (host the repo or use a checkout):

```bash
bash install.sh --model "opencode/mimo-v2.5-free" --targets "claude,codex"
```

Or from a remote copy:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/MuhamadBarzani/forge-delegate/main/install.sh) -- --model "opencode/mimo-v2.5-free" --targets "claude,codex"
```

> GitHub Pages: enable it with *Settings → Pages → Deploy from a branch → `main` / `/docs`*.
> The configurator lives at `docs/index.html`; if you host the repo under a different
> owner/name, update the hardcoded URL in the page's `#url` input value (and the
> `FORGE_DELEGATE_REPO` default in `install.sh`).

Or manually:

```bash
node cli.mjs setup --model "opencode/mimo-v2.5-free" --targets claude,codex,opencode
```

The installer/`setup` will:
1. Register the MCP server with each agent you chose (`--targets claude,codex,opencode`).
2. Set your default model (`--model`) so calls can omit `model`.

Routing and cost-policy guidance is injected by the MCP server itself into the agent's context
via MCP `instructions` — no memory-file (`CLAUDE.md`/`AGENTS.md`) editing needed.

Then restart your agent and confirm the server is connected: `/mcp` in Claude Code,
`codex mcp`, or `opencode`.

### What you need

- **Node.js ≥ 18** and **opencode** installed (the installer can fetch opencode for you).
- **Free `opencode/*` models** (e.g. `opencode/mimo-v2.5-free`) need no auth — zero setup.
- **Any other provider** (deepseek, openai, google, ollama, …) must be logged into **your**
  opencode first — that's a step *you* do in your own opencode, not something forge-delegate
  handles: `opencode auth login <provider>`. forge-delegate reuses your opencode's credentials
  and never stores API keys. (Ollama needs no key, just the Ollama app running.)

### Scope

| `--scope` | Claude Code | Codex | opencode |
|---|---|---|---|
| `user` (default) | `~/.claude.json` — all projects | `~/.codex/config.toml` — all projects | `~/.config/opencode/opencode.json` — all projects |
| `project` | `.mcp.json` in the project (needs one-time approval) | `.codex/config.toml` in the project (loads for trusted projects only) | `opencode.json` in the project |

### Try it free — zero signup

opencode ships free no-auth models under `opencode/`:

```bash
bash install.sh --model "opencode/mimo-v2.5-free" --targets "claude,codex"
```

Other free options: `opencode/hy3-free`, `opencode/nemotron-3.5-lightning-free`. Free tiers are
rate-limited; switch anytime with `forge-delegate config set --model <m>`.

## Tools

| Tool | What it does | Context cost |
|---|---|---|
| `ask_model` | One-shot question to any model (direct API, no file access) | Small |
| `delegate_task` | Send a task + optional files to a model agent running via opencode; returns result + session id | Medium |
| `delegate_agent` | Model works **autonomously** in the **background** — returns a job id instantly; poll `check_delegation` | Tiny |
| `check_delegation` | Poll a background job (or list all with no id) | Tiny |
| `list_models` | List local/keyless, direct-API, and agentic models | Small |
| `get_delegate_config` | Read current configuration (default model, directory, autoApprove, profiles) | Tiny |
| `set_delegate_config` | Change configuration at runtime — no reinstall | Tiny |

`delegate_agent` is the token-saver: the external model gets its own tool loop executed by
opencode locally. File contents never touch your main agent's context. The delegation runs as a
detached background process, so the MCP call returns instantly.

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

- **opencode provider** — free no-auth models (`opencode/mimo-v2.5-free`, ...) plus
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
forge-delegate setup      Register with Claude Code / Codex / opencode
forge-delegate serve      Start the MCP server (used internally)
forge-delegate config     get | set | path
forge-delegate status     Show opencode logins and usage summary
forge-delegate stats      Show detailed usage statistics
```

## License

MIT