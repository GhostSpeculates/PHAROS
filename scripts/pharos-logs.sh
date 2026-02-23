#!/bin/bash
# ============================================
# PHAROS — Tail Live Logs
# ============================================
# Streams live journal logs from the VPS.
# Usage: bash scripts/pharos-logs.sh [number_of_lines]
# Press Ctrl+C to stop.
# ============================================

set -euo pipefail

VPS_HOST="root@<vps-redacted>"
SERVICE_NAME="pharos"

# Number of historical lines to show before tailing (default: 50)
LINES="${1:-50}"

echo "============================================"
echo "  PHAROS — Live Logs (last $LINES + follow)"
echo "  Press Ctrl+C to stop"
echo "============================================"
echo ""

ssh "$VPS_HOST" "journalctl -u $SERVICE_NAME -n $LINES -f --no-pager"
