# Configuration

Installed services load the operator-owned `~/.config/jarvis/.env`, followed by generated `~/.config/jarvis/effective.env`. For foreground development, export variables in the shell before starting the server. `EnvironmentFile` values do not expand `${HOME}`; use absolute paths.

The installer resolves `JARVIS_HOST`, `JARVIS_PORT`, `JARVIS_DEPLOYMENT_REGISTRY`, and `JARVIS_ALLOW_INSECURE_NETWORK` with this precedence: current installer environment, `.env`, prior generated effective values, then defaults. It writes the result to `effective.env` so the installer probe, server, terminal host, managed services, and self-health manifest agree. Do not edit that generated file. Change `.env` and rerun the installer; `.env` itself and systemd drop-ins are not overwritten.

For those four keys, the installer accepts one-line systemd assignments with an unquoted, single-quoted, or double-quoted value. It rejects unsupported forms such as `export KEY=value` instead of shell-sourcing the file. Other `.env` keys remain systemd-owned and are not interpreted by the installer.

Uninstall treats the generated `effective.env` registry path as installed inventory. A newer shell or `.env` value is pending configuration until a successful install publishes a new effective file, so it cannot redirect removal of the currently installed units.

`JARVIS_BUILD_PATH` is an installer-process override, not a runtime service setting. It defaults to the caller's PATH and must contain only non-empty absolute directory entries. Managed build commands use it, while generated units keep the separately constructed restricted service PATH.

## Runtime Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `JARVIS_HOST` | `127.0.0.1` | Server bind address. Keep localhost when using Tailscale Serve. |
| `JARVIS_ALLOW_INSECURE_NETWORK` | unset | Must be `true` to bind outside loopback. Direct LAN/public binds have no Jarvis authentication; prefer Tailscale Serve. |
| `JARVIS_PORT` | `3210` | Server port. |
| `JARVIS_DEPLOYMENT_REGISTRY` | `~/.config/jarvis/deployments.json` | Absolute path to the installed v2 snapshot and managed-unit inventory. |
| `JARVIS_DATA_DIR` | `~/.jarvis` | SQLite database, previews, and terminal socket. |
| `JARVIS_AGENT_BACKEND` | `worker` | `worker` requires a matching connected VS Code window; `cli` runs the configured executable; `auto` prefers a worker and falls back to CLI. |
| `JARVIS_AGENT_EXECUTABLE` | `copilot` | Executable used only by `cli` or `auto` fallback. |
| `JARVIS_EDITOR_EXECUTABLE` | `code` | VS Code executable used to open a repository's Copilot worker from the mobile UI. |
| `JARVIS_POLICY` | built-in commit/push approval policy | Additional plain text sent to every agent task. Jarvis does not enforce it. |
| `JARVIS_AGENT_INSTRUCTIONS_FILE` | checkout `AGENTS.md` | Framework instructions supplied to Jarvis-invoked agents. Use an absolute path to override. |
| `JARVIS_WEB_ROOT` | `apps/web/dist` | Built PWA assets served by the server. |
| `JARVIS_TERMINAL_HOST_SCRIPT` | built server terminal host | Override only for a custom distribution. |
| `JARVIS_TAILSCALE_EXECUTABLE` | `tailscale` | Executable used by General settings to expose local ports to the Tailnet. |
| `JARVIS_DEPLOYMENT_ACTION_TIMEOUT_MS` | `45000` | Synchronous timeout for managed `start`, `stop`, and `restart` actions. Must be an integer from `1` through Node's timer ceiling of `2147483647` milliseconds; keep it above the managed unit's 30-second stop allowance. |
| `JARVIS_JAM_ASSISTANT_ROOT` | `~/scratch/jam_assistant` | Jam Assistant checkout supervised by `jarvis-jam-assistant`. |
| `JARVIS_JAM_ASSISTANT_HOST` | `127.0.0.1` | Local-only Jam Assistant bind address. |
| `JARVIS_JAM_ASSISTANT_PORT` | `4173` | Local Jam Assistant Vite port. Strictly enforced; Vite never falls back to another port. |
| `JARVIS_JAM_ASSISTANT_TAILSCALE_PORT` | `4173` | Tailnet-only HTTPS Serve port managed by the Jam Assistant service. |
| `JARVIS_MAX_JSON_LINE_BYTES` | `1048576` | Maximum JSON-encoded task event size. |
| `JARVIS_MAX_STDERR_CHUNK_BYTES` | `65536` | Maximum buffered agent stderr chunk. |

The installed service explicitly sets `JARVIS_AGENT_BACKEND=worker`; the Copilot CLI is not a production prerequisite. If choosing `auto` or `cli`, verify the executable and its authentication separately.

Deployment status commands retain a 10-second timeout. Managed actions wait synchronously for their separate 45-second default budget so a valid 10-to-30-second stop is not reported as a failure. `JARVIS_DEPLOYMENT_ACTION_TIMEOUT_MS` accepts integers from `1` through `2147483647`; larger values are rejected instead of being clamped to a 1-millisecond Node timer. A timeout returns HTTP 504; other command errors retain their command diagnostic. Fully asynchronous actions would require job-state tracking in both the API and UI and are not implemented.

## Policy and Repository Instructions

- `JARVIS_AGENT_INSTRUCTIONS_FILE` supplies the framework-level operating contract, normally this repository's [AGENTS.md](../AGENTS.md).
- A target checkout's own instruction files govern work in that checkout.
- `JARVIS_POLICY` appends operator preferences shared by all tasks.

None of these strings creates a security boundary. The worker and terminal have the desktop user's filesystem and process permissions.

## Data

The default layout is:

```text
~/.jarvis/
  jarvis.sqlite3
  previews/<repository-id>/index.html
  terminal-host.sock
```

Repository paths are unique and one task may be active per repository. Treat the database as server-owned; stop both services before backup or manual repair.

## Network

For phone access, leave the server on localhost and use:

```bash
tailscale serve --bg http://127.0.0.1:3210
```

This supplies HTTPS required by PWA installation and Web Push. A LAN bind needs a separate trusted TLS reverse proxy. Never publish Jarvis to the public Internet: it exposes repository content and a shell running as the desktop user.

Managed deployments are installed only when their manifest paths are selected explicitly or their installed snapshots are preserved from registry v2. Changing the registry path without a new selection copies the prior installed selection to the new path. Source manifest changes take effect only when those paths are selected explicitly again. Any Tailnet behavior belongs to the selected deployment; the core installer does not require Tailscale or enable Funnel.

## Apply Changes

```bash
systemctl --user restart jarvis-terminal-host jarvis
systemctl --user is-active jarvis
systemctl --user is-active jarvis-terminal-host
curl -fsS http://127.0.0.1:3210/api/health
curl -fsS http://127.0.0.1:3210/api/readiness
curl -fsS http://127.0.0.1:3210/
```

`/api/health` is process liveness. In the installed configuration, `/api/readiness` requires the built web entry and a connectable terminal-host socket; it deliberately does not require a VS Code worker. When changing `JARVIS_DATA_DIR`, both services must receive the same value or they will use different terminal socket paths.
