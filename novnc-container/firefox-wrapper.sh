#!/bin/bash
# Replaces the real firefox binary. Always launches in kiosk mode at $START_URL
# using a pre-configured profile that disables session restore and welcome pages.
exec /usr/bin/firefox-real \
  --kiosk \
  --no-remote \
  --profile /firefox-kiosk-profile \
  "${START_URL:-about:blank}" \
  "$@"
