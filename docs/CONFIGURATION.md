# Configuration

The systemd services load `~/.config/jarvis/.env`. For foreground development, export variables in the shell before starting the server. `EnvironmentFile` values do not expand `${HOME}`; use absolute paths.

## Runtime Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `JARVIS_HOST` | `127.0.0.1` | Server bind address. Keep localhost when using Tailscale Serve. |
| `JARVIS_ALLOW_INSECURE_NETWORK` | unset | Must be `true` to bind outside loopback. Direct LAN/public binds have no Jarvis authentication; prefer Tailscale Serve. |
| `JARVIS_PORT` | `3210` | Server port. |
| `JARVIS_DATA_DIR` | `~/.jarvis` | SQLite database, previews, and terminal socket. |
| `JARVIS_AGENT_BACKEND` | `worker` | `worker` requires a matching connected VS Code window; `cli` runs the configured executable; `auto` prefers a worker and falls back to CLI. |
| `JARVIS_AGENT_EXECUTABLE` | `copilot` | Executable used only by `cli` or `auto` fallback. |
| `JARVIS_POLICY` | built-in commit/push approval policy | Additional plain text sent to every agent task. Jarvis does not enforce it. |
| `JARVIS_AGENT_INSTRUCTIONS_FILE` | checkout `AGENTS.md` | Framework instructions supplied to Jarvis-invoked agents. Use an absolute path to override. |
| `JARVIS_WEB_ROOT` | `apps/web/dist` | Built PWA assets served by the server. |
| `JARVIS_TERMINAL_HOST_SCRIPT` | built server terminal host | Override only for a custom distribution. |
| `JARVIS_TAILSCALE_EXECUTABLE` | `tailscale` | Executable used by General settings to expose local ports to the Tailnet. |
| `JARVIS_JAM_ASSISTANT_ROOT` | `~/scratch-2/jam_assistant` | Jam Assistant checkout supervised by `jarvis-jam-assistant`. |
| `JARVIS_JAM_ASSISTANT_HOST` | `127.0.0.1` | Local-only Jam Assistant bind address. |
| `JARVIS_JAM_ASSISTANT_PORT` | `4173` | Local Jam Assistant Vite port. Strictly enforced; Vite never falls back to another port. |
| `JARVIS_JAM_ASSISTANT_TAILSCALE_PORT` | `4173` | Tailnet-only HTTPS Serve port managed by the Jam Assistant service. |
| `JARVIS_MAX_JSON_LINE_BYTES` | `1048576` | Maximum JSON-encoded task event size. |
| `JARVIS_MAX_STDERR_CHUNK_BYTES` | `65536` | Maximum buffered agent stderr chunk. |

The installed service explicitly sets `JARVIS_AGENT_BACKEND=worker`; the Copilot CLI is not a production prerequisite. If choosing `auto` or `cli`, verify the executable and its authentication separately.

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

The installer also supervises Jam Assistant at `http://127.0.0.1:4173` and configures the private Tailscale Serve endpoint `https://<tailnet-host>:4173/`. It changes only the 4173 Serve mapping; the existing Jarvis HTTPS mapping on port 443 remains untouched. It never enables Tailscale Funnel.

## Apply Changes

```bash
systemctl --user restart jarvis-terminal-host jarvis
systemctl --user is-active jarvis jarvis-terminal-host
curl -fsS http://127.0.0.1:3210/api/health
```

When changing `JARVIS_DATA_DIR`, both services must receive the same value or they will use different terminal socket paths.
