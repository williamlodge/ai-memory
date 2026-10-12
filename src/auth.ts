import crypto from "node:crypto";
import { db } from "./db.js";

export const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

export function createAgent(name: string): string {
  const token = "mem_" + crypto.randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO agents (name, token_hash) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET token_hash = excluded.token_hash")
    .run(name.toLowerCase(), hashToken(token));
  return token;
}

export function revokeAgent(name: string): boolean {
  return db.prepare("DELETE FROM agents WHERE name = ?").run(name.toLowerCase()).changes > 0;
}

export function listAgents() {
  return db.prepare("SELECT name, created_at, last_used_at FROM agents ORDER BY name").all();
}

/** Returns the agent name for a valid token, or null. */
export function agentForToken(token?: string | null): string | null {
  if (!token) return null;
  const row = db.prepare("SELECT name FROM agents WHERE token_hash = ?").get(hashToken(token)) as { name: string } | undefined;
  if (!row) return null;
  db.prepare("UPDATE agents SET last_used_at = datetime('now') WHERE name = ?").run(row.name);
  return row.name;
}
