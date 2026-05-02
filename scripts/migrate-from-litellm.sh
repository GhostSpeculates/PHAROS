#!/usr/bin/env bash
# migrate-from-litellm.sh
# Backs up your existing config, swaps LiteLLM env vars for Pharos,
# and prints verification commands.
#
# Usage:
#   bash migrate-from-litellm.sh                  # targets .env in CWD
#   bash migrate-from-litellm.sh /path/to/.env    # explicit path
#   PHAROS_BASE=https://api.pharos.dev/v1 bash migrate-from-litellm.sh  # hosted
#
# What it does:
#   1. Backs up the target .env file before touching it
#   2. Comments out LiteLLM-specific vars (LITELLM_PROXY, LITELLM_KEY,
#      LITELLM_API_KEY, OPENAI_BASE_URL pointing to localhost:4000)
#   3. Appends Pharos base URL
#   4. Prints verification commands including the /health and /v1/credits check
#
# Note on key topology: this script preserves your existing wallet/key setup.
# Pharos API keys are separate from provider keys (held in pharos.yaml server-side).
# If you were using LiteLLM's virtual keys, map them to Pharos API keys manually
# after migration — one Pharos key per user/team.

set -euo pipefail

ENV_FILE="${1:-.env}"
PHAROS_BASE="${PHAROS_BASE:-http://localhost:3777/v1}"
BACKUP="${ENV_FILE}.pre-pharos-$(date +%s)"

# -- pre-flight -----------------------------------------------------------------

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: no .env found at '$ENV_FILE'" >&2
  echo "  Create it first and add PHAROS_API_KEY before running." >&2
  exit 1
fi

if ! command -v sed &>/dev/null; then
  echo "ERROR: sed not found." >&2
  exit 1
fi

# -- backup --------------------------------------------------------------------

cp "$ENV_FILE" "$BACKUP"
echo "backup  → $BACKUP"

# -- comment out litellm vars --------------------------------------------------

# Handles the common LiteLLM env var names. Add more patterns below if your
# setup uses non-standard names.

sed -i.bak \
  -e 's|^\(LITELLM_PROXY=.*\)|# \1  # disabled: pharos migration|' \
  -e 's|^\(LITELLM_KEY=.*\)|# \1  # disabled: pharos migration|' \
  -e 's|^\(LITELLM_API_KEY=.*\)|# \1  # disabled: pharos migration|' \
  -e 's|^\(LITELLM_MASTER_KEY=.*\)|# \1  # disabled: pharos migration|' \
  -e 's|^\(OPENAI_BASE_URL=http://localhost:4000[^$]*\)|# \1  # disabled: pharos migration|' \
  -e 's|^\(OPENAI_BASE_URL=https://localhost:4000[^$]*\)|# \1  # disabled: pharos migration|' \
  "$ENV_FILE"

rm -f "${ENV_FILE}.bak"

# -- append pharos vars --------------------------------------------------------

cat >> "$ENV_FILE" <<EOF

# Pharos (migrated from LiteLLM — $(date -u +%FT%TZ))
# Provider-prefixed model names (e.g. anthropic/claude-sonnet-4-6) work as-is.
# BYOK: provider keys live in pharos.yaml on the server, not in client env vars.
OPENAI_BASE_URL=${PHAROS_BASE}
# PHAROS_API_KEY=pharos-sk-...  # set this if not already present
EOF

echo "patched → $ENV_FILE"
echo ""

# -- summary -------------------------------------------------------------------

PHAROS_HOST="${PHAROS_BASE%/v1}"

echo "Next steps:"
echo ""
echo "  1. Ensure PHAROS_API_KEY is set in $ENV_FILE (or your shell)"
echo "  2. Restart your application (Pharos defaults to :3777; LiteLLM was :4000)"
echo "  3. Verify:"
echo ""
echo "     # gateway health — all configured providers should show status"
echo "     curl -s ${PHAROS_HOST}/health | jq ."
echo ""
echo "     # model list — confirm provider-prefixed names are available"
echo "     curl -s ${PHAROS_BASE}/models \\"
echo "       -H \"Authorization: Bearer \$PHAROS_API_KEY\" | jq '.data[].id'"
echo ""
echo "     # smoke test — provider-prefixed model, same as LiteLLM syntax"
echo "     curl -s ${PHAROS_BASE}/chat/completions \\"
echo "       -H \"Authorization: Bearer \$PHAROS_API_KEY\" \\"
echo "       -H \"Content-Type: application/json\" \\"
echo "       -d '{\"model\":\"anthropic/claude-sonnet-4-6\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":32}' \\"
echo "       | jq -r '.choices[0].message.content'"
echo ""
echo "     # wallet check — confirms per-call cost tracking is live"
echo "     curl -s ${PHAROS_BASE}/credits \\"
echo "       -H \"Authorization: Bearer \$PHAROS_API_KEY\" | jq ."
echo ""
echo "Supply chain note: pin your Pharos deploy to a specific git commit and verify"
echo "the commit hash against the GitHub release artifact before pointing production"
echo "traffic at it. Unlike LiteLLM's PyPI distribution, you control the exact bytes."
echo ""
echo "Done. LiteLLM → Pharos migration complete."
echo "Backup kept at: $BACKUP"
