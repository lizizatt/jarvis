# Deployment Guide

This guide covers production deployment of Jarvis on a Linux laptop.

## Quick Start

For most users, automated setup is recommended:

```bash
cd ~/jarvis
bash deploy/systemd/install.sh
```

This will:
1. Verify Node.js, npm, VS Code, and the Jarvis Copilot Worker extension are installed
2. Build the project
3. Create systemd configuration directories
4. Install a per-user systemd service
5. Start the service with auto-restart on failure
6. Display connection info

Then access Jarvis at http://127.0.0.1:3210

## Manual Installation

If you prefer manual control or have a custom setup:

### 1. Install dependencies
```bash
# Ensure these are in PATH:
node --version         # ≥ 20.19
npm --version
code --version
```

### 2. Build the project
```bash
cd ~/jarvis
npm ci
npm run build
```

### 3. Create systemd service (optional)
```bash
bash deploy/systemd/install.sh
```

The installer resolves the current checkout, Node executable, and Copilot tool path before writing the user unit. Do not copy the template directly without replacing its `@@...@@` placeholders.

### 4. Run manually (without systemd)
```bash
npm --workspace @jarvis/server start
```

By default, it listens on http://127.0.0.1:3210

## Configuration

### Environment Variables

Create `~/.config/jarvis/.env` to customize:

```bash
JARVIS_HOST=127.0.0.1          # Bind address (default: localhost)
JARVIS_PORT=3210               # Listen port
# JARVIS_DATA_DIR=/home/you/.jarvis  # Optional; use an absolute path
JARVIS_AGENT_BACKEND=worker      # matching VS Code repository window required
JARVIS_POLICY="..."            # Policy text for agents
```

See [CONFIGURATION.md](../docs/CONFIGURATION.md) for all options.

The systemd service automatically loads `~/.config/jarvis/.env` at startup.

### Network Access

#### Tailscale Serve (recommended)

```bash
tailscale serve --bg http://127.0.0.1:3210
```

Exposes Jarvis to all Tailnet members at `https://<device-name>.<tailnet>.ts.net/`

#### LAN fallback

Set `JARVIS_HOST` to your LAN IP and generate a self-signed certificate:

```bash
JARVIS_HOST=192.168.1.100 npm --workspace @jarvis/server start
```

For HTTPS (required for PWA), use a reverse proxy (nginx, caddy, etc.).

#### Localhost only

Default behavior; PWA features require HTTPS, which is not available on localhost over HTTP.

## Systemd Service

### Status and logs

```bash
# Check status
systemctl --user status jarvis

# View logs
journalctl --user -u jarvis -f

# View last 50 lines
journalctl --user -u jarvis -n 50
```

### Restart

```bash
systemctl --user restart jarvis
```

### Stop

```bash
systemctl --user stop jarvis
```

### View the systemd unit

```bash
systemctl --user cat jarvis
```

## Monitoring

### Health endpoint

```bash
curl http://127.0.0.1:3210/api/health
# { "ok": true, "interruptedOnStartup": false }
```

### Database integrity

```bash
sqlite3 ~/.jarvis/jarvis.sqlite3 "PRAGMA integrity_check;"
```

### Disk usage

```bash
du -sh ~/.jarvis
```

## Backup & Recovery

### Backup

```bash
# Stop the service first
systemctl --user stop jarvis

# Backup the entire data directory
tar czf ~/jarvis-backup-$(date +%Y%m%d).tar.gz ~/.jarvis

# Restart
systemctl --user start jarvis
```

### Restore

```bash
# Stop the service
systemctl --user stop jarvis

# Restore from backup
tar xzf ~/jarvis-backup-*.tar.gz -C ~/

# Restart
systemctl --user start jarvis
```

### Partial recovery

To recover only specific repositories or tasks, use a SQLite client:

```bash
systemctl --user stop jarvis

sqlite3 ~/.jarvis/jarvis.sqlite3

# Inside sqlite3 shell:
.tables
SELECT * FROM repositories;
SELECT * FROM tasks WHERE state = 'stopped';
-- etc.

.quit

systemctl --user start jarvis
```

## Upgrade

### From source

```bash
cd ~/jarvis

# Fetch latest code
git pull

# Rebuild
npm ci
npm run build

# Restart service
systemctl --user restart jarvis
```

### Database migrations

Migrations are applied automatically at startup. No manual action needed.

## Troubleshooting

### Service won't start

```bash
# Check logs
journalctl --user -u jarvis -n 20

# Common causes:
# - Data directory not writable: ls -ld ~/.jarvis
# - Node.js not found: which node (check ExecStart in systemd unit)
# - Port already in use: lsof -i :3210
```

### High CPU usage

```bash
# Check if a task is hung
curl http://127.0.0.1:3210/api/tasks

# View active processes
ps aux | grep "npm\|node\|copilot"

# Restart the service
systemctl --user restart jarvis
```

### Database locked

```bash
# Stop the service
systemctl --user stop jarvis

# Check for stale processes
ps aux | grep "node.*index.js"

# Wait a few seconds, then restart
systemctl --user start jarvis
```

### PWA won't install

- Ensure HTTPS (use Tailscale Serve or a reverse proxy)
- Try in a private/incognito window
- Clear browser cache
- Check browser console for errors

### Agent won't respond

```bash
# Test the CLI directly
copilot -p "Reply with: Copilot is ready" --allow-all-tools

# Check if agent is hung
ps aux | grep copilot
kill -9 <pid>  # If necessary

# Restart the server
systemctl --user restart jarvis
```

## Security Considerations

- **Tailscale-only:** Do not expose Jarvis to the public Internet
- **Full shell access:** The PWA provides unrestricted terminal access to the laptop user
- **Local credentials:** Jarvis uses existing GitHub CLI auth; no credentials are copied
- **Data isolation:** All data stays on the laptop in `~/.jarvis`

## Performance Tuning

### Memory

If running many concurrent tasks, increase the memory limit in the systemd unit:

```bash
# Edit the service
systemctl --user edit jarvis

# Add:
[Service]
MemoryMax=1G

# Restart
systemctl --user restart jarvis
```

### Database

For very large task histories, consider vacuuming the database:

```bash
systemctl --user stop jarvis
sqlite3 ~/.jarvis/jarvis.sqlite3 "VACUUM;"
systemctl --user start jarvis
```

### Network

For LAN-only deployments without Tailscale, disable firewalls selectively:

```bash
# Allow only from your local subnet (example for ufw)
sudo ufw allow from 192.168.1.0/24 to any port 3210
```

## Uninstallation

To remove Jarvis:

```bash
bash deploy/systemd/uninstall.sh
```

This removes the systemd service but preserves:
- `~/.config/jarvis/` (configuration)
- `~/.jarvis/` (data and database)

To completely remove:

```bash
rm -rf ~/.config/jarvis ~/.jarvis
```

## Support

For issues, consult:
- [README.md](../README.md) for user-facing docs
- [CONFIGURATION.md](../docs/CONFIGURATION.md) for environment variables
- `journalctl --user -u jarvis -f` for server logs
- Smoke test: `node tools/sandbox-smoke.mjs` (after building and starting server)
