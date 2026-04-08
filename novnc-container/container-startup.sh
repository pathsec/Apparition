#!/bin/bash
# Backgrounds a Firefox launcher that waits for openbox, then hands
# off to the original accetto startup.sh with all original args.
(
  exec >> /tmp/firefox-kiosk.log 2>&1
  echo "[$(date)] waiting for openbox, user=$(id)"
  for i in $(seq 1 30); do
    pgrep -x openbox > /dev/null && break
    sleep 1
  done
  echo "[$(date)] openbox found after ${i}s"
  # Set root window to white so the background matches before Firefox renders.
  DISPLAY=:1 xsetroot -solid white

  echo "[$(date)] launching firefox, DISPLAY=$DISPLAY, START_URL=$START_URL"
  DISPLAY=:1 /usr/bin/firefox &
  FIREFOX_PID=$!

  # Wait for Firefox to create its window before signaling ready.
  # At this point openbox has applied the fullscreen rule, so the window
  # is already fullscreen — no corner flash when noVNC connects.
  echo "[$(date)] waiting for firefox window"
  for i in $(seq 1 30); do
    DISPLAY=:1 xdotool search --class firefox > /dev/null 2>&1 && break
    sleep 1
  done
  echo "[$(date)] firefox window found after ${i}s, signaling ready"
  touch /tmp/kiosk-display-ready

  wait $FIREFOX_PID
  echo "[$(date)] firefox exited: $?"
) &

# Launch URL completion monitor in background (exits immediately if COMPLETION_URL is unset).
bash /dockerstartup/monitor.sh &

# Launch title/favicon monitor in background (exits immediately if INFO_URL is unset).
bash /dockerstartup/titlemon.sh &

exec /dockerstartup/startup.sh "$@"
