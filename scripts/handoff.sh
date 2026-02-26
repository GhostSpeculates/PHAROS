#!/bin/bash
# ============================================
# PHAROS — Session Handoff Report
# ============================================
# Generates a comprehensive handoff document for
# continuity between development sessions.
# Usage: bash scripts/handoff.sh
# ============================================

set -euo pipefail

VPS_HOST="root@<vps-redacted>"
SERVICE_NAME="pharos"
PORT=3777
API_KEY="${PHAROS_API_KEY:-}"

# ── Colors ─────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

header() { echo -e "\n${BOLD}${CYAN}═══ $1 ═══${NC}\n"; }
subheader() { echo -e "${BOLD}── $1 ──${NC}"; }
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
dim()  { echo -e "  ${DIM}$1${NC}"; }

echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║     PHAROS — Session Handoff Report          ║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo -e "${DIM}  Generated: $(date '+%Y-%m-%d %H:%M:%S %Z')${NC}"

# ─── Git State ────────────────────────────────────

header "GIT STATE"

BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
COMMIT=$(git log -1 --format='%h %s' 2>/dev/null || echo "unknown")
COMMIT_HASH=$(git log -1 --format='%H' 2>/dev/null || echo "")
COMMIT_DATE=$(git log -1 --format='%ci' 2>/dev/null || echo "")

subheader "Current Branch"
echo "  $BRANCH"
echo ""

subheader "Latest Commit"
echo "  $COMMIT"
dim "$COMMIT_DATE"
echo ""

subheader "Remote Sync"
LOCAL_HEAD=$(git rev-parse HEAD 2>/dev/null || echo "")
REMOTE_HEAD=$(git rev-parse origin/$BRANCH 2>/dev/null || echo "")
if [[ "$LOCAL_HEAD" == "$REMOTE_HEAD" ]]; then
  ok "Local and remote are in sync"
else
  AHEAD=$(git rev-list --count origin/$BRANCH..HEAD 2>/dev/null || echo "?")
  BEHIND=$(git rev-list --count HEAD..origin/$BRANCH 2>/dev/null || echo "?")
  [[ "$AHEAD" != "0" ]] && warn "Local is $AHEAD commit(s) ahead of origin/$BRANCH"
  [[ "$BEHIND" != "0" ]] && warn "Local is $BEHIND commit(s) behind origin/$BRANCH"
fi
echo ""

subheader "Working Tree"
STAGED=$(git diff --cached --stat 2>/dev/null | tail -1)
UNSTAGED=$(git diff --stat 2>/dev/null | tail -1)
UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')

if [[ -z "$STAGED" && -z "$UNSTAGED" && "$UNTRACKED" == "0" ]]; then
  ok "Clean working tree"
else
  [[ -n "$STAGED" ]] && warn "Staged: $STAGED"
  [[ -n "$UNSTAGED" ]] && warn "Unstaged: $UNSTAGED"
  [[ "$UNTRACKED" != "0" ]] && warn "$UNTRACKED untracked file(s)"
fi
echo ""

subheader "Recent Commits (last 5)"
git log --oneline -5 2>/dev/null | while read -r line; do
  echo "  $line"
done

# ─── Test Suite ───────────────────────────────────

header "TEST SUITE"

TEST_OUTPUT=$(npx vitest run 2>&1 || true)
# The "Tests" summary line has the total count (e.g. "1120 passed")
TEST_TOTAL=$(echo "$TEST_OUTPUT" | grep "^.*Tests.*passed" | grep -oE '[0-9]+ passed' | head -1 || echo "? passed")
TEST_FAILED=$(echo "$TEST_OUTPUT" | grep "^.*Tests.*failed" | grep -oE '[0-9]+ failed' | head -1 || echo "")
TEST_FILES_LINE=$(echo "$TEST_OUTPUT" | grep "^.*Test Files" | head -1 || echo "")

if [[ -z "$TEST_FAILED" ]]; then
  ok "$TEST_TOTAL"
  [[ -n "$TEST_FILES_LINE" ]] && dim "$(echo "$TEST_FILES_LINE" | sed 's/^[[:space:]]*//')"
else
  fail "$TEST_FAILED, $TEST_TOTAL"
  echo ""
  echo "$TEST_OUTPUT" | grep "×" | head -10
fi

# ─── Build Check ──────────────────────────────────

header "BUILD STATUS"

BUILD_OUTPUT=$(npm run build 2>&1)
BUILD_EXIT=$?

if [[ $BUILD_EXIT -eq 0 ]]; then
  ok "TypeScript build succeeded"
else
  fail "Build failed!"
  echo "$BUILD_OUTPUT" | tail -10
fi

# ─── VPS / Production ────────────────────────────

header "VPS / PRODUCTION"

subheader "Service Status"
VPS_STATUS=$(ssh -o ConnectTimeout=5 "$VPS_HOST" "systemctl is-active $SERVICE_NAME" 2>/dev/null || echo "unreachable")
if [[ "$VPS_STATUS" == "active" ]]; then
  ok "Service is running"
else
  fail "Service status: $VPS_STATUS"
fi

