#!/usr/bin/env node
// forge-delegate launcher.
//
// Clients run this file instead of npx. It keeps a private install under
// ~/.forge-delegate/pkg, refreshes it from npm when a newer same-major release
// exists, then starts `node cli.mjs serve`.
//
// An update never blocks startup: the new version is fetched in the background
// and used on the next launch. If the registry or npm is unavailable, the last
// good version runs. A cold start with nothing installed falls back to npx.
//
// `--install-only <version>` exists for `setup`, which pre-installs the running
// version so a client's first launch does not have to wait for npm.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(homedir(), ".forge-delegate");
const PKG = join(ROOT, "pkg");
const STATE = join(ROOT, "launcher-state.json");
const LATEST = join(ROOT, "latest.json");
const SKILL = join(homedir(), ".claude", "skills", "delegate-work", "SKILL.md");
const REGISTRY = process.env.FORGE_REGISTRY ?? "https://registry.npmjs.org";
const TTL = 6 * 3600 * 1000;
const AUTO =
  process.env.FORGE_AUTO_UPDATE !== "0" &&
  process.env.FORGE_AUTO_UPDATE !== "false" &&
  process.env.FORGE_NO_AUTO_UPDATE !== "1";

function parseVersion(v) {
  const m = String(v ?? "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function cliPath(version) {
  if (!version) return null;
  const cli = join(PKG, version, "node_modules", "forge-delegate", "cli.mjs");
  return existsSync(cli) ? cli : null;
}

// Newest first. A version directory only counts once its cli.mjs exists, so a
// half-finished install can never be selected.
function installedVersions() {
  try {
    return readdirSync(PKG)
      .filter((name) => /^\d+\.\d+\.\d+$/.test(name) && cliPath(name))
      .sort((a, b) => compareVersions(b, a));
  } catch {
    return [];
  }
}

async function latestVersion() {
  const cached = readJson(LATEST);
  if (cached?.version && Number.isFinite(cached.checkedAt) && Date.now() - cached.checkedAt < TTL) {
    return cached.version;
  }
  try {
    const res = await fetch(`${REGISTRY}/forge-delegate/latest`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const { version } = await res.json();
    if (!parseVersion(version)) return null;
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(LATEST, JSON.stringify({ version, checkedAt: Date.now() }));
    return version;
  } catch {
    return null;
  }
}

// Install into a staging directory and rename it into place, so a failed or
// interrupted download never becomes the version the launcher picks.
function installVersion(version) {
  if (cliPath(version)) return true;
  mkdirSync(PKG, { recursive: true });
  const stage = join(PKG, `.tmp-${process.pid}-${Date.now().toString(36)}`);
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const res = spawnSync(
      npm,
      [
        "install",
        "--prefix",
        stage,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--silent",
        `forge-delegate@${version}`,
      ],
      { stdio: "ignore", timeout: 180_000 }
    );
    if (res.status !== 0 || !existsSync(join(stage, "node_modules", "forge-delegate", "cli.mjs"))) return false;
    try {
      renameSync(stage, join(PKG, version));
    } catch {
      // Another process won the race; its copy is complete because it also
      // installed into a staging directory before renaming.
    }
    return Boolean(cliPath(version));
  } finally {
    try {
      rmSync(stage, { recursive: true, force: true });
    } catch {}
  }
}

// Keep the selected version plus one fallback.
function prune(keep) {
  const versions = installedVersions();
  const keepSet = new Set([keep, versions.find((v) => v !== keep)]);
  for (const version of versions) {
    if (keepSet.has(version)) continue;
    try {
      rmSync(join(PKG, version), { recursive: true, force: true });
    } catch {}
  }
}

function installOnly(version) {
  if (!parseVersion(version)) return false;
  const ok = installVersion(version);
  if (ok) prune(version);
  return ok;
}

// The skill is a file on disk that only `setup` rewrites. Refresh it from the
// version being launched, but never create one the user did not ask for.
function syncSkill(cli) {
  try {
    const src = join(dirname(cli), "skills", "delegate-work", "SKILL.md");
    if (!existsSync(src) || !existsSync(SKILL)) return;
    const want = readFileSync(src, "utf8");
    if (readFileSync(SKILL, "utf8") !== want) writeFileSync(SKILL, want);
  } catch {}
}

// `setup` copies this file once, but a later release may fix update logic.
// Refresh it from the version being launched; the running copy is already in
// memory, so replacing the file on disk is safe.
function syncLauncher(cli) {
  try {
    const src = join(dirname(cli), "launcher.mjs");
    if (!existsSync(src) || !existsSync(SELF)) return;
    const want = readFileSync(src, "utf8");
    if (readFileSync(SELF, "utf8") !== want) writeFileSync(SELF, want);
  } catch {}
}

if (process.argv[2] === "--install-only") {
  process.exit(installOnly(process.argv[3]) ? 0 : 1);
}

const current = installedVersions()[0] ?? null;
let target = current;

if (AUTO) {
  const latest = await latestVersion();
  if (latest) {
    const latestMajor = parseVersion(latest)[0];
    const currentMajor = current ? parseVersion(current)[0] : latestMajor;
    if (latestMajor === currentMajor && compareVersions(latest, current ?? "0.0.0") > 0) {
      if (cliPath(latest)) {
        target = latest;
      } else if (current) {
        // Update in the background and run the current version now, so an
        // npm install can never hold up the MCP handshake.
        const child = spawn(process.execPath, [SELF, "--install-only", latest], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      } else if (installVersion(latest)) {
        // Nothing usable installed yet — this one has to be synchronous.
        target = latest;
      }
    } else if (current && latestMajor > currentMajor) {
      process.stderr.write(
        `forge-delegate: ${latest} is a major update and needs a manual upgrade; running ${current}\n`
      );
    }
  }
}

const cli = cliPath(target);
if (cli) {
  syncLauncher(cli);
  syncSkill(cli);
  try {
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(STATE, JSON.stringify({ version: target, autoUpdate: AUTO, updatedAt: Date.now() }));
  } catch {}
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
// No args means "serve" (the MCP entry point). Any other arg is forwarded, so
// `node ~/.forge-delegate/launcher.mjs status` works without a global binary.
const args = process.argv.slice(2);
const cliArgs = args.length ? args : ["serve"];
const child = cli
  ? spawn(process.execPath, [cli, ...cliArgs], { stdio: "inherit" })
  : spawn(npx, ["-y", "forge-delegate", ...cliArgs], { stdio: "inherit" });

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
