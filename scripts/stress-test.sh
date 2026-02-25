#!/usr/bin/env bash
set -uo pipefail

# ═══════════════════════════════════════════════════════════════
#  Pharos Stress Test
#  Runs against LOCAL dev server (localhost:3777)
#  Tests classifier accuracy, routing, burst handling, mixed load
# ═══════════════════════════════════════════════════════════════

BASE_URL="http://localhost:3777"
TIMEOUT=30
RESULTS_DIR=$(mktemp -d)

# Read API key from local .env
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
if [[ -f "$PROJECT_ROOT/.env" ]]; then
    API_KEY=$(grep '^PHAROS_API_KEY=' "$PROJECT_ROOT/.env" | cut -d'=' -f2- | tr -d '\r')
else
    echo "ERROR: .env file not found at $PROJECT_ROOT/.env"
    exit 1
fi

if [[ -z "$API_KEY" ]]; then
    echo "ERROR: PHAROS_API_KEY not set in .env"
    exit 1
fi

# ─── Test Queries ────────────────────────────────────────────
Q_SIMPLE="What is 2+2?"
Q_MODERATE="Explain the difference between TCP and UDP"
Q_ANALYSIS="Design a database schema for an e-commerce platform with inventory tracking"
Q_COMPLEX="Write a TypeScript implementation of a red-black tree with insert, delete, and rebalance operations"
Q_FRONTIER='Prove that P!=NP or explain the deepest implications of the Riemann Hypothesis on prime distribution'

# ─── Helpers ─────────────────────────────────────────────────

get_ms() {
    python3 -c 'import time; print(int(time.time()*1000))'
}

json_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    echo "$s"
}

