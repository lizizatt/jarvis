# Deployment review scope and verification

## Scope

- Review date: 2026-09-11.
- Source revision: `54407e9784f34921d29ab1ffa9051f79a7df4eca`.
- Review target: the current Jarvis checkout's deployment and configuration behavior, not changes introduced by a branch diff.
- [Findings](DEPLOYABILITY_FINDINGS.md) describe existing defects and cleanup opportunities. They do not claim regressions from a base revision.
- No application changes, installation, service restarts, extension installation, commits, or pushes are authorized by this review.
- Pre-existing untracked design documents remain untouched.

## Assessment and cleanup order

Jarvis has localhost-by-default networking, a separate terminal host, project-owned deployment manifests, and tested service-control logic. The highest-value cleanup is separating the core application from workstation-specific integration choices and installed state.

1. **Standalone installation:** optional integrations, validated effective configuration, consistent endpoints, and deliberate executable paths.
2. **Reliable lifecycle:** staged reconciliation, installed-state snapshots, readiness checks, and failure-path tests.
3. **Release packaging:** consider versioned release directories and explicit activation/rollback rather than treating a mutable development checkout as the release artifact.

The third item is an architectural recommendation, not a violation of the current documented checkout-based deployment model. [Startup searches for the source-tree layout](../../apps/server/src/index.ts#L9-L15), and [web publishing intentionally serves rebuilt assets immediately](../DEPLOYMENT.md#L17-L25). An artifact-only distribution would require an explicit contract for assets, instructions, runtime dependencies, and data migrations.

## Adversarial review method

Draft the findings first, then assign each to a fresh independent verifier instructed to disprove it before accepting it. Check concrete triggers, code paths, mitigations, severity, and whether proposed cleanup is a requirement or a new design choice. Use disposable fixtures or read-only checks; never inspect private application state or invoke real service control.

A separate final cross-cutting reviewer inspects source without reading the findings. New candidates require independent verification before promotion. Branch-review mechanics such as fetching, checkout, and introduced-by-diff checks do not apply to this whole-checkout/document review.

## Verification ledger

| Finding | Disposition | Evidence and corrections |
| --- | --- | --- |
| F1 | Verified, narrowed | P1 is relative to standalone productization, not a violation of the documented workstation contract. Required executable presence is not Tailnet connectivity. Guard empty managed-unit operations. |
| F2 | Verified, expanded | EnvironmentFile overrides service Environment settings. Shell-only and environment-file-only registry overrides both diverge. Installer and self-manifest health probes are independent. |
| F3 | Verified, narrowed | Managed builds follow registry publication; root build and manifest validation precede it. Existing running units are not immediately replaced. Live build outputs need separate protection. |
| F4 | Verified, narrowed | Source-read failure aborts all API management; direct systemd remains usable. Uninstall process-substitution failure can leave a partial inventory without aborting the parent. |
| F5 | Verified, narrowed | Missing configured assets and post-restart persistent host failure escape readiness. Direct restart/build failures abort. Aggregate is-active means any active unit; terminal retries can recover within five seconds. |
| F6 | Verified, narrowed | Empty optional lookup produces `.`; initial absolute ExecStart paths are protected. Risk is descendant lookup without a custom PATH override, not established privilege escalation. |
| F7 | Verified, added | Independently discovered and separately verified: unit rename leaves the previous unit enabled/untracked, and uninstall misses it. P2 because the rename is deliberate and manual recovery exists. |
| F8 | Verified, added | Final blind sweep discovered the 10-second action timeout versus 30-second permitted stop. Separate verifier checked job/client lifetime and API/UI consequences. |

Each original finding received a separate fresh adversarial verifier. Two additional findings received their own fresh verification passes. The primary reviewer checked the cited implementation and applied the corrections rather than accepting suggested severity ratings wholesale.

### Independent sweep ledger

- First cross-cutting sweep found F7 plus duplicates of existing findings. A broad documentation search accidentally surfaced report snippets, so this pass was not treated as blind.
- Replacement sweep was restricted to explicit source/test paths and maintained blindness. It found F8 plus duplicates of F1, F2, and F7. F8 was independently verified and added.
- Rejected overstatements: optional projects contradict the current deployment contract; managed PATH contains only Node/Copilot directories; direct restart failures are ignored; missing web assets prove a successful default build failed silently; current-directory lookup affects absolute ExecStart; one source failure stops running services. None is claimed in the final findings.
- Review saturation is limited to these inspected deployment/configuration paths and checks; this is not a claim that the repository is defect-free.

## Coverage

| Area | Lenses | Status |
| --- | --- | --- |
| Installer and service templates | Portability, configuration propagation, operational safety | Source review, independent verification, and blind sweep complete. |
| Reconciler and uninstall | Artifact publication, lifecycle consistency, failure recovery | Source review, independent verification, and blind sweep complete. |
| Server configuration and deployment manager | API integration, installed/source state, fault isolation | Source review, independent verification, and blind sweep complete. |
| Health, static assets, terminal host | Readiness, startup timing, capability availability | Source review, independent verification, and blind sweep complete. |
| Worker configuration, web proxy, registration tooling | Endpoint compatibility and onboarding | Initial source review complete; supporting context only. |
| Deployment tests and root scripts | Negative cases, installer coverage, test integration | Existing coverage inspected; missing failure-path tests recorded. |

## Validation

Before this document was drafted, the source review ran successfully:

- `npm test --workspace @jarvis/server`: 57 passing tests.
- `bash deploy/systemd/test.sh`: isolated manifest generation and systemd syntax verification passed.
- `npm run lint`.
- `npm run typecheck`.

The [deployment shell test](../../deploy/systemd/test.sh) exercises successful generation with one fixture project. The [root scripts](../../package.json#L11-L21) do not invoke that shell harness. Recommended additional coverage includes core-only installation, custom ports/registry paths, optional executable absence, failing builds, missing source manifests, readiness failures, renamed units, and delayed service actions.

Full web/worker suites, production builds, and live installation were not run. A build would overwrite assets used by the checkout-based deployment. Passing existing tests does not establish that the documented failure cases are covered.

During adversarial verification, focused deployment tests passed (4/4), as did a focused API test (1/1). Verifiers also checked empty-argument path handling, descendant executable lookup, process-substitution exit propagation, Node child-process timeout semantics, and systemd environment/job semantics. These checks do not constitute a live install or end-to-end reproduction of every finding. F3 and F7 are source-verified ordering/lifecycle defects; no failing production builds or service rename actions were attempted.

Document validation passed: all 34 local links and line ranges resolve, neither document has editor diagnostics, and no pending verification entries remain. Only the two review documents were added; application source and pre-existing design documents were unchanged.
