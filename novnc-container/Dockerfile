FROM accetto/ubuntu-vnc-xfce-firefox-g3:latest

USER root

# curl   — used by grab-profile.sh to upload the Firefox profile archive.
# sqlite3 — used by monitor.sh to query places.sqlite (URL history) and
#            cookies.sqlite for completion detection.
RUN apt-get update && apt-get install -y --no-install-recommends curl sqlite3 xdotool && rm -rf /var/lib/apt/lists/*

# /usr/bin/firefox is a symlink -> ../lib/firefox/firefox
# Move the symlink to firefox-real, then put our wrapper in its place.
RUN mv /usr/bin/firefox /usr/bin/firefox-real
COPY firefox-wrapper.sh /usr/bin/firefox
RUN chmod +x /usr/bin/firefox

# Pre-configured Firefox profile: disables session restore, welcome pages,
# and default-browser prompts so Firefox always opens the command-line URL.
RUN mkdir -p /firefox-kiosk-profile
COPY firefox-profile/user.js /firefox-kiosk-profile/user.js
RUN chown -R headless:headless /firefox-kiosk-profile

# Firefox enterprise policies: belt-and-suspenders on top of user.js.
RUN mkdir -p /usr/lib/firefox/distribution
COPY policies.json /usr/lib/firefox/distribution/policies.json

# Hide the noVNC control bar and the "Connected to (unencrypted) ..." status popup.
RUN find /usr /opt -name "vnc.html" 2>/dev/null | head -1 | \
    xargs -I{} sed -i \
    's|</head>|<style>#noVNC_control_bar_anchor,#noVNC_panel,#noVNC_status{display:none!important}</style></head>|' \
    {}

# Override ENTRYPOINT to inject Firefox launcher before the accetto startup.
COPY container-startup.sh /dockerstartup/container-startup.sh
COPY monitor.sh /dockerstartup/monitor.sh
COPY titlemon.sh /dockerstartup/titlemon.sh
COPY grab-profile.sh /dockerstartup/grab-profile.sh
RUN chmod +x /dockerstartup/container-startup.sh /dockerstartup/monitor.sh /dockerstartup/titlemon.sh /dockerstartup/grab-profile.sh

USER headless

ENTRYPOINT ["/usr/bin/tini", "--", "/dockerstartup/container-startup.sh"]
CMD ["--wait"]
