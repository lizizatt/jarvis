# Deployment gate execution — 2026-09-11

## Candidate and scope

- Container image ID: `sha256:172b5372069301936e638ee92b80ab7634223c254d22cd919e72c7b3b7a32274`.
- Source input: reviewed generated `context-v2` under the session's temporary release-gate directory. The image was built before implementation commit `4645c89`; immutable image identity and source-byte attestation, not current HEAD, identify the tested payload.
- No live Jarvis service operation or deployment was authorized or performed. Test service operations occur only in the disposable VM.
- This record distinguishes executable gates from historical review and fixture validation. Subsequent source changes require affected checks to be rerun.

## Container — PASS

The initial clean-image run exposed a missing test input: the container recipe itself. After adding that file to the image, lint, typecheck, non-GUI tests, and all builds passed in a network-disabled validation layer. Dependency acquisition used network access inside the image build.

Runtime smoke passed as a non-root user with no network, published ports, host mounts, or extra capabilities, a read-only root filesystem, and temporary writable storage. It exercised API/readiness, the HTML entry, a fixture worker task, and a real PTY.

## Browser — PASS within stated scope

The independent container browser run reported six passing checks across mobile and desktop Chromium. Checks covered the main routes, JavaScript loading, manifest and service-worker scope, task/terminal/diff/preview flows, and the warmed root app shell with browser networking offline.

Limits: the WebGL virtual-window renderer was disabled because headless SwiftShader stalled. The fixture neutralized an unavailable Google Fonts request and ignored expected script-block messages from the sandboxed preview iframe. Uncached deep-route/API offline behavior, real phone installation, and visual-effect correctness were not established. The temporary browser image and files were removed; the candidate image was retained.

## Real systemd VM — FAILED; work paused

The one-off harness uses an Ubuntu 24.04 cloud image verified against its published SHA256, a disposable writable overlay, no guest NIC or shared host filesystem, and serial-only evidence collection. It resolves the candidate image once by immutable ID and checks included source bytes against the approved context, reporting omissions explicitly.

Earlier runs exposed harness limitations: candidate provenance needed strengthening, a same-revision registry migration could not justify a full upgrade PASS, and the phase-two unit had a boot-order cycle through cloud-init. Those harness defects were corrected. Nine local harness checks passed.

Run `20260911T213311Z-821510` completed with failure: phases 1–6 passed, then the reboot check saw active core units but an HTTP connection refusal and empty-JSON parsing failure. Phase 8 was not reached. Guest runtime was Node `v22.23.2`, npm `10.9.8`. Staging, seed ISO, and writable overlay were removed; serial/QEMU logs and source attestation remain.

A bounded 60-second post-reboot readiness wait is now retained with executable command-stub tests and failure diagnostics. A startup race is the leading hypothesis, not a confirmed diagnosis. The helper does not restart or reinstall services and refuses direct execution outside its guarded guest caller.

Retry `20260911T215526Z-1879515` was cancelled without a completed verdict. Cancellation removed run staging/seed/overlay but left a QEMU child running; that exact guest was terminated during handoff preparation. Child-process cancellation cleanup needs a regression before resuming unattended runs. The readiness fix has not completed VM verification. Twelve local harness checks pass; no new VM was launched during handoff preparation.

Work is paused at the user's request. See the [handoff](DEPLOYABILITY_HANDOFF.md) for artifact locations, remaining work, and safe resumption steps.

Even successful completion will be **PARTIAL lifecycle evidence**, because the approved payload has no actual older application revision. Historical-version upgrade verification remains a separate release requirement.

## Remaining checks

- Fix cancellation child-process cleanup, then obtain a completed VM verdict for the readiness fix, with phase summary, runtime versions, source attestation, and cleanup evidence.
- Select and test a real older revision for a historical application upgrade.
- Run or confirm VS Code extension-host and real Copilot authentication checks in an approved environment.
- Keep commit and live-deployment approvals separate from test execution.
