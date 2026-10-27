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
  sessionUsage,
  pickVariant,
  detectOpencode,
  listAuthDirectProviders,
  listLocalProviders,
  loadConfig,
  saveConfig,
  configPath,
  resolveConfig,
  installKind,
  VERSION,
} from "./lib.mjs";

const execFileAsync = promisify(execFile);
const RUNS_DIR = join(homedir(), ".forge-delegate", "runs");
const here = dirname(fileURLToPath(import.meta.url));
const INSTALL_KIND = installKind();
const INSTALL_LABEL =
  INSTALL_KIND === "launcher"
    ? "launcher (automatic updates)"
    : INSTALL_KIND === "package"
      ? "npx/package (manual updates)"
      : "checkout";

// The installed skill is a file on disk that only `setup` rewrites, so a published
// skill change goes unnoticed. Compare the two and say so, rather than running
// stale in silence.
function skillStatus() {
  const src = join(here, "skills", "delegate-work", "SKILL.md");
  if (!existsSync(src)) return null;
  const dests = [
    join(homedir(), ".claude", "skills", "delegate-work", "SKILL.md"),
    join(process.cwd(), ".claude", "skills", "delegate-work", "SKILL.md"),
  ];
  const installed = dests.filter(existsSync);
  if (!installed.length) return { state: "missing", detail: "not installed" };
  const want = readFileSync(src, "utf8");
  const stale = installed.filter((d) => readFileSync(d, "utf8") !== want);
  return stale.length
    ? { state: "stale", detail: `out of date: ${stale.join(", ")}` }
    : { state: "ok", detail: "up to date" };
}

const SKILL_STATUS = skillStatus();
if (SKILL_STATUS && SKILL_STATUS.state !== "ok") {
  // stderr only — stdout is the JSON-RPC channel.
  process.stderr.write(
    `forge-delegate: delegate-work skill ${SKILL_STATUS.detail}. Run: npx -y forge-delegate setup\n`
  );
}

// Same channel rule. Non-blocking so a slow or missing `opencode` can never delay
// the MCP handshake; if the binary is absent or pre-v2 the user hears about it
// instead of getting silent empty delegations later.
detectOpencode()
  .then((oc) => {
    if (!oc.found) {
      process.stderr.write(
        "forge-delegate: opencode not found on PATH — delegations will fail. Install: https://opencode.ai\n"
      );
    } else if (!oc.supported) {
      process.stderr.write(
        `forge-delegate: opencode ${oc.version?.raw ?? "(unknown version)"} is too old — requires opencode 2 or newer ` +
          `(v2 removed the CLI flags forge-delegate uses). Run: opencode upgrade\n`
      );
    }
  })
  .catch(() => {});

const INSTRUCTIONS = `forge-delegate hands coding work to cheap external models running as full agents. They read the project and write the code in their own loop, so the work never passes through your context. Spend your context on judgment; delegate the typing. The user installed this so you would delegate: when a task matches the list in the delegate tool's description, delegate it rather than writing it yourself.

Keep for yourself: architecture, debugging an unknown root cause, security-sensitive code, anything where being wrong is expensive, and the verdict on whatever comes back. Delegation does not transfer responsibility for the result. For an audit or survey, delegate the gathering and keep the verdict: ask for a digest with a file path behind every claim, then judge it yourself. A claim with no path is not a finding.

Routing:
- Anything touching files -> delegate. An inline call blocks until it finishes: Claude Code moves calls past 2 minutes to the background, other hosts wait. Outside Claude Code, pass background:true for anything that may run more than a couple of minutes, then poll check_delegation.
- Parallel fan-out -> several delegate calls with background:true.
- Follow-up in the same area -> pass the previous session id as continue_session.
- A second opinion from a different model, or the user asks for one -> ask_model. Answer ordinary syntax and API questions yourself.
- Omit model/directory/agent: the configured defaults are already correct (get_delegate_config to see them, set_delegate_config to change them — never reinstall).
- Never paste file contents into a task. Name the paths; the agent reads them itself.

Cost: the configured default model is already a cheap or free tier — just use it. Do not override \`model\` upward to a premium or flagship tier; if a task looks too big for the default, split it into smaller delegations instead.
`;

const server = new McpServer(
  { name: "forge-delegate", version: VERSION },
  { instructions: INSTRUCTIONS }
);

// Uniform wrapper: times the call, records usage, converts errors to tool errors.
// fn returns the result text, or { text, tokens, cost } when it knows the usage.
async function withUsage(tool, model, fn) {
  const started = Date.now();
  try {
    const r = await fn();
    const { text, tokens, cost } = typeof r === "string" ? { text: r } : r;
    logUsage({ tool, model, ms: Date.now() - started, ok: true, tokens, cost });
    return { content: [{ type: "text", text }] };
  } catch (e) {
    logUsage({ tool, model, ms: Date.now() - started, ok: false });
    return { content: [{ type: "text", text: `ERROR: ${e.message}` }], isError: true };
  }
}

