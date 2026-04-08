# Apparition

Apparition is a campaign-driven, containerized browser-in-the-middle platform that delivers ephemeral, isolated browsing sessions to recipients via a link. When a user visits /join/<token>, Apparition launches a dedicated Docker container running Firefox in a lightweight Openbox desktop streamed over noVNC, providing a full-screen "real browser" experience without exposing the operator host or other sessions. A Node/Express control server orchestrates session creation and teardown, enforces campaign lifetime and completion rules, and records campaign/token/session state in SQLite.

Sessions can end automatically on timeout, manual teardown, or a defined completion condition—after which the container is destroyed and the user is redirected to a configured destination. Optionally, the user can continue browsing until a campaign-defined time limit is reached. When a completion condition is met, the session's browser profile can be downloaded from the admin console; otherwise, the profile remains available for download at any time from the sessions view for review and reporting.

<p align="center">
  <img width="900" alt="Architecture" src="https://github.com/user-attachments/assets/4d8b9cd5-13bf-44ed-8f1f-6418aafa6933" />
</p>

<p align="center">
  <img width="575" alt="Campaign Tab" src="https://github.com/user-attachments/assets/bc0ad88f-c225-4259-93f4-22002ac4d5af" />
  <img width="341" alt="Campaign Creation Tab" src="https://github.com/user-attachments/assets/575c3c11-d69e-4b54-8379-9a69daea77f8" />
</p>

## Important Note!
This is a first-release build created with heavy vibe-coding. There may be unforeseen issues / flaws. Use only in an authorized context.

## How It Works

1. You create a **Campaign** with a start URL, lifetime, and redirect URL.
2. You generate **Invite Tokens** and optionally email them to recipients.
3. A recipient clicks their `/join/<token>` link.
4. Apparition spins up a Docker container running Firefox in a headless Openbox desktop via noVNC.
5. The control server waits until the VNC display is ready and Firefox has opened its window before redirecting the user — no loading flash or black screen.
6. The user sees a full-screen browser. When the session ends (timeout, completion trigger, or manual teardown), the container is destroyed and the user is redirected.

## Architecture

```
                    ┌─────────────────────────┐
                    │         nginx           │  (optional, recommended)
                    │   TLS termination +     │
                    │   WebSocket proxy       │
                    └────────────┬────────────┘
                                 │ :443
                    ┌────────────▼────────────┐
                    │    Apparition (Node)    │  :3000
                    │  Express + SQLite       │
                    │  Admin UI + API         │
                    └────────────┬────────────┘
                                 │ Docker socket
              ┌──────────────────┼──────────────────┐
              │                  │                  │
   ┌──────────▼──────┐  ┌────────▼──────┐  ┌───────▼───────┐
   │ novnc-session-1 │  │novnc-session-2│  │novnc-session-3│
   │ Firefox + noVNC │  │Firefox + noVNC│  │Firefox + noVNC│
   │   port 6900     │  │   port 6901   │  │   port 6902   │
   └─────────────────┘  └───────────────┘  └───────────────┘
```

- **Control server** — Node.js/Express app. Manages campaigns, tokens, sessions, and the admin dashboard. Spawns and tears down sibling containers via the Docker socket.
- **noVNC containers** — Docker sibling containers, each running Openbox + Firefox + noVNC, bound to a unique host port (6900–6999 by default). Each container receives session context via environment variables.
- **SQLite** — Stores campaigns, invite tokens, sessions, email history, event logs, and submissions.
- **nginx** (recommended for production) — Terminates TLS, proxies all traffic including WebSocket upgrades to noVNC.

---

## Prerequisites

- **Docker Engine** 20.10+ and **Docker Compose** v2+
- A Linux host (Debian/Ubuntu or RHEL/Fedora recommended)
- Node.js 18+ (only needed for local development — Docker handles production)
- (Production) nginx + certbot for TLS

---

## Installation

### 1. Clone the repository

```bash
git clone <repo-url> apparition
cd apparition
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and set at minimum:

| Variable | What to set |
|---|---|
| `SESSION_SECRET` | A long random string — run `openssl rand -hex 64` |
| `JWT_SECRET` | A different long random string — run `openssl rand -hex 64` |
| `CONTROL_HOST` | The public URL of this server, e.g. `https://example.com` |
| `CONTAINER_HOST` | Internal URL for container callbacks — `http://host.docker.internal:3000` |
| `NOVNC_HOST` | Hostname where noVNC ports are reachable — usually `host.docker.internal` |

### 3. Build the kiosk image

The custom noVNC/Firefox container image must be built before any sessions can start:

```bash
docker compose build novnc-kiosk
```

This builds `./novnc-container` and tags it as `novnc-kiosk` locally. Only needs to be run once, or again after changes to `novnc-container/`.

### 4. Start the control server

```bash
docker compose up -d
```

The app runs on port 3000. Check logs with:

```bash
docker compose logs -f app
```

### 5. Create the admin account

```bash
docker compose exec app node src/scripts/create-admin.js
```

