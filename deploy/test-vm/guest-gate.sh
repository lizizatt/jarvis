#!/bin/bash
set -Eeuo pipefail

readonly SENTINEL_VALUE=JARVIS_DISPOSABLE_VM_GATE_V1
readonly REPO_ROOT=/workspace
readonly GATE_ROOT=/home/gate/vm-gate
readonly FIXTURE_ROOT="$GATE_ROOT/fixtures"
readonly ALPHA_ROOT="$FIXTURE_ROOT/alpha"
readonly BETA_ROOT="$FIXTURE_ROOT/beta"
readonly ALPHA_MANIFEST="$ALPHA_ROOT/jarvis.deployment.json"
readonly BETA_MANIFEST="$BETA_ROOT/jarvis.deployment.json"
readonly REGISTRY="$HOME/.config/jarvis/deployments.json"
readonly SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
readonly EVIDENCE_ROOT="$HOME/.jarvis-vm-gate"
readonly PHASE_MODE="${1:-}"
readonly RUN_STARTED_FILE="$EVIDENCE_ROOT/run-started-epoch"
readonly BOOT_ID_FILE="$EVIDENCE_ROOT/phase1-boot-id"
readonly BOOT_READINESS_HELPER=/opt/jarvis-vm-gate/boot-readiness.sh

guard_fail() {
  printf 'VM_GATE|RESULT|FAIL|phase=guard|detail=%s\n' "$1" >&2
  exit 1
}

[[ "$PHASE_MODE" == phase1 || "$PHASE_MODE" == phase2 ]] || guard_fail invalid-phase
[[ "${JARVIS_VM_GATE_SENTINEL:-}" == "$SENTINEL_VALUE" ]] || guard_fail invalid-environment-sentinel
[[ -f /etc/jarvis-disposable-vm-gate ]] || guard_fail missing-sentinel-file
[[ "$(< /etc/jarvis-disposable-vm-gate)" == "$SENTINEL_VALUE" ]] || guard_fail invalid-sentinel-file
[[ "$(id -u)" == 2000 ]] || guard_fail unexpected-user
[[ "$REPO_ROOT" == /workspace && "$GATE_ROOT" == /home/gate/vm-gate ]] || guard_fail unexpected-fixed-path
[[ -r "$BOOT_READINESS_HELPER" ]] || guard_fail missing-boot-readiness-helper
source "$BOOT_READINESS_HELPER"

CURRENT_PHASE=bootstrap
PHASE_STARTED_NS=0

on_error() {
  local status=$?
  local line="$1"
  trap - ERR
  printf 'VM_GATE|RESULT|FAIL|phase=%s|line=%s|status=%s\n' \
    "$CURRENT_PHASE" "$line" "$status"
  exit "$status"
}
trap 'on_error "$LINENO"' ERR

fail() {
  printf 'ASSERTION FAILED: %s\n' "$*" >&2
  return 1
}

phase_start() {
  CURRENT_PHASE="$1"
  PHASE_STARTED_NS="$(date +%s%N)"
  printf 'VM_GATE|PHASE|%s|START|epoch=%s\n' "$CURRENT_PHASE" "$(date +%s)"
}

phase_pass() {
  local finished_ns duration_ms
  finished_ns="$(date +%s%N)"
  duration_ms=$(( (finished_ns - PHASE_STARTED_NS) / 1000000 ))
  printf 'VM_GATE|PHASE|%s|PASS|duration_ms=%s\n' "$CURRENT_PHASE" "$duration_ms"
}

assert_active_enabled() {
  local unit="$1"
  [[ "$(systemctl --user is-active "$unit")" == active ]] \
    || fail "$unit is not active"
  [[ "$(systemctl --user is-enabled "$unit")" == enabled ]] \
    || fail "$unit is not enabled"
  printf 'VM_GATE|ASSERT|unit-active-enabled|PASS|unit=%s\n' "$unit"
}

assert_not_active() {
  local unit="$1"
  if systemctl --user is-active "$unit" >/dev/null 2>&1; then
    fail "$unit is unexpectedly active"
  fi
  printf 'VM_GATE|ASSERT|unit-not-active|PASS|unit=%s\n' "$unit"
}

