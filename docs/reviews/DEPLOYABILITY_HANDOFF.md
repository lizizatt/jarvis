# Deployment hardening handoff — 2026-09-11

## Pause point

Work is paused at the user's request. Do not resume VM testing or deployment just because this document is opened.

- Branch: `feat/deployment-hardening`.
- Baseline implementation commit: `4645c89` — `Harden deployment configuration and lifecycle with isolated validation`.
- This handoff's commit retains the subsequent VM boot-readiness helper, its seed packaging, regression tests, and corrected status documents.
- Nothing has been pushed or deployed. Commit permission does not grant deployment permission.
- Three unrelated design drafts remain untracked and intentionally excluded: [digital-window recreation](../design/DIGITAL_WINDOW_RECREATION_SPEC.md), [voice candidates](../design/VOICE_CANDIDATES.md), and [voice interface](../design/VOICE_INTERFACE.md). Preserve them.

## Safety constraints for resuming

- Do not inspect or change the active host Jarvis services, live state, or editor/Copilot storage. Do not install extensions or restart registered VS Code windows.
- Do not build into this checkout's served web assets. Full validation belongs in copied trees or disposable containers, with separate HOME, state, sockets, and ports.
- Service installation, restart, reboot, and uninstall tests belong only in the disposable guest. Do not run guest scripts directly on the host.
- Read [AGENTS.md](../../AGENTS.md) and inspect current Git changes before editing. The VM harness is intentionally pinned to this checkout and one approved source context; it is not a reusable release gate.
- No push or live deployment without fresh permission. Do not commit temporary evidence, images, build outputs, credentials, or runtime state.

## What was implemented

The [verified findings](DEPLOYABILITY_FINDINGS.md) cover eight deployability defects. The baseline commit addresses them with:

- Core-only installation by default; explicit optional managed manifests, no personal checkout defaults or mandatory Tailscale.
- Effective installation configuration shared by installer and runtime, preserved operator configuration, deliberate absolute service PATH, and a separate managed-build PATH.
- Registry v2 installed manifest snapshots and managed/retiring-unit inventory; legacy migration and uninstall without surviving source manifests.
- Build-before-publication, staged metadata, per-file publication recovery, stale-unit retirement, and activation/readiness recovery. Arbitrary managed build outputs are **not** globally atomic or versioned.
- Separate liveness and readiness, served-PWA checks, bounded terminal protocol ping/pong, and independent worker capability reporting.
- Configurable managed-action timeout (45 seconds by default, with a Node-safe upper bound); status commands retain their shorter budget. Actions remain synchronous and timed-out systemd jobs can continue.
- Installer fixtures, copied-source isolation, container validation, and an offline disposable real-systemd VM harness.

Implementation detail and limitations: [implementation sequence](DEPLOYABILITY_IMPLEMENTATION.md), [isolated validation](../ISOLATED_VALIDATION.md), and [execution evidence](DEPLOYABILITY_GATE_EXECUTION.md).

## Evidence at pause

| Check | Result and limits |
| --- | --- |
| Prior copied-source full validation | Lint, typecheck, all workspace builds, 199 tests (69 server, 83 web, 36 installer, 11 isolation-boundary), and API/PWA-entry/fixture-worker/real-PTY smoke passed. This is not a blanket root-suite or real-Copilot PASS. |
| Container | Network-disabled validation layer passed after dependency acquisition; non-root, networkless, read-only runtime smoke passed. |
| Browser | Six desktop/mobile Chromium checks reported passing. WebGL renderer disabled, unavailable font request neutralized, warmed root shell only for offline coverage. Not real-phone or visual-effect verification. |
| Last completed VM | Run `20260911T213311Z-821510`: phases 1–6 passed; phase 7 failed immediately after reboot with HTTP connection refused, then empty-JSON parsing. Phase 8 was not reached. Guest Node `v22.23.2`, npm `10.9.8`. |
| Cancelled retry | Run `20260911T215526Z-1879515` started despite the tool cancellation. Its launcher exited and removed staging/seed/overlay, but QEMU remained running. The identified guest was explicitly terminated during handoff preparation. No completed verdict; do not count this retry as validation. |
| Retained readiness fix | Waits up to 60 seconds for each core unit to be active/enabled and readiness JSON to report `ok: true`; emits unit state and current-boot journals on timeout. No restart/reinstall in the probe. The helper rejects direct execution and is sourced after the guest guards. **Not yet verified through a completed VM run.** |
| Handoff checks | Shell syntax and 12 local VM harness tests passed, including fake-command retry/timeout and direct-execution rejection; scoped ESLint and diff whitespace checks passed. No full host build or root test suite was run for this handoff. |

