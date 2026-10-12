#!/usr/bin/env bash
# Nightly SQLite backup, keeps 30 days. Cron (as admin):
#   15 3 * * * /home/admin/projects/ai-memory/deploy/backup.sh
set -euo pipefail
SRC=/home/admin/ai-memory-data/memory.db
DEST=/home/admin/backups/ai-memory
mkdir -p "$DEST"
sqlite3 "$SRC" ".backup '$DEST/memory-$(date +%F).db'"
find "$DEST" -name 'memory-*.db' -mtime +30 -delete
