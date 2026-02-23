#!/usr/bin/env bash
# Quick 5-request test: 2 simple, 2 moderate, 1 frontier

VPS="http://<vps-redacted>:3777"
API_KEY="pharos-REDACTED"

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  echo "$s"
}

send() {
  local idx=$1 label=$2 expected=$3
  shift 3
  local msg="$*"
  local escaped
  escaped=$(json_escape "$msg")

  printf "\n[%d/5] %-10s | expected: %-12s\n" "$idx" "$label" "$expected"
  printf "      msg: %.90s\n" "$msg"

  local tmpfile
  tmpfile=$(mktemp)

  local http_code
  http_code=$(curl -s -w "%{http_code}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -D "$tmpfile.hdr" \
    -o "$tmpfile.body" \
    "$VPS/v1/chat/completions" \
    -d "{\"model\":\"pharos-auto\",\"messages\":[{\"role\":\"user\",\"content\":\"$escaped\"}],\"max_tokens\":200}" 2>&1)

  local tier model score retries
  tier=$(grep -i 'x-pharos-tier' "$tmpfile.hdr" 2>/dev/null | awk '{print $2}' | tr -d '\r' || true)
  model=$(grep -i 'x-pharos-model' "$tmpfile.hdr" 2>/dev/null | awk '{print $2}' | tr -d '\r' || true)
  score=$(grep -i 'x-pharos-score' "$tmpfile.hdr" 2>/dev/null | awk '{print $2}' | tr -d '\r' || true)
  retries=$(grep -i 'x-pharos-retries' "$tmpfile.hdr" 2>/dev/null | awk '{print $2}' | tr -d '\r' || true)
  local cost
  cost=$(grep -i 'x-pharos-cost' "$tmpfile.hdr" 2>/dev/null | awk '{print $2}' | tr -d '\r' || true)

  local status_icon
  if [[ "$http_code" == "200" ]]; then
    status_icon="✓"
  else
    status_icon="✗ ($http_code)"
  fi

  local retry_info=""
  if [[ -n "$retries" && "$retries" != "0" ]]; then
    retry_info=" [retried x$retries]"
  fi

  printf "      %s  score=%s  tier=%-12s  model=%s  cost=\$%s%s\n" \
    "$status_icon" "${score:-?}" "${tier:-?}" "${model:-?}" "${cost:-?}" "$retry_info"

  # Show first 120 chars of response content
  local content
  content=$(sed -n 's/.*"content":"\([^"]*\)".*/\1/p' "$tmpfile.body" 2>/dev/null | head -1)
  if [[ -n "$content" ]]; then
    printf "      response: %.120s...\n" "$content"
  fi

  rm -f "$tmpfile" "$tmpfile.hdr" "$tmpfile.body"
}

echo "═══════════════════════════════════════════════════════"
echo "  Quick Test — 5 requests (new classifier + Opus)"
echo "═══════════════════════════════════════════════════════"

# Simple
send 1 "simple" "free (1-3)" "Hey, what's up?"
sleep 2

send 2 "simple" "free (1-3)" "What's the capital of France?"
sleep 2

# Moderate
send 3 "moderate" "econ (4-6)" "Explain how a binary search tree works and when you'd use one instead of a hash map"
sleep 2

send 4 "moderate" "premium (7-8)" "Design a REST API for a task management app with users, projects, and tasks. Include the endpoints, HTTP methods, and example request/response bodies."
sleep 2

# Frontier — genuinely PhD-level multi-domain
send 5 "frontier" "frontier (9-10)" "Synthesize a novel theoretical framework that unifies reinforcement learning from human feedback (RLHF) with mechanism design theory from economics. Formally define the principal-agent problem where the principal is a society of diverse human annotators with heterogeneous preferences, derive the conditions under which a truthful preference elicitation mechanism exists using the Gibbard-Satterthwaite theorem constraints, and prove whether RLHF with a Bradley-Terry preference model can approximate the social welfare function under Arrow's impossibility theorem. Provide the mathematical formalism."

echo ""
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Done. Pulling stats..."
echo "═══════════════════════════════════════════════════════"
echo ""

echo "─── Recent 5 ───"
curl -s -H "Authorization: Bearer $API_KEY" "$VPS/v1/stats/recent" 2>&1
echo ""
