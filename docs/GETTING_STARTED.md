# Getting Started

Run repository commands from the Jarvis root.

## Prerequisites

- Node.js 20.19 or newer and npm
- VS Code 1.125 or newer, with the `code` CLI in `PATH`
- GitHub Copilot signed in within VS Code
- Tailscale on the laptop and phone for private remote access

The normal backend is the VS Code worker. The Copilot CLI is not required.

## Install

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run install:local --workspace jarvis-copilot-worker
bash deploy/systemd/install.sh
```

The worker install creates an ignored VSIX, installs it locally, and leaves the artifact under `apps/vscode-worker`. Do not commit it.

The systemd installer builds Jarvis, creates `~/.config/jarvis/.env` on first use, and enables both user services. It does not install or reload the VS Code extension.

## Connect a Checkout

1. Open the checkout in its own VS Code window.
2. Reload that window after installing or updating the worker extension.
3. Run **Jarvis: Connect Copilot Worker** from the Command Palette.
4. Register the checkout:

```bash
npm run repo:add -- /absolute/path/to/checkout "Display Name" main
```

5. Confirm the worker and model list are present:

```bash
curl -fsS http://127.0.0.1:3210/api/workers
```

Repository-local `AGENTS.md` files govern work in that checkout. `JARVIS_POLICY` is additional text sent to every Jarvis task; it is guidance, not a permission boundary.

## Phone Access

Keep Jarvis bound to localhost and publish it only to the private Tailnet:

```bash
tailscale serve --bg http://127.0.0.1:3210
```

Open the resulting HTTPS URL on the phone and install the PWA. See [PWA Mobile Setup](PWA_MOBILE_SETUP.md) for browser-specific steps.

## Verify

```bash
systemctl --user is-active jarvis jarvis-terminal-host
curl -fsS http://127.0.0.1:3210/api/health
curl -fsS http://127.0.0.1:3210/api/workers
code --list-extensions --show-versions | grep jarvis-local.jarvis-copilot-worker
```

Both services should report `active`; health should return `ok: true`; and each usable repository should appear in `/api/workers` with at least one model.

## Next Steps

- [Agent workflow and validation](../AGENTS.md)
- [Deployment and recovery](DEPLOYMENT.md)
- [Configuration](CONFIGURATION.md)