Follow the prompts to set a username and password. This only needs to be run once.

### 6. Open the admin panel

Navigate to `http://localhost:3000/admin/login` (or your domain).

---

## Production Setup (nginx + TLS)

### Install and configure nginx

Copy the included nginx config:

```bash
sudo cp nginx/novnc-manager.conf /etc/nginx/sites-available/apparition
```

Replace `YOUR_DOMAIN` with your actual domain in the config file:

```bash
sudo sed -i 's/YOUR_DOMAIN/example.com/g' /etc/nginx/sites-available/apparition
```

### Obtain a TLS certificate

```bash
sudo certbot --nginx -d example.com
```

### Enable the site

```bash
sudo ln -s /etc/nginx/sites-available/apparition /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Update `.env` for production

```env
CONTROL_HOST=https://example.com
CONTAINER_HOST=http://host.docker.internal:3000
COOKIE_SECURE=true
```

> **`CONTAINER_HOST` vs `CONTROL_HOST`:** Containers use `CONTAINER_HOST` to POST callbacks (submit, complete, profile upload) directly to the Node server, bypassing nginx. This must be a URL reachable from inside Docker — `http://host.docker.internal:3000` works on Linux when `extra_hosts: host.docker.internal:host-gateway` is set (it is, in `docker-compose.yml`).

Restart the app after changing `.env`:

```bash
docker compose up -d
```

---

## Environment Variables

See `.env.example` for the full annotated template.

### Required

| Variable | Description |
|---|---|
| `SESSION_SECRET` | Secret for Express session signing |
| `JWT_SECRET` | Secret for container JWT signing (must differ from `SESSION_SECRET`) |

### Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the Node server listens on |
| `CONTROL_HOST` | — | Public base URL (used in invite links and emails) |
| `CONTAINER_HOST` | `http://host.docker.internal:3000` | Internal URL containers use for callbacks |
| `NOVNC_HOST` | `host.docker.internal` | Host/IP where noVNC container ports are reachable |
| `COOKIE_SECURE` | `false` | Set to `true` when serving over HTTPS |
| `JOIN_PATH` | `join` | URL segment for invite links (e.g. `/join/<token>`) |
| `DB_PATH` | `/data/app.db` | Path to the SQLite database file |

### Docker / Containers

| Variable | Default | Description |
|---|---|---|
| `NOVNC_IMAGE` | `novnc-kiosk` | Docker image used for session containers |
| `NOVNC_PORT_START` | `6900` | Start of host port pool for noVNC containers |
| `NOVNC_PORT_END` | `6999` | End of host port pool |
| `CONTAINER_NETWORK` | `bridge` | Docker network containers are attached to |
| `CONTAINER_MEMORY_LIMIT` | `1073741824` | Per-container memory limit in bytes (default 1 GB) |
| `CONTAINER_CPU_LIMIT` | `1000000000` | Per-container CPU limit in nanocpus (default 1 CPU) |
| `CLEANUP_INTERVAL_MS` | `60000` | How often the cleanup job runs in milliseconds |
| `VNC_RESOLUTION` | `1920x1080` | Initial VNC framebuffer resolution. Set to match your typical viewer window size to avoid upscale blur. noVNC's `resize=remote` adjusts this dynamically once connected. |

### SMTP / Email

