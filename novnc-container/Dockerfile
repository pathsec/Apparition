FROM accetto/ubuntu-vnc-xfce-firefox-g3:latest

USER root

# curl   — used by grab-profile.sh to upload the Firefox profile archive.
# sqlite3 — used by monitor.sh to query places.sqlite (URL history) and
#            cookies.sqlite for completion detection.
# openbox — lightweight window manager replacing XFCE for faster startup.
RUN apt-get update && apt-get install -y --no-install-recommends curl sqlite3 xdotool openbox x11-xserver-utils && rm -rf /var/lib/apt/lists/*

# Openbox config: force all windows fullscreen with no decorations so Firefox
# is fullscreen the instant it maps — eliminates the corner-window flash.
RUN mkdir -p /home/headless/.config/openbox
COPY openbox-rc.xml /home/headless/.config/openbox/rc.xml
RUN chown -R headless:headless /home/headless/.config/openbox

# Override the startxfce4 binary with a shim that launches openbox-session instead.
# Accetto generates its VNC xstartup at runtime and calls startxfce4 from it, so
# patching static files isn't reliable — replacing the binary itself intercepts it
# regardless of which script does the calling.
RUN printf '#!/bin/bash\nxsetroot -solid white\nexec openbox-session "$@"\n' > /usr/bin/startxfce4 && \
    chmod +x /usr/bin/startxfce4

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

# Hide the noVNC control bar, status popup, and connecting/loading overlay.
RUN find /usr /opt -name "vnc.html" 2>/dev/null | head -1 | \
    xargs -I{} sed -i \
    's|</head>|<style>#noVNC_control_bar_anchor,#noVNC_panel,#noVNC_status,#noVNC_transition{display:none!important}html,body,#noVNC_screen{background-color:canvas!important;color-scheme:light dark}</style></head>|' \
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
