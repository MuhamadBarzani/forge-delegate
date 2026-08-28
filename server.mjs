import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync, openSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  logUsage,
  opencodeRun,
  runOne,
  opencodeArgs,
  parseEvents,
  pickVariant,
  listAuthDirectProviders,
  listLocalProviders,
  loadConfig,
  saveConfig,
  configPath,
  resolveConfig,
} from "./lib.mjs";

const execFileAsync = promisify(execFile);
const RUNS_DIR = join(homedir(), ".forge-delegate", "runs");
const here = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version;

const INSTRUCTIONS = `forge-delegate hands coding work to cheap external models running as full agents. They read the project and write the code in their own loop, so the work never passes through your context. Spend your context on judgment; delegate the typing.

DELEGATE BY DEFAULT — do not hand-write these yourself:
- Tests for code that already exists.
- Mechanical refactors: renames, signature changes, import rewrites, API migrations.
- Lint, type, and build errors — paste the error output and delegate the fix.
- Boilerplate: CRUD endpoints, config and schema files, adapters, fixtures, scaffolding.
- Ports and translations between languages, frameworks, or file formats.
- The same edit repeated across 3 or more files.
- Reading a large file or directory to answer one narrow question — delegate the reading, keep your context clean.

KEEP FOR YOURSELF: architecture, debugging an unknown root cause, security-sensitive code, anything where being wrong is expensive, and the review of whatever comes back. Delegation does not transfer responsibility for the result.

Routing:
- One-shot question, no file access needed -> ask_model.
- Anything touching files -> delegate (inline; Claude Code auto-backgrounds calls past 2 minutes).
- Parallel fan-out or long jobs -> delegate with background:true, then poll check_delegation.
- Follow-up in the same area -> pass the previous session id as continue_session.
- Omit model/directory/agent: the configured defaults are already correct (get_delegate_config to see them, set_delegate_config to change them — never reinstall).
- Never paste file contents into a task. Name the paths; the agent reads them itself.

Cost: the configured default model is already a cheap or free tier — just use it. Do not override \`model\` upward to a premium or flagship tier; if a task looks too big for the default, split it into smaller delegations instead.
`;

const server = new McpServer(
  { name: "forge-delegate", version: VERSION },
  { instructions: INSTRUCTIONS }
);

// Uniform wrapper: times the call, records usage, converts errors to tool errors.
async function withUsage(tool, model, fn) {
  const started = Date.now();
  try {
    const text = await fn();
    logUsage({ tool, model, ms: Date.now() - started, ok: true });
    return { content: [{ type: "text", text }] };
  } catch (e) {
    logUsage({ tool, model, ms: Date.now() - started, ok: false });
    return { content: [{ type: "text", text: `ERROR: ${e.message}` }], isError: true };
  }
}

function sessionFooter(sessionId, tokens) {
  const parts = [];
  if (tokens) parts.push(`~${tokens} tokens used`);
  parts.push(`session: ${sessionId}`);
  return "\n" + parts.join(" · ");
}

async function startBackgroundJob(model, task, opts = {}) {
  const variant = await pickVariant(model);
  mkdirSync(RUNS_DIR, { recursive: true });
  const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const logPath = join(RUNS_DIR, `${id}.log`);
  const out = openSync(logPath, "w");
  const cwd = opts.directory ?? process.cwd();
  const child = spawn("opencode", opencodeArgs(model, task, { ...opts, variant }), {
    cwd,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  const started = Date.now();
  const deadline = opts.timeoutMs ? started + opts.timeoutMs : null;
  if (deadline) {
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {}
    }, opts.timeoutMs).unref();
  }
  writeFileSync(
    join(RUNS_DIR, `${id}.json`),
    JSON.stringify({ id, pid: child.pid, model, directory: cwd, started, deadline, logPath })
  );
  return id;
}

