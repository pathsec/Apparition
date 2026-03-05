#!/bin/bash
# titlemon.sh — polls Firefox's active window title and current URL every 3s,
# sends them to the control server so the viewer tab can display the correct
# title and favicon. Exits immediately if INFO_URL is not set.

[ -z "$INFO_URL" ] && exit 0

PROFILE="/firefox-kiosk-profile"
PLACES_DB="$PROFILE/places.sqlite"

exec >> /tmp/titlemon.log 2>&1
log() { echo "[titlemon $(date +%T)] $*"; }

log "Starting. INFO_URL=${INFO_URL}"

# Wait up to 60s for Firefox to appear.
for i in $(seq 1 60); do
  pgrep -f "firefox" > /dev/null 2>&1 && break
  sleep 1
done
log "Firefox detected after ${i}s. Polling..."

# Copy a SQLite db to a temp dir before querying (bypasses Firefox's exclusive lock).
query_db() {
  local db="$1" sql="$2" tmpdir result
  tmpdir=$(mktemp -d)
  cp "$db"        "$tmpdir/q.sqlite"     2>/dev/null
  cp "${db}-wal"  "$tmpdir/q.sqlite-wal" 2>/dev/null
  cp "${db}-shm"  "$tmpdir/q.sqlite-shm" 2>/dev/null
  result=$(sqlite3 "$tmpdir/q.sqlite" "$sql" 2>/dev/null)
  rm -rf "$tmpdir"
  echo "$result"
}

LAST_TITLE=""

while true; do
  # Get the title of the active window on the VNC display.
  TITLE=$(DISPLAY=:1 xdotool getactivewindow getwindowname 2>/dev/null || echo "")

  if [ -n "$TITLE" ] && [ "$TITLE" != "$LAST_TITLE" ]; then
    # Derive a favicon URL from the most-recently-visited page in Firefox history.
    FAVICON_URL=""
    if [ -f "$PLACES_DB" ]; then
      URL=$(query_db "$PLACES_DB" \
        "SELECT url FROM moz_places WHERE last_visit_date IS NOT NULL ORDER BY last_visit_date DESC LIMIT 1;")
      if [ -n "$URL" ]; then
        DOMAIN=$(echo "$URL" | awk -F[/:] '{print $4}')
        [ -n "$DOMAIN" ] && FAVICON_URL="https://www.google.com/s2/favicons?sz=32&domain_url=${DOMAIN}"
      fi
    fi

    # Escape title for JSON.
    TITLE_ESC=$(printf '%s' "$TITLE" | sed 's/\\/\\\\/g; s/"/\\"/g')
    PAYLOAD="{\"title\":\"${TITLE_ESC}\",\"faviconUrl\":\"${FAVICON_URL}\"}"

    curl -sf -X POST \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD" \
      "$INFO_URL" -o /dev/null 2>/dev/null || true

    LAST_TITLE="$TITLE"
    log "Sent: title='${TITLE}' favicon='${FAVICON_URL}'"
  fi

  sleep 3
done
