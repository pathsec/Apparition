#!/bin/bash
# Launched by Xfce autostart. Since we removed all other Firefox autostart entries,
# this is the only thing that starts Firefox — no pkill race needed.
URL="${START_URL:-about:blank}"

# Wait for the Xfce session to fully settle before launching Firefox.
sleep 4

exec firefox \
  --kiosk \
  --no-remote \
  --new-instance \
  "$URL"
