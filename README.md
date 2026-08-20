# Jarvis

Jarvis is a local developer control plane: a Fastify server, React PWA, terminal host, and VS Code Copilot worker. It lets a phone on the same Tailnet supervise agent tasks in explicitly registered Git checkouts.

## Trust Boundary

- The server binds to `127.0.0.1:3210` by default. Use Tailscale Serve for phone access; do not expose Jarvis to the public Internet.
- The terminal and worker run with the desktop user's permissions. Registered repositories and their previews are trusted content.
- Copilot authentication stays in VS Code. Jarvis stores task state locally under `~/.jarvis`, not Copilot credentials.
- One agent task may run per registered checkout. The matching checkout must be open in a connected VS Code window.

## Components

```text
apps/server         Fastify API, SQLite, Git/previews, worker routing, terminal host
apps/web            React/Vite installable PWA
apps/vscode-worker  VS Code extension using the public Language Model API
deploy/systemd      Per-user service installer and unit templates
tools               Repository registration and smoke-test utilities
```

Production uses three user services:

- `jarvis.service` serves the API and built PWA.
- `jarvis-terminal-host.service` owns persistent PTY sessions.
- `jarvis-jam-assistant.service` runs the Jam Assistant Vite server on localhost:4173 and manages its private Tailscale Serve endpoint.

## Start Here

- New installation: [Getting Started](docs/GETTING_STARTED.md)
- Agent and contributor workflow: [AGENTS.md](AGENTS.md)
- Builds, services, backup, and recovery: [Deployment](docs/DEPLOYMENT.md)
- Environment variables: [Configuration](docs/CONFIGURATION.md)
- Phone installation: [PWA Mobile Setup](docs/PWA_MOBILE_SETUP.md)
- Worker behavior and release: [VS Code Worker](apps/vscode-worker/README.md)

## Development

Requirements: Node.js 20.19 or newer, npm, VS Code 1.125 or newer, and GitHub Copilot access in VS Code.

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Run the development server and Vite UI together:

```bash
npm run dev
```

The production server serves `apps/web/dist`; rebuilding web assets changes what it serves without rebuilding the server. See [AGENTS.md](AGENTS.md) for scoped test and release commands.

## Visual Verification

For UI changes, walk every page in a mobile viewport and screenshot it with the Playwright browser tools: Dashboard (`/`), each Repository Detail tab (Agent, Changes, Terminal, Preview), Task History, Settings, and System Detail. Set the viewport to a phone size (e.g. 390x844), navigate to each route, and compare the screenshot against the intended design before calling a visual fix done.

## Repository Registration

Jarvis does not scan the filesystem. With the server running:

```bash
npm run repo:add -- /absolute/path/to/checkout "Display Name" main
```

Open that checkout in its own VS Code window and run **Jarvis: Connect Copilot Worker**. A task is accepted only when the canonical registered path matches an advertised workspace root.

## Health

```bash
systemctl --user is-active jarvis jarvis-terminal-host jarvis-jam-assistant
curl -fsS http://127.0.0.1:3210/api/health
curl -fsS http://127.0.0.1:4173/
curl -fsS http://127.0.0.1:3210/api/workers
```

`/api/health` checks the server. `/api/workers` separately shows whether registered VS Code windows and model catalogs are available.
