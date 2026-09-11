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
- `deploy/test-vm`: one-off disposable VM lifecycle evidence pinned to this checkout and its approved source context.
- `tools`: repository registration and smoke-test utilities.

## One-Off VM Evidence Run

`deploy/test-vm/run-gate.sh` is not a reusable release gate. It is pinned to the host checkout at `/home/liz.izatt/jarvis`, the approved source root at `/tmp/jarvis-release-gate-duFf9r/context-v2`, and a gate root matching `/tmp/jarvis-release-gate-*/vm`.

The approved source root must contain `.jarvis-container-context.json` and every source file listed in that manifest. A run writes only its image cache under `<gate-root>/images` and its session files under `<gate-root>/runs/<UTC-timestamp>-<pid>`. The retained session files include host metadata, the tested source-content and omission report, serial output, QEMU diagnostics, and the phase summary; staging data, the seed ISO, containers, and the writable VM overlay are removed.

The container reference is only a lookup key. The script inspects it once, uses the resulting immutable image ID for container creation, and validates source bytes present in the image against the approved context. When supplied, `JARVIS_VM_GATE_EXPECTED_IMAGE_ID` adds an exact image-ID check. The script must not read `~/.jarvis`, Copilot or editor session storage, or host Jarvis services. Because the payload has no actual older revision, successful execution is partial lifecycle evidence, not a full release result.

## Validation

Run commands from the repository root unless noted.

| Changed area | First check |
| --- | --- |
| `apps/server` | `npm test --workspace @jarvis/server` |
| `apps/web` | `npm test --workspace @jarvis/web` |
| `apps/vscode-worker` | `npm run typecheck --workspace jarvis-copilot-worker` |
| `deploy/test-vm` | `deploy/test-vm/test.sh`; do not launch `run-gate.sh` as routine validation |
| docs/config/scripts | inspect the diff and run the command or parser affected |

Before handing off a code change, run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

The root suite runs server and web Vitest tests plus the worker's VS Code-hosted tests. Worker tests download/use a test VS Code instance and may require a graphical or headless display. `npm run test:e2e` builds the web app and starts an isolated fixture server that uses a local agent fixture, so it does not consume Copilot tokens. To target an external deployment, explicitly set both `PLAYWRIGHT_BASE_URL` and `PLAYWRIGHT_ALLOW_EXTERNAL=true`; those tests create tasks and terminal sessions on that deployment.

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
systemctl --user is-active jarvis
systemctl --user is-active jarvis-terminal-host
curl -fsS http://127.0.0.1:3210/api/health
curl -fsS http://127.0.0.1:3210/api/readiness
curl -fsS http://127.0.0.1:3210/
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