The startup race is a **leading hypothesis**, not yet a confirmed explanation of the reboot failure. A persistent startup crash or bad persisted configuration must still fail the bounded probe and be diagnosed from guest evidence.

## Retained local artifacts

These are temporary local resources, not repository files; verify they still exist before resuming:

- Approved source context: `/tmp/jarvis-release-gate-duFf9r/context-v2`.
- Candidate image reference: `jarvis-isolated-test:gate-20260911`.
- Required immutable image ID: `sha256:172b5372069301936e638ee92b80ab7634223c254d22cd919e72c7b3b7a32274`.
- VM gate root: `/tmp/jarvis-release-gate-duFf9r/vm`; cached Ubuntu image under its `images` directory; evidence under `runs/<run-id>`.
- Each failed/cancelled run retains serial/QEMU logs, host metadata, published checksums, and the source-content/omission report. Successful-only summary/runtime metadata files may be absent on failure.
- The completed failed run attested 145 present source files and reported 46 approved omissions. Its Ubuntu image SHA256 was `d0fe84bb5f80853425fa6be28e2c106f30104c3cfe8611933f2e65c9b63f0e30`.

The candidate image was built before the baseline commit. Its identity is established by immutable image ID and source-byte attestation, **not** by current HEAD. Subsequent harness changes are copied separately into the seed; rebuilding the image or replacing the approved context requires a new provenance review. The harness fetches the current published Ubuntu checksum list, so an aged cached image may later fail validation; investigate rather than bypassing the checksum guard.

## Resume sequence, when requested

1. Inspect current worktree, helper/tests, and retained evidence. Run [the local harness checks](../../deploy/test-vm/test.sh), which use command stubs and do not launch a guest.
2. Review the cancellation behavior in [the host launcher](../../deploy/test-vm/run-gate.sh): this cancellation left a child QEMU running after cleanup. Add explicit child-process teardown and a safe regression before relying on cancellation for unattended runs.
3. Confirm the approved context, immutable image, cached cloud image, and KVM access. Do not silently substitute current branch content for the approved payload.
4. Launch [the finite VM gate](../../deploy/test-vm/run-gate.sh) with `JARVIS_VM_GATE_ROOT=/tmp/jarvis-release-gate-duFf9r/vm` and `JARVIS_VM_GATE_EXPECTED_IMAGE_ID=sha256:172b5372069301936e638ee92b80ab7634223c254d22cd919e72c7b3b7a32274`. Keep operations isolated; retain its exact run ID and terminal handle. Do not poll or restart the live services while waiting.
5. Require all eight phase markers, including post-reboot actual WebSocket PTY output/shell exit and uninstall after source removal. Verify guest shutdown, cleanup, source attestation, and runtime versions. Investigate any persistent readiness timeout using guest logs, without restarting the services to make the reboot assertion pass.
6. Update the execution record and commit verified narrow changes. A successful current-payload run is **PARTIAL lifecycle evidence**, never a full release PASS: synthetic v1 inventory migration is not an older-application upgrade.
7. Separately select and approve a real older application revision for upgrade testing; establish real VS Code/Copilot capability and authentication. Real-phone/uncached-offline/visual coverage and versioned atomic application deployment remain outside the completed scope.

The next session should start with this handoff rather than treating older implementation-ledger statements as current gate results.