server.tool(
  "list_models",
  "List models available for delegation: local/keyless ones, fast direct-API models from opencode logins, and agentic models from the local opencode installation.",
  {},
  async () =>
    withUsage("list_models", "-", async () => {
      const lines = ["== local / keyless (ask_model) =="];
      const local = await listLocalProviders();
      if (local.ollama.length) lines.push(`  ollama: ${local.ollama.slice(0, 12).join(", ")}`);
      else lines.push("  ollama: not running");
      for (const [name, p] of Object.entries(local.config))
        lines.push(`  ${name} (opencode.json): ${p.models.join(", ") || "(models defined ad hoc)"}`);

      lines.push("\n== direct via opencode logins (ask_model, provider/model) ==");
      try {
        const authed = await listAuthDirectProviders();
        if (!authed.length) lines.push("  none — run 'opencode auth login <provider>'");
        for (const p of authed)
          lines.push(`  ${p.name}: ${p.models.join(", ") || "(model list unavailable — still usable)"}`);
      } catch (e) {
        lines.push(`  (unavailable: ${e.message})`);
      }

      lines.push("\n== agentic via opencode (delegate_* tools) ==");
      try {
        const { stdout } = await execFileAsync("opencode", ["models"], { timeout: 15_000, maxBuffer: 1024 * 1024 });
        lines.push(stdout.trim());
      } catch {
        lines.push("opencode not found");
      }

      return lines.join("\n");
    })
);

server.tool(
  "ask_model",
  "USE THIS INSTEAD OF ANSWERING FROM YOUR OWN REASONING when the question is self-contained and cheap to verify: a syntax or API detail, a regex, a short snippet, a second opinion on a design, a summary of text you already have. Sends a one-shot prompt to an external model and returns its raw response. Fast direct API call; the model has NO file access and CANNOT take actions — for anything touching files use delegate instead. Omit model to use the configured default (already a cheap tier).",
  {
    model: z.string().optional().describe("provider/model, e.g. deepseek/deepseek-v4-flash, ollama:llama3 (defaults to config defaultModel)"),
    prompt: z.string(),
    system: z.string().optional(),
  },
  async ({ model, prompt, system }) => {
    const r = resolveConfig({ model });
    if (!r.model) return { content: [{ type: "text", text: "ERROR: no model specified and no defaultModel configured. Call set_delegate_config or pass model." }], isError: true };
    return withUsage("ask_model", r.model, () =>
      runOne(r.model, system ? `${system}\n\n---\n\n${prompt}` : prompt).then((x) => x.text)
    );
  }
);

server.tool(
  "delegate",
  "USE THIS INSTEAD OF WRITING THE CODE YOURSELF when the task is: tests for code that already exists; a mechanical refactor (rename, signature change, import rewrite, API migration); fixing lint/type/build errors; boilerplate or scaffolding (CRUD endpoints, config, schemas, adapters, fixtures); a port between languages or frameworks; the same edit repeated across 3 or more files; or reading a large file/directory to answer one narrow question. Hands the task to another AI model running as a full agent via local opencode: it reads your project, explores, and writes concrete code in its own tool loop — none of which enters your context. Keep architecture, unknown-root-cause debugging, and security-sensitive code for yourself, and always review what comes back. Runs INLINE by default (result returned when done; Claude Code auto-backgrounds calls past 2 minutes). Pass background:true to run detached and get a job id instantly, then poll check_delegation — use that for parallel fan-out or hosts that block on long calls. Pass continue_session (returned by a previous delegation) to keep the same agent session instead of re-exploring. Never paste file contents into task: name the paths and let the agent read them. model/directory/agent/autoApprove default from config — omit them.",
  {
    model: z.string().optional().describe("provider/model format, e.g. opencode/mimo-v2.5-free (defaults to config defaultModel)"),
    task: z.string(),
    files: z.array(z.string()).optional().describe("specific files to attach (inline mode)"),
    background: z.boolean().optional().describe("run detached and return a job id (default false)"),
    continue_session: z.string().optional().describe("session id returned by a previous delegation"),
    directory: z.string().optional().describe("absolute path to run in (defaults to config defaultDirectory, else server cwd)"),
    agent: z.string().optional().describe("opencode agent to use (defaults to config defaultAgent)"),
    autoApprove: z.boolean().optional().describe("auto-approve permissions (defaults to config autoApprove, true)"),
    profile: z.string().optional().describe("named config profile to apply"),
  },
  async ({ model, task, files, background, continue_session, directory, agent, autoApprove, profile }) => {
    const r = resolveConfig({ model, directory, agent, autoApprove, profile });
    if (!r.model) return { content: [{ type: "text", text: "ERROR: no model specified and no defaultModel configured. Call set_delegate_config or pass model." }], isError: true };
    if (background) {
      return withUsage("delegate", r.model, async () => {
        const id = await startBackgroundJob(r.model, task, {
          sessionId: continue_session,
          directory: r.directory,
          agent: r.agent,
          autoApprove: r.autoApprove,
          timeoutMs: r.timeoutMs,
        });
        return `Started background job ${id}. Poll with check_delegation(id: "${id}").`;
      });
    }
    return withUsage("delegate", r.model, async () => {
      const res = await opencodeRun(r.model, task, {
        files,
        directory: r.directory,
        agent: r.agent,
        autoApprove: r.autoApprove,
        timeoutMs: r.timeoutMs,
      });
      return `${res.text || "(no summary — agent may have only edited files)"}${sessionFooter(res.sessionId, res.tokens)} — pass session id as continue_session to follow up`;
    });
  }
);

