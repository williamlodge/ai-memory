import fs from "node:fs";
import { createAgent, revokeAgent, listAgents } from "./auth.js";
import { exportAll, addMemory } from "./db.js";

if (process.getuid?.() === 0) {
  console.error("Don't run this as root (it would create root-owned DB files the service can't write).\nUse: sudo -u admin npm run cli -- <command>");
  process.exit(1);
}

const [cmd, arg] = process.argv.slice(2);
const BASE = process.env.PUBLIC_URL || "https://memory.williamlodge.com";

switch (cmd) {
  case "add-agent": {
    if (!arg) { console.error("Usage: npm run cli -- add-agent <name>"); process.exit(1); }
    const token = createAgent(arg);
    console.log(`\nAgent "${arg}" key (shown ONCE, store it in your password manager):\n\n  ${token}\n`);
    console.log(`MCP URL (header auth):  ${BASE}/mcp   + header  Authorization: Bearer ${token}`);
    console.log(`MCP URL (no headers):   ${BASE}/mcp/${token}`);
    console.log(`REST API:               ${BASE}/api/memories?q=...\n`);
    break;
  }
  case "revoke-agent":
    console.log(revokeAgent(arg) ? `Revoked ${arg}` : `No agent ${arg}`);
    break;
  case "list-agents":
    console.table(listAgents());
    break;
  case "export": {
    const out = arg || `memory-export-${new Date().toISOString().slice(0, 10)}.json`;
    fs.writeFileSync(out, JSON.stringify(exportAll(), null, 2));
    console.log(`Exported to ${out}`);
    break;
  }
  case "import": {
    // JSON array of { content, project?, tags?: string[] | "a,b", source? }
    const rows = JSON.parse(fs.readFileSync(arg, "utf8"));
    for (const r of rows)
      addMemory(r.content, r.source || "import", r.project, Array.isArray(r.tags) ? r.tags : r.tags ? String(r.tags).split(",") : []);
    console.log(`Imported ${rows.length} memories`);
    break;
  }
  default:
    console.log("Commands: add-agent <name> | revoke-agent <name> | list-agents | export [file] | import <file>");
}
