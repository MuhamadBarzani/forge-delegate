#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { loadConfig, saveConfig, configPath } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    if (eq >= 0) args[key] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      args[key] = argv[i + 1];
      i++;
    } else args[key] = true;
  }
  return args;
}

function launchCommand() {
  const isPublished = here.includes(join("node_modules", "forge-delegate")) || here.includes("/.npm/_npx/");
  return isPublished ? "npx -y forge-delegate serve" : `node ${join(here, "cli.mjs")} serve`;
}

function launchArray() {
  const isPublished = here.includes(join("node_modules", "forge-delegate")) || here.includes("/.npm/_npx/");
  return isPublished ? ["npx", "-y", "forge-delegate", "serve"] : [process.execPath, join(here, "cli.mjs"), "serve"];
}

function registerClaude(launch, scope) {
  try {
    execSync(`claude mcp remove --scope ${scope} forge-delegate`, { stdio: "ignore" });
  } catch {}
  try {
    execSync(`claude mcp remove forge-delegate`, { stdio: "ignore" });
  } catch {}
  execSync(`claude mcp add --scope ${scope} forge-delegate -- ${launch}`, { stdio: "inherit" });
  console.log(`  ✓ Claude Code (scope=${scope})`);
}

function codexConfigPath(scope, projectDir) {
  return scope === "user" ? join(homedir(), ".codex", "config.toml") : join(projectDir, ".codex", "config.toml");
}

function registerCodex(launchArr, scope, projectDir) {
  const path = codexConfigPath(scope, projectDir);
  mkdirSync(dirname(path), { recursive: true });
  let toml = "";
  try {
    toml = readFileSync(path, "utf8");
  } catch {}
  const section = `[mcp_servers.forge-delegate]`;
  const block = `${section}\ncommand = ${JSON.stringify(launchArr[0])}\nargs = ${JSON.stringify(launchArr.slice(1))}\n`;
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (toml.includes(section)) {
    toml = toml.replace(new RegExp(`${escaped}[\\s\\S]*?(?=\\n\\[|$)`), block.trimEnd());
  } else {
    toml += (toml.endsWith("\n") || toml === "" ? "" : "\n") + "\n" + block;
  }
  writeFileSync(path, toml);
  console.log(`  ✓ Codex (${path})`);
}

function opencodeConfigPath(scope, projectDir) {
  return scope === "user" ? join(homedir(), ".config", "opencode", "opencode.json") : join(projectDir, "opencode.json");
}

function registerOpencode(launchArr, scope, projectDir) {
  const path = opencodeConfigPath(scope, projectDir);
  mkdirSync(dirname(path), { recursive: true });
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  cfg.mcp = cfg.mcp ?? {};
  cfg.mcp["forge-delegate"] = { type: "local", command: launchArr, enabled: true };
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`  ✓ opencode (${path})`);
}

async function setup() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => rl.question(q);
  const flags = parseArgs(process.argv.slice(3));
  const current = loadConfig();

  // Flags win; anything omitted is asked interactively (Enter accepts the [default]).
  // In a non-terminal (piped/automated) run, prompts are skipped and defaults are used.
  const interactive = !!process.stdin.isTTY;
  let model = flags.model;
  let targets = flags.targets;
  let scope = flags.scope;
  let projectDir = flags["project-dir"];

  console.log("\n=== forge-delegate setup ===\n");
  if (interactive) console.log("Press Enter to accept the suggested [default], or type a value.\n");

  if (!model) {
    const def = current.defaultModel ?? "opencode/mimo-v2.5-free";
    model = interactive ? ((await ask(`Default model [${def}]: `)) ?? "").trim() || def : def;
  }
  if (!targets) targets = "claude,codex,opencode";
  if (!scope) scope = "user";
  if (scope === "project" && !projectDir) projectDir = process.cwd();
  projectDir = projectDir ?? process.cwd();
  targets = targets.split(",").map((s) => s.trim().toLowerCase());

  const launch = launchCommand();
  const launchArr = launchArray();

  // 1. Set the default model first so it's saved even if registration hits an issue
  if (model && model !== current.defaultModel) {
    saveConfig({ defaultModel: model });
    console.log(`  ✓ default model set: ${model}`);
  }

  // 2. Register with chosen hosts (claude / codex / opencode)
  for (const target of targets) {
    try {
      if (target === "claude") registerClaude(launch, scope);
      else if (target === "codex") registerCodex(launchArr, scope, projectDir);
      else if (target === "opencode") registerOpencode(launchArr, scope, projectDir);
      else console.log(`  ✗ unknown target '${target}' (use claude,codex,opencode)`);
    } catch (e) {
      console.log(`  ✗ ${target}: ${e.message}`);
    }
  }

  // 3. Check opencode logins
  let authCount = 0;
  try {
    const authPath = join(homedir(), ".local/share/opencode/auth.json");
    authCount = Object.keys(JSON.parse(readFileSync(authPath, "utf8"))).length;
  } catch {}
  if (authCount > 0) {
    console.log(`Found ${authCount} opencode provider login(s) — ready to use.`);
  } else {
    console.log("\nNo opencode logins found. To enable models, run:");
    console.log("  opencode auth login <provider>   (e.g. opencode auth login deepseek)");
    if (interactive) await ask("Press Enter when done (or Ctrl+C to skip): ");
  }

  console.log(`
Done! Restart your agent, then run /mcp (Claude Code) or \`codex mcp\` / \`opencode\` to confirm "forge-delegate" is connected.
Use list_models inside the agent to see everything available.
`);
  rl.close();
}

