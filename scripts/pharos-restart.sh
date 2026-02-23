#!/bin/bash
# ============================================
# PHAROS — Restart Service
# ============================================
# Restarts the Pharos service on the VPS and shows status.
# Usage: bash scripts/pharos-restart.sh
# ============================================

set -euo pipefail

VPS_HOST="root@<vps-redacted>"
SERVICE_NAME="pharos"

# ── Colors ─────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}[PHAROS]${NC} Restarting service on VPS..."

ssh "$VPS_HOST" bash -s <<REMOTE_RESTART
set -euo pipefail

echo ">> Restarting pharos service..."
systemctl restart $SERVICE_NAME

echo ">> Waiting 3 seconds for service to start..."
sleep 3

echo ""
echo "── Service Status ──"
echo ""
systemctl status $SERVICE_NAME --no-pager 2>&1 || true

echo ""
echo "── Last 10 Log Lines ──"
echo ""
journalctl -u $SERVICE_NAME -n 10 --no-pager 2>&1 || true

echo ""
echo "── Port 3777 Listener ──"
echo ""
ss -tlnp | grep ":3777 " 2>/dev/null || echo "  (not yet listening on port 3777)"

REMOTE_RESTART

echo ""
echo -e "${GREEN}[PHAROS]${NC} Restart complete."
echo ""
