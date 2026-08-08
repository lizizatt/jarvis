# Jarvis: Private Mobile Control for Local Developer Agents

Jarvis is a TypeScript control plane that runs on your laptop, exposing a responsive React PWA for remote task management via Tailscale. Server-register local Git checkouts, execute tasks through consented VS Code Copilot workers, stream live transcripts and terminal sessions to a phone, and persist all history locally.

## Architecture

```
┌─ Laptop (Linux/macOS)
│  ├─ Node.js HTTP/WebSocket server (Fastify)
│     ├─ SQLite state store (~/.jarvis/)
│     ├─ VS Code Copilot worker manager (one active task per checkout)
│     ├─ Terminal session bridge (node-pty host)
│     ├─ Git/PR status worker
│     ├─ Web Push sender
│     └─ Read-only preview router (repo HTML)
│  └─ Static web assets (React PWA)
│
└─ Phone (Tailnet-connected)
   └─ Installed PWA (auto-updates, offline support)
      ├─ Repository inventory + task canvas
      ├─ Live event timeline
      ├─ Terminal tab + shell commands
      ├─ Diff + PR status views
      └─ Web Push notifications
```

**Key constraints:**
- Server binds to `127.0.0.1:3210` by default (Tailscale-only access via Serve or local LAN fallback).
- One Copilot task per registered checkout at a time.
- Full shell access is intentional; bind to private networks only.
- Copilot model access remains inside each signed-in VS Code window; Jarvis stores no Copilot credentials.
- PWA requires HTTPS for Web Push and installation (automatic over Tailscale Serve or self-signed over LAN).

## Prerequisites

- **Node.js** ≥ 20.19 (check: `node --version`)
- **npm** (comes with Node.js)
- **VS Code 1.125+** signed into GitHub Copilot, with the local Jarvis Copilot Worker extension installed
- **Tailscale** (optional but recommended for phone access)
  - Install: https://tailscale.com/download
  - Authenticate: `tailscale up`
  - Phone: join the same Tailnet

## How to Spin Up Jarvis

This is the operational runbook for agents and humans bringing up Jarvis from a fresh checkout. Run all repository commands from the Jarvis root.

### First-time installation

1. Install dependencies and verify the checkout:

  ```bash
  npm ci
  npm run lint
  npm run typecheck
  npm test
  ```

2. Build the server, PWA, and VS Code worker:

  ```bash
  npm run build
  ```

3. Package and install the local worker extension:

  ```bash
  cd apps/vscode-worker
  npx --yes @vscode/vsce package \
    --no-dependencies \
    --allow-missing-repository \
    --skip-license \
    -o jarvis-copilot-worker.vsix
  code --install-extension jarvis-copilot-worker.vsix --force
  cd ../..
  ```

  The VSIX is a generated, ignored artifact. Do not add it to Git.

4. Install and start the per-user services:

  ```bash
  bash deploy/systemd/install.sh
  ```

  This installs and enables both `jarvis.service` and `jarvis-terminal-host.service`. It also copies `.env.sample` to `~/.config/jarvis/.env` on first installation.

5. Open each checkout Jarvis should control in its own VS Code window. In each window, run **Jarvis: Connect Copilot Worker** from the Command Palette once. The enabled state persists and the worker reconnects automatically while that window remains open.

6. Register each checkout with the running server:

  ```bash
  npm run repo:add -- /absolute/path/to/checkout "Display Name" main
  ```

7. Optionally expose Jarvis to the same private Tailnet as the phone:

  ```bash
  tailscale serve --bg http://127.0.0.1:3210
  ```

### Normal startup or update

After pulling changes, rebuild and restart both services:

```bash
npm ci
npm run build
systemctl --user restart jarvis-terminal-host jarvis
```

If `apps/vscode-worker` changed, repeat the package/install commands above and reload each registered VS Code window so the new extension host activates. Keep every registered checkout open in a separate VS Code window.

### Verify the deployment

```bash
systemctl --user is-active jarvis jarvis-terminal-host
curl -fsS http://127.0.0.1:3210/api/health
curl -fsS http://127.0.0.1:3210/api/workers
code --list-extensions --show-versions | grep jarvis-local.jarvis-copilot-worker
```

Expected results:

- both services report `active`;
- health returns `{"ok":true,...}`;
- `/api/workers` contains one worker per open registered checkout and a non-empty model list;
- the installed extension is `jarvis-local.jarvis-copilot-worker`;
- `http://127.0.0.1:3210` loads the dashboard locally;
- the Tailscale Serve HTTPS URL loads from a device on the same Tailnet.

