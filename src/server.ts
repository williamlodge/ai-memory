import express, { type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  addMemory, getMemory, updateMemory, deleteMemory,
  searchMemories, listMemories, listProjects, exportAll, type Memory,
} from "./db.js";
import { agentForToken } from "./auth.js";

const PORT = Number(process.env.PORT || 3850);
const HOST = process.env.HOST || "127.0.0.1"; // only reachable through the reverse proxy

const fmt = (m: Memory) =>
  `#${m.id} [${m.project}]${m.tags ? ` {${m.tags}}` : ""} (by ${m.source}, ${m.updated_at})\n${m.content}`;
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const list = (rows: Memory[], empty = "No memories found.") =>
  text(rows.length ? rows.map(fmt).join("\n\n---\n\n") : empty);

function buildServer(agent: string) {
  const server = new McpServer({ name: "william-ai-memory", version: "1.0.0" });

  server.registerTool("remember", {
    title: "Save a memory",
    description:
      "Save a durable fact, decision, preference, or project note so other AI agents can recall it later. " +
      "Use a project slug (e.g. eventcrewos, homelessdenver, code2cms, williamlodge, vps) when it applies.",
    inputSchema: {
      content: z.string().min(1).describe("The fact or note, written so it makes sense on its own later"),
      project: z.string().optional().describe("Project slug; defaults to 'general'"),
      tags: z.array(z.string()).optional().describe("Optional short tags"),
    },
  }, async ({ content, project, tags }) => {
    const m = addMemory(content, agent, project, tags);
    return text(`Saved.\n\n${fmt(m)}`);
  });

  server.registerTool("recall", {
    title: "Search memories",
    description:
      "Full-text search across saved memories. Call this at the start of a task to load context about the user's projects, preferences, and past decisions.",
    inputSchema: {
      query: z.string().describe("Keywords to search for"),
      project: z.string().optional().describe("Limit to one project slug"),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ query, project, limit }) => list(searchMemories(query, project, limit ?? 10)));

  server.registerTool("list_recent", {
    title: "List recent memories",
    description: "List the most recently updated memories, optionally for one project.",
    inputSchema: {
      project: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ project, limit }) => list(listMemories(project, limit ?? 20)));

  server.registerTool("list_projects", {
    title: "List projects",
    description: "List every project slug in memory with how many memories each has.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const p = listProjects();
    return text(p.length ? p.map((r) => `${r.project} — ${r.count} memories (last ${r.last_updated})`).join("\n") : "No projects yet.");
  });

  server.registerTool("get_memory", {
    title: "Get one memory",
    description: "Fetch a single memory by its id.",
    inputSchema: { id: z.number().int() },
    annotations: { readOnlyHint: true },
  }, async ({ id }) => {
    const m = getMemory(id);
    return text(m ? fmt(m) : `No memory #${id}.`);
  });

  server.registerTool("update_memory", {
    title: "Update a memory",
    description: "Correct or replace an existing memory instead of saving a duplicate.",
    inputSchema: {
      id: z.number().int(),
      content: z.string().optional(),
      project: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
  }, async ({ id, ...fields }) => {
    const m = updateMemory(id, agent, fields);
    return text(m ? `Updated.\n\n${fmt(m)}` : `No memory #${id}.`);
  });

  server.registerTool("forget", {
    title: "Delete a memory",
    description: "Permanently delete a memory by id. Only do this when the user asks.",
    inputSchema: { id: z.number().int() },
    annotations: { destructiveHint: true },
  }, async ({ id }) => text(deleteMemory(id) ? `Deleted #${id}.` : `No memory #${id}.`));

  return server;
}

// ---------- HTTP ----------
const app = express();
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "1mb" }));

type AuthedReq = Request & { agent?: string };

// Token from "Authorization: Bearer <token>" OR from the URL (/mcp/<token>) for
// clients like ChatGPT/Claude web connectors that can't set custom headers.
function auth(req: AuthedReq, res: Response, next: NextFunction) {
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const agent = agentForToken(header || (req.params.token as string | undefined));
  if (!agent) return res.status(401).json({ error: "unauthorized" });
  req.agent = agent;
  next();
}

async function handleMcp(req: AuthedReq, res: Response) {
  // Stateless: a fresh server + transport per request. Simple and robust behind a proxy.
  const server = buildServer(req.agent!);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP error:", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
}

const notAllowed = (_req: Request, res: Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });

app.post("/mcp", auth, handleMcp);
app.post("/mcp/:token", auth, handleMcp);
app.get(["/mcp", "/mcp/:token"], notAllowed);
app.delete(["/mcp", "/mcp/:token"], notAllowed);

// Plain REST API for agents without MCP support (Kimi, scripts, Custom GPT Actions).
const api = express.Router({ mergeParams: true });
api.use(auth);
api.get("/memories", (req: AuthedReq, res) => {
  const q = String(req.query.q || "");
  const project = req.query.project ? String(req.query.project) : undefined;
  const limit = Math.min(Number(req.query.limit) || 10, 100);
  res.json(q ? searchMemories(q, project, limit) : listMemories(project, limit));
});
api.post("/memories", (req: AuthedReq, res) => {
  const { content, project, tags } = req.body || {};
  if (!content || typeof content !== "string") return res.status(400).json({ error: "content required" });
  res.status(201).json(addMemory(content, req.agent!, project, Array.isArray(tags) ? tags : undefined));
});
api.get("/memories/:id", (req, res) => {
  const m = getMemory(Number(req.params.id));
  m ? res.json(m) : res.status(404).json({ error: "not found" });
});
api.patch("/memories/:id", (req: AuthedReq, res) => {
  const { content, project, tags } = req.body || {};
  const m = updateMemory(Number(req.params.id), req.agent!, {
    content: typeof content === "string" ? content : undefined,
    project: typeof project === "string" ? project : undefined,
    tags: Array.isArray(tags) ? tags.map(String) : typeof tags === "string" ? tags.split(",") : undefined,
  });
  m ? res.json(m) : res.status(404).json({ error: "not found" });
});
api.delete("/memories/:id", (req, res) => {
  deleteMemory(Number(req.params.id)) ? res.status(204).end() : res.status(404).json({ error: "not found" });
});
api.get("/projects", (_req, res) => res.json(listProjects()));
api.get("/export", (_req, res) => res.json(exportAll()));
app.use("/api/t/:token", api); // token-in-URL variant
app.use("/api", api);          // Authorization: Bearer header

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, HOST, () => console.log(`ai-memory listening on http://${HOST}:${PORT}`));
