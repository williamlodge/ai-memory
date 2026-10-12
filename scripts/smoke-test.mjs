// End-to-end test: starts the server on a temp DB, creates an agent key,
// then talks to it with the official MCP client and the REST API.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aimem-"));
const env = { ...process.env, MEMORY_DB: path.join(tmp, "test.db"), PORT: "3899" };
const base = "http://127.0.0.1:3899";

const out = execFileSync("node", ["dist/cli.js", "add-agent", "tester"], { env }).toString();
const token = out.match(/mem_[\w-]+/)[0];

const srv = spawn("node", ["dist/server.js"], { env, stdio: "inherit" });
await new Promise((r) => setTimeout(r, 800));

let failed = false;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed = true; };

try {
  check((await fetch(`${base}/mcp`, { method: "POST" })).status === 401, "rejects missing token");

  // MCP via Authorization header
  const c1 = new Client({ name: "t1", version: "1" });
  await c1.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  const tools = (await c1.listTools()).tools.map((t) => t.name);
  check(tools.includes("remember") && tools.includes("recall"), `lists tools: ${tools.join(", ")}`);

  const saved = await c1.callTool({ name: "remember", arguments: {
    content: "EventCrewOS uses the Road Case design system", project: "EventCrewOS", tags: ["design"] } });
  check(saved.content[0].text.includes("[eventcrewos]"), "remember normalizes project slug");

  // MCP via token in URL (for web connectors)
  const c2 = new Client({ name: "t2", version: "1" });
  await c2.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${token}`)));
  const found = await c2.callTool({ name: "recall", arguments: { query: "road case" } });
  check(found.content[0].text.includes("Road Case"), "recall finds it via URL-token connection");
  check(found.content[0].text.includes("by tester"), "records which agent wrote it");

  // REST
  const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const r = await fetch(`${base}/api/memories`, { method: "POST", headers: h,
    body: JSON.stringify({ content: "VPS runs AlmaLinux 9 with DirectAdmin", project: "vps" }) });
  check(r.status === 201, "REST create");
  const s = await (await fetch(`${base}/api/t/${token}/memories?q=almalinux`)).json();
  check(s.length === 1 && s[0].project === "vps", "REST search via URL token");
  const p = await (await fetch(`${base}/api/projects`, { headers: h })).json();
  check(p.length === 2, "lists 2 projects");

  await c1.close(); await c2.close();
} catch (e) {
  console.error(e); failed = true;
} finally {
  srv.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