assert_http_ok() {
  local url="$1"
  curl --fail --silent --show-error --max-time 5 "$url" >/dev/null \
    || fail "health request failed: $url"
  printf 'VM_GATE|ASSERT|http-ok|PASS|url=%s\n' "$url"
}

assert_json_ok() {
  local url="$1"
  curl --fail --silent --show-error --max-time 5 "$url" \
    | node --input-type=commonjs -e \
      'let body=""; process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => { if (JSON.parse(body).ok !== true) process.exit(1); });'
  printf 'VM_GATE|ASSERT|json-ok|PASS|url=%s\n' "$url"
}

assert_core_ready() {
  assert_active_enabled jarvis.service
  assert_active_enabled jarvis-terminal-host.service
  assert_json_ok http://127.0.0.1:3210/api/health
  assert_json_ok http://127.0.0.1:3210/api/readiness
  curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3210/ \
    | grep -Eiq '<!doctype html|<html' || fail "PWA HTML was not served"
  workers="$(curl --fail --silent --show-error --max-time 5 \
    http://127.0.0.1:3210/api/workers)"
  node --input-type=commonjs -e \
    'const value=JSON.parse(process.argv[1]); if (!Array.isArray(value)) process.exit(1);' "$workers"
  printf 'VM_GATE|CAPABILITY|workers|UNAVAILABLE|detail=no-vscode-worker-in-disposable-vm|value=%s\n' "$workers"
}

wait_for_health() {
  local unit="$1"
  local url="$2"
  local seconds="$3"
  local deadline=$((SECONDS + seconds))
  while (( SECONDS < deadline )); do
    if systemctl --user is-active "$unit" >/dev/null 2>&1 \
      && curl --fail --silent --max-time 1 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "$unit did not become healthy within ${seconds}s"
}

journal_excerpt() {
  local label="$1"
  shift
  local arguments=()
  local unit
  for unit in "$@"; do
    arguments+=(-u "$unit")
  done
  printf 'VM_GATE|JOURNAL|%s|BEGIN\n' "$label"
  journalctl --user --no-pager -n 50 "${arguments[@]}" || true
  printf 'VM_GATE|JOURNAL|%s|END\n' "$label"
}

write_manifest() {
  local root="$1"
  local id="$2"
  local name="$3"
  local unit="$4"
  local port="$5"
  local runner="${6:-./runner.mjs}"
  cat > "$root/jarvis.deployment.json" <<EOF
{
  "version": 1,
  "id": "$id",
  "name": "$name",
  "kind": "managed",
  "systemdUnit": "$unit",
  "runner": "$runner",
  "build": ["./build.sh"],
  "healthUrl": "http://127.0.0.1:$port/health",
  "actions": ["start", "stop", "restart"]
}
EOF
}

create_fixture() {
  local root="$1"
  local id="$2"
  local name="$3"
  local unit="$4"
  local port="$5"
  mkdir -p "$root"
  printf '{"port":%s,"id":"%s"}\n' "$port" "$id" > "$root/config.json"
  cat > "$root/runner.mjs" <<'EOF'
#!/usr/bin/env node
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, id: config.id }));
    return;
  }
  response.writeHead(404).end();
});
server.listen(config.port, '127.0.0.1');

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const delayPath = new URL('./stop-delay-seconds', import.meta.url);
    const delay = existsSync(delayPath) ? Number(readFileSync(delayPath, 'utf8').trim()) : 0;
    setTimeout(() => server.close(() => process.exit(0)), delay * 1000);
  });
}
EOF
  cat > "$root/unhealthy-runner.mjs" <<'EOF'
#!/usr/bin/env node
console.log('fixture intentionally started without a health listener');
const interval = setInterval(() => {}, 60_000);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { clearInterval(interval); process.exit(0); });
}
EOF
  cat > "$root/build.sh" <<'EOF'
#!/bin/bash
set -euo pipefail
if [[ -f .fail-build ]]; then
  echo 'intentional fixture build failure' >&2
  exit 42
fi
sha256sum runner.mjs > build-output.sha256
EOF
  chmod 0755 "$root/runner.mjs" "$root/unhealthy-runner.mjs" "$root/build.sh"
  write_manifest "$root" "$id" "$name" "$unit" "$port"
}

