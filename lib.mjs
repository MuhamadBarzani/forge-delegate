import { execFile, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const OPENCODE_TIMEOUT = Number(process.env.FORGE_OPENCODE_TIMEOUT ?? 900_000);

// forge-delegate targets opencode v2+. v2 removed the `--dir` and `--variant`
// flags from `run` — and treats an unknown flag as a help request, exiting 0 —
// so an older binary fails silently. Detecting the version is the only way to
// tell the user instead of returning empty results.
export function parseOpencodeVersion(text) {
  const m = String(text ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], raw: m[0] };
}

export function detectOpencode() {
  return new Promise((resolve) => {
    execFile("opencode", ["--version"], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) return resolve({ found: false, version: null, supported: false });
      const version = parseOpencodeVersion(`${stdout}\n${stderr}`);
      resolve({ found: true, version, supported: Boolean(version) && version.major >= 2 });
    });
  });
}

// The startup warning on stderr is easy for an MCP client to swallow, and a v1
// binary does not fail loudly: `run` reads the v2 flags as a help request and
// exits 0. Check once per process, then refuse to spawn instead of returning
// "(no output)" and letting it look like the model had nothing to say.
let opencodeGate;
function requireOpencodeV2() {
  opencodeGate ??= detectOpencode();
  return opencodeGate.then((oc) => {
    if (!oc.found)
      throw new Error("opencode not found on PATH — install it from https://opencode.ai");
    if (!oc.supported)
      throw new Error(
        `opencode ${oc.version?.raw ?? "(unknown version)"} is too old — forge-delegate requires opencode 2 or newer ` +
          `(v2 removed the CLI flags it uses). Run: opencode upgrade`
      );
    return oc;
  });
}

const CONFIG_DIR = join(homedir(), ".forge-delegate");
const AUTH_PATH = join(homedir(), ".local/share/opencode/auth.json");
const OPENCODE_CONFIG_PATH = join(homedir(), ".config/opencode/opencode.json");
const CATALOG_CACHE = join(CONFIG_DIR, "models-dev.json");
const CATALOG_TTL = 24 * 3600 * 1000;
const OLLAMA_BASE = process.env.OLLAMA_URL ?? "http://localhost:11434";