function configCmd(argv) {
  const sub = argv[0];
  if (sub === "path") {
    console.log(configPath());
    return;
  }
  const flags = parseArgs(argv);
  if (sub === "set") {
    const patch = {};
    if (flags.model) patch.defaultModel = flags.model;
    if (flags.agent) patch.defaultAgent = flags.agent;
    if (flags.variant) patch.defaultVariant = flags.variant;
    if (flags.timeout) patch.timeoutMs = Number(flags.timeout) * 1000;
    if (flags.dir) patch.defaultDirectory = flags.dir;
    if (flags["default-dir"]) patch.defaultDirectory = flags["default-dir"];
    if (flags.autoApprove !== undefined) patch.autoApprove = flags.autoApprove === "true" || flags.autoApprove === "1" || flags.autoApprove === true;
    saveConfig(patch);
    console.log(`updated ${configPath()}`);
  }
  const cfg = loadConfig();
  console.log(JSON.stringify(cfg, null, 2));
}

async function status() {
  let providers = [];
  try {
    const authPath = join(homedir(), ".local/share/opencode/auth.json");
    const { listAuthDirectProviders } = await import("./lib.mjs");
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    providers = Object.keys(auth);
  } catch {}
  console.log(`\nopencode logins: ${providers.length ? providers.join(", ") : "none (run 'opencode auth login <provider>')"}\n`);
  try {
    const usagePath = join(homedir(), ".forge-delegate", "usage.jsonl");
    if (existsSync(usagePath)) {
      const lines = readFileSync(usagePath, "utf8").trim().split("\n").length;
      console.log(`recorded delegations: ${lines} (see 'forge-delegate stats')`);
    }
  } catch {}
}

function stats() {
  const usagePath = join(homedir(), ".forge-delegate", "usage.jsonl");
  if (!existsSync(usagePath)) {
    console.log("no usage recorded yet");
    return;
  }
  const byKey = new Map();
  for (const line of readFileSync(usagePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const u = JSON.parse(line);
      const key = `${u.tool} · ${u.model}`;
      const s = byKey.get(key) ?? { calls: 0, ok: 0, ms: 0, tokens: 0 };
      s.calls++;
      if (u.ok) s.ok++;
      s.ms += u.ms ?? 0;
      s.tokens += u.tokens ?? 0;
      byKey.set(key, s);
    } catch {}
  }
  console.log("\nforge-delegate usage\n");
  console.log("calls  ok%   avg(s)   tokens  tool · model");
  for (const [key, s] of [...byKey.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
    console.log(
      String(s.calls).padStart(5),
      Math.round((s.ok / s.calls) * 100).toString().padStart(4) + "%",
      (s.ms / s.calls / 1000).toFixed(1).padStart(7),
      s.tokens ? String(s.tokens).padStart(8) : "       —",
      " ", key
    );
  }
  console.log(`\nlog: ${usagePath}\n`);
}

function help() {
  console.log(`
forge-delegate — delegate coding work from Claude Code/Codex/opencode to other AI models

Usage:
  forge-delegate setup [--model provider/model] [--targets claude,codex,opencode]
                       [--scope user|project] [--project-dir <path>]
                                             Interactive setup; flags optional (run bare to be prompted)
  forge-delegate serve                        Start the MCP server (used internally by agents)
  forge-delegate config get                   Show current configuration
  forge-delegate config set --model <m> [--agent <a>] [--variant <v>]
                          [--timeout <s>] [--dir <path>] [--autoApprove true|false]
  forge-delegate config path                  Print config file path
  forge-delegate status                       Show opencode logins and usage summary
  forge-delegate stats                        Show detailed usage statistics

Models come from your opencode installation:
  opencode auth login <provider>   add a provider
  opencode models                  list available models
`);
}

const cmd = process.argv[2] ?? "help";
if (cmd === "setup") await setup();
else if (cmd === "serve") await import("./server.mjs");
else if (cmd === "config") configCmd(process.argv.slice(3));
else if (cmd === "status") await status();
else if (cmd === "stats") stats();
else help();
