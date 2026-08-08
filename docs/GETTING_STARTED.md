# Getting Started with Jarvis

This quick-start guide walks you through installation, configuration, and first use of Jarvis.

## 5-Minute Setup

### 1. Verify Prerequisites

```bash
# Check all required tools are installed
node --version      # Must be ≥ 20.19
npm --version
gh --version        # GitHub CLI
copilot --version   # Copilot CLI plugin

# Test GitHub authentication
gh auth status
copilot -p "Reply with: Copilot is ready" --allow-all-tools
```

### 2. Install Jarvis as a Service

```bash
cd ~/jarvis
bash deploy/systemd/install.sh
```

This script:
- Builds the project
- Creates systemd configuration
- Starts the service with auto-restart on failure
- Displays the access URL

### 3. Open Jarvis

```bash
# On your laptop, open in a browser:
http://127.0.0.1:3210
```

You should see the Jarvis dashboard. Repository inventory is configured on the laptop.

### 4. Register a Repository

From the Jarvis checkout on the laptop, register the Git root and its main branch:

```bash
npm run repo:add -- /home/you/src/my-project "My Project" main
```

Refresh the dashboard and confirm the server-managed repository appears.

### 5. Connect Repository Workers

Open each registered repository in its own VS Code window and run **Jarvis: Connect Copilot Worker** once. The enabled state persists for that window profile.

### 6. Start a Task

Click the repository, then:
1. Enter a task prompt (e.g., "Add unit tests for the auth module")
2. Click "Start Task"
3. Watch the agent respond in real time

### 6. (Optional) Set Up Phone Access

On your laptop:
```bash
tailscale up        # Join your Tailnet
tailscale serve --bg http://127.0.0.1:3210
```

Then on your phone (same Tailnet):
1. Open `https://<laptop-name>.<tailnet>.ts.net/` in a browser
2. Tap "Install" or "Add to Home Screen" → "Install"
3. Open from your app drawer; it will receive push notifications

---

## Next Steps

- **Configuration:** See [CONFIGURATION.md](./CONFIGURATION.md) for env vars and advanced options
- **Deployment:** See [DEPLOYMENT.md](./DEPLOYMENT.md) for production setup and monitoring
- **Mobile:** See [PWA_MOBILE_SETUP.md](./PWA_MOBILE_SETUP.md) for phone installation and troubleshooting
- **API:** See [README.md](../README.md) for full API endpoint list and architecture

---

## Common Tasks

### Check Server Status

```bash
systemctl --user status jarvis
journalctl --user -u jarvis -f  # Follow logs
```

### Stop or Restart

```bash
systemctl --user restart jarvis
systemctl --user stop jarvis
```

### View Registered Repositories

```bash
curl http://127.0.0.1:3210/api/repositories | jq
```

### Change Agent Policy

Edit `~/.config/jarvis/.env`:
```bash
JARVIS_POLICY="Ask before any write operations."
```

Then restart:
```bash
systemctl --user restart jarvis
```

### Backup Your Data

```bash
tar czf ~/jarvis-backup.tar.gz ~/.jarvis
```

### Uninstall Jarvis

```bash
bash deploy/systemd/uninstall.sh
# Configuration and data are preserved
```

---

## Troubleshooting

### Server won't start
```bash
journalctl --user -u jarvis -n 20  # Check logs
lsof -i :3210                       # Port in use?
```

### PWA won't install
- Use HTTPS (enable Tailscale Serve or set up reverse proxy)
- Try in a private/incognito window
- Clear browser cache

### Task hangs
```bash
# Check logs
journalctl --user -u jarvis -f

# Restart server
systemctl --user restart jarvis
```

### Can't reach from phone
- Verify Tailnet connection: `tailscale status`
- Verify server is running: `systemctl --user status jarvis`
- Verify Serve is enabled: `tailscale status | grep Serve`

---

## Support

- **Full documentation:** [README.md](../README.md)
- **Architecture & features:** [README.md](../README.md#architecture)
- **Smoke test:** `npm run build && npm run test:e2e --workspace @jarvis/web`
- **API endpoints:** [README.md](../README.md#development)

## Key Concepts

**Repository:** A registered Git checkout on your laptop. Jarvis never modifies repositories; it only watches them.

**Task:** A Jarvis conversation executed by the Copilot worker in the matching open VS Code repository window, with a live transcript and optional terminal access.

**Event:** A message, question, or status change during a task (persisted in SQLite).

**Terminal:** A persistent shell session in a repository, accessible from the PWA.

**Preview:** A read-only, path-contained HTML route serving the repository's own HTML files (e.g., docs, generated reports).

**PWA:** Progressive Web App; installs on your phone like a native app, with offline caching and push notifications.

---

## Example Workflow

1. **Laptop:** Register two repositories
   ```bash
   # Via UI or API
   curl -X POST http://127.0.0.1:3210/api/repositories \
     -H 'Content-Type: application/json' \
     -d '{"name":"Backend","path":"/home/you/backend"}'
   ```

2. **Phone:** Install PWA (via Tailscale Serve)

3. **Phone:** Start a task in one repository
   - Prompt: "Add error handling to the auth endpoint"
   - Agent responds with questions and suggestions

4. **Phone:** Approve a commit
   - Agent asks for permission
   - You tap "Approve"
   - Agent commits and pushes

5. **Laptop:** Check the repository
   - New branch created with agent's changes
   - Task transcript saved in `~/.jarvis/jarvis.sqlite3`

6. **Phone:** Resume the task or start a new one
   - Agent recalls context from the transcript
   - Workflow continues

---

## Architecture at a Glance

```
You (on laptop)
    ↓
Jarvis Server (Node.js + SQLite)
    ├─ Copilot CLI adapter
    ├─ Git status worker
    ├─ Terminal bridge (node-pty)
    ├─ Web Push sender
    └─ Static web assets (React PWA)
    ↓
Jarvis PWA (on phone)
    ├─ Task canvas & chat
    ├─ Terminal tab
    ├─ Diff & PR views
    ├─ Web Push notifications
    └─ Offline support

All connected via:
  - Tailscale (private, encrypted)
  - Local Wi-Fi (LAN)
  - Localhost (laptop only)
```

No data leaves your laptop. No cloud accounts. No credentials stored in Jarvis.

---

## Security Reminders

- **Bind to private networks only** (Tailscale, LAN, localhost)
- **Full shell access is intentional** — the PWA mirrors your laptop's permissions
- **Credentials are not copied** — Jarvis uses existing GitHub CLI auth
- **Data is local** — `~/.jarvis` stays on your laptop
- **Device revocation:** If your phone is lost, revoke it from Tailscale ACLs

---

Happy coding! 🚀
