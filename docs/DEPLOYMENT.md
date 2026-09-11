# Deployment

Jarvis is deployed from the checkout as per-user systemd services. Jarvis and its terminal host are core units; project-owned manifests can declare additional managed deployments. Build output is local and ignored by Git.

## First Installation

Follow [Getting Started](GETTING_STARTED.md). A fresh no-argument install writes units under `~/.config/systemd/user`, copies `.env.sample` to `~/.config/jarvis/.env` when absent, builds Jarvis, and starts only the two core services. Tailscale and the Copilot CLI are not installer prerequisites.

Pass zero or more absolute manifest paths to select managed deployments. Positional paths replace the full prior selection; `--core-only` explicitly selects none. With no selection argument, the installed managed snapshots are preserved, including when `JARVIS_DEPLOYMENT_REGISTRY` moves to a new path. The legacy `JARVIS_JAM_ASSISTANT_MANIFEST` and `JARVIS_ALESIS_MANIFEST` variables remain supported only when explicitly set and no positional paths are supplied.

Each project owns a `jarvis.deployment.json` and executable runner. An explicit selection validates and builds every selected project, then records version 2 registry entries containing the validated manifest definitions and their source paths as provenance. Runtime deployment listing and actions use those snapshots rather than reopening source manifests. An existing version 1 path registry is migrated automatically during installation; its source manifests must remain readable for that one migration. During migration, the validated installed `deployments.tsv` supplies the old unit names, so edits to source manifests cannot redirect retirement. Invalid, duplicate, or core unit names in that legacy inventory abort installation before publication or service changes.

The installer stages the effective environment, self manifest, runner, registry, index, and all unit files. It publishes them only after the Jarvis build and every required managed build succeed. Publication keeps recovery metadata and restores previous files if a later destination fails. Publication destinations are canonicalized through existing symlink parents and may not overlap each other, `install-publication.json`, or its backup directory. The files are replaced individually rather than as one filesystem-wide atomic operation, and systemd activation follows publication.

Managed build commands run in their project directories with the caller's PATH. Set `JARVIS_BUILD_PATH` for an explicit build-only PATH; every entry must be a non-empty absolute directory. This path is validated separately and is never copied into generated service units, which retain the restricted runtime PATH. If a build overwrites assets used by a running service, the installer cannot roll those assets back; versioned release artifacts and atomic application activation remain a separate packaging concern.

On an explicit removal or unit rename, only unit names recorded in the previous installed inventory are retired. A retiring unit may be stopped and disabled before replacement activation to avoid a port conflict, but its file and retirement record remain until replacement readiness succeeds. If preparation, activation, or readiness fails, the installer disables the conflicting replacement and re-enables and restarts each old unit that was active before the attempt. The retained pending record makes a later installer run retry the retirement. The core `jarvis.service` and `jarvis-terminal-host.service` names are reserved and cannot be claimed or retired as managed units.

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
systemctl --user is-active jarvis
systemctl --user is-active jarvis-terminal-host
curl -fsS http://127.0.0.1:3210/api/health
curl -fsS http://127.0.0.1:3210/api/readiness
curl -fsS http://127.0.0.1:3210/
curl -fsS http://127.0.0.1:3210/api/workers
code --list-extensions --show-versions | grep jarvis-local.jarvis-copilot-worker
```

Check every required unit with a separate `is-active` invocation; an aggregate invocation can succeed when only one named unit is active. `/api/health` is liveness. `/api/readiness` checks that static web routes were installed with an available entry and that the terminal host answers a bounded protocol probe, without starting either component. The root request proves the PWA is actually served. Worker availability remains a separate capability; check `/api/workers` after server or worker changes.

Managed service actions wait synchronously for up to 45 seconds by default, separately from the 10-second status-command timeout. Configure `JARVIS_DEPLOYMENT_ACTION_TIMEOUT_MS` with an integer from `1` through `2147483647` if a supported service needs a larger budget. Keep it above the managed unit's 30-second stop allowance. A timed-out API request returns HTTP 504, but systemd may still complete an already-enqueued job; inspect deployment state before retrying.

For failures:

```bash
journalctl --user -u jarvis -n 100 --no-pager
journalctl --user -u jarvis-terminal-host -n 100 --no-pager
```

Run separate status, health, and journal checks for each selected managed manifest. The installer performs these checks in a bounded loop and identifies every inactive unit or failed liveness, readiness, PWA, and managed-health probe.

The readiness probe captures the response body and HTTP status with curl's long-standing `--output` and `--write-out` options. Installation does not require curl 7.76's `--fail-with-body` option.

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
```

If `apps/vscode-worker` changed, reinstall it and reload registered windows as described above.

## Configuration

The services load `~/.config/jarvis/.env` and the installer's generated `effective.env`. See [Configuration](CONFIGURATION.md) before changing installation-coordinated values.

## Backup and Restore

Stop both services before copying live state:

```bash
systemctl --user stop jarvis jarvis-terminal-host
tar czf "$HOME/jarvis-backup-$(date +%Y%m%d).tar.gz" -C "$HOME" .jarvis
systemctl --user start jarvis-terminal-host jarvis
```

To restore, stop both services, replace `~/.jarvis` from a trusted backup, then start the terminal host before Jarvis. Database schema updates run at server startup.

## Uninstall

```bash
bash deploy/systemd/uninstall.sh
```

The uninstall script removes the core services and all managed or pending-retirement units recorded in registry v2. It takes the installed registry path from generated `effective.env`; unapplied shell or `.env` changes cannot redirect uninstall. Shell and `.env` registry values are consulted only for legacy installations without an effective registry value. The script does not need the managed projects or their source manifests to remain present. Configuration and `~/.jarvis` data are retained unless removed separately. A legacy v1 registry still requires readable source manifests; run the installer once to migrate it before removing those sources.
