#!/bin/bash
# Backgrounds a Firefox launcher that waits for xfce4-session, then hands
# off to the original accetto startup.sh with all original args.
(
  exec >> /tmp/firefox-kiosk.log 2>&1
  echo "[$(date)] waiting for xfce4-session, user=$(id)"
  for i in $(seq 1 60); do
    pgrep -x xfce4-session > /dev/null && break
    sleep 1
  done
  echo "[$(date)] xfce4-session found after ${i}s, sleeping 1s..."
  sleep 1
  echo "[$(date)] launching firefox, DISPLAY=$DISPLAY, START_URL=$START_URL"
  DISPLAY=:1 /usr/bin/firefox
  echo "[$(date)] firefox exited: $?"
) &

# Launch URL completion monitor in background (exits immediately if COMPLETION_URL is unset).
bash /dockerstartup/monitor.sh &

# Launch title/favicon monitor in background (exits immediately if INFO_URL is unset).
bash /dockerstartup/titlemon.sh &

exec /dockerstartup/startup.sh "$@"
