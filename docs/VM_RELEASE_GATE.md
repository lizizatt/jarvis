# Disposable VM release gate

This is the release gate for real per-user systemd behavior. It is a procedure, not a provisioning script. Run it only in a disposable VM; mocks, containers, and the isolated runner do not complete this gate.

## Safety boundary

Use a fresh Linux VM with a functioning systemd user manager, Node.js 20.19 or newer, npm, Git, and curl. Take a VM snapshot before the run. Use a dedicated unprivileged user and a reviewed copy of the candidate source. Do not attach host home directories, editor state, service sockets, credentials, SSH agents, container sockets, or production data. Keep Jarvis and all fixture health endpoints on loopback.

Record the VM image/version, Node and npm versions, candidate Git revision plus `git status --short`, and the time of the run. The VM must be destroyed or reverted after evidence is collected.

## Fixture contract

Prepare two disposable managed projects inside the VM. Each needs an executable runner and a version 1 `jarvis.deployment.json` with a unique lowercase ID, a `jarvis-<id>.service` unit, loopback health URL, and supported actions. At least one fixture must support these controlled modes:

- Normal start and health response.
- A build command that can be made to fail before publication.
- Startup without a health response.
- A 15-20 second stop or restart, below the managed unit's 30-second stop allowance.
- A unit rename while retaining the same deployment ID.

Do not reuse a real managed project. Keep fixture ports distinct from `3210`, and preserve the fixture source until the uninstall-source-removal phase.

## 1. Preflight

From the candidate checkout, record the baseline and run copied validation:

```bash
node --version
npm --version
git status --short
npm ci
npm run validate:isolated:full
```

The extension-host suite may be `UNAVAILABLE`; record that separately. Any other failure blocks the VM gate.

Confirm no prior Jarvis units or state exist for the VM user. If they do, revert the VM instead of cleaning an unknown installation by hand.

## 2. Fresh core installation

Install the core services with no managed projects:

```bash
bash deploy/systemd/install.sh --core-only
```

Run each check separately and retain its output:

```bash
systemctl --user is-enabled jarvis.service
systemctl --user is-enabled jarvis-terminal-host.service
systemctl --user is-active jarvis.service
systemctl --user is-active jarvis-terminal-host.service
curl -fsS http://127.0.0.1:3210/api/health
curl -fsS http://127.0.0.1:3210/api/readiness
curl -fsS http://127.0.0.1:3210/
curl -fsS http://127.0.0.1:3210/api/workers
```

Require both units to be enabled and active, health and readiness to return `ok: true`, and the root request to return the PWA HTML. An empty worker list is a separate capability result, not a core installation failure.

## 3. Managed installation and upgrade

Install both absolute fixture manifests in one invocation. Verify each unit independently and probe each declared health URL. Save copies or hashes of `~/.config/jarvis/deployments.json`, `effective.env`, `self.deployment.json`, and all Jarvis unit files.

Update the candidate checkout to the intended upgrade revision without changing the manifest arguments, then run the installer with no arguments. Verify that the installed managed selection is preserved, all expected units are active, readiness remains true, and the registry contains version 2 snapshots with the original manifest paths as provenance.

## 4. Preparation and activation failures

Enable the second fixture's failing build mode and explicitly reinstall both manifests. Require a nonzero installer exit before service actions. Compare the saved registry, environment, runner, and unit files byte-for-byte; they must remain unchanged, and the prior services must remain healthy.

Restore the build, then enable the fixture's unhealthy-start mode. Run the installer and require a bounded nonzero result that names the failed unit or health URL. Capture the published registry/unit state and journals. This phase verifies diagnosability, not atomic rollback of arbitrary project assets. Restore normal mode, rerun the installer, and require all health checks to recover.

## 5. Rename and removal

Change one fixture's unit from `jarvis-<id>.service` to another valid `jarvis-<name>.service`, then explicitly install the complete desired manifest list. Require the old tracked unit to be stopped, disabled, and removed while the replacement is enabled, active, and healthy.

Install again with only one fixture manifest. Require the omitted fixture's tracked unit to be retired. Any unrelated user unit must remain untouched. Confirm `retiringUnits` is empty after successful recovery and that no stale Jarvis managed unit files remain.

## 6. Slow action

Enable the fixture's 15-20 second action mode and invoke its API action:

```bash
curl -fsS -X POST -H 'content-type: application/json' \
  -d '{"action":"restart"}' \
  http://127.0.0.1:3210/api/deployments/<fixture-id>/actions
```

Require the request to remain pending until systemd completes and then return success within the configured 45-second action budget. Verify health after completion. Repeat with a delay beyond the configured budget and require HTTP 504; inspect systemd state before retrying because the queued job may still complete.

## 7. Reboot

Reboot the disposable VM. After logging back in, require both core units and every selected managed unit to be enabled, active, and healthy without rerunning the installer. Recheck liveness, readiness, PWA HTML, terminal creation, and managed health endpoints. Record the current-boot journals for every tested unit.

## 8. Uninstall without managed source

After confirming the installed registry is version 2, remove or move the fixture source directories inside the VM. Run:

```bash
bash deploy/systemd/uninstall.sh
```

Answer the interactive confirmation with `y`. Require core, managed, and pending-retirement unit files to be absent and not active after daemon reload. Configuration and `~/.jarvis` data should remain, as documented. No source manifest may be needed to complete the uninstall.

## Evidence and result

The gate passes only when every phase above has command output, relevant journal excerpts, and an explicit pass result. Record failures without repairing the candidate in place; revert the VM, update the source normally, and start a fresh run.

Use these result labels:

- `PASS`: every real-systemd phase completed on the recorded candidate.
- `FAIL`: a phase produced incorrect behavior.
- `UNAVAILABLE`: no suitable disposable VM or user-manager environment was available.
- `NOT RUN`: the procedure was not attempted.

Until a run is recorded as `PASS`, deployment hardening is fixture-validated but not deployment-verified. Real VS Code/Copilot authentication and extension installation are outside this gate and need their own approved manual check.
