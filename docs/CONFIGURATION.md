# Jarvis Configuration

## Environment Variables

All configuration is passed to the server via environment variables or an optional `.env` file. The systemd service uses `EnvironmentFile` to load these at startup.

### Server Binding

| Variable | Default | Description |
|----------|---------|-------------|
| `JARVIS_HOST` | `127.0.0.1` | Server bind address. Set to `0.0.0.0` to listen on all interfaces (not recommended without TLS). Set to your LAN IP for phone testing. |
| `JARVIS_PORT` | `3210` | Server listen port. Must be non-privileged (≥ 1024). |

**Example: Bind to LAN for phone testing**
```bash
JARVIS_HOST=192.168.1.100 JARVIS_PORT=3210 npm --workspace @jarvis/server start
```

### Data & Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `JARVIS_DATA_DIR` | `~/.jarvis` | Root directory for SQLite database, previews, terminal sockets, and other persistent state. Must be writable. |

**Directory layout:**
```
$JARVIS_DATA_DIR/
├── jarvis.sqlite3                    # Main SQLite database
├── previews/<repo-id>/
│  └── index.html                     # Landing page per repository
└── terminal-host.sock                # Unix socket for terminal sessions
```

**Backup location:** Copy `$JARVIS_DATA_DIR` to a backup device or cloud storage. The entire directory is self-contained; no other files need backing up.

### Agent & Policy

| Variable | Default | Description |
|----------|---------|-------------|
| `JARVIS_AGENT_BACKEND` | `worker` | Production runtime. Requires the registered repository to be open in a connected VS Code Jarvis worker window. |
| `JARVIS_POLICY` | `"Work autonomously, but ask the user before commit, push, or pull-request operations unless this task explicitly grants permission."` | Global plain-text policy presented to every agent task. Jarvis does not enforce this policy; runtime policy enforcement takes precedence. |

**Example: Custom policy**
```bash
JARVIS_POLICY="Ask before any git operations. Never use sudo." npm --workspace @jarvis/server start
```

### Web Assets

| Variable | Default | Description |
|----------|---------|-------------|
| `JARVIS_WEB_ROOT` | `<monorepo-root>/apps/web/dist` | Absolute path to built PWA assets. Set only if deploying artifacts to a different location. |

### Advanced Options

| Variable | Default | Description |
|----------|---------|-------------|
| `JARVIS_TERMINAL_HOST_SCRIPT` | `<server-dist-dir>/terminal-host.js` | Absolute path to the terminal host subprocess. Normally auto-detected; override if distributing separately. |
| `JARVIS_MAX_JSON_LINE_BYTES` | `1048576` (1 MB) | Maximum size of one JSONL task event. Larger records are discarded and represented by a `line_too_large` parse-error event. |
| `JARVIS_MAX_STDERR_CHUNK_BYTES` | `65536` (64 KB) | Maximum size of a single stderr chunk buffered from the agent process. Adjust based on available memory and task verbosity. |

## Configuration Files

### `.env` file (optional, at repo root)

Create a `.env` file to avoid repeating environment variables:

```bash
# .env
JARVIS_HOST=127.0.0.1
JARVIS_PORT=3210
JARVIS_DATA_DIR=/home/you/.jarvis
JARVIS_AGENT_EXECUTABLE=copilot
JARVIS_POLICY="Work autonomously, but ask before commit/push/PR."
```

**Load it manually:**
```bash
source .env
npm --workspace @jarvis/server start
```

**Systemd loads it automatically:**
```
EnvironmentFile=-/home/you/.config/jarvis/.env
```

### Repository inventory

Repositories are registered from the laptop and contain only a display name, absolute checkout path, and main branch:

```bash
npm run repo:add -- /home/you/prod-repo "Production System" main
```

Use `JARVIS_POLICY` for instructions shared by every repository.

## Network Access

### Tailscale Serve (recommended for phone access)

```bash
# On your laptop
tailscale serve --bg http://127.0.0.1:3210
```

This exposes Jarvis at `https://<device-name>.<tailnet>.ts.net/` to devices allowed by your Tailnet policy. Tailscale provisions a publicly trusted TLS certificate for the device name.

**On your phone (same Tailnet):**
1. Open Safari/Chrome to `https://<device-name>.<tailnet>.ts.net/`
2. Tap "Share" → "Add to Home Screen" (or browser menu → "Install")
3. Open the installed PWA; it will auto-update and work offline

### LAN fallback (no Tailscale)