Useful recovery commands:

```bash
journalctl --user -u jarvis -n 100 --no-pager
journalctl --user -u jarvis-terminal-host -n 100 --no-pager
systemctl --user restart jarvis-terminal-host jarvis
```

If a repository is missing from `/api/workers`, open that exact checkout as a VS Code workspace, confirm Copilot is signed in, and run **Jarvis: Connect Copilot Worker**. Jarvis intentionally rejects tasks when the matching checkout worker or its model catalog is unavailable.

## Installation & Build

### 1. Clone or navigate to the workspace
```bash
cd ~/jarvis
```

### 2. Install dependencies
```bash
npm ci  # or npm install for development
```

### 3. Build the project
```bash
npm run build
```

This compiles TypeScript in `apps/server` and `apps/web`, producing:
- `apps/server/dist/` — compiled server
- `apps/web/dist/` — built PWA (static assets)

### 4. (Optional) Install as a per-user systemd service

For automatic startup and restart on failure:

```bash
bash deploy/systemd/install.sh
```

This creates `~/.config/systemd/user/jarvis.service` and enables it.

**To uninstall:**
```bash
bash deploy/systemd/uninstall.sh
```

## Running Jarvis

### Manual start (foreground)
```bash
npm run build
npm --workspace @jarvis/server start
```

### Manual start (development mode with auto-reload)
```bash
npm run dev
```
Runs both server and web dev server; open http://127.0.0.1:5173 in your browser (dev mode serves web on Vite port).

### Systemd service (after installation)
```bash
systemctl --user start jarvis
systemctl --user status jarvis
journalctl --user -u jarvis -f  # follow logs
```

## Testing

### Unit and integration tests
```bash
npm test
```

### Type checking
```bash
npm run typecheck
```

### Linting
```bash
npm run lint
```

### Sandbox smoke test

The smoke test verifies core functionality: repository registration, task lifecycle, terminal persistence, and preview routing.

```bash
npm run build

# Start the server (background)
npm --workspace @jarvis/server start &
SERVER_PID=$!

# Wait for server to be ready
sleep 2

# Run smoke test
node tools/sandbox-smoke.mjs

# Cleanup
kill $SERVER_PID
```

**What it tests:**
- Server health endpoint
- Repository registration with validation
- Task startup and child process tracking
- Task stop with full process tree termination
- Event persistence and ordering
- Terminal creation and I/O
- Preview routing and path containment

## Registering a Repository

Repository inventory is managed from the laptop, not the phone. Jarvis does not scan your home directory.

Use the server-side command from this checkout:

```bash
npm run repo:add -- /home/you/src/my-project "My Project" main
```

Arguments are the absolute checkout path, optional display name, and optional main branch. If omitted, the name and current branch are detected. Repositories do not carry agent instructions; the global `JARVIS_POLICY` applies to every task.

The server will:
- Validate the path is a Git repository
- Create a preview landing page at `~/.jarvis/<repo-id>/index.html`
- Add an entry to the SQLite database
- Start watching for status/diff changes

The command calls the loopback server API. For automation, the equivalent request is:

```bash
curl -X POST http://127.0.0.1:3210/api/repositories \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "my-project",
    "path": "/home/you/src/my-project",
    "defaultBranch": "main"
  }'
```

## Starting a Task

After registering a repository:

1. Open the PWA and select the repository
2. Enter your task prompt (e.g., "Add unit tests for the auth module")
3. Click "Start Task"
4. The server launches Copilot in JSONL streaming mode with a stable session UUID in the checkout directory
5. Messages, tool calls, and questions stream to all connected clients in real time
6. Use "Send Message" to reply to the agent or "Stop Task" to terminate it

**Policy reminder:** By default, Jarvis agents must ask you before commit, push, or pull-request operations. Configure this globally with `$JARVIS_POLICY`.

## PWA Installation

### Desktop browser (phone or laptop)
1. Open `http://127.0.0.1:3210` in Chrome/Firefox
2. Look for "Install" prompt (or use browser menu → "Install as app")
3. Once installed, it appears in your app drawer and can work offline (with cached assets)

### Phone (over Tailscale Serve)
1. Enable Tailscale Serve on your laptop:
   ```bash
  tailscale serve --bg http://127.0.0.1:3210
   ```
   This creates a HTTPS endpoint at `https://<laptop-name>.<tailnet-name>.ts.net/`
2. On your phone (same Tailnet):
   - Open Safari/Chrome to `https://<laptop-name>.<tailnet-name>.ts.net/`
   - Install as PWA (browser menu → "Add to Home Screen" or "Install")