function usageParts(tokens, cost) {
  const parts = [];
  if (tokens) parts.push(`~${tokens.toLocaleString("en-US")} tokens used`);
  if (cost) parts.push(`$${cost.toFixed(4)}`);
  return parts;
}

function sessionFooter(sessionId, tokens, cost) {
  return "\n" + [...usageParts(tokens, cost), `session: ${sessionId}`].join(" · ");
}

async function startBackgroundJob(model, task, opts = {}) {
  const variant = await pickVariant(model);
  mkdirSync(RUNS_DIR, { recursive: true });
  const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const logPath = join(RUNS_DIR, `${id}.log`);
  const out = openSync(logPath, "w");
  const cwd = opts.directory ?? process.cwd();
  // opencode v2 resolves the project from PWD, not the child's cwd (see lib.mjs).
  const env = opts.directory ? { ...process.env, PWD: opts.directory } : process.env;
  const child = spawn("opencode", opencodeArgs(model, task, { ...opts, variant }), {
    cwd,
    env,
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
  "List the models available for delegation: local/keyless ones, direct-API models from opencode logins, and agentic models from the local opencode installation. Call it when the user asks what's available or wants to change the default model, not before an ordinary delegation — those use the configured default.",
  {},
  async () =>
    withUsage("list_models", "-", async () => {
      const lines = ["== local / keyless (ask_model) =="];
      const local = await listLocalProviders();
      if (local.ollama.length) lines.push(`  ollama: ${local.ollama.slice(0, 12).join(", ")}`);
      else lines.push("  ollama: not running");
      for (const [name, p] of Object.entries(local.config))
        lines.push(`  ${name} (opencode.json): ${Object.keys(p.models).join(", ") || "(models defined ad hoc)"}`);

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
  "Get a second opinion from a different model — on a design, an approach, or a tricky snippet — or ask one when the user requests it. Sends a one-shot prompt over a direct API call and returns the raw response. The model has no file access and cannot take actions; for anything touching files use delegate. Don't use it for syntax or API details you already know: a cheap model is usually less reliable than you on those. Omit model to use the configured default.",
  {
    model: z.string().optional().describe("provider/model or ollama:<name>, e.g. deepseek/deepseek-v4-flash, ollama:llama3. Omit to use the configured default; don't pick a premium tier"),
    prompt: z.string().describe("The full question. The model has seen none of this conversation, so include the code and context it needs"),
    system: z.string().optional().describe("Optional system prompt, e.g. a role or an answer format"),
  },
  async ({ model, prompt, system }) => {
    const r = resolveConfig({ model });
    if (!r.model) return { content: [{ type: "text", text: "ERROR: no model specified and no defaultModel configured. Call set_delegate_config or pass model." }], isError: true };
    return withUsage("ask_model", r.model, () =>
      runOne(r.model, system ? `${system}\n\n---\n\n${prompt}` : prompt)
    );
  }
);

server.tool(
  "delegate",
  "Hand a coding task to another AI model running as a full agent via local opencode: it reads the project, explores, and writes the code in its own tool loop, none of which enters your context. Use it instead of writing the code yourself for: tests for code that already exists; a mechanical refactor (rename, signature change, import rewrite, API migration); lint/type/build errors (paste the error output); boilerplate or scaffolding (CRUD endpoints, config, schemas, adapters, fixtures); a port between languages or frameworks; the same edit repeated across 3 or more files; reading a large file or directory to answer one narrow question; the survey half of an audit. Runs inline by default and returns when done; Claude Code backgrounds calls past 2 minutes, other hosts wait. Pass background:true to get a job id at once, then poll check_delegation. Pass continue_session (returned by a previous delegation) to keep the same agent session instead of re-exploring. Name file paths in task; never paste their contents. model/directory/agent/autoApprove default from config — omit them. Review what comes back before reporting it done.",
  {
    model: z.string().optional().describe("provider/model, e.g. opencode/deepseek-v4.1-flash-free. Omit to use the configured default; don't raise it to a premium tier — split the task instead"),
    task: z.string().describe("Self-contained instructions: the goal, the file paths to read or change, constraints, and how to check the result (e.g. which tests to run). The agent has not seen this conversation"),
    files: z.array(z.string()).optional().describe("Paths to attach to the agent's prompt (inline only; ignored with background:true). Rarely needed: the agent reads paths named in task itself"),
    background: z.boolean().optional().describe("Run detached and return a job id immediately; poll check_delegation (default false)"),
    continue_session: z.string().optional().describe("Session id from a previous delegation's result, to continue in that agent session"),
    directory: z.string().optional().describe("Absolute path of the project to work in (defaults to config defaultDirectory, else the server's working directory)"),
    agent: z.string().optional().describe("opencode agent to use (defaults to config defaultAgent)"),
    autoApprove: z.boolean().optional().describe("Let the agent edit files and run commands without asking (defaults to config autoApprove, true). When false nobody is there to approve, so actions that need approval can stall or be refused"),
    profile: z.string().optional().describe("Named preset from config profiles (see get_delegate_config) that sets model, agent, variant, directory and autoApprove together"),
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
      return {
        text: `${res.text || "(no summary — agent may have only edited files)"}${sessionFooter(res.sessionId, res.tokens, res.cost)} — pass session id as continue_session to follow up`,
        tokens: res.tokens,
        cost: res.cost,
      };
    });
  }
);

server.tool(
  "check_delegation",
  "Check a delegation started with background:true. Returns RUNNING, DONE or TIMED OUT, the elapsed time, the session id, and the last 8,000 characters of the agent's output. Each poll costs context, so wait between polls instead of checking in a tight loop. Call with no id to list all jobs.",
  { id: z.string().optional().describe("Job id returned by delegate with background:true. Omit to list all jobs") },
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
      const parts = parsed.sessionId ? [`session: ${parsed.sessionId}`] : [];
      if (!running && parsed.sessionId) {
        const u = (await sessionUsage(parsed.sessionId, meta.started)) ?? { tokens: parsed.tokens, cost: null };
        parts.unshift(...usageParts(u.tokens, u.cost));
        // The job's delegate call was logged when it started; this adds its usage once.
        if (!meta.usageLogged) {
          logUsage({ tool: "delegate", model: meta.model, tokens: u.tokens, cost: u.cost, usageOnly: true });
          writeFileSync(metaPath, JSON.stringify({ ...meta, usageLogged: true }));
        }
      }
      const footer = parts.map((p) => ` · ${p}`).join("");
      let status = running ? "RUNNING" : "DONE";
      if (meta.deadline && Date.now() > meta.deadline) status = "TIMED OUT";
      return `[${status}] ${id} (${meta.model}, ${Math.round((Date.now() - meta.started) / 1000)}s)${footer}\n\n${tail.slice(-8000)}`;
    })
);

