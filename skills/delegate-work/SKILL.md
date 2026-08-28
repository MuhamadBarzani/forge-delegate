---
name: delegate-work
description: Hand a coding task to a cheap external model via forge-delegate instead of writing it yourself. Load BEFORE starting work that is high-volume and low-judgment - writing tests for code that already exists, mechanical refactors (renames, signature changes, import rewrites, API migrations), fixing lint/type/build errors, boilerplate and scaffolding (CRUD endpoints, config files, schemas, adapters, fixtures), porting code between languages or frameworks, the same edit repeated across 3 or more files, or reading a large file or directory to answer one narrow question. Triggers on - "write tests for", "add tests", "rename X to Y everywhere", "refactor", "migrate", "port this to", "fix the lint errors", "fix the type errors", "scaffold", "boilerplate", "do the same for the other files".
---

# Delegating work to a cheap model

`forge-delegate` runs another AI model as a full agent over this project. It reads
files, explores, and writes code in its own tool loop. None of that passes through
your context — you get back a summary and a diff on disk.

The point is not to save the user money on your tokens. It is that your context is
the scarce resource in a long session, and mechanical work burns it fast.

## Decide

Delegate when the task is **high-volume and low-judgment**: the shape of the correct
answer is already known, and the work is typing it out across files.

| Delegate | Keep |
|---|---|
| Tests for code that already exists | Deciding what behaviour to test |
| Rename / signature change / import rewrite across files | Designing the new interface |
| Fixing lint, type, or build errors | Debugging an unknown root cause |
| CRUD endpoints, config, schemas, fixtures, adapters | Architecture and data modelling |
| Porting between languages or frameworks | Security-sensitive code |
| The same edit repeated across 3+ files | The first instance, so the pattern is right |
| Reading a big file to answer one question | Anything where being wrong is expensive |

Delegating does not transfer responsibility. Review what comes back before you
report it as done.

## Do it

1. Do the judgment part yourself first — decide the interface, write the first
   instance, name the files.
2. Call `delegate` with a task that names paths. **Never paste file contents into
   the task**; the agent reads them itself. That is the whole point.
3. Omit `model`, `directory`, and `agent` — the configured defaults are already a
   cheap or free tier. Do not raise `model` to a premium tier; if the task is too
   big for the default, split it into smaller delegations.
4. Review the result. Run the tests or the build yourself.

```
delegate(task: "Write unit tests for the exported functions in src/parser.ts.
                Follow the style of tests/lexer.test.ts. Cover the error paths.")
```

Parallel or long-running work: `background: true` returns a job id immediately,
then poll `check_delegation(id)`. Follow-up in the same area: pass the previous
`session: <id>` back as `continue_session` so the agent skips re-exploring.

For a question that needs no file access at all — a syntax detail, a regex, a
second opinion — use `ask_model` instead; it is a direct API call with no agent loop.

## Don't

- Don't delegate a task you cannot describe precisely. Vague task, vague diff.
- Don't delegate and walk away. Unreviewed delegated code is worse than no code.
- Don't paste large files into the task text.
- Don't override `model` upward because a task "seems hard" — split it instead.
