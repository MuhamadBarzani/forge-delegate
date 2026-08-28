import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const OPENCODE_TIMEOUT = Number(process.env.FORGE_OPENCODE_TIMEOUT ?? 900_000);
const CONFIG_DIR = join(homedir(), ".forge-delegate");
const AUTH_PATH = join(homedir(), ".local/share/opencode/auth.json");
const OPENCODE_CONFIG_PATH = join(homedir(), ".config/opencode/opencode.json");
const CATALOG_CACHE = join(CONFIG_DIR, "models-dev.json");
const CATALOG_TTL = 24 * 3600 * 1000;
const VARIANTS_CACHE = join(CONFIG_DIR, "variants.json");
const OLLAMA_BASE = process.env.OLLAMA_URL ?? "http://localhost:11434";

function loadOpencodeAuth() {
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

export function opencodeArgs(model, prompt, { files, sessionId, variant, directory, agent, autoApprove } = {}) {
  const args = ["run", "--format", "json"];
  if (autoApprove) args.push("--auto");
  if (sessionId) args.push("-s", sessionId);
  if (directory) args.push("--dir", directory);
  if (agent) args.push("--agent", agent);
  args.push("-m", model);
  if (variant) args.push("--variant", variant);
  for (const f of files ?? []) args.push("-f", f);
  args.push(prompt);
  return args;
}

export async function pickVariant(model) {
  const [provider, ...rest] = model.split("/");
  const id = rest.join("/");
  if (!provider || !id || model.startsWith("ollama:")) return undefined;
  let variants = {};
  try {
    variants = await loadVariantMap();
  } catch {
    return undefined;
  }
  const list = variants[`${provider}/${id}`];
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list.length === 1 ? list[0] : list[list.length - 2];
}

// Variant names per provider/model, discovered from `GET /config/providers`
// on a short-lived local opencode server. Cached on disk for 24h.
async function loadVariantMap() {
  try {
    const cached = JSON.parse(readFileSync(VARIANTS_CACHE, "utf8"));
    if (Date.now() - cached.fetchedAt < CATALOG_TTL && cached.data) return cached.data;
  } catch {}
  const child = spawn("opencode", ["serve", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const baseUrl = await new Promise((resolvePromise, rejectPromise) => {
      let out = "";
      const timer = setTimeout(() => rejectPromise(new Error("opencode serve timed out")), 20_000);
      child.stdout.on("data", (d) => {
        out += d;
        const m = out.match(/listening on (https?:\/\/\S+)/);
        if (m) {
          clearTimeout(timer);
          resolvePromise(m[1]);
        }
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        rejectPromise(e);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        rejectPromise(new Error("opencode serve exited before listening"));
      });
    });
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/config/providers`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`config/providers ${res.status}`);
    const body = await res.json();
    const providers = body.providers ?? body;
    const map = {};
    for (const p of Array.isArray(providers) ? providers : Object.values(providers)) {
      for (const [mid, m] of Object.entries(p.models ?? {})) {
        if (m?.variants) map[`${p.id}/${mid}`] = Object.keys(m.variants);
      }
    }
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(VARIANTS_CACHE, JSON.stringify({ fetchedAt: Date.now(), data: map }));
    } catch {}
    return map;
  } finally {
    child.kill("SIGKILL");
  }
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
  const started = Date.now();
  const variant = opts.variant ?? (await pickVariant(model));
  const timeoutMs = opts.timeoutMs ?? OPENCODE_TIMEOUT;
  const cwd = opts.directory ?? process.cwd();
  const stdout = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("opencode", opencodeArgs(model, prompt, { ...opts, variant }), {
      cwd,
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
  const auth = loadOpencodeAuth();
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
  const auth = loadOpencodeAuth();
  if (!auth[prov]?.key)
    throw new Error(`no opencode login for '${prov}' — run: opencode auth login ${prov}`);
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