server.tool(
  "get_delegate_config",
  "Read the current forge-delegate configuration: defaultModel, defaultAgent, defaultVariant, autoApprove, timeoutMs, defaultDirectory, and named profiles — plus the installed version and whether it updates automatically. Call this to see what will be used when a model/directory is omitted, or when the user asks which version is running.",
  {},
  async () => {
    const cfg = loadConfig();
    const { profiles, ...rest } = cfg;
    const lines = Object.entries(rest).map(([k, v]) => `  ${k}: ${v ?? "(unset)"}`);
    const prof = Object.entries(profiles).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join("\n") || "  (none)";
    const skill = SKILL_STATUS ? `\nskill (delegate-work): ${SKILL_STATUS.detail}${SKILL_STATUS.state === "ok" ? "" : " — run: npx -y forge-delegate setup"}` : "";
    return {
      content: [
        {
          type: "text",
          text: `version: ${VERSION}\ninstall: ${INSTALL_LABEL}\nconfig: ${configPath()}\n${lines.join("\n")}\nprofiles:\n${prof}${skill}`,
        },
      ],
    };
  }
);

server.tool(
  "set_delegate_config",
  "Change forge-delegate configuration at runtime — no reinstall. Only change settings when the user asks; never raise defaultModel to a premium tier on your own. Pass any subset of {defaultModel, defaultAgent, defaultVariant, autoApprove, timeoutMs, defaultDirectory, profiles}. Set a field to null to clear it. To edit a profile, pass the whole profiles object (e.g. profiles: {tests: {model: \"...\"}}); set a profile to null to delete it. Only provided keys change; others are preserved.",
  {
    defaultModel: z.string().nullable().optional().describe("provider/model used when a call omits model"),
    defaultAgent: z.string().nullable().optional().describe("opencode agent used when a call omits agent"),
    defaultVariant: z.string().nullable().optional().describe("Reasoning-effort variant, sent to opencode as provider/model#variant"),
    autoApprove: z.boolean().optional().describe("Let delegated agents edit files and run commands without asking"),
    timeoutMs: z.number().optional().describe("Per-delegation timeout in milliseconds (default 900000, 15 minutes)"),
    defaultDirectory: z.string().nullable().optional().describe("Absolute project path used when a call omits directory"),
    profiles: z.record(z.any()).optional().describe("The whole profiles object: { name: { model, agent, variant, autoApprove, directory } }. A profile set to null is deleted"),
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