1. Bind to your LAN interface:
   ```bash
   JARVIS_HOST=192.168.1.100 npm --workspace @jarvis/server start
   ```
2. Generate a self-signed certificate (or use a reverse proxy with TLS):
   ```bash
   openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes \
     -subj "/CN=192.168.1.100"
   ```
3. On your phone, navigate to `https://192.168.1.100:3210` and accept the certificate warning.
4. Install as PWA (browser menu → "Add to Home Screen").

**Note:** PWA installation and Web Push require HTTPS.

### Localhost only (no phone access)

```bash
JARVIS_HOST=127.0.0.1 JARVIS_PORT=3210 npm --workspace @jarvis/server start
```

Open http://127.0.0.1:3210 on your laptop. PWA installation and notifications will not work without HTTPS (browser limitation).

## Database Schema

The SQLite database is managed by Jarvis and should not be edited manually. However, understanding the schema helps with backups and troubleshooting.

### Main tables

- **repositories** — Registered Git checkouts (id, name, path, default_branch, created_at, updated_at)
- **tasks** — Agent task records (id, repository_id, session_id, state, created_at, updated_at, stopped_by, stopped_at, exit_code)
- **task_events** — Ordered task messages and lifecycle events (id, task_id, sequence, kind, payload, created_at)
- **terminal_sessions** — PTY sessions per checkout (id, repository_id, name, created_at)
- **push_subscriptions** — Web Push endpoints registered by the PWA (endpoint, subscription, created_at)
- **settings** — Miscellaneous metadata (key, value)

### Constraints

- One active task per repository at a time (enforced by unique index on `tasks(repository_id)` where state is 'starting'/'running'/'stopping')
- Task events are immutable and ordered by sequence number per task
- Repositories are uniquely identified by path (no duplicate checkouts)

## Troubleshooting Configuration

### Server binds but PWA shows "Not Secure"

**Cause:** HTTP instead of HTTPS.
- **Tailscale:** Use `tailscale serve --bg http://127.0.0.1:3210` to add TLS.
- **LAN:** Generate a self-signed cert and use a reverse proxy (e.g., nginx, caddy).
- **Localhost:** PWA features (install, notifications) require HTTPS.

### Agent command not found

**Cause:** `$JARVIS_AGENT_EXECUTABLE` is not in `$PATH` or doesn't exist.

```bash
# Test the executable
which copilot
copilot --version

# If not found, install or set absolute path
JARVIS_AGENT_EXECUTABLE=/opt/github-cli/copilot npm --workspace @jarvis/server start
```

### Database locked errors

**Cause:** SQLite is single-writer; server already running or another process has the database.

```bash
# Check for stale processes
ps aux | grep "node.*dist/src/index.js"

# Kill if needed
kill -9 <pid>

# Restart
systemctl --user restart jarvis
```

### Out of disk space in JARVIS_DATA_DIR

**Cause:** Large task transcripts or many terminal sessions.

```bash
# Check size
du -sh ~/.jarvis

# Clean old tasks (manual, requires stopping server)
systemctl --user stop jarvis
# Use a SQLite client to inspect and delete old task records
sqlite3 ~/.jarvis/jarvis.sqlite3
# Then restart
systemctl --user start jarvis
```

## Integration with CI/CD

Jarvis is designed for local development, not CI/CD. However, you can expose its API for automation:

```bash
# Start server in the background
JARVIS_HOST=127.0.0.1 JARVIS_PORT=3210 npm --workspace @jarvis/server start &
SERVER_PID=$!

# Wait for health check
sleep 2
curl http://127.0.0.1:3210/api/health

# Perform API operations (e.g., register a repo)
curl -X POST http://127.0.0.1:3210/api/repositories ...

# Cleanup
kill $SERVER_PID
```

For automated testing, use the **Smoke Test** (see README).

## Security Notes

- **Tailscale-only:** Jarvis only supports private networks (Tailscale, LAN). Do not expose it to the public Internet.
- **Full shell access:** The PWA provides full terminal access to the laptop user's shell. Treat it as a privileged interface.
- **No credential isolation:** Jarvis reuses existing GitHub CLI credentials; it does not manage or store them.
- **Local data only:** All data is stored in `~/.jarvis` on the laptop; nothing is synced to the cloud.

For additional security, consider:
- Restricting which Tailnet members can access Jarvis (Tailscale ACLs).
- Using device revocation if your phone is lost.
- Regularly backing up `~/.jarvis` to an encrypted external drive.