function execFileText(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// opencode v2 moved credentials into its own store; auth.json is frozen at
// whatever v1 last wrote there. Reading the file on v2 therefore hands back
// stale keys, which surface as 401s that look like the user's fault. Ask v2
// for its credentials instead, and fall back to the file on v1 (where the
// `auth export` command does not exist).
export async function loadOpencodeAuth() {
  try {
    const entries = JSON.parse(await execFileText("opencode", ["auth", "export"]));
    if (Array.isArray(entries)) {
      const auth = {};
      for (const e of entries) {
        if (e?.integrationID && e?.value?.type === "key" && e.value.key)
          auth[e.integrationID] = { type: "api", key: e.value.key };
      }
      return auth;
    }
  } catch {}
  try {
    return JSON.parse(readFileSync(AUTH_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function loadCatalog() {
  try {
    const cached = JSON.parse(readFileSync(CATALOG_CACHE, "utf8"));
    if (Date.now() - cached.fetchedAt < CATALOG_TTL && cached.data) return cached.data;
  } catch {}
  const res = await fetch("https://models.dev/api.json");
  if (!res.ok) throw new Error(`models.dev ${res.status}`);
  const data = await res.json();
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CATALOG_CACHE, JSON.stringify({ fetchedAt: Date.now(), data }));
  } catch {}
  return data;
}

export function logUsage(entry) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    appendFileSync(join(CONFIG_DIR, "usage.jsonl"), JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
  } catch {}
}

const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function defaultConfig() {
  return {
    defaultModel: null,
    defaultAgent: null,
    defaultVariant: null,
    autoApprove: true,
    timeoutMs: Number(process.env.FORGE_OPENCODE_TIMEOUT ?? 900_000),
    defaultDirectory: null,
    profiles: {},
  };
}

export function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return { ...defaultConfig(), ...raw, profiles: raw.profiles ?? {} };
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(patch = {}) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const next = { ...loadConfig(), ...patch };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function configPath() {
  return CONFIG_PATH;
}

// Merge a single call's options with the active profile (if any) and config defaults.
export function resolveConfig(overrides = {}) {
  const cfg = loadConfig();
  const profile = overrides.profile ? cfg.profiles?.[overrides.profile] ?? {} : {};
  const o = { ...profile, ...overrides };
  return {
    model: o.model ?? cfg.defaultModel ?? null,
    agent: o.agent ?? cfg.defaultAgent ?? null,
    variant: o.variant ?? cfg.defaultVariant ?? null,
    autoApprove: o.autoApprove ?? cfg.autoApprove,
    timeoutMs: o.timeoutMs ?? cfg.timeoutMs,
    directory: o.directory ?? cfg.defaultDirectory ?? null,
  };
}

// opencode v2 selects the run directory via the child's cwd (there is no `--dir`)
// and the reasoning variant inline as `provider/model#variant` (there is no
// `--variant`). Passing the old flags makes `run` print its help and exit 0 —
// a silent no-op, so do not reintroduce them.
export function opencodeArgs(model, prompt, { files, sessionId, variant, agent, autoApprove } = {}) {
  const args = ["run", "--format", "json"];
  if (autoApprove) args.push("--auto");
  if (sessionId) args.push("-s", sessionId);
  if (agent) args.push("--agent", agent);
  const ref = variant && !model.includes("#") ? `${model}#${variant}` : model;
  args.push("-m", ref);
  for (const f of files ?? []) args.push("-f", f);
  args.push(prompt);
  return args;
}

// Variant (reasoning effort) names come from the model catalog's
// `reasoning_options`. opencode v2 no longer exposes them over the server API.
export async function pickVariant(model) {
  if (model.includes("#") || model.startsWith("ollama:")) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = model.slice(0, slash);
  const id = model.slice(slash + 1);
  let catalog;
  try {
    catalog = await loadCatalog();
  } catch {
    return undefined;
  }
  const options = catalog?.[provider]?.models?.[id]?.reasoning_options;
  const effort = Array.isArray(options) ? options.find((o) => o?.type === "effort") : null;
  const list = effort?.values;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list.length === 1 ? list[0] : list[list.length - 2];
}

export function parseEvents(stdout) {
  let text = "";
  let sessionId = null;
  let tokens = 0;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line);
      if (!sessionId && ev.sessionID) sessionId = ev.sessionID;
      if (ev.type === "text" && ev.part?.text) text += (text ? "\n" : "") + ev.part.text;
      if (ev.type === "step_finish" && ev.part?.tokens)
        tokens += (ev.part.tokens.input ?? 0) + (ev.part.tokens.output ?? 0);
    } catch {}
  }
  return { text: text.trim(), sessionId, tokens };
}

