#!/usr/bin/env bash
# Create (or replace) ai-memory keys for several agents, test each one against
# the live server, and save them to a private file instead of the screen.
#
#   sudo bash deploy/make-keys.sh                    # default agent list
#   sudo bash deploy/make-keys.sh claude codex       # just these
#
# Running it again for a name REPLACES that agent's key (the old one stops working).
set -euo pipefail

APP=/home/admin/projects/ai-memory
URL=${PUBLIC_URL:-https://memory.williamlodge.com}
AGENTS=("$@")
[ ${#AGENTS[@]} -eq 0 ] && AGENTS=(claude claude-code chatgpt codex gemini kimi glm qwen)

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo (it switches to admin for the CLI)."; exit 1; }

OUT=/root/ai-memory-keys-$(date +%Y%m%d-%H%M%S).txt
umask 077
{
  echo "ai-memory keys created $(date)"
  echo "Copy these into your password manager, then delete this file:  rm $OUT"
  echo "Never paste keys into an AI chat."
  echo
} > "$OUT"

cd "$APP"
for a in "${AGENTS[@]}"; do
  key=$(sudo -u admin npm run --silent cli -- add-agent "$a" | grep -oE 'mem_[A-Za-z0-9_-]+' | head -1)
  if [ -z "$key" ]; then echo "FAIL  $a  (no key created)"; continue; fi
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $key" "$URL/api/projects")
  [ "$code" = 200 ] && status=OK || status="FAIL (HTTP $code)"
  printf '%-12s %s\n' "$a" "$status"
  {
    echo "== $a"
    echo "key:         $key"
    echo "header auth: $URL/mcp   +  Authorization: Bearer $key"
    echo "URL auth:    $URL/mcp/$key"
    echo
  } >> "$OUT"
done

echo
echo "Keys saved to $OUT (only root can read it)."
echo "View:   cat $OUT"
echo "Then copy them to your password manager and run:  rm $OUT"
