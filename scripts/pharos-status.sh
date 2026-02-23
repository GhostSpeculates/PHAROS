#!/bin/bash
# ============================================
# PHAROS — VPS Status Check
# ============================================
# Shows service status, logs, port, and memory.
# Usage: bash scripts/pharos-status.sh
# ============================================

set -euo pipefail

VPS_HOST="root@<vps-redacted>"
SERVICE_NAME="pharos"
PORT=3777

# ── Colors ─────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

header() { echo -e "\n${BOLD}${CYAN}── $1 ──${NC}\n"; }

echo -e "${BOLD}${GREEN}============================================${NC}"
echo -e "${BOLD}${GREEN}  PHAROS — VPS Status Report${NC}"
echo -e "${BOLD}${GREEN}============================================${NC}"

ssh "$VPS_HOST" bash -s <<REMOTE_STATUS
set -uo pipefail

echo ""
echo "── Service Status ──"
echo ""
systemctl status $SERVICE_NAME --no-pager 2>&1 || echo "(service not found or not running)"

echo ""
echo "── Last 20 Log Lines ──"
echo ""
journalctl -u $SERVICE_NAME -n 20 --no-pager 2>&1 || echo "(no logs available)"

echo ""
echo "── Port $PORT Listener ──"
echo ""
ss -tlnp | head -1
ss -tlnp | grep ":$PORT " 2>/dev/null || echo "  (nothing listening on port $PORT)"

echo ""
echo "── Memory Usage ──"
echo ""
free -h

echo ""
echo "── Pharos Process Memory ──"
echo ""
ps aux | head -1
ps aux | grep "node dist/index.js" | grep -v grep || echo "  (pharos process not found)"

echo ""
echo "── Disk Usage (/root/pharos) ──"
echo ""
du -sh /root/pharos 2>/dev/null || echo "  (directory not found)"
du -sh /root/pharos/data 2>/dev/null || echo "  (data directory not found)"

echo ""
echo "── Uptime ──"
echo ""
uptime

REMOTE_STATUS

echo ""
echo -e "${GREEN}Status check complete.${NC}"
echo ""
