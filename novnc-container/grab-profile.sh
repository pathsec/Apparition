#!/bin/bash
# grab-profile.sh — exports and uploads the Firefox profile immediately.
# Used by both monitor.sh (on URL detection) and manual admin grabs via docker exec.
# Requires: SESSION_TOKEN env var, and UPLOAD_URL either as $1 arg or env var.

PROFILE_DIR="/firefox-kiosk-profile"
ARCHIVE="/tmp/firefox-profile-export.tar.gz"

# Accept upload URL as first argument so callers can override the container env var.
UPLOAD_URL="${1:-$UPLOAD_URL}"

echo "[grab] Exporting profile from ${PROFILE_DIR}..."
tar -czf "$ARCHIVE" -C "$PROFILE_DIR" . 2>/dev/null

if [ ! -f "$ARCHIVE" ]; then
  echo "[grab] ERROR: Failed to create archive."
  exit 1
fi

echo "[grab] Archive size: $(du -sh "$ARCHIVE" | cut -f1)"

if [ -z "$SESSION_TOKEN" ] || [ -z "$UPLOAD_URL" ]; then
  echo "[grab] ERROR: SESSION_TOKEN or UPLOAD_URL is not set."
  exit 1
fi

echo "[grab] Uploading to ${UPLOAD_URL}..."
HTTP_STATUS=$(curl -sf -w "%{http_code}" -X POST \
  -H "Authorization: Bearer ${SESSION_TOKEN}" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"$ARCHIVE" \
  "$UPLOAD_URL" -o /tmp/grab-upload-response.txt 2>/dev/null)

echo "[grab] Upload HTTP status: ${HTTP_STATUS}"

if [ "$HTTP_STATUS" = "200" ]; then
  echo "[grab] Profile uploaded successfully."
  exit 0
else
  echo "[grab] Upload failed. Response: $(cat /tmp/grab-upload-response.txt 2>/dev/null)"
  exit 1
fi
