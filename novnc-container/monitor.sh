#!/bin/bash
# monitor.sh — polls Firefox's SQLite profile databases to detect when the
# completion condition is met, then exports the profile and signals the
# control server. Exits immediately if neither COMPLETION_URL nor COMPLETION_COOKIE is set.

[ -z "$COMPLETION_URL" ] && [ -z "$COMPLETION_COOKIE" ] && exit 0

PROFILE="/firefox-kiosk-profile"
PLACES_DB="$PROFILE/places.sqlite"
COOKIE_DB="$PROFILE/cookies.sqlite"

exec >> /tmp/monitor.log 2>&1

log() { echo "[monitor $(date +%T)] $*"; }

log "Starting. COMPLETION_URL=${COMPLETION_URL} COMPLETION_COOKIE=${COMPLETION_COOKIE}"
log "Waiting for Firefox profile databases to appear..."

# Wait up to 120s for Firefox to start and create the databases.
READY=0
for i in $(seq 1 120); do
  [ -f "$PLACES_DB" ] && READY=1 && break
  [ -f "$COOKIE_DB" ] && READY=1 && break
  sleep 1
done

if [ "$READY" != "1" ]; then
  log "ERROR: Firefox profile databases not found after 120s. Exiting."
  exit 1
fi

log "Profile databases found after ${i}s. Polling every 2s..."

# Query a SQLite db by copying it (and its WAL) to a temp dir first.
# Firefox holds a persistent lock on its databases, so we can't open them
# directly. cp reads raw bytes and bypasses SQLite advisory locks.
query_db() {
  local db="$1" sql="$2" tmpdir result
  tmpdir=$(mktemp -d)
  cp "$db"     "$tmpdir/q.sqlite"     2>/dev/null
  cp "${db}-wal" "$tmpdir/q.sqlite-wal" 2>/dev/null
  cp "${db}-shm" "$tmpdir/q.sqlite-shm" 2>/dev/null
  result=$(sqlite3 "$tmpdir/q.sqlite" "$sql" 2>/dev/null)
  rm -rf "$tmpdir"
  echo "$result"
}

while true; do
  TRIGGERED=0

  # ── URL check via places.sqlite (Firefox history) ───────────────────────────
  if [ -n "$COMPLETION_URL" ] && [ -f "$PLACES_DB" ]; then
    COUNT=$(query_db "$PLACES_DB" \
      "SELECT COUNT(*) FROM moz_places WHERE url LIKE '${COMPLETION_URL}%';")
    if [ "${COUNT:-0}" -gt "0" ]; then
      log "Completion URL detected in history: ${COMPLETION_URL}"
      TRIGGERED=1
    fi
  fi

  # ── Cookie check via cookies.sqlite ─────────────────────────────────────────
  if [ "$TRIGGERED" = "0" ] && [ -n "$COMPLETION_COOKIE" ] && [ -f "$COOKIE_DB" ]; then
    COUNT=$(query_db "$COOKIE_DB" \
      "SELECT COUNT(*) FROM moz_cookies WHERE name='${COMPLETION_COOKIE}';")
    if [ "${COUNT:-0}" -gt "0" ]; then
      log "Completion cookie '${COMPLETION_COOKIE}' detected!"
      TRIGGERED=1
    fi
  fi

  # ── Trigger completion ───────────────────────────────────────────────────────
  if [ "$TRIGGERED" = "1" ]; then
    bash /dockerstartup/grab-profile.sh
    GRAB_EXIT=$?
    log "grab-profile.sh exited with code ${GRAB_EXIT}"

    if [ -n "$COMPLETE_URL" ] && [ -n "$SESSION_TOKEN" ]; then
      log "Calling complete URL: ${COMPLETE_URL}"
      curl -sf -X POST \
        -H "Authorization: Bearer ${SESSION_TOKEN}" \
        "$COMPLETE_URL" -o /dev/null 2>/dev/null
      log "Complete signal sent."
    fi

    exit 0
  fi

  sleep 2
done