hash_install_state() {
  local output="$1"
  {
    find "$HOME/.config/jarvis" -maxdepth 1 -type f -print
    find "$SYSTEMD_USER_DIR" -maxdepth 1 -type f -name 'jarvis*.service' -print
  } | LC_ALL=C sort | while IFS= read -r path; do sha256sum "$path"; done > "$output"
}

capture_unit_lifecycle() {
  local label="$1"
  local output="$2"
  shift 2
  local active_enter enabled invocation_id unit
  : > "$output"
  for unit in "$@"; do
    invocation_id="$(systemctl --user show "$unit" --property=InvocationID --value)"
    active_enter="$(systemctl --user show "$unit" --property=ActiveEnterTimestampMonotonic --value)"
    enabled="$(systemctl --user is-enabled "$unit" 2>&1 || true)"
    [[ "$invocation_id" =~ ^[0-9a-f]{32}$ ]] || fail "$unit has no active invocation ID"
    [[ "$active_enter" =~ ^[1-9][0-9]*$ ]] || fail "$unit has no active-enter timestamp"
    [[ "$enabled" == enabled ]] || fail "$unit is not enabled during $label capture: $enabled"
    printf '%s|%s|%s|%s\n' "$unit" "$invocation_id" "$active_enter" "$enabled" >> "$output"
    printf 'VM_GATE|LIFECYCLE|%s|unit=%s|invocation_id=%s|active_enter_monotonic=%s|enabled=%s\n' \
      "$label" "$unit" "$invocation_id" "$active_enter" "$enabled"
  done
}

assert_unit_lifecycle_unchanged() {
  local before="$1"
  local after="$2"
  if ! cmp --silent "$before" "$after"; then
    printf 'VM_GATE|LIFECYCLE|build-failure-before|BEGIN\n'
    cat "$before"
    printf 'VM_GATE|LIFECYCLE|build-failure-before|END\n'
    printf 'VM_GATE|LIFECYCLE|build-failure-after|BEGIN\n'
    cat "$after"
    printf 'VM_GATE|LIFECYCLE|build-failure-after|END\n'
    fail "a service restarted or changed enabled state during failed build preparation"
  fi
}