# Send a single request, write result line to file
# Format: id|label|http_code|latency_ms|tier|model|provider|score|cost
send_request() {
    local id="$1" label="$2" query="$3" result_file="$4"
    local escaped
    escaped=$(json_escape "$query")

    local hdr_file body_file
    hdr_file=$(mktemp)
    body_file=$(mktemp)

    local start_ms end_ms latency_ms http_code
    start_ms=$(get_ms)

    http_code=$(curl -s -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $API_KEY" \
        -D "$hdr_file" \
        -o "$body_file" \
        "$BASE_URL/v1/chat/completions" \
        -d "{\"model\":\"pharos-auto\",\"messages\":[{\"role\":\"user\",\"content\":\"$escaped\"}],\"max_tokens\":100}" 2>&1) || http_code="000"

    end_ms=$(get_ms)
    latency_ms=$((end_ms - start_ms))

    local tier model provider score cost
    tier=$(grep -i 'x-pharos-tier:' "$hdr_file" 2>/dev/null | awk '{print $2}' | tr -d '\r' || echo "")
    model=$(grep -i 'x-pharos-model:' "$hdr_file" 2>/dev/null | awk '{print $2}' | tr -d '\r' || echo "")
    provider=$(grep -i 'x-pharos-provider:' "$hdr_file" 2>/dev/null | awk '{print $2}' | tr -d '\r' || echo "")
    score=$(grep -i 'x-pharos-score:' "$hdr_file" 2>/dev/null | awk '{print $2}' | tr -d '\r' || echo "")
    cost=$(grep -i 'x-pharos-cost:' "$hdr_file" 2>/dev/null | awk '{print $2}' | tr -d '\r' || echo "0")

    echo "${id}|${label}|${http_code}|${latency_ms}|${tier}|${model}|${provider}|${score}|${cost}" > "$result_file"

    rm -f "$hdr_file" "$body_file"
}

# ═══════════════════════════════════════════════════════════════
echo ""
echo "  Pharos Stress Test"
echo "  Target: $BASE_URL"
echo ""

# Verify server is up
if ! curl -s --max-time 3 "$BASE_URL/health" > /dev/null 2>&1; then
    echo "ERROR: Server not responding at $BASE_URL/health"
    exit 1
fi
echo "  Server is up. Starting tests..."
echo ""

# Collect all result lines into a single file for summary
ALL_RESULTS="$RESULTS_DIR/all_results.txt"
touch "$ALL_RESULTS"

print_result() {
    local line="$1"
    IFS='|' read -r id label http_code latency_ms tier model provider score cost <<< "$line"

    local status
    if [[ "$http_code" == "200" ]]; then
        status="OK"
    elif [[ "$http_code" == "000" ]]; then
        status="TIMEOUT"
    elif [[ "$http_code" == "429" ]]; then
        status="429"
    else
        status="ERR$http_code"
    fi

    printf "  %-7s %-10s %6sms  score=%-3s tier=%-12s provider=%-12s model=%s\n" \
        "$status" "$label" "$latency_ms" "${score:-?}" "${tier:-?}" "${provider:-?}" "${model:-?}"

    echo "$line" >> "$ALL_RESULTS"
}

# ═══════════════════════════════════════════════════════════════
#  PHASE 1: Sequential Baseline
# ═══════════════════════════════════════════════════════════════
echo "--- Phase 1: Sequential Baseline (5 queries) ---"
echo ""

SEQ_QUERIES=("$Q_SIMPLE" "$Q_MODERATE" "$Q_ANALYSIS" "$Q_COMPLEX" "$Q_FRONTIER")
SEQ_LABELS=("simple" "moderate" "analysis" "complex" "frontier")

for i in "${!SEQ_QUERIES[@]}"; do
    rf="$RESULTS_DIR/seq_$i"
    send_request "S$((i+1))" "${SEQ_LABELS[$i]}" "${SEQ_QUERIES[$i]}" "$rf"
    print_result "$(cat "$rf")"
done

echo ""

# ═══════════════════════════════════════════════════════════════
#  PHASE 2: Burst Test (10 concurrent simple queries)
# ═══════════════════════════════════════════════════════════════
echo "--- Phase 2: Burst Test (10 concurrent simple queries) ---"
echo ""

BURST_PIDS=()
for i in $(seq 0 9); do
    rf="$RESULTS_DIR/burst_$i"
    send_request "B$((i+1))" "simple" "$Q_SIMPLE" "$rf" &
    BURST_PIDS+=($!)
done

for pid in "${BURST_PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
done

for i in $(seq 0 9); do
    rf="$RESULTS_DIR/burst_$i"
    [[ -f "$rf" ]] && print_result "$(cat "$rf")"
done

echo ""

# ═══════════════════════════════════════════════════════════════
#  PHASE 3: Mixed Load (20 concurrent)
# ═══════════════════════════════════════════════════════════════
echo "--- Phase 3: Mixed Load (20 concurrent: 8 simple, 5 moderate, 4 analysis, 2 complex, 1 frontier) ---"
echo ""

MIXED_PIDS=()
MIX_IDX=0

for i in $(seq 1 8); do
    rf="$RESULTS_DIR/mix_$MIX_IDX"
    send_request "M$((MIX_IDX+1))" "simple" "$Q_SIMPLE" "$rf" &
    MIXED_PIDS+=($!)
    MIX_IDX=$((MIX_IDX + 1))
done

for i in $(seq 1 5); do
    rf="$RESULTS_DIR/mix_$MIX_IDX"
    send_request "M$((MIX_IDX+1))" "moderate" "$Q_MODERATE" "$rf" &
    MIXED_PIDS+=($!)
    MIX_IDX=$((MIX_IDX + 1))
done

for i in $(seq 1 4); do
    rf="$RESULTS_DIR/mix_$MIX_IDX"
    send_request "M$((MIX_IDX+1))" "analysis" "$Q_ANALYSIS" "$rf" &
    MIXED_PIDS+=($!)
    MIX_IDX=$((MIX_IDX + 1))
done

for i in $(seq 1 2); do
    rf="$RESULTS_DIR/mix_$MIX_IDX"
    send_request "M$((MIX_IDX+1))" "complex" "$Q_COMPLEX" "$rf" &
    MIXED_PIDS+=($!)
    MIX_IDX=$((MIX_IDX + 1))
done

rf="$RESULTS_DIR/mix_$MIX_IDX"
send_request "M$((MIX_IDX+1))" "frontier" "$Q_FRONTIER" "$rf" &
MIXED_PIDS+=($!)

for pid in "${MIXED_PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
done

for i in $(seq 0 $MIX_IDX); do
    rf="$RESULTS_DIR/mix_$i"
    [[ -f "$rf" ]] && print_result "$(cat "$rf")"
done

echo ""

# ═══════════════════════════════════════════════════════════════
#  Summary Report (computed via awk from ALL_RESULTS)
# ═══════════════════════════════════════════════════════════════

echo "==========================================================="
echo "  STRESS TEST REPORT"
echo "==========================================================="
echo ""

python3 -c "
import sys

lines = open('$ALL_RESULTS').read().strip().split('\n')
if not lines or not lines[0]:
    print('  No results.')
    sys.exit(0)

total = ok = fail = timeout = rate_limited = 0
total_cost = 0.0
latencies = []
tiers = {}
providers = {}
errors = []

for line in lines:
    parts = line.split('|')
    if len(parts) < 9:
        continue
    rid, label, http, lat, tier, model, provider, score, cost = parts[0], parts[1], parts[2], int(parts[3]), parts[4], parts[5], parts[6], parts[7], parts[8]
    total += 1
    latencies.append(lat)
    if http == '200':
        ok += 1
        try: total_cost += float(cost)
        except: pass
        tiers[tier] = tiers.get(tier, 0) + 1
        providers[provider] = providers.get(provider, 0) + 1
    elif http == '000':
        timeout += 1
        errors.append(f'{rid} ({label}): timed out')
    elif http == '429':
        rate_limited += 1
        fail += 1
    else:
        fail += 1
        errors.append(f'{rid} ({label}): HTTP {http}')

print('  Requests')
print(f'    Total:        {total}')
print(f'    Succeeded:    {ok}')
print(f'    Failed:       {fail}')
print(f'    Timed out:    {timeout}')
print(f'    Rate limited: {rate_limited}')
print()

if latencies:
    s = sorted(latencies)
    p95i = min(int(len(s) * 0.95 + 0.5), len(s)) - 1
    print('  Latency')
    print(f'    Min:   {s[0]}ms')
    print(f'    Max:   {s[-1]}ms')
    print(f'    Avg:   {sum(s)//len(s)}ms')
    print(f'    p95:   {s[p95i]}ms')
    print()

print('  Tier Distribution')
for t in ['free', 'economical', 'premium', 'frontier']:
    if t in tiers:
        print(f'    {t:<12} {tiers[t]}')
print()

print('  Provider Distribution')
for p in sorted(providers):
    print(f'    {p:<12} {providers[p]}')
print()

print(f'  Total Estimated Cost: \${total_cost:.6f}')
print()

if errors:
    print('  Errors')
    for e in errors:
        print(f'    - {e}')
    print()
"

echo "==========================================================="

# Cleanup
rm -rf "$RESULTS_DIR"
