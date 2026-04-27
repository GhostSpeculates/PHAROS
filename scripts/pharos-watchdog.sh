#!/bin/bash
# pharos-watchdog.sh — Pharos SPOF protection
# Checks Pharos health every 5 min (via system crontab)
# If down: restart, re-check, alert Ghost via ntfy if still down
# Runs silently when healthy

LOGFILE="/tmp/pharos-watchdog.log"
NTFY_TOPIC="ghost-noir-ctrl"
NTFY_URL="https://ntfy.sh/${NTFY_TOPIC}"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOGFILE"
}

check_health() {
    curl -sf http://localhost:3777/health >/dev/null 2>&1
    return $?
}

if check_health; then
    exit 0
fi

log "ALERT: Pharos health check FAILED — attempting restart"

launchctl kickstart -k gui/501/com.pharos.gateway 2>/dev/null
log "Issued launchctl kickstart -k gui/501/com.pharos.gateway"

sleep 10

if check_health; then
    log "RECOVERED: Pharos is healthy after restart"
    exit 0
fi

log "CRITICAL: Pharos still DOWN after restart — alerting Ghost"
curl -sf \
    -H "Title: Pharos DOWN" \
    -H "Priority: urgent" \
    -H "Tags: rotating_light" \
    -d "Pharos gateway is DOWN and failed to recover after restart. All agents may be unresponsive. SSH into VPS to investigate: ssh clawd-vps" \
    "$NTFY_URL" >/dev/null 2>&1

log "Alert sent to ntfy topic: $NTFY_TOPIC"
exit 1
