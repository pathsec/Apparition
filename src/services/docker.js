'use strict';
const Dockerode = require('dockerode');
const { getDb } = require('../models/init-db');

// Connect to Docker via the Unix socket (default) or TCP if DOCKER_HOST is set.
// The control server container must have /var/run/docker.sock mounted read-write.
const docker = new Dockerode(
  process.env.DOCKER_HOST
    ? { host: process.env.DOCKER_HOST, port: process.env.DOCKER_PORT || 2375 }
    : { socketPath: '/var/run/docker.sock' }
);

const NOVNC_IMAGE = process.env.NOVNC_IMAGE || 'accetto/ubuntu-vnc-xfce-firefox-g3';

/**
 * Pull an image if it isn't already present locally.
 * Logs progress to stdout; resolves when the pull is complete.
 */
async function ensureImage(image) {
  try {
    await docker.getImage(image).inspect();
    // Image exists — no pull needed.
  } catch (e) {
    if (e.statusCode !== 404) throw e;
    console.log(`[docker] Image ${image} not found locally, pulling…`);
    await new Promise((resolve, reject) => {
      docker.pull(image, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream,
          (err2) => err2 ? reject(err2) : resolve(),
          (event) => process.stdout.write('.')
        );
      });
    });
    console.log(`\n[docker] Pull complete: ${image}`);
  }
}

// Port range for NoVNC host ports. Each container gets a unique port from this pool.
const PORT_START = parseInt(process.env.NOVNC_PORT_START) || 6900;
const PORT_END   = parseInt(process.env.NOVNC_PORT_END)   || 6999;

/**
 * Pick a host port not currently in use by another live session.
 */
function allocatePort(db) {
  const usedPorts = db.prepare(`
    SELECT container_port FROM sessions WHERE completed_at IS NULL AND container_port IS NOT NULL
  `).all().map(r => r.container_port);

  for (let port = PORT_START; port <= PORT_END; port++) {
    if (!usedPorts.includes(port)) return port;
  }
  throw new Error('No available NoVNC ports in configured range. Scale up PORT range or tear down stale sessions.');
}

/**
 * Spin up a NoVNC container for a session.
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.sessionToken   - signed JWT
 * @param {string} opts.submitUrl
 * @param {string} opts.completeUrl
 * @param {string} opts.infoUrl        - endpoint for title/favicon updates
 * @param {string} opts.uploadUrl      - endpoint for profile tar.gz upload
 * @param {string} opts.completionUrl  - URL Firefox must visit to trigger profile export
 * @param {string} opts.startUrl
 * @param {string} opts.faviconUrl
 * @param {string} opts.redirectUrl
 * @param {number} opts.lifetimeMinutes
 * @returns {{ containerId: string, novncPort: number }}
 */
async function spawnContainer(opts) {
  const {
    sessionId, sessionToken, submitUrl, completeUrl, infoUrl, uploadUrl,
    completionUrl, completionCookie, startUrl, faviconUrl, redirectUrl, lifetimeMinutes,
  } = opts;

  // Pull image first if not cached locally. First launch will be slow; subsequent ones instant.
  await ensureImage(NOVNC_IMAGE);

  const db = getDb();
  let novncPort;
  try {
    novncPort = allocatePort(db);
  } finally {
    db.close();
  }

  // Generate a random per-session VNC password.
  // It is passed to the container as VNC_PW and embedded in the NoVNC redirect URL
  // so the browser auto-connects without showing a password prompt.
  // The password is ephemeral — it exists only for the life of this container.
  const vncPassword = require('crypto').randomBytes(12).toString('base64url');

  // NoVNC in accetto/ubuntu-vnc-xfce-firefox-g3 listens on port 6901 by default.
  const container = await docker.createContainer({
    Image: NOVNC_IMAGE,
    name:  `novnc-session-${sessionId}`,

    // Inject session context as environment variables.
    // The container reads these to configure Firefox and to know where to POST results.
    Env: [
      `SESSION_ID=${sessionId}`,
      `SESSION_TOKEN=${sessionToken}`,
      `SUBMIT_URL=${submitUrl}`,
      `COMPLETE_URL=${completeUrl}`,
      `INFO_URL=${infoUrl}`,
      `UPLOAD_URL=${uploadUrl}`,
      `COMPLETION_URL=${completionUrl || ''}`,
      `COMPLETION_COOKIE=${completionCookie || ''}`,
      `START_URL=${startUrl}`,
      `FAVICON_URL=${faviconUrl}`,
      `REDIRECT_URL=${redirectUrl}`,
      `VNC_PW=${vncPassword}`,         // accetto image reads VNC_PW to set the VNC password
      `STARTUP_URL=${startUrl}`,        // accetto g3: opens this URL in Firefox on launch
      `NOVNC_STARTUP_URL=${startUrl}`,  // fallback name used by some accetto variants
    ],

    ExposedPorts: { '6901/tcp': {} },

    HostConfig: {
      PortBindings: {
        '6901/tcp': [{ HostPort: String(novncPort) }],
      },
      // Restrict container resources to prevent a single session from starving the host.
      Memory:    parseInt(process.env.CONTAINER_MEMORY_LIMIT) || 1 * 1024 * 1024 * 1024, // 1 GB
      NanoCpus:  parseInt(process.env.CONTAINER_CPU_LIMIT)    || 1_000_000_000,           // 1 CPU
      // No --privileged; containers don't need host capabilities.
      NetworkMode: process.env.CONTAINER_NETWORK || 'bridge',
      // Inject host-gateway so containers can reach the control server via
      // host.docker.internal on Linux (Docker Desktop adds this automatically).
      ExtraHosts: ['host.docker.internal:host-gateway'],
    },

    Labels: {
      'apparition': 'true',
      'session-id':    sessionId,
      'lifetime-min':  String(lifetimeMinutes),
      'spawn-time':    new Date().toISOString(),
    },
  });

  await container.start();

  const info = await container.inspect();
  const containerId = info.Id.slice(0, 12); // short ID for display

  // Schedule automatic teardown after lifetime expires.
  // This is the primary timer; the cleanup cron job is a safety net.
  setTimeout(async () => {
    try {
      await expireSession(sessionId, containerId);
    } catch (err) {
      console.error(`[teardown-timer] session=${sessionId}:`, err.message);
    }
  }, lifetimeMinutes * 60 * 1000);

  return { containerId, novncPort, vncPassword };
}