write_unrelated_unit() {
  mkdir -p "$SYSTEMD_USER_DIR"
  cat > "$SYSTEMD_USER_DIR/gate-unrelated.service" <<'EOF'
[Unit]
Description=Disposable VM gate unrelated unit
[Service]
Type=oneshot
ExecStart=/usr/bin/true
RemainAfterExit=yes
[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now gate-unrelated.service
  assert_active_enabled gate-unrelated.service
}

assert_registry_v2() {
  node --input-type=commonjs -e '
    const registry = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (registry.version !== 2 || !Array.isArray(registry.deployments)
      || !Array.isArray(registry.managedUnits) || !Array.isArray(registry.retiringUnits)) process.exit(1);
  ' "$REGISTRY"
}

run_phase1() {
  phase_start 1-preflight
  [[ "$JARVIS_VM_GATE_SENTINEL" == "$SENTINEL_VALUE" ]] || fail "environment sentinel mismatch"
  [[ "$(id -u)" == 2000 ]] || fail "gate must run as uid 2000"
  [[ "$HOME" == /home/gate ]] || fail "unexpected HOME"
  [[ "$XDG_RUNTIME_DIR" == /run/user/2000 ]] || fail "unexpected XDG_RUNTIME_DIR"
  [[ "$(< /proc/1/comm)" == systemd ]] || fail "PID 1 is not systemd"
  [[ "$(find /sys/class/net -mindepth 1 -maxdepth 1 -printf '%f\n')" == lo ]] \
    || fail "guest has a network interface other than loopback"
  [[ -f "$REPO_ROOT/.jarvis-vm-candidate-meta" ]] || fail "candidate metadata is missing"
  [[ -d "$REPO_ROOT/node_modules" ]] || fail "offline node_modules payload is missing"
  [[ -f "$REPO_ROOT/apps/server/dist/src/index.js" ]] || fail "server build artifact is missing"
  [[ -f "$REPO_ROOT/apps/web/dist/index.html" ]] || fail "web build artifact is missing"
  [[ ! -e "$REGISTRY" ]] || fail "unexpected prior Jarvis registry"
  if compgen -G "$SYSTEMD_USER_DIR/jarvis*.service" >/dev/null; then
    fail "unexpected prior Jarvis unit files"
  fi
  node_version="$(node --version)"
  npm_version="$(npm --version)"
  printf 'VM_GATE|RUNTIME|node=%s|npm=%s\n' "$node_version" "$npm_version"
  git --version
  curl --version | head -n 1
  node --input-type=commonjs -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 20 || (major === 20 && minor < 19)) process.exit(1);
  '
  cat /etc/os-release
  cat "$REPO_ROOT/.jarvis-vm-candidate-meta"
  docker_image_id="$(awk -F= '$1 == "DOCKER_IMAGE_ID" { print $2 }' "$REPO_ROOT/.jarvis-vm-candidate-meta")"
  payload_sha="$(awk -F= '$1 == "PAYLOAD_SHA256" { print $2 }' "$REPO_ROOT/.jarvis-vm-candidate-meta")"
  tested_source_sha="$(awk -F= '$1 == "TESTED_SOURCE_CONTENT_SHA256" { print $2 }' "$REPO_ROOT/.jarvis-vm-candidate-meta")"
  [[ "$docker_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "candidate image ID is invalid"
  [[ "$payload_sha" =~ ^[0-9a-f]{64}$ ]] || fail "candidate payload hash is invalid"
  [[ "$tested_source_sha" =~ ^[0-9a-f]{64}$ ]] || fail "tested source content hash is invalid"
  printf 'VM_GATE|IMAGE|ubuntu=24.04|sha256=%s\n' \
    "$(awk -F= '$1 == "UBUNTU_IMAGE_SHA256" { print $2 }' "$REPO_ROOT/.jarvis-vm-candidate-meta")"
  printf 'VM_GATE|CAPABILITY|container-payload|PASS|detail=immutable-image-id-used-and-present-source-files-matched-approved-context-v2|image_id=%s|payload_sha256=%s|tested_source_content_sha256=%s\n' \
    "$docker_image_id" "$payload_sha" "$tested_source_sha"
  date +%s > "$RUN_STARTED_FILE"
  cat /proc/sys/kernel/random/boot_id > "$BOOT_ID_FILE"
  phase_pass

  phase_start 2-fresh-core
  cd "$REPO_ROOT"
  bash deploy/systemd/install.sh --core-only
  assert_core_ready
  assert_registry_v2
  node --input-type=commonjs -e '
    const registry = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (registry.managedUnits.length !== 0 || registry.deployments.length !== 1) process.exit(1);
  ' "$REGISTRY"
  journal_excerpt fresh-core jarvis.service jarvis-terminal-host.service
  phase_pass

  phase_start 3-registry-migration
  create_fixture "$ALPHA_ROOT" alpha 'Alpha fixture' jarvis-alpha.service 4311
  create_fixture "$BETA_ROOT" beta 'Beta fixture' jarvis-beta.service 4312
  bash "$REPO_ROOT/deploy/systemd/install.sh" "$ALPHA_MANIFEST" "$BETA_MANIFEST"
  assert_active_enabled jarvis-alpha.service
  assert_active_enabled jarvis-beta.service
  assert_http_ok http://127.0.0.1:4311/health
  assert_http_ok http://127.0.0.1:4312/health

  printf 'VM_GATE|CAPABILITY|older-revision-upgrade|UNAVAILABLE|detail=no-actual-older-revision-in-approved-payload\n'
  printf 'VM_GATE|CAPABILITY|registry-v1-migration|PASS_CURRENT_CANDIDATE|detail=synthetic-v1-index-with-current-candidate-manifests\n'
  node --input-type=commonjs -e '
    const fs = require("node:fs");
    fs.writeFileSync(process.argv[1], JSON.stringify({ version: 1, manifests: process.argv.slice(2) }, null, 2) + "\n");
  ' "$REGISTRY" "$REPO_ROOT/jarvis.deployment.json" "$ALPHA_MANIFEST" "$BETA_MANIFEST"
  bash "$REPO_ROOT/deploy/systemd/install.sh"
  assert_registry_v2
  node --input-type=commonjs -e '
    const registry = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const expected = new Set(process.argv.slice(2));
    const provenance = new Set(registry.deployments.map(item => item.provenance.manifestPath));
    if (registry.managedUnits.length !== 2 || registry.retiringUnits.length !== 0
      || [...expected].some(path => !provenance.has(path))) process.exit(1);
  ' "$REGISTRY" "$REPO_ROOT/jarvis.deployment.json" "$ALPHA_MANIFEST" "$BETA_MANIFEST"
  assert_core_ready
  journal_excerpt registry-migration jarvis.service jarvis-alpha.service jarvis-beta.service
  phase_pass

  phase_start 4-failure-recovery
  assert_core_ready
  capture_unit_lifecycle build-failure-before "$EVIDENCE_ROOT/before-build-failure.lifecycle" \
    jarvis.service jarvis-terminal-host.service jarvis-alpha.service jarvis-beta.service
  hash_install_state "$EVIDENCE_ROOT/before-build-failure.sha256"
  touch "$BETA_ROOT/.fail-build"
  if build_failure_output="$(bash "$REPO_ROOT/deploy/systemd/install.sh" \
    "$ALPHA_MANIFEST" "$BETA_MANIFEST" 2>&1)"; then
    fail "managed build failure unexpectedly succeeded"
  fi
  rm "$BETA_ROOT/.fail-build"
  printf '%s\n' "$build_failure_output"
  grep -Fq 'Build failed for Beta fixture' <<< "$build_failure_output" \
    || fail "build failure was not diagnosed"
  hash_install_state "$EVIDENCE_ROOT/after-build-failure.sha256"
  cmp "$EVIDENCE_ROOT/before-build-failure.sha256" \
    "$EVIDENCE_ROOT/after-build-failure.sha256" \
    || fail "installed state changed after failed preparation"
  assert_core_ready
  capture_unit_lifecycle build-failure-after "$EVIDENCE_ROOT/after-build-failure.lifecycle" \
    jarvis.service jarvis-terminal-host.service jarvis-alpha.service jarvis-beta.service
  assert_unit_lifecycle_unchanged "$EVIDENCE_ROOT/before-build-failure.lifecycle" \
    "$EVIDENCE_ROOT/after-build-failure.lifecycle"
  assert_active_enabled jarvis-alpha.service
  assert_active_enabled jarvis-beta.service
  assert_http_ok http://127.0.0.1:4311/health
  assert_http_ok http://127.0.0.1:4312/health
  printf 'VM_GATE|ASSERT|failed-build-state-hashes|PASS\n'
  printf 'VM_GATE|ASSERT|failed-build-service-lifecycle|PASS|detail=invocation-active-enter-and-enabled-state-unchanged\n'

  write_manifest "$ALPHA_ROOT" alpha 'Alpha fixture' jarvis-alpha-renamed.service 4311 ./unhealthy-runner.mjs
  if activation_failure_output="$(bash "$REPO_ROOT/deploy/systemd/install.sh" \
    "$ALPHA_MANIFEST" "$BETA_MANIFEST" 2>&1)"; then
    fail "unhealthy renamed activation unexpectedly succeeded"
  fi
  printf '%s\n' "$activation_failure_output"
  grep -Fq 'Managed deployment health failed: http://127.0.0.1:4311/health' \
    <<< "$activation_failure_output" || fail "activation failure did not name the failed health URL"
  assert_active_enabled jarvis-alpha.service
  assert_not_active jarvis-alpha-renamed.service
  wait_for_health jarvis-alpha.service http://127.0.0.1:4311/health 10
  node --input-type=commonjs -e '
    const registry = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (!registry.retiringUnits.some(item => item.systemdUnit === "jarvis-alpha.service"
      && item.phase === "pending" && item.replacementUnit === "jarvis-alpha-renamed.service")) process.exit(1);
  ' "$REGISTRY"
  journal_excerpt rename-failure jarvis-alpha.service jarvis-alpha-renamed.service jarvis.service

  write_manifest "$ALPHA_ROOT" alpha 'Alpha fixture' jarvis-alpha-renamed.service 4311 ./runner.mjs
  bash "$REPO_ROOT/deploy/systemd/install.sh" "$ALPHA_MANIFEST" "$BETA_MANIFEST"
  assert_active_enabled jarvis-alpha-renamed.service
  assert_not_active jarvis-alpha.service
  [[ ! -e "$SYSTEMD_USER_DIR/jarvis-alpha.service" ]] || fail "old renamed unit file remains"
  assert_http_ok http://127.0.0.1:4311/health
  assert_registry_v2
  node --input-type=commonjs -e '
    const registry = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (registry.retiringUnits.length !== 0) process.exit(1);
  ' "$REGISTRY"
  printf 'VM_GATE|ASSERT|rename-readiness-recovery|PASS\n'
  phase_pass

  phase_start 5-rename-removal
  write_unrelated_unit
  bash "$REPO_ROOT/deploy/systemd/install.sh" "$ALPHA_MANIFEST"
  assert_active_enabled jarvis-alpha-renamed.service
  assert_not_active jarvis-beta.service
  [[ ! -e "$SYSTEMD_USER_DIR/jarvis-beta.service" ]] || fail "removed beta unit file remains"
  [[ ! -e "$SYSTEMD_USER_DIR/jarvis-alpha.service" ]] || fail "old alpha unit file remains"
  assert_active_enabled gate-unrelated.service
  node --input-type=commonjs -e '
    const registry = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (registry.managedUnits.length !== 1 || registry.managedUnits[0] !== "jarvis-alpha-renamed.service"
      || registry.retiringUnits.length !== 0) process.exit(1);
  ' "$REGISTRY"
  assert_core_ready
  journal_excerpt rename-removal jarvis-alpha-renamed.service jarvis-beta.service gate-unrelated.service
  phase_pass

  phase_start 6-slow-action
  printf '15\n' > "$ALPHA_ROOT/stop-delay-seconds"
  action_body="$EVIDENCE_ROOT/slow-action-body.json"
  read -r action_status action_seconds < <(
    curl --silent --show-error --max-time 35 --output "$action_body" \
      --write-out '%{http_code} %{time_total}\n' \
      --request POST --header 'content-type: application/json' \
      --data '{"action":"restart"}' \
      http://127.0.0.1:3210/api/deployments/alpha/actions
  )
  [[ "$action_status" == 200 ]] || fail "15-second restart returned HTTP $action_status"
  node --input-type=commonjs -e '
    const seconds = Number(process.argv[1]);
    if (seconds < 14 || seconds > 30) process.exit(1);
  ' "$action_seconds"
  node --input-type=commonjs -e '
    const body = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (body.accepted !== true || body.scheduled !== false) process.exit(1);
  ' "$action_body"
  wait_for_health jarvis-alpha-renamed.service http://127.0.0.1:4311/health 10
  printf 'VM_GATE|ASSERT|slow-15s-action|PASS|duration_seconds=%s\n' "$action_seconds"

  printf '0\n' > "$ALPHA_ROOT/stop-delay-seconds"
  printf '\nJARVIS_DEPLOYMENT_ACTION_TIMEOUT_MS=5000\n' >> "$HOME/.config/jarvis/.env"
  bash "$REPO_ROOT/deploy/systemd/install.sh"
  printf '15\n' > "$ALPHA_ROOT/stop-delay-seconds"
  timeout_body="$EVIDENCE_ROOT/timeout-action-body.json"
  read -r timeout_status timeout_seconds < <(
    curl --silent --show-error --max-time 15 --output "$timeout_body" \
      --write-out '%{http_code} %{time_total}\n' \
      --request POST --header 'content-type: application/json' \
      --data '{"action":"restart"}' \
      http://127.0.0.1:3210/api/deployments/alpha/actions
  )
  [[ "$timeout_status" == 504 ]] || fail "bounded action returned HTTP $timeout_status instead of 504"
  node --input-type=commonjs -e '
    const seconds = Number(process.argv[1]);
    if (seconds < 4 || seconds > 10) process.exit(1);
  ' "$timeout_seconds"
  grep -Fq 'timed out after 5000 ms' "$timeout_body" || fail "timeout response lacked detail"
  systemctl --user show jarvis-alpha-renamed.service --no-pager \
    --property=LoadState,ActiveState,SubState,Result
  wait_for_health jarvis-alpha-renamed.service http://127.0.0.1:4311/health 35
  printf '0\n' > "$ALPHA_ROOT/stop-delay-seconds"
  sed -i '/^JARVIS_DEPLOYMENT_ACTION_TIMEOUT_MS=5000$/d' "$HOME/.config/jarvis/.env"
  bash "$REPO_ROOT/deploy/systemd/install.sh"
  assert_http_ok http://127.0.0.1:4311/health
  printf 'VM_GATE|ASSERT|bounded-action-timeout|PASS|duration_seconds=%s|http=504\n' "$timeout_seconds"
  journal_excerpt slow-action jarvis.service jarvis-alpha-renamed.service
  phase_pass

  touch "$EVIDENCE_ROOT/phase1-complete"
}

run_phase2() {
  phase_start 7-reboot
  [[ -f "$EVIDENCE_ROOT/phase1-complete" ]] || fail "phase 1 marker is missing"
  [[ "$(< "$BOOT_ID_FILE")" != "$(< /proc/sys/kernel/random/boot_id)" ]] \
    || fail "boot ID did not change"
  wait_for_boot_readiness 60
  assert_core_ready
  assert_active_enabled jarvis-alpha-renamed.service
  assert_http_ok http://127.0.0.1:4311/health
  assert_not_active jarvis-beta.service
  assert_active_enabled gate-unrelated.service

  terminal_repo="$GATE_ROOT/terminal-repository"
  mkdir -p "$terminal_repo"
  git -C "$terminal_repo" init --quiet --initial-branch=main
  git -C "$terminal_repo" config user.name 'VM Gate'
  git -C "$terminal_repo" config user.email vm-gate@invalid.example
  printf 'terminal fixture\n' > "$terminal_repo/README.md"
  git -C "$terminal_repo" add README.md
  git -C "$terminal_repo" commit --quiet -m initial
  repository_payload="$(node --input-type=commonjs -e \
    'process.stdout.write(JSON.stringify({name:"VM gate terminal",path:process.argv[1]}))' "$terminal_repo")"
  repository_response="$(curl --fail --silent --show-error --max-time 5 \
    --request POST --header 'content-type: application/json' --data "$repository_payload" \
    http://127.0.0.1:3210/api/repositories)"
  repository_id="$(node --input-type=commonjs -e \
    'const value=JSON.parse(process.argv[1]); if (!value.id) process.exit(1); process.stdout.write(value.id)' \
    "$repository_response")"
  terminal_response="$(curl --fail --silent --show-error --max-time 5 \
    --request POST --header 'content-type: application/json' --data '{"name":"reboot-check"}' \
    "http://127.0.0.1:3210/api/repositories/$repository_id/terminals")"
  terminal_id="$(node --input-type=commonjs -e '
    const value = JSON.parse(process.argv[1]);
    if (!value.id || value.status !== "new") process.exit(1);
    process.stdout.write(value.id);
  ' "$terminal_response")"
  (
    cd "$REPO_ROOT"
    JARVIS_VM_GATE_TERMINAL_ID="$terminal_id" node --input-type=module <<'NODE'
import WebSocket from 'ws';

const terminalId = process.env.JARVIS_VM_GATE_TERMINAL_ID;
const marker = 'JARVIS_VM_GATE_TERMINAL_AFTER_REBOOT_OK';
const socket = new WebSocket(`ws://127.0.0.1:3210/ws/terminals/${encodeURIComponent(terminalId)}`);

await new Promise((resolve, reject) => {
  let exitSeen = false;
  let inputSent = false;
  let markerSeen = false;
  const timeout = setTimeout(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ action: 'input', data: '\u0003exit\n' }));
      socket.terminate();
    }
    reject(new Error('Timed out waiting for post-reboot terminal round trip'));
  }, 10_000);
  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
      return;
    }
    if (message.type === 'ready' && !inputSent) {
      inputSent = true;
      socket.send(JSON.stringify({
        action: 'input',
        data: "printf '%s%s\\n' 'JARVIS_VM_GATE_TERMINAL_' 'AFTER_REBOOT_OK'; exit\n",
      }));
    }
    if (message.type === 'output' && message.data.includes(marker)) markerSeen = true;
    if (message.type === 'error' || message.type === 'missing') {
      clearTimeout(timeout);
      reject(new Error(`Terminal protocol failed: ${raw.toString()}`));
    }
    if (message.type === 'exit') {
      if (message.exitCode !== 0 || !markerSeen) {
        clearTimeout(timeout);
        reject(new Error(`Terminal exited without the marker: ${raw.toString()}`));
        return;
      }
      exitSeen = true;
      socket.close(1000, 'VM gate terminal complete');
    }
  });
  socket.on('close', () => {
    clearTimeout(timeout);
    if (exitSeen && markerSeen) resolve();
    else reject(new Error('Terminal WebSocket closed before shell exit'));
  });
  socket.on('error', (error) => {
    clearTimeout(timeout);
    reject(error);
  });
});
console.log(marker);
NODE
  )
  terminal_rows="$(curl --fail --silent --show-error --max-time 5 \
    "http://127.0.0.1:3210/api/repositories/$repository_id/terminals")"
  node --input-type=commonjs -e '
    const rows = JSON.parse(process.argv[1]);
    if (!rows.some((row) => row.id === process.argv[2] && row.status === "exited")) process.exit(1);
  ' "$terminal_rows" "$terminal_id"
  printf 'VM_GATE|ASSERT|terminal-round-trip-after-reboot|PASS|repository=%s|terminal=%s|shell=exited\n' \
    "$repository_id" "$terminal_id"
  printf 'VM_GATE|JOURNAL|current-boot|BEGIN\n'
  journalctl --user -b --no-pager -n 80 \
    -u jarvis.service -u jarvis-terminal-host.service -u jarvis-alpha-renamed.service
  printf 'VM_GATE|JOURNAL|current-boot|END\n'
  phase_pass

  phase_start 8-uninstall
  assert_registry_v2
  mkdir -p "$HOME/.jarvis"
  printf 'retained state\n' > "$HOME/.jarvis/vm-gate-retained-state"
  printf 'retained config\n' > "$HOME/.config/jarvis/vm-gate-retained-config"
  [[ "$FIXTURE_ROOT" == /home/gate/vm-gate/fixtures ]] || fail "fixture cleanup guard failed"
  rm -rf -- "$FIXTURE_ROOT"
  [[ ! -e "$ALPHA_MANIFEST" && ! -e "$BETA_MANIFEST" ]] \
    || fail "managed source deletion failed"
  printf 'y\n' | bash "$REPO_ROOT/deploy/systemd/uninstall.sh"
  for unit in jarvis.service jarvis-terminal-host.service jarvis-alpha-renamed.service jarvis-beta.service jarvis-alpha.service; do
    assert_not_active "$unit"
    [[ ! -e "$SYSTEMD_USER_DIR/$unit" ]] || fail "unit file remains after uninstall: $unit"
  done
  [[ -f "$HOME/.jarvis/vm-gate-retained-state" ]] || fail "Jarvis state was removed"
  [[ -f "$HOME/.config/jarvis/vm-gate-retained-config" ]] || fail "Jarvis config was removed"
  [[ -f "$REGISTRY" ]] || fail "installed registry was not retained"
  assert_active_enabled gate-unrelated.service
  systemctl --user disable --now gate-unrelated.service
  rm "$SYSTEMD_USER_DIR/gate-unrelated.service"
  systemctl --user daemon-reload
  phase_pass

  total_seconds=$(( $(date +%s) - $(< "$RUN_STARTED_FILE") ))
  printf 'VM_GATE|RESULT|PARTIAL|total_seconds=%s|phases=8|reason=no-actual-older-revision-upgrade\n' \
    "$total_seconds"
}

mkdir -p "$EVIDENCE_ROOT" "$GATE_ROOT"

if [[ "$PHASE_MODE" == phase1 ]]; then
  run_phase1
else
  run_phase2
fi
