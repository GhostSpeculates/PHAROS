#!/usr/bin/env bash
# ─── Pharos Stress Test ───
# Sends 30 varied requests to test classifier accuracy and routing.

VPS="http://<vps-redacted>:3777"
API_KEY="pharos-REDACTED"
DELAY=2
PASS=0
FAIL=0
RETRIED=0

# Escape a string for safe JSON embedding
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  echo "$s"
}

send() {
  local idx=$1 label=$2 expected_tier=$3
  shift 3
  local msg="$*"
  local escaped
  escaped=$(json_escape "$msg")

  printf "\n[%02d/30] %-10s | %-12s | %.70s\n" "$idx" "$label" "$expected_tier" "$msg"

  local tmpfile
  tmpfile=$(mktemp)

  local http_code
  http_code=$(curl -s -w "%{http_code}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -D "$tmpfile.hdr" \
    -o "$tmpfile.body" \
    "$VPS/v1/chat/completions" \
    -d "{\"model\":\"pharos-auto\",\"messages\":[{\"role\":\"user\",\"content\":\"$escaped\"}],\"max_tokens\":150}" 2>&1)

  local tier model score retries
  tier=$(grep -i 'x-pharos-tier' "$tmpfile.hdr" 2>/dev/null | awk '{print $2}' | tr -d '\r' || true)
  model=$(grep -i 'x-pharos-model' "$tmpfile.hdr" 2>/dev/null | awk '{print $2}' | tr -d '\r' || true)
  score=$(grep -i 'x-pharos-score' "$tmpfile.hdr" 2>/dev/null | awk '{print $2}' | tr -d '\r' || true)
  retries=$(grep -i 'x-pharos-retries' "$tmpfile.hdr" 2>/dev/null | awk '{print $2}' | tr -d '\r' || true)

  local status
  if [[ "$http_code" == "200" ]]; then
    PASS=$((PASS + 1))
    status="✓"
  else
    FAIL=$((FAIL + 1))
    status="✗ ($http_code)"
  fi

  if [[ -n "$retries" && "$retries" != "0" ]]; then
    RETRIED=$((RETRIED + 1))
    status="$status [retried x$retries]"
  fi

  printf "         %s  score=%s  tier=%-12s  model=%s\n" \
    "$status" "${score:-?}" "${tier:-?}" "${model:-?}"

  rm -f "$tmpfile" "$tmpfile.hdr" "$tmpfile.body"
}

echo "═══════════════════════════════════════════════════════════════"
echo "  Pharos Stress Test — 30 requests against $VPS"
echo "═══════════════════════════════════════════════════════════════"

# ─── SIMPLE (expect score 1-3 → free tier) ───
send 1  "simple" "free" "Hi"
sleep $DELAY
send 2  "simple" "free" "Hello there!"
sleep $DELAY
send 3  "simple" "free" "What time is it?"
sleep $DELAY
send 4  "simple" "free" "Say something funny"
sleep $DELAY
send 5  "simple" "free" "Thanks!"
sleep $DELAY
send 6  "simple" "free" "Good morning"
sleep $DELAY
send 7  "simple" "free" "What is 2 + 2?"
sleep $DELAY
send 8  "simple" "free" "Tell me a joke"
sleep $DELAY
send 9  "simple" "free" "How are you?"
sleep $DELAY
send 10 "simple" "free" "Translate hello to Spanish"
sleep $DELAY

# ─── MODERATE (expect score 4-6 → economical tier) ───
send 11 "moderate" "economical" "Explain the difference between TCP and UDP in networking"
sleep $DELAY
send 12 "moderate" "economical" "Write a Python function to check if a string is a palindrome"
sleep $DELAY
send 13 "moderate" "economical" "What are the main causes of the French Revolution?"
sleep $DELAY
send 14 "moderate" "economical" "Compare React and Vue.js for building web applications"
sleep $DELAY
send 15 "moderate" "economical" "How does garbage collection work in Java?"
sleep $DELAY
send 16 "moderate" "economical" "Summarize the key points of supply and demand in economics"
sleep $DELAY
send 17 "moderate" "economical" "Write a SQL query to find the second highest salary from an employees table"
sleep $DELAY
send 18 "moderate" "economical" "What is the difference between machine learning and deep learning?"
sleep $DELAY
send 19 "moderate" "economical" "Explain how HTTPS encryption works step by step"
sleep $DELAY
send 20 "moderate" "economical" "What are design patterns in software engineering? Give three examples"
sleep $DELAY

# ─── COMPLEX (expect score 7-9 → premium/frontier tier) ───
send 21 "complex" "premium" "Design a microservices architecture for an e-commerce platform with 10M DAUs. Include service boundaries, communication patterns, database choices, caching, and failure handling."
sleep $DELAY
send 22 "complex" "premium" "Write a detailed technical analysis of the CAP theorem. Explain how Cassandra, MongoDB, and CockroachDB make different trade-offs with concrete examples."
sleep $DELAY
send 23 "complex" "premium" "Implement a lock-free concurrent hash map in C++ using atomic operations. Explain memory ordering constraints, ABA problem mitigation, and comparison to mutex-based approaches."
sleep $DELAY
send 24 "complex" "premium" "Analyze the ethical implications of LLMs in healthcare. Consider bias, liability for incorrect diagnoses, patient privacy, and propose a regulatory framework."
sleep $DELAY
send 25 "complex" "premium" "Design a real-time fraud detection system for 50K TPS. Detail the ML pipeline, feature engineering, model serving, latency requirements, and concept drift handling."
sleep $DELAY
send 26 "complex" "premium" "Explain the mathematical foundations of transformer attention. Derive scaled dot-product attention, multi-head attention, positional encodings, and analyze computational complexity vs RNNs."
sleep $DELAY
send 27 "complex" "premium" "Compare consensus algorithms: Paxos, Raft, PBFT, and Tendermint. For each, explain protocol, fault tolerance, performance, and real-world systems using them."
sleep $DELAY
send 28 "complex" "premium" "Design a compiler optimization pipeline. Include lexical analysis, parsing, IR design, optimization passes (constant folding, dead code elimination, loop unrolling), and x86-64 codegen."
sleep $DELAY
send 29 "complex" "premium" "Analyze game theory in cryptocurrency mining pools. Model strategic interactions with Nash equilibrium, explain selfish mining, block withholding, and propose mechanism design solutions."
sleep $DELAY
send 30 "complex" "premium" "Design a global CDN serving 1PB daily. Cover edge placement, cache invalidation, origin shielding, TLS termination, DDoS mitigation, and cost optimization with capacity planning."

echo ""
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Test Complete: $PASS passed, $FAIL failed, $RETRIED retried"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Pull final stats
echo "─── /v1/stats ───"
curl -s -H "Authorization: Bearer $API_KEY" "$VPS/v1/stats" 2>&1
echo ""
echo ""

echo "─── /v1/stats/recent (last 30) ───"
curl -s -H "Authorization: Bearer $API_KEY" "$VPS/v1/stats/recent" 2>&1
echo ""