| Variable | Default | Description |
|---|---|---|
| `SMTP_HOST` | — | SMTP server hostname |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_SECURE` | `false` | Use SMTPS (set to `true` for port 465) |
| `SMTP_USER` | — | SMTP username or API key |
| `SMTP_PASS` | — | SMTP password or secret key |
| `SMTP_FROM` | — | Sender address |
| `SMTP_FROM_NAME` | `Apparition` | Display name for outgoing email |

SMTP settings can also be configured through the admin Settings UI. Environment variables take precedence over UI values.

### Optional: Direct TLS (without nginx)

| Variable | Description |
|---|---|
| `SSL_KEY` | Path to TLS private key — enables HTTPS on Node directly |
| `SSL_CERT` | Path to TLS certificate |

> Only needed if you are **not** using nginx. When nginx handles TLS termination, leave these unset and set `COOKIE_SECURE=true` instead.

---

## Campaigns

A campaign is a named configuration that a set of invite tokens inherit. Each campaign defines:

| Field | Description |
|---|---|
| **Name** | Internal label for the campaign |
| **Start URL** | Firefox opens this URL when a session starts |
| **Lifetime** | Session duration in minutes — container is torn down after this |
| **Redirect URL** | Where users are sent after their session ends |
| **Slug** | Clean URL prefix for the viewer (e.g. `/my-campaign/<shortId>`) |
| **Favicon URL** | Tab icon shown in the viewer (auto-updated from user's browsing) |
| **Completion URL** | URL that, when visited by Firefox, triggers session completion |
| **Completion Cookie** | Cookie name that, when set, triggers session completion |
| **After Completion** | `redirect` (default) tears down the container; `keep_alive` keeps it running |
| **Show Loading Page** | Whether to show a "Starting..." page while the container boots. When disabled, the transition is seamless — the control server waits for the display to be ready before redirecting. |

---

## Invite Tokens

Each invite token maps to one unique `/join/<token>` URL. Tokens can be:

- Generated individually from the campaign detail page
- Bulk-generated for email distribution
- Sent via the built-in email composer

When a token is used:

1. A Docker container starts (`novnc-session-<uuid>`)
2. Firefox opens the campaign's start URL
3. The control server polls until Openbox is running, the root window is white, and Firefox has opened its window
4. The viewer renders a full-screen iframe showing the Firefox session

The viewer polls the server every 3 seconds to sync the browser tab title and favicon with Firefox's current page.

---

## Email Tracking

When emails are sent through the built-in composer, Apparition logs every event as a discrete row in the `email_events` table — rather than overwriting boolean flags — so scanner and bot activity is visible alongside genuine human engagement.

### Events logged

| Event | When |
|---|---|
| `sent` | Email was successfully handed off to the SMTP server |
| `open` | The 1×1 tracking pixel embedded in the HTML email was loaded |
| `click` | The `/join/<token>` link was visited |

Each event records the timestamp, IP address, and user-agent. Multiple `open` events from the same send are expected and normal — email security scanners typically pre-fetch images before delivery, generating hits with Microsoft/Google datacenter IPs and generic scanner user-agents that precede any human open.

### Tracking pixel

A 1×1 transparent GIF is automatically appended to every HTML email body at send time. The pixel URL is `/t/<token>` and requires no authentication. Set `Cache-Control: no-store` is sent to prevent CDN or proxy caching.

### CSV export

From the campaign detail page, click **Export CSV** to download a per-recipient summary with the following columns:

`email`, `token`, `sent_at`, `send_error`, `open_count`, `first_open`, `last_open`, `open_ips`, `open_user_agents`, `click_count`, `first_click`, `last_click`, `click_ips`, `launched`, `completed`

The `open_ips` and `open_user_agents` columns contain comma-separated lists of all recorded values, making it straightforward to distinguish scanner hits (repeated datacenter IPs before the email was delivered) from genuine opens.

---

## Admin Panel

The admin panel at `/admin` provides:

- **Dashboard** — live session count and recent activity
- **Campaigns** — create and manage campaigns; view tokens, session logs, and export tracking CSV
- **Invite Links** — manage individual tokens, view click and launch stats
- **Email** — compose and send campaign emails with embedded invite links and automatic open-tracking pixels
- **Sessions** — full session log with submission data and Firefox profile downloads
- **Settings** — configure SMTP and Cloudflare Turnstile

---

## Bot Protection (Cloudflare Turnstile)

To require a CAPTCHA challenge on the join page, add to `.env` or configure via the Settings UI:

```env
TURNSTILE_SITE_KEY=your-site-key
TURNSTILE_SECRET_KEY=your-secret-key
```

When configured, the join page renders a Turnstile widget before allowing a session to start.

---

## Kiosk Container

Each session runs in an isolated Docker container built from `novnc-container/`. Key properties:

- **Openbox** window manager (replaces XFCE) — starts in ~1–2 seconds versus 5–7 for a full desktop environment, with no panels, file managers, or daemons
- **Firefox** runs in `--kiosk` mode against a pre-configured profile that disables session restore, welcome pages, telemetry, and default browser prompts
- **noVNC** streams the display over WebSocket; the control bar, status popups, and loading overlay are hidden for a seamless presentation
- **Dynamic resolution** — `resize=remote` is set on all noVNC URLs, so the VNC framebuffer resizes to match the user's browser window automatically
- **Seamless startup** — a readiness flag (`/tmp/kiosk-display-ready`) is written only after `xsetroot` has set the root window to white and `xdotool` confirms Firefox has opened its window. The loading page polls this flag via `docker exec` before redirecting, so the user always lands on an active session with no gray or black flash.

To rebuild the kiosk image after changes:

```bash
docker compose build novnc-kiosk
```

---

## Development

```bash
npm install
cp .env.example .env   # edit for local config
npm run dev            # starts with nodemon hot-reload
```

The server runs on `http://localhost:3000`. Docker must be running and accessible for container management.

---

## Security Notes

- The app container mounts the Docker socket (`/var/run/docker.sock`), which grants root-equivalent access to the host. In production, consider using [Tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) to restrict which Docker API calls are permitted.
- Session cookies are `httpOnly`, `sameSite: lax`, and `secure` when `COOKIE_SECURE=true`.
- All container-to-server callbacks are authenticated with short-lived, session-scoped JWTs.
- Rate limiting is applied to the join and session endpoints.
- The `security_opt: label:disable` in `docker-compose.yml` is required on Fedora/RHEL to allow Docker socket access under SELinux. It only affects label confinement for the app container.
- The tracking pixel endpoint (`/t/:token`) is intentionally unauthenticated — it must be reachable by email clients. It only records an event and returns a static GIF; it exposes no session data.