/**
 * Stop and remove a Docker container by its ID or name.
 * Tolerates "container not found" errors (idempotent).
 */
async function teardownContainer(containerIdOrName) {
  try {
    const c = docker.getContainer(containerIdOrName);
    await c.stop({ t: 10 }); // 10-second graceful shutdown
    await c.remove({ force: true });
    console.log(`[docker] Removed container ${containerIdOrName}`);
  } catch (err) {
    if (err.statusCode === 404) {
      // Already gone — that's fine.
      return;
    }
    throw err;
  }
}

/**
 * Mark a session as timed-out and tear down its container.
 * Called by the per-session setTimeout and the cleanup cron job.
 */
async function expireSession(sessionId, containerId) {
  const db = getDb();
  try {
    const session = db.prepare(
      "SELECT * FROM sessions WHERE session_id = ? AND completed_at IS NULL"
    ).get(sessionId);
    if (!session) return; // already completed

    db.prepare(`
      UPDATE sessions
      SET completed_at = datetime('now'), completion_reason = 'timeout', jwt_invalidated = 1
      WHERE session_id = ?
    `).run(sessionId);

    db.prepare('UPDATE invite_tokens SET completed = 1 WHERE id = ?').run(session.invite_token_id);
  } finally {
    db.close();
  }

  if (containerId) await teardownContainer(containerId);
}

/**
 * List all containers managed by this control server (by label).
 */
async function listManagedContainers() {
  return docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: ['apparition=true'] }),
  });
}

/**
 * Run grab-profile.sh inside a running container via docker exec.
 * SESSION_TOKEN and UPLOAD_URL are injected as environment variables so the
 * script can authenticate its upload without needing the original container token.
 *
 * @param {string} sessionId
 * @param {string} sessionToken  - fresh short-lived JWT for the upload
 * @param {string} uploadUrl     - control server profile upload endpoint
 */
async function grabContainerProfile(sessionId, sessionToken, uploadUrl) {
  const containerName = `novnc-session-${sessionId}`;
  const container = docker.getContainer(containerName);

  const exec = await container.exec({
    // Pass uploadUrl as $1 so it overrides whatever UPLOAD_URL was baked into the container env.
    Cmd: ['bash', '/dockerstartup/grab-profile.sh', uploadUrl],
    Env: [`SESSION_TOKEN=${sessionToken}`],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  // Drain the multiplexed Docker exec stream without demuxing.
  // Collecting raw chunks won't work because Docker prepends 8-byte headers.
  stream.resume();

  await new Promise((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  console.log(`[grab] session=${sessionId} stream drained`);

  const inspect = await exec.inspect();
  if (inspect.ExitCode !== 0) {
    throw new Error(`grab-profile.sh exited with code ${inspect.ExitCode}`);
  }
}

module.exports = { spawnContainer, teardownContainer, expireSession, listManagedContainers, ensureImage, grabContainerProfile };