DEPLOYED_COMMIT=""
if [[ "$VPS_STATUS" == "active" ]]; then
  # Check deployed version via health endpoint
  subheader "Health Check"
  HEALTH=$(ssh -o ConnectTimeout=5 "$VPS_HOST" "curl -s http://127.0.0.1:$PORT/health" 2>/dev/null || echo "{}")

  PROVIDER_COUNT=$(echo "$HEALTH" | python3 -c "
import sys, json
try:
    h = json.load(sys.stdin)
    providers = h.get('providers', {})
    available = [k for k,v in providers.items() if v.get('available')]
    healthy = [k for k,v in providers.items() if v.get('healthy')]
    print(f'{len(available)} available, {len(healthy)} healthy')
    for name in sorted(providers.keys()):
        p = providers[name]
        avail = '✓' if p.get('available') else '✗'
        hlth = 'healthy' if p.get('healthy') else 'unhealthy'
        print(f'  {avail} {name}: {hlth}')
except:
    print('  (could not parse health response)')
" 2>/dev/null || echo "  (could not reach health endpoint)")

  echo "$PROVIDER_COUNT"
  echo ""

  # Check if VPS is on the same commit as local
  subheader "Deployed Version"
  VPS_MTIME=$(ssh -o ConnectTimeout=5 "$VPS_HOST" "stat -c '%Y' /root/pharos/dist/index.js 2>/dev/null" 2>/dev/null || echo "")
  LOCAL_MTIME=$(stat -f '%m' dist/index.js 2>/dev/null || stat -c '%Y' dist/index.js 2>/dev/null || echo "")

  if [[ -n "$VPS_MTIME" && -n "$LOCAL_MTIME" ]]; then
    # Compare within 60 seconds tolerance
    DIFF=$((LOCAL_MTIME - VPS_MTIME))
    ABS_DIFF=${DIFF#-}
    if [[ $ABS_DIFF -lt 120 ]]; then
      ok "VPS appears to be running the latest build"
    else
      warn "VPS build may be stale (local build is newer)"
      dim "Run: bash scripts/deploy-vps.sh"
    fi
  fi

  # Grab stats if API key is available
  if [[ -n "$API_KEY" ]]; then
    echo ""
    subheader "Production Stats"
    STATS=$(ssh -o ConnectTimeout=5 "$VPS_HOST" "curl -s -H 'Authorization: Bearer $API_KEY' http://127.0.0.1:$PORT/v1/stats" 2>/dev/null || echo "{}")

    echo "$STATS" | python3 -c "
import sys, json
try:
    s = json.load(sys.stdin)
    total = s.get('totalRequests', 0)
    cost = s.get('totalCost', 0)
    baseline = s.get('baselineCost', 0)
    savings = s.get('savingsPercent', 0)
    errors = s.get('totalErrors', 0)
    error_rate = (errors / total * 100) if total > 0 else 0
    print(f'  Requests:     {total}')
    print(f'  Total cost:   \${cost:.4f}')
    print(f'  Baseline:     \${baseline:.4f}')
    print(f'  Savings:      {savings:.1f}%')
    print(f'  Error rate:   {error_rate:.1f}% ({errors} errors)')
except:
    print('  (could not parse stats)')
" 2>/dev/null || echo "  (stats unavailable — set PHAROS_API_KEY env var)"
  else
    echo ""
    dim "Set PHAROS_API_KEY to include production stats"
  fi
fi

# ─── Phase / Roadmap ─────────────────────────────

header "ROADMAP STATUS"

echo -e "  Phase 1 (Core Engine):          ${GREEN}COMPLETE${NC}"
echo -e "  Phase 2A (Provider Expansion):  ${GREEN}DEPLOYED${NC}"
echo -e "  Phase 2B (Model Registry):      ${GREEN}DEPLOYED${NC}"
echo -e "  Phase 2C (Task-Type Routing):   ${GREEN}DEPLOYED${NC}"
echo -e "  Phase 2D (Conversation+Cache):  ${GREEN}DEPLOYED${NC}"
echo -e "  Phase 2E (Performance Learn):   ${DIM}NOT STARTED${NC}"
echo -e "  Phase 3  (Dashboard):           ${DIM}NOT STARTED${NC}"
echo -e "  Phase 4  (Distribution):        ${DIM}NOT STARTED${NC}"

# ─── Config / Environment ────────────────────────

header "ENVIRONMENT"

NODE_V=$(node --version 2>/dev/null || echo "not found")
NPM_V=$(npm --version 2>/dev/null || echo "not found")

echo "  Node.js:  $NODE_V"
echo "  npm:      $NPM_V"
echo "  Branch:   $BRANCH"
echo "  VPS:      $VPS_HOST"
echo "  Port:     $PORT"

# ─── Key Files Changed (vs last deployed) ────────

header "KEY FILES"

echo "  Config:     config/pharos.default.yaml"
echo "  Schema:     src/config/schema.ts"
echo "  Classifier: src/classifier/prompt.ts"
echo "  Router:     src/router/index.ts"
echo "  Affinity:   src/router/affinity.ts"
echo "  ConvTrack:  src/router/conversation-tracker.ts"
echo "  Anthropic:  src/providers/anthropic.ts"
echo "  Gateway:    src/gateway/router.ts"
echo "  Server:     src/server.ts"
echo "  Tests:      src/__tests__/*.test.ts"

# ─── Summary ──────────────────────────────────────

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║     Handoff complete.                        ║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}Quick commands:${NC}"
echo "    npm test                        Run tests"
echo "    npm run build                   Build TypeScript"
echo "    bash scripts/deploy-vps.sh      Deploy to VPS"
echo "    bash scripts/quick-test.sh      5-request smoke test"
echo "    bash scripts/pharos-status.sh   Full VPS status"
echo "    bash scripts/pharos-logs.sh     Live log stream"
echo ""
