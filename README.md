# ai-memory

One shared, self-hosted memory server for all of William's AI agents: Claude, Claude Code, ChatGPT,
Codex, Gemini, Kimi, GLM, Qwen, or anything else that speaks MCP or plain HTTP.
Any agent can save a fact, and every other agent can recall it.

- **MCP server** over Streamable HTTP at `https://memory.williamlodge.com/mcp`
- **REST API** at `/api/...` for anything without MCP support
- **SQLite + full-text search (FTS5)**, one file, easy to back up
- **One key per agent**, so every memory records who wrote it, and you can revoke one agent without touching the rest

> Built by Claude. See [Why this exists](#why-this-exists) and [How it was built](#how-it-was-built).
>
> **Setup guide for every model** (Claude, Claude Code, ChatGPT, Codex, Gemini, Kimi, GLM, Qwen): https://williamlodge.com/ai-memory/  
> **The build story:** https://williamlodge.com/blog/shared-ai-memory/

---

## Why this exists

Every AI tool keeps its own memory, and that memory lives on the vendor's servers: Claude's with
Anthropic, ChatGPT's with OpenAI, Gemini's with Google, and so on. That causes three problems:

1. **The agents can't see each other.** A decision made with Claude is unknown to Codex or ChatGPT.
2. **You repeat yourself.** Every new chat or tool means re-explaining the same projects, servers, and preferences.
3. **The data isn't yours.** It sits on someone else's servers, in a format you can't easily export, search, or back up.

While working on this setup, Claude suggested a different approach: run **one memory server on your
own VPS**, and connect every agent to it through MCP (Model Context Protocol, the open standard for
giving AI tools access to external tools and data). The memories live in one SQLite file you own,
can read, can back up, and can move.

## How it was built

- **Designed and written by Claude** (claude.ai chat): the server, the database layer, the CLI, the smoke tests, the systemd unit, and the backup script.
- **Reviewed, tested, and deployed by Claude Code** on the VPS: it read every file before running anything, built and ran the tests, installed the service, wired up the OpenLiteSpeed proxy through DirectAdmin, and fixed the bugs listed in [Lessons learned](#lessons-learned-and-fixes).
- William supplied the goal, the server, and the go-aheads.

---

## How it works

```
 Claude / ChatGPT / Codex / Gemini / Kimi / GLM / Qwen / Claude Code
                         │  HTTPS (MCP or REST) + per-agent key
                         ▼
        memory.williamlodge.com  (OpenLiteSpeed, wildcard TLS cert)
                         │  reverse proxy
                         ▼
        127.0.0.1:3850   ai-memory (Node 22, Express, MCP SDK)  ← systemd service, runs as `admin`
                         │
                         ▼
        /home/admin/ai-memory-data/memory.db   (SQLite, WAL mode, FTS5 index)
```

- The Node server only listens on `127.0.0.1`. The only way in from the internet is through the HTTPS proxy.
- MCP is **stateless**: every request gets a fresh MCP server + transport. That keeps it simple and reliable behind a proxy.
- Agent keys look like `mem_<32 random chars>`. Only a **SHA-256 hash** of each key is stored, so the database never contains a usable key.
- Every memory records `source` (which agent wrote or last edited it), `project`, `tags`, and timestamps.

### Tools the agents get

| Tool | What it does |
|---|---|
| `remember` | Save a fact/decision/note, with optional `project` slug and `tags` |
| `recall` | Keyword search across memories (optionally one project) |
| `list_recent` | Most recently updated memories |
| `list_projects` | Every project slug and its count |
| `get_memory` | One memory by id |
| `update_memory` | Fix a memory instead of saving a duplicate |
| `forget` | Delete a memory by id |

Project slugs are lower-cased and spaces become dashes (`Event Crew OS` → `event-crew-os`).
Suggested slugs: `williamlodge`, `eventcrewos`, `fieldcompass`, `homelessdenver`, `homelessboulder`,
`lodgeosint`, `code2cms`, `seo-tools`, `vps`, `general`.

### Project layout

```
src/server.ts            HTTP server: MCP endpoint, REST API, auth middleware, /health
src/db.ts                SQLite schema, FTS5 triggers, all queries
src/auth.ts              create / revoke / list agents, token hashing
src/cli.ts               admin CLI (add-agent, revoke-agent, list-agents, export, import)
scripts/smoke-test.mjs   end-to-end test (temp DB, real MCP client, REST calls)
deploy/ai-memory.service systemd unit
deploy/backup.sh         nightly SQLite backup, keeps 30 days
.env.example             PORT, HOST, MEMORY_DB, PUBLIC_URL
```

### Folder layout on the VPS

```
/home/admin/projects/ai-memory        ← source (this git repo)
/home/admin/projects/ai-memory/.env   ← config (NOT in git, chmod 600)
/home/admin/ai-memory-data/memory.db  ← live database (NOT in git, folder chmod 700)
/home/admin/backups/ai-memory         ← nightly backups
```

---

## Deploy (how it is set up on the VPS)

Server: AlmaLinux 9, DirectAdmin, OpenLiteSpeed, Node 22, sqlite3. The service runs as the
`admin` user. Commands marked *root* need root; everything else runs as `admin`.

### 1. Get the code and build

```bash
cd /home/admin/projects
git clone https://github.com/williamlodge/ai-memory.git
cd ai-memory
npm ci
npm run build
npm test                                  # should print 8 PASS lines
mkdir -p /home/admin/ai-memory-data && chmod 700 /home/admin/ai-memory-data
cp .env.example .env && chmod 600 .env
```

### 2. Run it as a service (*root*)

```bash
cp /home/admin/projects/ai-memory/deploy/ai-memory.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ai-memory
curl -s http://127.0.0.1:3850/health      # → {"ok":true}
```

### 3. Subdomain, TLS, and proxy (*root*)

- **Subdomain/DNS:** `memory` is a DirectAdmin subdomain of `williamlodge.com`; DNS is served by the VPS itself.
- **TLS:** covered by the existing `*.williamlodge.com` wildcard certificate, so no new certificate was needed.
- **Proxy:** on this server, per-subdomain OpenLiteSpeed config lives in the **domain's** custom config
  file, inside `|*if SUB="..."|` blocks. (A separate `memory.williamlodge.com.cust_openlitespeed` file is
  *not* picked up for subdomains.) This block was added to
  `/usr/local/directadmin/data/users/admin/domains/williamlodge.com.cust_openlitespeed`, before the `|*if !SUB|` block:

```
|*if SUB="memory"|
extprocessor ai_memory {
  type                    proxy
  address                 127.0.0.1:3850
  maxConns                50
  pcKeepAliveTimeout      60
  initTimeout             30
  retryTimeout            2
  respBuffer              0
}
context / {
  type                    proxy
  handler                 ai_memory
  addDefaultCharset       off
  extraHeaders            <<<END_extraHeaders
X-Robots-Tag: noindex, nofollow, noarchive
Cache-Control: no-store
  END_extraHeaders
}
|*endif|
```

Then regenerate and restart:

```bash
cd /usr/local/directadmin/custombuild && ./build rewrite_confs
curl -s https://memory.williamlodge.com/health                         # → {"ok":true}
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://memory.williamlodge.com/mcp   # → 401
```

Always back up the custom config and the generated `openlitespeed.conf` before changing them.

### 4. Create a key per agent

**Easiest:** one script creates every key, tests each against the live server, and saves them to a
root-only file instead of printing them:

```bash
sudo bash /home/admin/projects/ai-memory/deploy/make-keys.sh               # claude claude-code chatgpt codex gemini kimi glm qwen
sudo bash /home/admin/projects/ai-memory/deploy/make-keys.sh claude codex  # just these
```

**Or one at a time.** Always run the CLI as `admin`, from the project folder:

```bash
cd /home/admin/projects/ai-memory
sudo -u admin npm run cli -- add-agent claude
sudo -u admin npm run cli -- add-agent claude-code
sudo -u admin npm run cli -- add-agent chatgpt
sudo -u admin npm run cli -- add-agent codex
sudo -u admin npm run cli -- add-agent gemini
sudo -u admin npm run cli -- add-agent kimi
sudo -u admin npm run cli -- add-agent glm
sudo -u admin npm run cli -- add-agent qwen
sudo -u admin npm run cli -- list-agents      # confirm they're in the live DB
```

Each key is shown **once**. Put it straight into your password manager.
**Never paste keys into an AI chat, a ticket, or a commit.** Running `add-agent` again for the same
name replaces that agent's key (the old one stops working).

### 5. Nightly backup

```bash
crontab -e          # as admin, add:
15 3 * * * /home/admin/projects/ai-memory/deploy/backup.sh
```

---

## Connect each agent

Two ways to authenticate:

- **Header (preferred):** URL `https://memory.williamlodge.com/mcp` + header `Authorization: Bearer <key>`.
- **Key in URL:** `https://memory.williamlodge.com/mcp/<key>`. Only for web connectors that can't set headers.
  The key ends up in web server access logs this way, so treat the whole URL like a password.

App menu names change often; if a path below doesn't match, look for "Connectors", "MCP", or "Developer mode" in settings.

**Claude (web/desktop/mobile)**: Settings → Connectors → Add custom connector → URL `https://memory.williamlodge.com/mcp/<claude-key>`.

**ChatGPT**: Settings → Apps & Connectors → Advanced → enable Developer mode → Create connector → URL `https://memory.williamlodge.com/mcp/<chatgpt-key>`, authentication: none.

**Claude Code** (any terminal):
```bash
claude mcp add --transport http --scope user memory https://memory.williamlodge.com/mcp --header "Authorization: Bearer <claude-code-key>"
```

**Codex CLI**: `~/.codex/config.toml` (Windows: `C:\Users\<you>\.codex\config.toml`):
```toml
[mcp_servers.memory]
url = "https://memory.williamlodge.com/mcp"
bearer_token_env_var = "AI_MEMORY_KEY"
```
Then set the key: `export AI_MEMORY_KEY="<codex-key>"` (Linux/WSL, add to `~/.bashrc`) or `setx AI_MEMORY_KEY "<codex-key>"` (PowerShell, then open a new terminal).

**Gemini CLI**: `~/.gemini/settings.json`:
```json
{
  "mcpServers": {
    "memory": {
      "httpUrl": "https://memory.williamlodge.com/mcp",
      "headers": { "Authorization": "Bearer <gemini-key>" }
    }
  }
}
```

**Kimi, GLM, Qwen, scripts, or anything without MCP**: use the REST API:
```
GET    /api/memories?q=road+case&project=eventcrewos   search (omit q to list recent)
POST   /api/memories          {"content": "...", "project": "...", "tags": ["..."]}
GET    /api/memories/:id
PATCH  /api/memories/:id      {"content"?, "project"?, "tags"?}   (tags: array or "a,b")
DELETE /api/memories/:id
GET    /api/projects
GET    /api/export
```
With header `Authorization: Bearer <key>`, or prefix with `/api/t/<key>/...`.

Quick test from any terminal:
```bash
curl -s -H "Authorization: Bearer <key>" "https://memory.williamlodge.com/api/projects"
```

### Make agents actually use it

Add this to each agent's custom instructions / `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`:

> You have a shared memory MCP server called "memory". At the start of a task, call `recall` with the project name to load context. When we make a durable decision or I state a lasting preference, save it with `remember` under the right project slug. Use `update_memory` instead of saving duplicates. Never save passwords, keys, or tokens.

---

## Security model

- Nothing listens publicly except the HTTPS proxy; the app is bound to `127.0.0.1`.
- Requests without a valid key get `401`. Keys are 192 bits of randomness, so guessing isn't practical.
- Only SHA-256 hashes of keys are stored.
- **Every key has full access** (read, edit, delete, export everything). This is a single-user system; if a key leaks, revoke it right away.
- The service runs as an unprivileged user with `NoNewPrivileges`, `ProtectSystem=full`, and `PrivateTmp`.
- Responses carry `X-Robots-Tag: noindex` and `Cache-Control: no-store`.
- The CLI refuses to run as root.
- Don't store secrets in memories. Every connected agent can read every memory.

---

## Maintenance

```bash
cd /home/admin/projects/ai-memory
sudo -u admin npm run cli -- list-agents               # who has keys, last used
sudo -u admin npm run cli -- revoke-agent chatgpt      # kill one key
sudo -u admin npm run cli -- export                    # JSON dump of everything
sudo -u admin npm run cli -- import file.json          # bulk import [{content, project, tags}]

# Logs
journalctl -u ai-memory -f

# Update after a git push (pull as whoever has GitHub access, then):
sudo -u admin npm ci && sudo -u admin npm run build
systemctl restart ai-memory
```

## Local dev

```bash
npm install
npm run build
npm test
npm run dev        # http://127.0.0.1:3850, DB in ./data/memory.db
```

---

## Lessons learned and fixes

Things that went wrong during the first deploy, and what changed because of them:

1. **The CLI ignored `.env`, so keys went into the wrong database.** `npm run cli` didn't load `.env`,
   so `MEMORY_DB` wasn't set and the CLI quietly created `./data/memory.db` inside the repo. The keys
   it printed didn't exist in the live database and every request got `401`.
   **Fix:** `start` and `cli` now run with `node --env-file-if-exists=.env`. After adding keys, run
   `list-agents` to confirm.
2. **Running the CLI as root.** That can create root-owned database/WAL files that the `admin`
   service can't write to. **Fix:** the CLI now exits if run as root; use `sudo -u admin`.
3. **Keys pasted into a chat.** Any key that has been pasted into an AI chat, screenshot, or ticket
   should be treated as public. **Fix:** regenerate it with `add-agent <name>` (this replaces the old key).
4. **REST tags as a string crashed `PATCH`.** **Fix:** tags are accepted as an array or `"a,b"` on both `POST` and `PATCH`.
5. **DirectAdmin subdomain config.** A standalone `<sub>.<domain>.cust_openlitespeed` file isn't used for
   subdomains on this server; the `|*if SUB="memory"|` block in the parent domain's file is.
6. **SSH sessions dropping.** Fixed separately with `ClientAliveInterval 60` / `ClientAliveCountMax 3` in
   `/etc/ssh/sshd_config.d/40-keepalive.conf` on the server and `ServerAliveInterval 60` on the client.
   Running long sessions inside `tmux` also helps.

---

## Credits

Suggested, designed, and written by **Claude** (Anthropic). Reviewed, tested, deployed, and
documented with **Claude Code**. Owned and operated by William Lodge.
