# ai-memory

One shared memory server for all of William's AI agents (Claude, ChatGPT, Codex, Gemini, Kimi, Claude Code).
Any agent can save a fact, and every other agent can recall it.

- **MCP server** over Streamable HTTP at `https://memory.williamlodge.com/mcp`
- **REST API** at `/api/...` for anything without MCP support
- **SQLite + full-text search**, one file, easy to back up
- **One key per agent**, so every memory records who wrote it, and you can revoke one agent without touching the rest

## Why this exists

Each AI tool keeps its own memory, stored on that company's servers (Claude's on Anthropic's,
ChatGPT's on OpenAI's, and so on). None of them can see what the others know, and the data
isn't under William's control. Every new chat or tool meant re-explaining the same projects.

Claude suggested fixing this with one self-hosted memory server that every agent connects to
over MCP, running on William's own VPS so the data lives in one SQLite file he owns and backs up.
The code was designed and written by Claude (claude.ai chat), then reviewed, tested, and
deployed on the VPS with Claude Code.

## Tools the agents get

| Tool | What it does |
|---|---|
| `remember` | Save a fact/decision/note, with optional `project` slug and `tags` |
| `recall` | Keyword search across memories (optionally one project) |
| `list_recent` | Most recently updated memories |
| `list_projects` | Every project slug and its count |
| `get_memory` | One memory by id |
| `update_memory` | Fix a memory instead of saving a duplicate |
| `forget` | Delete a memory by id |

Suggested project slugs: `williamlodge`, `eventcrewos`, `fieldcompass`, `homelessdenver`, `homelessboulder`, `lodgeosint`, `code2cms`, `seo-tools`, `vps`, `general`.

## Folder layout on the VPS

```
/home/admin/projects/ai-memory      ← source (git repo)
/home/admin/ai-memory-data/memory.db ← live database (NOT in git)
/home/admin/backups/ai-memory       ← nightly backups
```

---

## Deploy

### 1. GitHub

The repo is `github.com/williamlodge/ai-memory` (private). To work on it from Windows:

```powershell
cd C:\Users\william\projects
git clone https://github.com/williamlodge/ai-memory.git
```

### 2. Clone and build (SSH as admin)

```bash
ssh admin@187.124.235.228
node -v                                   # needs v20+
cd /home/admin/projects
git clone https://github.com/williamlodge/ai-memory.git
cd ai-memory
npm ci
npm run build
npm test                                  # should print 8 PASS lines
mkdir -p /home/admin/ai-memory-data
cp .env.example .env
```

### 3. Run it as a service (SSH as root)

```bash
ssh root@187.124.235.228
cp /home/admin/projects/ai-memory/deploy/ai-memory.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ai-memory
systemctl status ai-memory --no-pager
curl -s http://127.0.0.1:3850/health      # → {"ok":true}
```

It listens on 127.0.0.1 only, so nothing is exposed until the proxy is set up.

### 4. Subdomain + HTTPS proxy

1. DirectAdmin → williamlodge.com → **Subdomain Management** → add `memory`.
2. Point DNS: `A  memory  187.124.235.228`.
3. DirectAdmin → **SSL Certificates** → issue Let's Encrypt for `memory.williamlodge.com`.
4. Proxy all requests for the subdomain to `http://127.0.0.1:3850`.
   On OpenLiteSpeed this means defining an external app (type "Web Server", address `127.0.0.1:3850`)
   for the vhost and a context `/` of type "Proxy" pointing to it. Through DirectAdmin this is done
   with a **Custom HTTPD Configuration** for the subdomain. Back up the current config before changing it.
5. Test from your laptop:
   ```powershell
   curl.exe -s https://memory.williamlodge.com/health
   ```

### 5. Create a key per agent (SSH as admin)

```bash
cd /home/admin/projects/ai-memory
npm run cli -- add-agent claude
npm run cli -- add-agent chatgpt
npm run cli -- add-agent codex
npm run cli -- add-agent gemini
npm run cli -- add-agent kimi
npm run cli -- add-agent claude-code
```

Each key is shown **once**. Put it straight into your password manager. Don't paste keys into any AI chat.

### 6. Nightly backup (SSH as admin)

```bash
dnf list installed sqlite || echo "ask root: dnf install sqlite"
crontab -e
# add:
15 3 * * * /home/admin/projects/ai-memory/deploy/backup.sh
```

---

## Connect each agent

Two ways to authenticate:

- **Header:** URL `https://memory.williamlodge.com/mcp` + `Authorization: Bearer <key>`. Use this wherever the client lets you set headers.
- **Key in URL:** `https://memory.williamlodge.com/mcp/<key>`. For web connectors that can't set headers. Treat this whole URL like a password.

App menu names change often; if a path below doesn't match, look for "Connectors", "MCP", or "Developer mode" in settings.

**Claude (web/desktop/mobile)** – Settings → Connectors → Add custom connector → URL `https://memory.williamlodge.com/mcp/<claude-key>`.

**ChatGPT** – Settings → Apps & Connectors → Advanced → enable Developer mode → Create connector → URL `https://memory.williamlodge.com/mcp/<chatgpt-key>`, authentication: none.

**Claude Code** (any terminal):
```bash
claude mcp add --transport http --scope user memory https://memory.williamlodge.com/mcp --header "Authorization: Bearer <claude-code-key>"
```

**Codex CLI** – `C:\Users\william\.codex\config.toml` (or `~/.codex/config.toml` in WSL):
```toml
[mcp_servers.memory]
url = "https://memory.williamlodge.com/mcp"
bearer_token_env_var = "AI_MEMORY_KEY"
```
Then set the key once in PowerShell: `setx AI_MEMORY_KEY "<codex-key>"` (open a new terminal after).

**Gemini CLI** – `C:\Users\william\.gemini\settings.json`:
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

**Kimi / anything without MCP** – use the REST API:
```
GET    /api/memories?q=road+case&project=eventcrewos
POST   /api/memories          {"content": "...", "project": "...", "tags": ["..."]}
PATCH  /api/memories/:id
DELETE /api/memories/:id
GET    /api/projects
GET    /api/export
```
With header `Authorization: Bearer <key>`, or prefix with `/api/t/<key>/...`.

### Make agents actually use it

Add this to each agent's custom instructions / `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`:

> You have a shared memory MCP server called "memory". At the start of a task, call `recall` with the project name to load context. When we make a durable decision or I state a lasting preference, save it with `remember` under the right project slug. Use `update_memory` instead of saving duplicates. Never save passwords, keys, or tokens.

---

## Maintenance

```bash
npm run cli -- list-agents               # who has keys, last used
npm run cli -- revoke-agent chatgpt      # kill one key
npm run cli -- export                    # JSON dump of everything
npm run cli -- import file.json          # bulk import [{content, project, tags}]

# Update after a git push:
cd /home/admin/projects/ai-memory && git status && git pull && npm ci && npm run build
sudo systemctl restart ai-memory
```

## Local dev (Windows)

```powershell
cd C:\Users\william\projects\ai-memory
npm install
npm run build
npm test
npm run dev        # http://127.0.0.1:3850, DB in .\data\memory.db
```
