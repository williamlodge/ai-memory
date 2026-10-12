import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type Memory = {
  id: number;
  content: string;
  project: string;
  tags: string;
  source: string;
  created_at: string;
  updated_at: string;
};

const DB_PATH = process.env.MEMORY_DB || path.resolve("data/memory.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT 'general',
  tags TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mem_project ON memories(project);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, project, tags, content='memories', content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, project, tags) VALUES (new.id, new.content, new.project, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, project, tags) VALUES ('delete', old.id, old.content, old.project, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS mem_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, project, tags) VALUES ('delete', old.id, old.content, old.project, old.tags);
  INSERT INTO memories_fts(rowid, content, project, tags) VALUES (new.id, new.content, new.project, new.tags);
END;

CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
`);

const norm = (s?: string) => (s || "general").trim().toLowerCase().replace(/\s+/g, "-");
const normTags = (t?: string[]) =>
  (t || []).map((x) => x.trim().toLowerCase()).filter(Boolean).join(",");

export function addMemory(content: string, source: string, project?: string, tags?: string[]): Memory {
  const info = db
    .prepare("INSERT INTO memories (content, project, tags, source) VALUES (?, ?, ?, ?)")
    .run(content.trim(), norm(project), normTags(tags), source);
  return getMemory(Number(info.lastInsertRowid))!;
}

export function getMemory(id: number): Memory | undefined {
  return db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Memory | undefined;
}

export function updateMemory(id: number, source: string, fields: { content?: string; project?: string; tags?: string[] }) {
  const cur = getMemory(id);
  if (!cur) return undefined;
  db.prepare(
    "UPDATE memories SET content = ?, project = ?, tags = ?, source = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(
    fields.content?.trim() ?? cur.content,
    fields.project !== undefined ? norm(fields.project) : cur.project,
    fields.tags !== undefined ? normTags(fields.tags) : cur.tags,
    source,
    id
  );
  return getMemory(id);
}

export function deleteMemory(id: number): boolean {
  return db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
}

// Turn free text into a safe FTS5 query: each word quoted, OR'd together.
function ftsQuery(q: string) {
  const words = q.match(/[\p{L}\p{N}_.-]+/gu) || [];
  return words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
}

export function searchMemories(query: string, project?: string, limit = 10): Memory[] {
  const fq = ftsQuery(query);
  if (!fq) return listMemories(project, limit);
  const sql = `
    SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
    WHERE memories_fts MATCH ? ${project ? "AND m.project = ?" : ""}
    ORDER BY bm25(memories_fts) LIMIT ?`;
  const args: unknown[] = [fq];
  if (project) args.push(norm(project));
  args.push(limit);
  return db.prepare(sql).all(...args) as Memory[];
}

export function listMemories(project?: string, limit = 20): Memory[] {
  if (project)
    return db.prepare("SELECT * FROM memories WHERE project = ? ORDER BY updated_at DESC, id DESC LIMIT ?").all(norm(project), limit) as Memory[];
  return db.prepare("SELECT * FROM memories ORDER BY updated_at DESC, id DESC LIMIT ?").all(limit) as Memory[];
}

export function listProjects(): { project: string; count: number; last_updated: string }[] {
  return db
    .prepare("SELECT project, COUNT(*) AS count, MAX(updated_at) AS last_updated FROM memories GROUP BY project ORDER BY last_updated DESC")
    .all() as any;
}

export function exportAll(): Memory[] {
  return db.prepare("SELECT * FROM memories ORDER BY id").all() as Memory[];
}