server.tool(
  "check_delegation",
  "Check status of a background delegation job: running/completed plus output so far. Call with no id to list all jobs.",
  { id: z.string().optional() },
  async ({ id }) =>
    withUsage("check_delegation", id ?? "-", async () => {
      if (!existsSync(RUNS_DIR)) return "no jobs yet";
      if (!id) {
        const jobs = readdirSync(RUNS_DIR)
          .filter((f) => f.endsWith(".json"))
          .map((f) => JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8")))
          .map((m) => `${m.id} [${m.model}] started ${new Date(m.started).toLocaleTimeString()}`);
        return jobs.join("\n") || "no jobs yet";
      }
      const metaPath = join(RUNS_DIR, `${id}.json`);
      if (!existsSync(metaPath)) return `unknown job ${id}`;
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      let running = false;
      try {
        process.kill(meta.pid, 0);
        running = true;
      } catch {}
      const log = existsSync(meta.logPath) ? readFileSync(meta.logPath, "utf8") : "";
      const parsed = parseEvents(log);
      const tail = parsed.text || "(agent still thinking, no text output yet)";
      const footer = parsed.sessionId ? ` · session: ${parsed.sessionId}` : "";
      let status = running ? "RUNNING" : "DONE";
      if (meta.deadline && Date.now() > meta.deadline) status = "TIMED OUT";
      return `[${status}] ${id} (${meta.model}, ${Math.round((Date.now() - meta.started) / 1000)}s)${footer}\n\n${tail.slice(-8000)}`;
    })
);

server.tool(
  "get_delegate_config",
  "Read the current forge-delegate configuration: defaultModel, defaultAgent, defaultVariant, autoApprove, timeoutMs, defaultDirectory, and named profiles. Call this to see what will be used when a model/directory is omitted.",
  {},
  async () => {
    const cfg = loadConfig();
    const { profiles, ...rest } = cfg;
    const lines = Object.entries(rest).map(([k, v]) => `  ${k}: ${v ?? "(unset)"}`);
    const prof = Object.entries(profiles).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join("\n") || "  (none)";
    return { content: [{ type: "text", text: `config: ${configPath()}\n${lines.join("\n")}\nprofiles:\n${prof}` }] };
  }
);

server.tool(
  "set_delegate_config",
  "Change forge-delegate configuration at runtime — no reinstall. Pass any subset of {defaultModel, defaultAgent, defaultVariant, autoApprove, timeoutMs, defaultDirectory, profiles}. Set a field to null to clear it. To edit a profile, pass the whole profiles object (e.g. profiles: {tests: {model: \"...\"}}); set a profile to null to delete it. Only provided keys change; others are preserved.",
  {
    defaultModel: z.string().nullable().optional(),
    defaultAgent: z.string().nullable().optional(),
    defaultVariant: z.string().nullable().optional(),
    autoApprove: z.boolean().optional(),
    timeoutMs: z.number().optional(),
    defaultDirectory: z.string().nullable().optional(),
    profiles: z.record(z.any()).optional(),
  },
  async (patch) => {
    try {
      saveConfig(patch);
      const cfg = loadConfig();
      return { content: [{ type: "text", text: `Updated. defaultModel=${cfg.defaultModel ?? "(unset)"}, autoApprove=${cfg.autoApprove}, defaultDirectory=${cfg.defaultDirectory ?? "(unset)"}, profiles=${Object.keys(cfg.profiles).join(",") || "none"}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
