# Jarvis Agent Guide

Jarvis is a local Fastify server, React PWA, terminal host, and VS Code Copilot worker. It streams agent activity to the user and stores task history under `~/.jarvis`.

## Safety

- Work only in the checkout supplied as the task repository root.
- Treat cancellation as final and leave the checkout understandable.
- Never inspect private Copilot chat or extension storage.
- Preserve changes you did not make. Do not use destructive Git commands to clean the tree.
- Ask before commit, push, pull-request creation, service restart, extension installation, or other consequential operations unless the task grants permission.
- Do not commit credentials, `.env` files, `~/.jarvis` state, build output, test output, VSIX files, or VS Code test downloads.
- Jarvis exposes the user's shell and repository files. Keep the server on localhost or a private Tailnet.

## Before Editing

1. Read the owning implementation and its nearest test.
2. Check `git status`; distinguish task changes from pre-existing work.
3. Form one local hypothesis and choose the cheapest command that could disprove it.
4. Make a small edit, run that check, then continue.

Follow instructions in the target repository. `JARVIS_POLICY` adds runtime guidance for every Jarvis task; it does not replace repository-local `AGENTS.md` files or enforce permissions.

## Repository Map

- `apps/server`: Fastify API, SQLite, Git status, previews, worker routing, and terminal host.
- `apps/web`: React/Vite PWA served from `apps/web/dist` in production.
- `apps/vscode-worker`: VS Code extension using the public Language Model API and worker protocol v2.
- `deploy/systemd`: per-user service installer and unit templates.
- `tools`: repository registration and smoke-test utilities.

## Validation

Run commands from the repository root unless noted.

| Changed area | First check |
| --- | --- |
| `apps/server` | `npm test --workspace @jarvis/server` |
| `apps/web` | `npm test --workspace @jarvis/web` |
| `apps/vscode-worker` | `npm run typecheck --workspace jarvis-copilot-worker` |
| docs/config/scripts | inspect the diff and run the command or parser affected |

Before handing off a code change, run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

The root suite runs server and web Vitest tests plus the worker's VS Code-hosted tests. Worker tests download/use a test VS Code instance and may require a graphical or headless display. Playwright does not start the app: run `npm run dev:web` separately, then `npm run test:e2e`, or set `PLAYWRIGHT_BASE_URL` to an existing deployment.

Do not pipe validation through `tail` or similar filters when the exit status could be hidden. Report commands you could not run.

## Local Release

Deploy only after validation and explicit permission. Never revert source to roll back a deployment; preserve the worktree and use Git history deliberately.

| Change | Build and publish | Verify |
| --- | --- | --- |
| Web only | `npm run build --workspace @jarvis/web` | Load the changed screen; health remains available |
| Server or terminal host | `npm run build --workspace @jarvis/server`, then restart both services | Check both services and health |
| Shared/full-stack | `npm run build`, then restart both services | Check both services, health, and workers |
| VS Code worker | `npm run install:local --workspace jarvis-copilot-worker`, then reload each registered VS Code window | Check installed extension version and `/api/workers` |

Use these checks after a service restart:

```bash
systemctl --user is-active jarvis jarvis-terminal-host
curl -fsS http://127.0.0.1:3210/api/health
curl -fsS http://127.0.0.1:3210/api/workers
```

If startup fails, inspect both logs:

```bash
journalctl --user -u jarvis -n 100 --no-pager
journalctl --user -u jarvis-terminal-host -n 100 --no-pager
```

Reloading a VS Code window interrupts its active worker turn. Restarting `jarvis-terminal-host` ends active terminal sessions. State those effects before deploying when users may be active.

## Completion

- Summarize behavior changed, files affected, and validation performed.
- Mention residual risk, unavailable checks, and unrelated failures without fixing them.
- Keep prose direct: preserve non-obvious contracts and safety constraints; remove narration, implementation history, and duplicated claims.
