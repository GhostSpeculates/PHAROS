#!/bin/bash
# ============================================
# PHAROS — Deploy to Hostinger VPS
# ============================================
# Builds locally, packages, and deploys to the VPS.
# Usage: bash scripts/deploy-vps.sh
# ============================================

set -euo pipefail

# ── Configuration ──────────────────────────
VPS_HOST="root@<vps-redacted>"
VPS_DIR="/root/pharos"
SERVICE_NAME="pharos"
TARBALL="pharos-deploy.tar.gz"
PORT=3777

# ── Colors ─────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log()  { echo -e "${CYAN}[PHAROS]${NC} $1"; }
ok()   { echo -e "${GREEN}[  OK  ]${NC} $1"; }
warn() { echo -e "${YELLOW}[ WARN ]${NC} $1"; }
fail() { echo -e "${RED}[FAIL ]${NC} $1"; exit 1; }

# ── Resolve project root (script lives in scripts/) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

log "Project root: $PROJECT_ROOT"

# ── Pre-flight checks ─────────────────────
if [ ! -f "package.json" ]; then
    fail "package.json not found. Are you in the project root?"
fi

if [ ! -f ".env" ]; then
    fail ".env file not found. Create it before deploying."
fi

if ! command -v ssh &> /dev/null; then
    fail "ssh is not installed or not in PATH."
fi

if ! command -v scp &> /dev/null; then
    fail "scp is not installed or not in PATH."
fi

# ── Step 1: Build ──────────────────────────
log "Step 1/6: Building TypeScript project..."
npm run build
ok "Build completed."

# ── Verify build output ───────────────────
if [ ! -d "dist" ]; then
    fail "dist/ directory not found after build. Build may have failed."
fi

if [ ! -f "dist/index.js" ]; then
    fail "dist/index.js not found. Build output is incomplete."
fi

# ── Step 2: Create tarball ─────────────────
log "Step 2/6: Creating deployment tarball..."

# Clean up any previous tarball
rm -f "$TARBALL"

# Package only what's needed
tar czf "$TARBALL" \
    dist/ \
    config/ \
    package.json \
    package-lock.json \
    .env

TARBALL_SIZE=$(du -h "$TARBALL" | cut -f1)
ok "Tarball created: $TARBALL ($TARBALL_SIZE)"

# ── Step 3: Upload to VPS ─────────────────
log "Step 3/6: Uploading tarball to VPS ($VPS_HOST:$VPS_DIR)..."

ssh "$VPS_HOST" "mkdir -p $VPS_DIR"
scp "$TARBALL" "$VPS_HOST:$VPS_DIR/$TARBALL"
ok "Upload complete."

# ── Step 4: Extract and install on VPS ─────
log "Step 4/6: Extracting and installing dependencies on VPS..."

ssh "$VPS_HOST" bash -s <<REMOTE_SCRIPT
set -euo pipefail

cd $VPS_DIR

echo ">> Extracting tarball..."
tar xzf $TARBALL

echo ">> Removing tarball..."
rm -f $TARBALL

echo ">> Creating data directory for SQLite..."
mkdir -p data

echo ">> Installing production dependencies..."
npm install --production --no-audit --no-fund

echo ">> Checking Node.js version..."
node --version

echo ">> Verifying entry point..."
ls -la dist/index.js

echo ">> Done with remote setup."
REMOTE_SCRIPT

ok "Remote setup complete."

# ── Step 5: Create systemd service ─────────
log "Step 5/6: Configuring systemd service..."

ssh "$VPS_HOST" bash -s <<'SERVICE_SCRIPT'
set -euo pipefail

SERVICE_FILE="/etc/systemd/system/pharos.service"

cat > "$SERVICE_FILE" <<'EOF'
[Unit]
Description=Pharos - Intelligent LLM Routing Gateway
Documentation=https://github.com/nex-labs/pharos
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/pharos
ExecStart=/usr/bin/node dist/index.js
EnvironmentFile=/root/pharos/.env
Restart=always
RestartSec=5
StartLimitBurst=5
StartLimitIntervalSec=60

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pharos

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/root/pharos

# Resource limits
MemoryMax=2G
MemoryHigh=1536M

# Graceful shutdown
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

echo ">> Systemd service file written."

echo ">> Reloading systemd daemon..."
systemctl daemon-reload

echo ">> Enabling pharos service..."
systemctl enable pharos

echo ">> Restarting pharos service..."
systemctl restart pharos

echo ">> Waiting 3 seconds for service to start..."
sleep 3

echo ">> Service status:"
systemctl status pharos --no-pager || true

SERVICE_SCRIPT

ok "Systemd service configured and started."

# ── Step 6: Show logs ──────────────────────
log "Step 6/6: Showing recent logs..."
echo ""
ssh "$VPS_HOST" "journalctl -u pharos -n 30 --no-pager" || true

# ── Cleanup local tarball ──────────────────
rm -f "$TARBALL"

# ── Summary ────────────────────────────────
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN} PHAROS deployed successfully!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "  VPS:      ${CYAN}$VPS_HOST${NC}"
echo -e "  Path:     ${CYAN}$VPS_DIR${NC}"
echo -e "  Port:     ${CYAN}$PORT${NC}"
echo -e "  Service:  ${CYAN}$SERVICE_NAME${NC}"
echo ""
echo -e "  Test:     ${YELLOW}curl http://<vps-redacted>:$PORT/health${NC}"
echo -e "  Logs:     ${YELLOW}bash scripts/pharos-logs.sh${NC}"
echo -e "  Status:   ${YELLOW}bash scripts/pharos-status.sh${NC}"
echo -e "  Restart:  ${YELLOW}bash scripts/pharos-restart.sh${NC}"
echo ""