3. Once installed, the PWA can receive Web Push notifications

### LAN fallback (for local phone testing without Tailscale)
1. Bind server to your LAN interface (see [Configuration](#configuration))
2. Set up a self-signed certificate (PWA requires HTTPS)
3. On phone, navigate to your laptop's LAN IP (e.g., `https://192.168.1.100:3210`)
4. Accept the certificate warning and install as PWA

**HTTPS requirement:** Web Push and PWA installation only work over HTTPS. Tailscale Serve handles this automatically; for LAN testing, generate a self-signed cert or use a reverse proxy.

## Configuration

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for environment variables, data locations, and advanced options.

**Quick reference:**
- `JARVIS_HOST` — Server bind address (default: `127.0.0.1`)
- `JARVIS_PORT` — Server port (default: `3210`)
- `JARVIS_DATA_DIR` — Persistent data location (default: `~/.jarvis`)
- `JARVIS_AGENT_BACKEND` — `worker` in production; a matching repository window must be open and connected
- `JARVIS_POLICY` — Agent policy text (default: "Work autonomously, but ask…")
- `JARVIS_WEB_ROOT` — Static asset path (default: `apps/web/dist`)

## Data & Backups

**Location:** `~/.jarvis/`

```
~/.jarvis/
├── jarvis.sqlite3          # SQLite database (repositories, tasks, terminals, subscriptions)
├── previews/               # Per-repo landing pages
│  └── <repo-id>/
│     └── index.html
└── <other migrations>      # Reserved for future extensions
```

**Backup strategy:**
1. Stop the server: `systemctl --user stop jarvis` (or Ctrl+C)
2. Compress the database: `tar czf ~/jarvis-backup-$(date +%F).tar.gz ~/.jarvis/`
3. Restore: `tar xzf ~/jarvis-backup-*.tar.gz -C ~/` (after stopping server)

**Never:**
- Edit `jarvis.sqlite3` directly (use the API)
- Delete `~/.jarvis` while the server is running
- Copy `~/.jarvis` to another user or machine (credentials and paths are local)

## Troubleshooting

### Server won't start
- Check `journalctl --user -u jarvis -n 20` for errors
- Verify `JARVIS_DATA_DIR` is writable
- Ensure port `JARVIS_PORT` is not in use: `lsof -i :3210`
- Check Node.js version: `node --version` (must be ≥ 20.19)

### PWA won't install
- Open in a private/incognito window (some browsers block installation)
- Ensure HTTPS is enabled (check browser address bar for 🔒)
- Clear browser cache and try again

### Task hangs or won't stop
- Check server logs: `journalctl --user -u jarvis -f`
- Manually restart: `systemctl --user restart jarvis`
- If task process persists, kill it: `ps aux | grep copilot` and `kill -9 <pid>`

### Preview links don't work
- Verify repository is registered and preview exists: `ls ~/.jarvis/previews/`
- Check preview landing page: `curl http://127.0.0.1:3210/previews/<repo-id>`

### Terminal sessions drop
- Reconnect via PWA (should auto-resume)
- Check `JARVIS_DATA_DIR` for terminal socket: `ls ~/.jarvis/terminal-host.sock`
- Restart server if socket is stale: `systemctl --user restart jarvis`

## Copilot CLI Policy Note

The `copilot` CLI is controlled by GitHub's Acceptable Use Policy. Jarvis passes your policy text to the CLI at task startup but does **not** override the CLI's built-in enforcement. If the CLI denies an operation (e.g., "This action is not permitted by your organization"), the task will report the error; Jarvis cannot force approval.

**To verify CLI permissions:**
```bash
# Test the CLI directly
copilot -p "Reply with: Copilot is ready" --allow-all-tools
```

## Development

### Project structure
- `apps/server/src/` — Node.js backend (Fastify, SQLite, CLI adapter, terminal bridge)
- `apps/web/src/` — React PWA frontend (Vite, PWA plugin, service worker)
- `apps/server/src/types.ts` and `apps/web/src/types.ts` — transport-specific server and browser types
- `tools/` — Smoke test and utility scripts
- `deploy/systemd/` — Systemd service template and install scripts

### Running tests in CI
```bash
npm run typecheck --workspaces
npm test --workspaces
npm run build --workspaces
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3210 npm run test:e2e -- --workers=1
```

## License & Support

Jarvis is part of the Saildrone engineering platform. For issues, questions, or contributions, please file an issue or contact your team lead.
