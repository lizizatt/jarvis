# Deployment gate execution — 2026-09-11

## Candidate and scope

- Container image ID: `sha256:172b5372069301936e638ee92b80ab7634223c254d22cd919e72c7b3b7a32274`.
- Source input: reviewed generated `context-v2` under the session's temporary release-gate directory. The image tests uncommitted candidate content, not HEAD alone.
- No live Jarvis service operation or deployment was authorized or performed. Test service operations occur only in the disposable VM.
- This record distinguishes executable gates from historical review and fixture validation. Subsequent source changes require affected checks to be rerun.

## Container — PASS

The initial clean-image run exposed a missing test input: the container recipe itself. After adding that file to the image, lint, typecheck, non-GUI tests, and all builds passed in a network-disabled validation layer. Dependency acquisition used network access inside the image build.

Runtime smoke passed as a non-root user with no network, published ports, host mounts, or extra capabilities, a read-only root filesystem, and temporary writable storage. It exercised API/readiness, the HTML entry, a fixture worker task, and a real PTY.

## Browser — PASS within stated scope

The independent container browser run reported six passing checks across mobile and desktop Chromium. Checks covered the main routes, JavaScript loading, manifest and service-worker scope, task/terminal/diff/preview flows, and the warmed root app shell with browser networking offline.

Limits: the WebGL virtual-window renderer was disabled because headless SwiftShader stalled. The fixture neutralized an unavailable Google Fonts request and ignored expected script-block messages from the sandboxed preview iframe. Uncached deep-route/API offline behavior, real phone installation, and visual-effect correctness were not established. The temporary browser image and files were removed; the candidate image was retained.

## Real systemd VM — PENDING

The one-off harness uses an Ubuntu 24.04 cloud image verified against its published SHA256, a disposable writable overlay, no guest NIC or shared host filesystem, and serial-only evidence collection. It resolves the candidate image once by immutable ID and checks included source bytes against the approved context, reporting omissions explicitly.

Earlier runs exposed harness limitations: candidate provenance needed strengthening, a same-revision registry migration could not justify a full upgrade PASS, and the phase-two unit had a boot-order cycle through cloud-init. Those harness defects were corrected. Nine local harness checks passed.

The corrected finite run started with session ID `20260911T213311Z-821510`. Completion and cleanup are pending. Do not interpret earlier phase markers as a completed release gate.

Even successful completion will be **PARTIAL lifecycle evidence**, because the approved payload has no actual older application revision. Historical-version upgrade verification remains a separate release requirement.

## Remaining checks

- Collect the corrected VM verdict, phase summary, runtime versions, source attestation, and cleanup evidence.
- Select and test a real older revision for a historical application upgrade.
- Run or confirm VS Code extension-host and real Copilot authentication checks in an approved environment.
- Keep commit and live-deployment approvals separate from test execution.
