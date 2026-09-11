# Deployment hardening implementation sequence

This is the execution checklist for the [verified findings](DEPLOYABILITY_FINDINGS.md). The review is historical evidence; this document tracks implementation and validation. User approval covers implementation and isolated testing, not deployment or commits.

## Safety and agreed test boundaries

- Preserve the running installation: no real host service operations, no reads/writes of live Jarvis state, and no production asset rebuilds in this checkout.
- Test the installer CLI and generated installation state with temporary homes, copied fixture checkouts, and recording external-command substitutes. These verify intent, not real systemd behavior.
- Test application behavior through API/deployment-manager boundaries using disposable fixtures.
- Run builds and full validation in a copied source tree, with separate output and data. The host copy controls contamination for trusted code; it is not an OS sandbox and retains the user's file and network access. Do not mount host home, service sockets, or the container-engine socket into test containers. Do not use host networking or privileged containers.
- Keep optional integration choices separate from core installation. Preserve existing environment configuration; make migrations explicit rather than silently retiring unrelated integrations.
- No commits, pushes, extension installation, live service restarts, or deployment without separate approval.

## Ordered tasks and exit gates

1. [x] **Build the safe installer harness.** Exercise the real installer CLI against copied fixtures, isolated HOME, a minimal environment, and recording systemctl/network/build substitutes. Fail closed on unsupported commands. Prove no real service calls or checkout build output occur. Wire into routine tests.
2. [x] **Make core installation standalone (F1, F2, F6).** Support zero-to-many explicitly selected managed manifests; optional Tailnet tooling; one validated effective installation configuration; consistent custom port/registry handling; absolute, deliberate service PATH. Test clean/core-only install, invalid inputs, configuration preservation, and custom endpoints.
3. [x] **Make installed state durable (F3, F4, F7).** Build before publishing metadata, stage output, retain installed manifest snapshots and unit inventory, isolate failures, retire only tracked stale units, and uninstall without source manifests. Test failed preparation and rename/removal across two installations. Document remaining activation/build-output atomicity limits and migration behavior.
4. [x] **Make readiness and actions truthful (F5, F8).** Check each required unit, served PWA, and terminal socket separately from liveness. Preserve worker absence as a separate capability. Handle slow managed service actions without false timeouts and test eventual result behavior.
5. [x] **Add isolated application smoke coverage.** Build copied source and run API/PWA/terminal smoke checks with fixture workers and separate state. Provide an unprivileged container option with narrowly scoped build inputs. No host credentials or live endpoints. See [isolated validation](../ISOLATED_VALIDATION.md).
6. [x] **Establish the real-systemd release gate.** Document/provide a disposable-VM procedure for fresh install, upgrade, failure recovery, rename/removal, slow actions, reboot, and uninstall. VM execution is a separate gate if provisioning capabilities are unavailable; mocks or containers must not be represented as completing it. The [VM procedure](../VM_RELEASE_GATE.md) is established; execution remains `NOT RUN`.
7. [x] **Validate and adversarially review.** Run focused tests, lint/typecheck, full tests and build in isolation where possible. Review implementation against every finding, update operator documentation, and record unavailable checks. Available checks passed; container, real-systemd VM, browser PWA, and extension-host gates remain unrun. Fixes are not deployment-verified.

## Deferred design decisions

- Versioned release artifacts and atomic application activation/rollback remain a separate packaging project. Staging registry/unit metadata does not protect live assets overwritten by arbitrary project builds.
- Real VS Code/Copilot authentication and extension-host integration require a separately approved manual check; fixture workers do not prove them.

## Progress ledger

- Plan recorded before implementation. Original checkout has unrelated untracked design documents and review documents; preserve all of them.
- Steps 1 through 3 are implemented in the isolated installer harness. Registry v2 embeds validated manifest definitions with source provenance, active managed units, and phase-marked retirement inventory. The server retains v1 read compatibility; the installer migrates v1 registries while their source manifests are still readable.
- Preparation stages all registry, environment, runner, index, and unit outputs until every selected build succeeds. Per-file publication uses rollback metadata, but neither multi-file visibility nor arbitrary build output in managed project directories is atomic.
- Explicit rename/removal retires only previously recorded managed units and keeps recovery inventory until retirement completes. Uninstall consumes v2 inventory without source manifests. These behaviors are fixture-tested only; the real-systemd VM gate remains Step 6.
- Step 4 adds `/api/readiness` for required web-entry and terminal-socket checks while keeping `/api/health` as liveness and worker presence separate. The installer independently verifies every required unit, liveness, readiness, the served PWA, and managed health URLs, retaining endpoint detail on bounded failure.
- Managed actions remain synchronous with a configurable 45-second default, distinct from the 10-second status-query timeout and above the managed unit's 30-second stop allowance. API tests cover delayed success, timeout, and command-error behavior; asynchronous job tracking remains outside this narrow fix.
- Step 5 adds a copied-source runner with physically copied dependencies, canonical source containment, internal-only symlink validation, fresh HOME/TMP/XDG state, a minimal executable PATH, and loopback port allocation by the kernel. The smoke check fetches the built PWA HTML entry over HTTP and exercises the API, protocol-v2 fixture worker, SQLite state, and real PTY socket host without browser-side PWA or offline checks. The optional container consumes only a generated, reviewable source manifest.
- On 2026-09-11, final isolated full mode passed lint, typecheck, 69 server tests, 83 web tests, 36 installer tests, 11 copy-boundary tests, all workspace builds, and the application smoke (199 tests total). VS Code extension-host tests were `UNAVAILABLE` because downloaded `.vscode-test` runtimes are excluded and no network download was attempted. Root `npm test` was not claimed as passing: its available constituent suites were run explicitly instead.
- Step 6 defines the disposable-VM gate and evidence labels. No VM was provisioned or used in this implementation session, so real-systemd fresh install, upgrade, reboot, and uninstall remain `NOT RUN` and must not be described as deployment-verified.

## Adversarial implementation review outcomes

- Installer review led to retained old-unit files and recovery inventory until replacement readiness, rollback of previously active retiring units on activation/readiness failure, legacy installed-index migration and direct v1 uninstall, and installed-effective configuration precedence during uninstall.
- Publication rejects recovery-file/directory aliases before mutation. Managed builds have a separate caller executable path, while rendered service paths remain deliberate. Readiness no longer requires a newly introduced curl version.
- Server review added a bounded versioned terminal ping/pong rather than accepting raw socket connection, readiness tied to registered static routes, and a Node-safe upper bound for action timeouts.
- Isolation review added ancestor-symlink containment tests, tracked-first generated container contexts with explicit candidate inclusion, network-disabled container validation layers, and teardown that attempts all cleanup steps. Documentation distinguishes trusted-code contamination isolation from an OS security sandbox and HTML-entry smoke from browser PWA verification.
- Regression checks cover both immediate activation failure and readiness failure after a replacement starts, including retry. Final source changes remain uncommitted and were not deployed.

## Next release gate

Run the generated-context container procedure and disposable-VM checklist in an approved environment; record results before any live migration. Real VS Code/Copilot and browser/offline behavior still require their separate checks. Versioned application releases and globally atomic activation are not implemented by this change.
