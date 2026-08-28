// MCP handshake smoke test: boots the server via stdio, lists tools, and calls
// each one once to catch invalid tools/call result shapes (e.g. bare-string returns).
// Runs against the LOCAL source (node server.mjs). Exit code nonzero on any failure.
import { spawn } from "node:child_process";

const child = spawn("node", ["server.mjs"], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
let nextId = 1;
const pending = new Map();
const tools = [];

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

child.stdout.on("data", (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      if (msg.method === "initialize") {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1.0.0" } } }) + "\n");
      } else if (msg.method === "tools/list") {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools } }) + "\n");
      } else if (msg.method === "notifications/initialized") {
        // noop
      }
    }
  }
});

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL: ${msg}`);
};
const ok = (msg) => console.log(`  ok  ${msg}`);

await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-test", version: "1.0.0" } });
await send("notifications/initialized", {});
const list = await send("tools/list", {});
tools.push(...(list.result?.tools ?? []));
if (tools.length === 6) ok(`${tools.length} tools listed`);
else fail(`expected 6 tools, got ${tools.length}: ${tools.map((t) => t.name).join(",")}`);

const expected = ["list_models", "ask_model", "delegate", "check_delegation", "get_delegate_config", "set_delegate_config"];
for (const name of expected) {
  if (!tools.find((t) => t.name === name)) fail(`missing tool: ${name}`);
}

const calls = [
  ["list_models", {}],
  ["get_delegate_config", {}],
  ["set_delegate_config", {}],
  ["check_delegation", {}],
];

for (const [name, args] of calls) {
  const r = await send("tools/call", { name, arguments: args });
  if (r.error) fail(`${name}: ${r.error.message.slice(0, 80)}`);
  else if (r.result?.isError) fail(`${name}: returned isError=true: ${r.result.content?.[0]?.text}`);
  else if (!r.result?.content?.[0]?.text) fail(`${name}: no text content in result`);
  else ok(`${name}`);
}

// ask_model/delegate_* require a live model — skip them here (they share the withUsage path).
child.kill();
process.exit(failures ? 1 : 0);