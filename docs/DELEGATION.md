# Delegation guide

forge-delegate exists so your primary (expensive) agent stays focused on the decisions that
need its judgment, while a cheap model grinds through the mechanical majority of coding work.

## When does the primary agent delegate?

Installing the tools doesn't force an agent to use them — it decides, guided by the
`instructions` that forge-delegate injects into its context over MCP. Those instructions
contain the cost policy, the delegate-vs-keep rules below, and the routing rules for which
tool to call. Edit them by editing the `INSTRUCTIONS` string in `server.mjs`.

## What to delegate vs. keep

| ✅ Delegate — high volume, low risk | ⛔ Keep on the primary agent |
|---|---|
| Tests for well-specified behavior | Architecture, system design, choosing abstractions |
| Boilerplate & scaffolding (CRUD, DTOs, fixtures, mocks) | Security-sensitive code (auth, crypto, secrets, permissions) |
| Mechanical edits across many files (renames, prop propagation, imports) | Concurrency, performance-critical paths, subtle correctness |
| Lint / formatting / type-error fixes | Ambiguous / underspecified requirements needing judgment |
| Docstrings, comments, README / changelog sections | Public API / interface design, breaking changes |
| Straightforward data transforms / migrations with a clear spec | Debugging unknown root causes |
| Obvious glue code / format conversions | Anything costly or hard to detect if wrong |

**Rule of thumb:** high volume + low risk → delegate. Low volume + high risk → keep it.
Unsure → keep it.

## Which tool?

| Need | Tool |
|---|---|
| Quick one-shot question, no file access needed | `ask_model` |
| A self-contained coding task (inline; auto-backgrounds past ~2 min in Claude Code) | `delegate` |
| Parallel fan-out or fire-and-forget | `delegate` with `background:true` + `check_delegation` |
| See what's available | `list_models` |

## Cost policy (non-negotiable)

The user pays per delegated call on a budget plan. **Always pick cheap or free models.**
Never pick top-tier/premium/frontier models — not even "just this once" or for hard tasks.
If a task seems too hard for a cheap model, split it into smaller delegated steps instead of
upgrading the model.

## Preconditions for a good delegation

1. **Self-contained prompt.** State the goal, constraints, and acceptance criteria. Don't
   assume the cheap model saw the surrounding conversation.
2. **Right working directory.** Pass `directory:` (or set `defaultDirectory`) — don't rely on
   the server's inherited cwd.
3. **Bound the blast radius.** Auto-approve is on by default, so point delegations at
   repositories you trust and review the diffs afterward.
4. **Follow up cheaply.** Keep the returned `session` id and pass it as `continue_session` for
   follow-ups — the agent keeps its context instead of re-exploring.

## Tuning

- Change the default model / directory / auto-approve anytime: `set_delegate_config`, or
  `forge-delegate config set`.
- Save named presets in `profiles` (e.g. `tests`, `quick`) and reference them per call with
  `profile: "name"`.
- Raise/lower the per-delegation timeout with `timeoutMs` (env default `FORGE_OPENCODE_TIMEOUT`).