export async function opencodeRun(model, prompt, opts = {}) {
  await requireOpencodeV2();
  const started = Date.now();
  const variant = opts.variant ?? (await pickVariant(model));
  const timeoutMs = opts.timeoutMs ?? OPENCODE_TIMEOUT;
  const cwd = opts.directory ?? process.cwd();
  // opencode v2 picks the project from the PWD environment variable, not from the
  // child's cwd — so a delegation with `directory` set would otherwise run against
  // the server's directory while looking like it honoured the option.
  const env = opts.directory ? { ...process.env, PWD: opts.directory } : process.env;
  const stdout = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("opencode", opencodeArgs(model, prompt, { ...opts, variant }), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errOut = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`opencode timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      rejectPromise(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 || out.trim()) resolvePromise(out);
      else rejectPromise(new Error(`opencode exited ${code}: ${errOut.slice(-500) || "no output"}`));
    });
  });
  const { text, sessionId, tokens } = parseEvents(stdout);
  return { text: text || "(no output)", sessionId, tokens, ms: Date.now() - started };
}

export async function callDirect(baseUrl, model, messages, apiKey, extraBody = {}) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, messages, ...extraBody }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

export async function listAuthDirectProviders() {
  const auth = await loadOpencodeAuth();
  let catalog = {};
  try {
    catalog = await loadCatalog();
  } catch {}
  return Object.entries(auth)
    .filter(([, v]) => v?.key)
    .map(([name]) => ({
      name,
      models: Object.keys(catalog[name]?.models ?? {}).slice(0, 10),
      baseUrl: catalog[name]?.api ?? "(unknown)",
    }));
}

// Custom providers defined in opencode.json (npm @ai-sdk/openai-compatible + baseURL)
function loadOpencodeConfigProviders() {
  try {
    const cfg = JSON.parse(readFileSync(OPENCODE_CONFIG_PATH, "utf8"));
    const out = {};
    for (const [name, p] of Object.entries(cfg.provider ?? {})) {
      const baseUrl = p?.options?.baseURL;
      if (!baseUrl || (p.npm && p.npm !== "@ai-sdk/openai-compatible")) continue;
      const models = {};
      for (const [id, m] of Object.entries(p.models ?? {})) {
        models[id] = m?.options ?? {};
      }
      out[name.toLowerCase()] = { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey: p.options?.apiKey, models };
    }
    return out;
  } catch {
    return {};
  }
}

async function ollamaModels() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

export async function listLocalProviders() {
  const ollama = await ollamaModels();
  const config = loadOpencodeConfigProviders();
  return { ollama, config };
}

async function runOllama(model, prompt) {
  const res = await fetch(`${OLLAMA_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

export async function runAuthDirect(model, prompt) {
  const slashIdx = model.indexOf("/");
  if (slashIdx <= 0) throw new Error(`expected provider/model format, got '${model}'`);
  const prov = model.slice(0, slashIdx);
  const id = model.slice(slashIdx + 1);
  const auth = await loadOpencodeAuth();
  if (!auth[prov]?.key) {
    // opencode's own free tier rejects direct HTTP ("can only be used from within
    // OpenCode"), so these models are reachable only through the CLI.
    if (prov === "opencode" || prov === "opencode-go")
      throw new Error(
        `'${model}' is hosted by opencode, whose free tier only works from inside opencode — ` +
          `ask_model cannot call it directly. Use the delegate tool instead, or prefix the model ` +
          `with 'opencode:' to route it through the CLI.`
      );
    throw new Error(`no opencode login for '${prov}' — run: opencode auth login ${prov}`);
  }
  const catalog = await loadCatalog();
  const info = catalog[prov];
  if (!info?.api || info.npm !== "@ai-sdk/openai-compatible")
    throw new Error(`provider '${prov}' is not OpenAI-compatible for direct calls — use 'opencode:${prov}/${id}' instead`);
  const text = await callDirect(info.api, id, [{ role: "user", content: prompt }], auth[prov].key);
  return { text, tokens: null, backend: `opencode-auth:${prov}` };
}

export async function runOne(model, prompt) {
  if (model.startsWith("opencode:")) {
    const r = await opencodeRun(model.slice("opencode:".length), prompt);
    return { text: r.text, tokens: r.tokens, backend: "opencode" };
  }

  if (model.startsWith("ollama:") || model.startsWith("local:") || model.startsWith("ollama/")) {
    const id = model.replace(/^(ollama:|local:|ollama\/)/, "");
    const text = await runOllama(id, prompt);
    return { text, tokens: null, backend: "ollama" };
  }

  // provider/model → opencode auth (catalog) or opencode.json custom providers
  const slashIdx = model.indexOf("/");
  if (slashIdx > 0) {
    const prov = model.slice(0, slashIdx).toLowerCase();
    const id = model.slice(slashIdx + 1);
    const custom = loadOpencodeConfigProviders()[prov];
    if (custom) {
      const extra = custom.models[id] ?? {};
      const text = await callDirect(custom.baseUrl, id, [{ role: "user", content: prompt }], custom.apiKey, extra);
      return { text, tokens: null, backend: `config:${prov}` };
    }
    return runAuthDirect(model, prompt);
  }

  throw new Error(`unknown model '${model}' — see list_models`);
}

