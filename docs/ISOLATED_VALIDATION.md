# Isolated validation

The host runner validates a copied checkout so normal build, test, and smoke output does not contaminate the working tree or Jarvis's configured state directories. It is intended for trusted repository code. It is not an operating-system security sandbox: commands run as the same user, can access files available to that user, and can make network connections.

The runner supplies fresh home, cache, temporary, and XDG paths and omits inherited credentials and live Jarvis settings. Those controls reduce accidental interaction with host state; they do not constrain code that deliberately uses another host path or endpoint.

## Commands

Run the default build and application smoke check:

```bash
npm run validate:isolated
```

Run lint, typecheck, non-GUI tests, build, and the application smoke check:

```bash
npm run validate:isolated:full
```

Run only the public copy-boundary tests:

```bash
npm run test:isolated-runner
```

Both validation modes create a temporary tree and remove it on completion. Pass `--keep` directly to `tools/isolated-runner.mjs` only when a failed copied tree is needed for local diagnosis.

## Isolation boundary

The runner:

- Gets tracked and unignored candidate names from Git, then applies a fixed top-level and extension allowlist.
- Canonicalizes each accepted source file and dependency root before copying it and rejects paths that resolve outside the canonical checkout, including paths redirected by an ancestor symlink.
- Excludes `.git`, `.env` files other than the root `.env.sample`, dependency directories, build output, test output, VSIX files, downloaded VS Code test instances, databases, sockets, logs, archives, and secret-like filenames.
- Copies the root and workspace `node_modules` directories with `fs.cp`, `verbatimSymlinks: true`, and no package installation. Regular dependency files are copies, not hard links.
- Rejects absolute, broken, and tree-escaping symlinks after the copy. Relative npm `.bin` links and workspace links are accepted only when their final targets are inside the copied tree.
- Supplies a new `HOME`, temporary directory, npm cache, and XDG directories. It constructs `PATH` only from the current Node, npm, Git, and shell executable directories and does not pass proxy, credential, token, display, DBus, or live Jarvis variables through.
- Forces loopback settings, disables inherited external Playwright targeting, and uses port `0` for the smoke server.

The runner itself only reads the source checkout and dependency directories. It directs normal compiler output, test output, SQLite data, Git fixtures, terminal sockets, npm cache data, and PWA assets into the temporary validation root. Because tested code retains the user's host permissions, this is contamination isolation rather than protection from malicious code.

Existing dependencies are required. The runner deliberately does not run `npm ci` against the source checkout or fetch missing packages.

## Smoke coverage

Smoke mode builds every workspace in the copy, then starts the compiled Fastify application on an ephemeral loopback port. A disposable Git repository, SQLite database, protocol-v2 fixture worker, and terminal host all live under isolated temporary state. The check proves:

- `/api/health` and `/api/readiness` succeed.
- An HTTP request receives the copied PWA's HTML entry and root element.
- A fixture worker registers, receives a task, emits an event, and completes it.
- A real PTY is created through the Unix-socket terminal host and returns command output.

The PWA check does not launch a browser, execute client JavaScript, register a service worker, verify installability, render the UI, or exercise offline behavior.

No installer, service manager, live endpoint, real Copilot account, or registered repository is used.

## Full-mode gates

Full mode runs these checks in the copied tree:

1. `npm run lint`
2. `npm run typecheck`
3. Server and web `npm test` workspace suites
4. `npm run test:deployment`
5. `npm run test:isolated-runner`
6. `npm run build`
7. The isolated application smoke check

The VS Code extension-host suite is reported as `UNAVAILABLE`. Its test launcher downloads a VS Code test instance when no cache is present, while downloaded `.vscode-test` output is intentionally excluded from the copy. The runner does not make that download or silently count the suite as passing. Run that suite separately in an approved GUI/headless environment with a prepared test runtime.

## Optional container

[The test container recipe](../deploy/test-container/Containerfile) is a second, optional boundary. Do not give the checkout itself to `docker build`. Generate a new context containing allowlisted tracked files and a manifest of every copied, excluded, and missing path:

```bash
context_parent="$(mktemp -d)"
context="$context_parent/context"
npm run prepare:container-context -- --output "$context" --include-candidates
cat "$context/.jarvis-container-context.json"
```

Omit `--include-candidates` for the default tracked-only context. Use it only when intentional untracked work is required; candidate paths are filtered through the same source allowlist and listed separately in the manifest. Review the manifest before building. The command refuses an existing destination so an old or manually modified context is not silently reused.

Use a configured Docker CLI with BuildKit. The base image pull, Debian `apt-get`, and `npm ci` layers require network access and may contact their configured registries. The later lint, typecheck, test, and build layer runs with `RUN --network=none`; the safety environment is set before those checks. Do not pass npm credentials, secrets, SSH agents, live environment files, or extra build contexts.

```bash
DOCKER_BUILDKIT=1 docker build \
  --file "$context/deploy/test-container/Containerfile" \
  --tag jarvis-isolated-test \
  "$context"
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  --cap-drop all --security-opt no-new-privileges \
  jarvis-isolated-test
```

The runtime smoke does not need outbound network access or host mounts. Do not add host networking, privileged mode, the Docker socket, or credential forwarding. Container success is not evidence for the real-systemd gate. Remove the generated context after review when it is no longer needed.

## Remaining release gates

The copied runner cannot prove user-manager enablement, reboot behavior, real unit retirement, or uninstall on a host. Follow the [disposable VM release gate](VM_RELEASE_GATE.md) for those checks. Real VS Code/Copilot authentication remains a separate manual capability check.
