# Deployment

Jarvis is deployed from the checkout and runs as three per-user systemd services: `jarvis`, `jarvis-terminal-host`, and `jarvis-jam-assistant`. Build output is local and ignored by Git.

## First Installation

Follow [Getting Started](GETTING_STARTED.md). The installer writes units under `~/.config/systemd/user`, copies `.env.sample` to `~/.config/jarvis/.env` when absent, builds the checkout, and starts all three services. It expects Jam Assistant at `~/scratch-2/jam_assistant` by default; override with `JARVIS_JAM_ASSISTANT_ROOT`.

Do not copy service templates directly: the installer resolves checkout and executable paths.

## Publish a Local Build

Validate before publishing. See [AGENTS.md](../AGENTS.md) for the full validation suite.

### Web-only change

```bash
npm run build --workspace @jarvis/web
```

The server reads `apps/web/dist` directly; no service restart is needed. Verify the changed screen in a fresh browser/PWA load.

### Server or terminal-host change

```bash
npm run build --workspace @jarvis/server
systemctl --user restart jarvis-terminal-host jarvis
systemctl --user restart jarvis-jam-assistant
```

Restarting the terminal host ends active terminal sessions. Announce that impact before deploying.

### Cross-component change

```bash
npm run build
systemctl --user restart jarvis-terminal-host jarvis
```

### VS Code worker change

```bash
npm run install:local --workspace jarvis-copilot-worker
```

Reload every registered VS Code window; extension installation alone does not replace code in running extension hosts. Reloading interrupts active worker turns. Re-run **Jarvis: Connect Copilot Worker** only if the window does not reconnect automatically.

## Verify

```bash
systemctl --user is-active jarvis jarvis-terminal-host jarvis-jam-assistant
curl -fsS http://127.0.0.1:3210/api/health
curl -fsS http://127.0.0.1:4173/
curl -fsS http://127.0.0.1:3210/api/workers
code --list-extensions --show-versions | grep jarvis-local.jarvis-copilot-worker
```

Health does not prove that workers are connected. Check `/api/workers` after server or worker changes.

For failures:

```bash
journalctl --user -u jarvis -n 100 --no-pager
journalctl --user -u jarvis-terminal-host -n 100 --no-pager
journalctl --user -u jarvis-jam-assistant -n 100 --no-pager
```

Do not use `git checkout`, `git reset`, or source deletion as a deployment rollback. Preserve the worktree, inspect the failure, and deliberately rebuild a known revision only with user approval.

## Update an Existing Installation

After pulling a dependency or full-stack update:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
systemctl --user restart jarvis-terminal-host jarvis
systemctl --user restart jarvis-jam-assistant
```

If `apps/vscode-worker` changed, reinstall it and reload registered windows as described above.

## Configuration

The services load `~/.config/jarvis/.env`. Edit it, then restart both services when shared values such as `JARVIS_DATA_DIR` change. See [Configuration](CONFIGURATION.md).

## Backup and Restore

Stop both services before copying live state:

```bash
systemctl --user stop jarvis jarvis-terminal-host jarvis-jam-assistant
tar czf "$HOME/jarvis-backup-$(date +%Y%m%d).tar.gz" -C "$HOME" .jarvis
systemctl --user start jarvis-terminal-host jarvis-jam-assistant jarvis
```

To restore, stop both services, replace `~/.jarvis` from a trusted backup, then start the terminal host before Jarvis. Database schema updates run at server startup.

## Uninstall

```bash
bash deploy/systemd/uninstall.sh
```

The uninstall script removes the user services. Configuration and `~/.jarvis` data are retained unless removed separately.
