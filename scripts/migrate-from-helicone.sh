#!/usr/bin/env bash
# migrate-from-helicone.sh
# Backs up your existing config, swaps Helicone env vars for Pharos,
# and prints verification commands.
#
# Usage:
#   bash migrate-from-helicone.sh                 # targets .env in CWD
#   bash migrate-from-helicone.sh /path/to/.env   # explicit path
#   PHAROS_BASE=https://api.pharos.dev/v1 bash migrate-from-helicone.sh  # hosted
#
# What it does:
#   1. Backs up the target .env file before touching it
#   2. Comments out Helicone-specific vars (OPENAI_BASE_URL pointing to helicone, HELICONE_API_KEY)
#   3. Appends Pharos base URL
#   4. Prints next-step verification commands

set -euo pipefail

ENV_FILE="${1:-.env}"
PHAROS_BASE="${PHAROS_BASE:-http://localhost:3777/v1}"
BACKUP="${ENV_FILE}.pre-pharos-$(date +%s)"

# -- pre-flight -----------------------------------------------------------------

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: no .env found at '$ENV_FILE'" >&2
  echo "  Create it first (cp .env.example .env) and add PHAROS_API_KEY." >&2
  exit 1
fi

if ! command -v sed &>/dev/null; then
  echo "ERROR: sed not found. This script requires GNU/BSD sed." >&2
  exit 1
fi

# -- backup --------------------------------------------------------------------

cp "$ENV_FILE" "$BACKUP"
echo "backup  → $BACKUP"

# -- comment out helicone vars -------------------------------------------------

# macOS ships BSD sed; -i requires an explicit backup extension. We use .bak and
# remove it afterward so the only backup that persists is our timestamped copy.

sed -i.bak \
  -e 's|^\(OPENAI_BASE_URL=https://oai\.helicone\.ai[^$]*\)|# \1  # disabled: pharos migration|' \
  -e 's|^\(OPENAI_BASE_URL=https://gateway\.helicone\.ai[^$]*\)|# \1  # disabled: pharos migration|' \
  -e 's|^\(HELICONE_API_KEY=.*\)|# \1  # disabled: pharos migration|' \
  -e 's|^\(HELICONE_AUTH_API_KEY=.*\)|# \1  # disabled: pharos migration|' \
  "$ENV_FILE"

# Remove the sed backup; we have the timestamped one
rm -f "${ENV_FILE}.bak"

# -- append pharos vars --------------------------------------------------------

cat >> "$ENV_FILE" <<EOF

# Pharos (migrated from Helicone — $(date -u +%FT%TZ))
# Auth: one PHAROS_API_KEY replaces the dual OpenAI key + Helicone key pattern.
# Provider keys are held server-side in pharos.yaml.
OPENAI_BASE_URL=${PHAROS_BASE}
# PHAROS_API_KEY=pharos-sk-...  # set this if not already present
EOF

echo "patched → $ENV_FILE"
echo ""

# -- summary -------------------------------------------------------------------

echo "Next steps:"
echo ""
echo "  1. Ensure PHAROS_API_KEY is set in $ENV_FILE (or exported in your shell)"
echo "  2. Restart your application"
echo "  3. Verify with:"
echo ""
echo "     # smoke test — should return a model response"
echo "     curl -s ${PHAROS_BASE}/chat/completions \\"
echo "       -H \"Authorization: Bearer \$PHAROS_API_KEY\" \\"
echo "       -H \"Content-Type: application/json\" \\"
echo "       -d '{\"model\":\"pharos-auto\",\"messages\":[{\"role\":\"user\",\"content\":\"healthcheck\"}],\"max_tokens\":32}' \\"
echo "       | jq ."
echo ""
echo "     # wallet endpoint — confirms your balance is visible"
echo "     curl -s ${PHAROS_BASE%/v1}/v1/credits \\"
echo "       -H \"Authorization: Bearer \$PHAROS_API_KEY\" | jq ."
echo ""
echo "Done. Helicone → Pharos migration complete."
echo "Backup kept at: $BACKUP"
