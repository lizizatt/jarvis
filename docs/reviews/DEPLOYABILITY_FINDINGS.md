# Deployment and configuration review findings

## F1 — Make unrelated deployments optional

**Severity: P1 against the standalone-deployment goal — blocks standalone installation.** The current deployment guide explicitly requires the external checkouts; this is a productization blocker, not a regression from that documented workstation-specific contract.

**Source:** [Installer manifest selection and prerequisites](../../deploy/systemd/install.sh#L18-L42).

**Trigger:** Install on a machine with Jarvis and its core prerequisites, but without Jam Assistant or Alesis checkouts at the configured locations.

**Expected:** Installing Jarvis alone starts its server and terminal host. Additional projects and private remote access are explicit choices.

**Actual:** The installer always requires two additional manifest arguments, defaulting to Jam Assistant and Alesis, and exits if either file is absent. Tailscale executable presence is also unconditional, including for localhost-only use; this check does not establish daemon health or connectivity.

**Impact:** The installation procedure is coupled to the original workstation's project inventory. Redirecting manifest paths does not provide a core-only installation mode.

**Evidence:** The fixed manifest array is checked before the Jarvis build; the prerequisites loop unconditionally checks `tailscale`.

**Remediation:** Default to the Jarvis self manifest and core services. Accept an explicit optional manifest list and make Tailnet setup opt-in. Guard [managed-unit operations](../../deploy/systemd/install.sh#L114-L119) when the list is empty.

**Acceptance check:** With only the Jarvis checkout, installation succeeds without external manifests or Tailscale and issues no operand-less managed-unit commands. Explicitly selected missing manifests still fail before installation changes are published.

## F2 — Derive installation checks from effective configuration

**Severity: P2 — nondefault configurations diverge across components.**

**Source:** [Server configuration](../../apps/server/src/index.ts#L26-L42), [installer registry location](../../deploy/systemd/install.sh#L16), [installer health check](../../deploy/systemd/install.sh#L125-L133), [service environment](../../deploy/systemd/jarvis.service.template#L17-L25), and [self-deployment health URL](../../jarvis.deployment.json#L7).

**Trigger:** Set a nondefault `JARVIS_PORT` in the service environment file, or provide `JARVIS_DEPLOYMENT_REGISTRY` in only one of the installer's shell environment and the service environment file.

**Expected:** The installer verifies the server it configured, and the installed server reads the registry the installer wrote.

**Actual:** The installer probes port 3210 regardless of the configured server port. Independently, [runtime deployment status](../../apps/server/src/deployments.ts#L79-L87) probes the self manifest's fixed port 3210; self manifests are [excluded from the installer's managed health index](../../tools/reconcile-deployments.mjs#L20-L32). A shell-only registry override changes the installation output path without persisting that override into the service configuration. An environment-file-only override changes the server path but not the installer's output path.

**Impact:** A healthy custom-port instance fails installation verification when nothing listens on 3210; an unrelated endpoint answering there can instead produce false success. Deployment health can target the wrong endpoint, and the service can read an absent or stale registry instead of the newly generated one.

**Evidence:** Server settings are read from its process environment; the installer has a literal health URL and does not write its registry override into the service environment.

**Remediation:** Validate one effective installation configuration and derive checks, registry paths, and endpoint instructions from it. Document separately configured clients, including the worker endpoint, repository-registration tool, and development proxy.

**Acceptance check:** A custom-port/custom-registry installation verifies the configured endpoint and lists the installed deployments without requiring undocumented duplicate settings.

## F3 — Finish builds before publishing installation state

**Severity: P2 — a failed update leaves partially published state.**

**Source:** [Registry publication and build ordering](../../tools/reconcile-deployments.mjs#L18-L35), [installer unit generation and reconciliation](../../deploy/systemd/install.sh#L78-L99).

**Trigger:** Reconcile changed installation definitions for multiple managed deployments when a later project's build fails. Byte-identical rewrites do not create a new effective configuration mismatch.

**Expected:** A failed preparation phase preserves the previously installed registry and unit definitions.

**Actual:** The registry is overwritten before managed builds run. Builds and unit-file writes are then interleaved. The installer also rewrites core unit files before invoking reconciliation.

**Impact:** Failure leaves the new registry and some new unit files on disk without completing activation; the deployment index remains old. The server can observe the new registry immediately. Running services retain their previously loaded systemd definitions until reload, so this is not immediate activation of partial units.

**Evidence:** `writeFile(options.registry, ...)` precedes `runBuild(manifest)`; each successfully built managed unit is written before proceeding to the next manifest. Manifest validation and Jarvis's own root build finish before publication; this failure case concerns managed-project builds, not an invalid later manifest.

**Remediation:** Separate validation/build from publication. Stage registry and unit output, finish required builds, then publish with a recoverable activation sequence. Preserve the previous installed configuration on preparation failure. Staging metadata alone does not make project builds atomic if they overwrite live assets.

**Acceptance check:** A deliberately failing second build leaves the previous registry and installed units unchanged. Separately exercise publication and activation failures.

## F4 — Isolate deployment management from mutable source manifests

**Severity: P2 — one broken project disables Jarvis API/UI management of all deployments.**

**Source:** [Deployment listing and action lookup](../../apps/server/src/deployments.ts#L54-L64), [manifest loading](../../apps/server/src/deployments.ts#L106-L129), and [uninstall manifest discovery](../../deploy/systemd/uninstall.sh#L12-L21).

**Trigger:** Move or delete one registered project checkout, or make one source manifest invalid after installation.

**Expected:** Unrelated installed deployments remain visible and controllable; the affected deployment reports an actionable failure.

**Actual:** Listing and every action reload all source manifests through `Promise.all`. Any read or parse failure aborts the whole operation. Source manifest edits can also change the server's deployment definition without regenerating the installed systemd unit.

**Impact:** An unavailable optional project prevents API/UI control of unrelated services, including Jarvis self-restart. Direct systemd control remains available and running units are not automatically stopped. Jarvis management metadata and uninstall inventory depend on source files that may no longer exist. A failed manifest read inside uninstall's process substitution can print an error while the parent script continues with an incomplete unit list and reports completion, leaving undiscovered units installed.

**Evidence:** `list()` and `act()` both call `loadManifests()` before returning status or selecting a target; manifest reads have no per-deployment failure isolation.

**Remediation:** Persist a validated snapshot of installed definitions, retaining source paths as provenance. Reconcile source changes explicitly. Report per-deployment failures without failing unrelated actions, and track installed units independently for uninstallation.

**Acceptance check:** Removing one source manifest does not prevent listing or controlling unrelated installed deployments, and uninstall can still identify the installed units.

## F5 — Verify required capabilities separately from liveness

**Severity: P2 — installation can report success with an unusable UI or terminal.**

**Source:** [Liveness endpoint](../../apps/server/src/app.ts#L43), [conditional static serving](../../apps/server/src/app.ts#L238-L243), [installer verification](../../deploy/systemd/install.sh#L125-L133), and [external terminal-host handling](../../apps/server/src/terminals.ts#L52-L59).

**Trigger:** Select a missing web root in the preserved service environment file, or have the terminal host fail after a successful `Type=simple` restart and remain unavailable during verification. A directly failed restart command or failed root build aborts installation and is not this failure case.

**Expected:** Verification distinguishes a running HTTP server from a usable installed PWA and terminal capability.

**Actual:** `/api/health` provides liveness, not capability readiness. A missing web root silently omits static serving. Installation verification neither loads the PWA nor checks the terminal-host unit/socket. Its aggregate `systemctl is-active` invocation includes Jarvis and managed deployments only, and succeeds when any listed unit is active, not necessarily all of them.

**Impact:** Installation can report success while the UI returns 404 or terminal attachment fails. External terminal attachment retries for approximately five seconds; recovery within that window succeeds.

**Evidence:** The health handler has no capability checks; static registration is conditional on directory existence; the terminal host is absent from the verification unit list.

**Remediation:** Keep liveness simple. Check the served entry page and required terminal-host socket/unit independently, and verify each required unit separately. Report worker/model availability separately so a closed VS Code window does not force a server restart loop. Data access and registry diagnostics are useful follow-on work, not failures established by this finding.

**Acceptance check:** Missing web assets and an unavailable terminal host produce explicit readiness failures while liveness remains independently meaningful.

## F6 — Exclude relative entries from service process PATH

**Severity: P2 — normal optional-tool absence changes executable resolution.**

**Source:** [Installer tool-path construction](../../deploy/systemd/install.sh#L13-L15), [server service PATH](../../deploy/systemd/jarvis.service.template#L20), and [managed-unit PATH rendering](../../tools/reconcile-deployments.mjs#L24-L30).

**Trigger:** Install without the optional Copilot CLI executable in `PATH`, as supported by the normal VS Code worker backend, and without a custom service `PATH` override. An observable collision also requires a descendant to invoke a bare command with a matching executable in the working directory.

**Expected:** Generated services search deliberate absolute executable directories only.

**Actual:** `COPILOT_EXECUTABLE` is empty and `dirname ""` produces `.`. The resulting `TOOL_PATH` is embedded in the server service and prepended to the environment used to generate managed units.

**Impact:** Descendant commands, runner commands, and `/usr/bin/env` shebang lookup can resolve from a service's working directory before later system directories. Initial server and managed-runner `ExecStart` paths are absolute and are not shadowed by this PATH entry. This is a latent executable-resolution hazard, not evidence of an active collision or privilege escalation: services run as the desktop user and project runners are already trusted.

**Evidence:** Tool-path construction does not guard the optional lookup. Managed units receive the reconciler's full inherited `PATH`, not just the Node/Copilot directories. Missing Copilot creates `.`; empty components are a separate possible inherited-PATH problem, not produced by that lookup.

**Remediation:** Include optional executable directories only when lookup succeeds. Reject relative/empty PATH entries and render a deliberate baseline for services rather than copying an arbitrary interactive-shell path.

**Acceptance check:** With Copilot CLI absent, generated server and managed-unit paths contain neither `.` nor empty entries.

## F7 — Retire previously installed units during reconciliation

**Severity: P2 — renamed deployments leave unmanaged services behind.**

**Source:** [Reconciler outputs](../../tools/reconcile-deployments.mjs#L18-L35), [installer activation](../../deploy/systemd/install.sh#L97-L119), and [uninstall inventory](../../deploy/systemd/uninstall.sh#L12-L21).

**Trigger:** Change an installed managed manifest's `systemdUnit` to another valid name and rerun installation. The validator accepts the change; no immutable-name contract is documented.

**Expected:** Reconciliation explicitly retires the old installed unit, or rejects the rename pending a migration.

**Actual:** Only current unit names are generated, indexed, enabled, and restarted. Old files and enablement remain. The overwritten index and live-source registry no longer expose the old name, and uninstall discovers only current manifest names.

**Impact:** The old unit remains enabled and potentially running, survives uninstall, and may compete with the replacement for ports or run duplicate/stale application code. `daemon-reload` does not stop or disable it.

**Evidence:** Reconciliation does not read the previous installed-unit inventory or remove stale outputs. Unlike F4, this failure occurs with valid, readable manifests and an otherwise successful reconciliation.

**Remediation:** Preserve a validated inventory of installed unit names, diff desired against installed state, and explicitly stop/disable/remove retired units through a recoverable transition. Use installed inventory for uninstall rather than live manifest discovery. Do not delete arbitrary units merely because their names start with `jarvis-`.

**Acceptance check:** A two-pass old-name/new-name installation retires only the previously tracked old unit. Uninstall removes all tracked installed units even if source manifests have changed. Already orphaned units whose inventory was overwritten need separate operator-assisted recovery.

## F8 — Align service-action responses with systemd job completion

**Severity: P2 — valid slow service actions report failure while continuing.**

**Source:** [Command timeout](../../apps/server/src/deployments.ts#L6-L7), [blocking managed actions](../../apps/server/src/deployments.ts#L60-L74), [managed stop allowance](../../deploy/systemd/managed-deployment.service.template#L13-L18), and [route error handling](../../apps/server/src/app.ts#L272-L280).

**Trigger:** A managed service takes between 10 and 30 seconds to stop normally during a stop or restart action.

**Expected:** The API either waits for the permitted operation to complete or reports acceptance and tracks the asynchronous result.

**Actual:** The shared 10-second `execFile` timeout terminates the blocking `systemctl` client and rejects the request. Systemd permits a 30-second stop and owns the already-enqueued job; killing the client does not cancel that job. The route reports an HTTP 400 error even though the action can subsequently succeed.

**Impact:** Users see failure while service state continues changing. [The settings handler](../../apps/web/src/pages/Settings.tsx#L37-L51) skips its successful-action reload on error, leaving stale state and encouraging unnecessary retries. Scheduled Jarvis self-restart is a different path and is not affected by this blocking-call mismatch.

**Evidence:** Managed actions use blocking `systemctl` with the same timeout as status queries; tests use immediately returning command stubs. A focused verifier confirmed Node timeout rejection semantics without invoking systemd actions.

**Remediation:** Use a distinct managed-action timeout consistent with supported stop/start durations, or use `--no-block` with an accepted response and explicit job completion tracking. A longer timeout fixes the stated slow-stop case but cannot guarantee completion of all start jobs. For asynchronous restarts, checking only for `running` is insufficient because the service begins in that state.

**Acceptance check:** A permitted slow stop does not produce a false failure. Real action failures remain distinguishable, and the UI converges to the eventual job result without retrying the action.
