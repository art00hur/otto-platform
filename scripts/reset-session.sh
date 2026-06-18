#!/bin/bash
# Reset OpenClaw sessions on a customer VPS.
# Clears persisted session .jsonl files + runtime logs, then restarts the gateway.
#
# Usage (from backend VPS):
#   ./scripts/reset-session.sh <customer-vps-ip>
#
# Example:
#   ./scripts/reset-session.sh ${CLIENT_VPS_IP}

set -e

VPS_IP="${1:?Usage: reset-session.sh <vps-ip>}"

echo "==> Resetting sessions on $VPS_IP..."

ssh -o StrictHostKeyChecking=no "root@$VPS_IP" bash -s <<'REMOTE'
set -e

CLAW_HOME="/home/openclaw/.openclaw"
CLAW_UID=$(id -u openclaw)
TMP_DIR="/tmp/openclaw-${CLAW_UID}"

# 1. Kill gateway FIRST (releases file locks and stops writing to session files)
GW_PID=$(pgrep -u openclaw -f 'openclaw-gateway' || true)
PARENT_PID=$(pgrep -u openclaw -f '^openclaw$' || true)

if [ -n "$GW_PID" ]; then
  kill "$GW_PID" 2>/dev/null || true
  echo "   Killed gateway (PID $GW_PID)"
  sleep 2
fi

# Also kill the parent openclaw process so it doesn't auto-respawn the gateway
if [ -n "$PARENT_PID" ]; then
  kill "$PARENT_PID" 2>/dev/null || true
  echo "   Killed parent openclaw (PID $PARENT_PID)"
  sleep 1
fi

# 2. Delete persisted session files — this is where conversation history lives
#    Location: ~/.openclaw/agents/{agentId}/sessions/*.jsonl
SESSION_COUNT=0
for dir in "$CLAW_HOME"/agents/*/sessions; do
  if [ -d "$dir" ]; then
    COUNT=$(find "$dir" -name '*.jsonl' 2>/dev/null | wc -l)
    SESSION_COUNT=$((SESSION_COUNT + COUNT))
    rm -f "$dir"/*.jsonl 2>/dev/null || true
  fi
done
# Also check for main agent sessions at root level
if [ -d "$CLAW_HOME/sessions" ]; then
  COUNT=$(find "$CLAW_HOME/sessions" -name '*.jsonl' 2>/dev/null | wc -l)
  SESSION_COUNT=$((SESSION_COUNT + COUNT))
  rm -f "$CLAW_HOME/sessions"/*.jsonl 2>/dev/null || true
fi
echo "   Deleted $SESSION_COUNT session file(s)"

# 3. Delete runtime log (gateway reads this on startup for session replay)
LOG_COUNT=$(find "$TMP_DIR" -name 'openclaw-*.log' 2>/dev/null | wc -l)
find "$TMP_DIR" -name 'openclaw-*.log' -delete 2>/dev/null || true
echo "   Deleted $LOG_COUNT runtime log(s)"

# 4. Remove gateway lock file (prevents stale lock issues on restart)
rm -f "$TMP_DIR"/gateway.*.lock 2>/dev/null || true

# 5. Start gateway fresh
nohup sudo -i -u openclaw openclaw gateway > /dev/null 2>&1 &
echo "   Starting gateway..."
sleep 5

NEW_PID=$(pgrep -u openclaw -f 'openclaw-gateway' || true)
if [ -n "$NEW_PID" ]; then
  echo "   Gateway running (PID $NEW_PID)"
else
  echo "   WARNING: Gateway did not start. Check manually."
  exit 1
fi

echo "==> Done. All sessions cleared, gateway restarted fresh."
REMOTE

echo "==> Session reset complete. Refresh the dashboard."
