import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync, openSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

const INSTRUCTIONS = `forge-delegate gives you a crew of external AI models to delegate coding work to. Hand off the high-volume, low-risk work (boilerplate, tests, lint/type fixes, mechanical edits) to a cheap or free model and keep the expensive agent focused on architecture and judgment calls.

COST POLICY — MANDATORY, NON-NEGOTIABLE:
The user pays per delegated call on a budget plan. You MUST pick only cheap or free models for EVERY delegation (ask_model, delegate). NEVER pick top-tier, premium, flagship, or frontier models — not even "just this once" or for hard tasks. If a task seems too hard for a cheap model, split it into smaller delegated steps instead of upgrading. Run list_models and prefer free/cheap models (deepseek flash tiers, free opencode models, local ollama).

Routing:
- Quick one-shot questions → ask_model (direct API, no file access).
- Multi-file edits/refactors/tests → delegate (inline by default; Claude Code auto-backgrounds calls past 2 min).
- Parallel or fire-and-forget → delegate with background:true (returns a job id instantly); poll check_delegation for the result.
- Follow-ups on a delegated area: pass the returned session id as continue_session.
- Omit model/directory to use the configured defaults (get_delegate_config); change them anytime with set_delegate_config — never reinstall.
- Never paste large files into your own context for delegation — delegate and let the agent read files itself.

The per-tool descriptions are the authoritative reference.
`;

const server = new McpServer(
  { name: "forge-delegate", version: "1.0.4" },
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
  "Send a one-shot prompt to an external AI model and get its raw response. Fast direct API call; the model has NO file access and CANNOT take actions. For work requiring tools/files use delegate instead. model defaults to the configured defaultModel.",
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
  "Delegate a coding task to another AI model running as a full agent (via local opencode): it reads your project, explores, and writes concrete code in its own tool loop — invisible to the caller's context. Runs INLINE by default (the result is returned in your context when done; Claude Code auto-backgrounds calls running past 2 minutes). Pass background:true to run detached and return a job id instantly, then poll check_delegation for the result — use that for parallel fan-out or hosts that block on long calls. Pass continue_session (returned by a previous delegation) to keep the same agent session instead of re-exploring. Optionally attach specific files in inline mode. model/directory/agent/autoApprove default from config.",
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
