import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const bootReadinessHelper = join(scriptRoot, 'boot-readiness.sh');
const [host, guest, userData, bootstrap, phase2Unit] = await Promise.all([
  readFile(join(scriptRoot, 'run-gate.sh'), 'utf8'),
  readFile(join(scriptRoot, 'guest-gate.sh'), 'utf8'),
  readFile(join(scriptRoot, 'user-data'), 'utf8'),
  readFile(join(scriptRoot, 'bootstrap.sh'), 'utf8'),
  readFile(join(scriptRoot, 'jarvis-vm-gate-phase2.service'), 'utf8'),
]);

test('host resolves the image once and creates containers by immutable ID', () => {
  assert.equal(host.match(/docker image inspect/g)?.length, 1);
  assert.match(host, /created_container="\$\(docker create "\$docker_image_id" true\)"/);
  assert.match(host, /created_container="\$\(docker create --user root --entrypoint \/bin\/bash "\$docker_image_id"/);
  assert.match(host, /payload_container="\$created_container"/);
  assert.match(host, /iso_container="\$created_container"/);
  assert.doesNotMatch(host, /docker create[^\n]*--name/);
  assert.doesNotMatch(host, /PASS_PREVALIDATED|prevalidated-image/);
});

test('host records source and payload hashes and accepts only partial lifecycle evidence', () => {
  assert.match(host, /verify-source-content\.mjs/);
  assert.match(host, /TESTED_SOURCE_CONTENT_SHA256/);
  assert.match(host, /PAYLOAD_SHA256/);
  assert.match(host, /OMITTED_APPROVED_SOURCE_FILES_BEGIN/);
  assert.match(host, /VM_GATE\|RESULT\|PARTIAL\|/);
  assert.doesNotMatch(host, /\[host\] PASS:/);
  assert.match(host, /3-registry-migration/);
});

test('host retains structured guest Node and npm versions', () => {
  assert.match(guest, /VM_GATE\|RUNTIME\|node=%s\|npm=%s/);
  assert.match(host, /RUNTIME_METADATA="\$RUN_ROOT\/runtime-metadata\.txt"/);
  assert.match(host, /NODE_VERSION=%s/);
  assert.match(host, /NPM_VERSION=%s/);
  assert.match(host, /\(IMAGE\|RUNTIME\|CAPABILITY\|PHASE\|RESULT\)/);
});

test('guest guards the disposable environment before mutable setup', () => {
  const sentinelGuard = guest.indexOf('[[ "${JARVIS_VM_GATE_SENTINEL:-}" == "$SENTINEL_VALUE" ]]');
  const mutableSetup = guest.indexOf('mkdir -p "$EVIDENCE_ROOT" "$GATE_ROOT"');
  assert.ok(sentinelGuard >= 0 && mutableSetup > sentinelGuard);
  assert.match(guest, /ActiveEnterTimestampMonotonic/);
  assert.match(guest, /InvocationID/);
  assert.match(guest, /systemctl --user is-enabled/);
  assert.match(guest, /failed-build-service-lifecycle/);
});

test('post-reboot terminal probe is valid ESM and exits the PTY shell', () => {
  const match = guest.match(/JARVIS_VM_GATE_TERMINAL_ID="\$terminal_id" node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/);
  assert.ok(match, 'terminal WebSocket module was not found');
  const checked = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    encoding: 'utf8',
    input: match[1],
  });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(match[1], /import WebSocket from 'ws'/);
  assert.match(match[1], /message\.type === 'ready'/);
  assert.match(match[1], /AFTER_REBOOT_OK/);
  assert.match(match[1], /; exit\\n/);
  assert.match(match[1], /message\.type === 'exit'/);
});

test('cloud-init verifies the payload before extracting it', () => {
  const checksum = userData.indexOf('sha256sum --check payload.sha256');
  const extraction = userData.indexOf('tar -xpf /mnt/jarvis-cidata/payload.tar');
  assert.ok(checksum >= 0 && extraction > checksum);
  assert.match(userData, /permissions: '0444'/);
  assert.match(userData, /install -m 0444 \/mnt\/jarvis-cidata\/candidate-meta/);
});

test('phase 2 boot handoff cannot cycle through cloud-init.target', () => {
  assert.match(phase2Unit, /^ConditionPathExists=\/home\/gate\/\.jarvis-vm-gate\/phase1-complete$/m);
  assert.match(phase2Unit, /^WantedBy=multi-user\.target$/m);
  assert.doesNotMatch(phase2Unit, /^After=.*cloud-init\.target.*$/m);
  assert.match(host, /"\$SCRIPT_DIR\/boot-readiness\.sh"/);
  assert.match(userData, /install -m 0755 \/mnt\/jarvis-cidata\/boot-readiness\.sh \/opt\/jarvis-vm-gate\/boot-readiness\.sh/);
  assert.match(guest, /source "\$BOOT_READINESS_HELPER"/);

  const startUserManager = bootstrap.indexOf('systemctl start "user@$gate_uid.service"');
  const runGuestGate = bootstrap.indexOf('/bin/bash "$GATE_SCRIPT" "$PHASE"');
  assert.ok(startUserManager >= 0 && runGuestGate > startUserManager);

  const phase2 = guest.indexOf('run_phase2()');
  const readinessWait = guest.indexOf('wait_for_boot_readiness 60', phase2);
  const coreAssertion = guest.indexOf('assert_core_ready', phase2);
  const managedAssertion = guest.indexOf('assert_active_enabled jarvis-alpha-renamed.service', phase2);
  assert.ok(phase2 >= 0 && readinessWait > phase2);
  assert.ok(coreAssertion > readinessWait && managedAssertion > readinessWait);
});

test('boot readiness refuses direct execution without probing the host', () => {
  const result = spawnSync('/bin/bash', [bootReadinessHelper], {
    encoding: 'utf8',
    env: { PATH: '' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /do not run it directly/);
  assert.doesNotMatch(result.stderr, /command not found/);
});

test('boot readiness retries an initial refusal and accepts readiness JSON', async (context) => {
  const fixture = await createBootReadinessFixture(2);
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  const result = runBootReadiness(fixture, 5);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /VM_GATE\|ASSERT\|boot-readiness\|PASS\|attempts=2/);

  const commands = await readFile(fixture.commandLog, 'utf8');
  assert.equal(commands.match(/^curl\t/gm)?.length, 2);
  assert.match(commands, /^sleep\t1$/m);
  assert.doesNotMatch(commands, /^systemctl\t--user\t(?:start|restart|enable|daemon-reload)\b/m);
});

test('boot readiness times out with unit state and journal diagnostics', async (context) => {
  const fixture = await createBootReadinessFixture(999);
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  const result = runBootReadiness(fixture, 2);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /core services did not become ready within 2s/);
  assert.match(result.stdout, /VM_GATE\|DIAGNOSTICS\|boot-readiness\|BEGIN/);
  assert.match(result.stdout, /ActiveState=active/);
  assert.match(result.stdout, /UnitFileState=enabled/);
  assert.match(result.stdout, /fixture journal for boot readiness timeout/);
  assert.match(result.stdout, /VM_GATE\|DIAGNOSTICS\|boot-readiness\|END/);

  const commands = await readFile(fixture.commandLog, 'utf8');
  assert.match(commands, /^systemctl\t--user\tshow\tjarvis\.service\b/m);
  assert.match(commands, /^systemctl\t--user\tshow\tjarvis-terminal-host\.service\b/m);
  assert.match(commands, /^journalctl\t--user\t-b\t--no-pager\t-n\t80\b/m);
  assert.doesNotMatch(commands, /^systemctl\t--user\t(?:start|restart|enable|daemon-reload)\b/m);
});

async function createBootReadinessFixture(readyAfter) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-boot-readiness-'));
  const bin = join(root, 'bin');
  const commandLog = join(root, 'commands.tsv');
  const curlCount = join(root, 'curl-count');
  const clock = join(root, 'clock');
  await mkdir(bin);
  await Promise.all([
    writeFile(commandLog, ''),
    writeFile(curlCount, '0\n'),
    writeFile(clock, '100\n'),
    writeFixtureExecutable(bin, 'systemctl', [
      'record systemctl "$@"',
      '[[ "$#" -ge 3 && "$1" == "--user" ]] || reject "systemctl $*"',
      'shift',
      'verb="$1"',
      'shift',
      'case "$verb" in',
      '  is-active)',
      '    [[ "$#" -eq 1 ]] || reject "systemctl is-active $*"',
      '    valid_unit "$1"',
      '    printf "active\\n"',
      '    ;;',
      '  is-enabled)',
      '    [[ "$#" -eq 1 ]] || reject "systemctl is-enabled $*"',
      '    valid_unit "$1"',
      '    printf "enabled\\n"',
      '    ;;',
      '  show)',
      '    [[ "$#" -eq 3 && "$2" == "--no-pager" && "$3" == "--property=LoadState,ActiveState,SubState,Result,UnitFileState" ]] || reject "systemctl show $*"',
      '    valid_unit "$1"',
      '    printf "LoadState=loaded\\nActiveState=active\\nSubState=running\\nResult=success\\nUnitFileState=enabled\\n"',
      '    ;;',
      '  *) reject "systemctl $verb $*" ;;',
      'esac',
    ], [
      'valid_unit() {',
      '  [[ "$1" == "jarvis.service" || "$1" == "jarvis-terminal-host.service" ]] || reject "unit $1"',
      '}',
    ]),
    writeFixtureExecutable(bin, 'curl', [
      'record curl "$@"',
      '[[ "$#" -eq 5 && "$1" == "--fail" && "$2" == "--silent" && "$3" == "--max-time" && "$4" == "1" && "$5" == "http://127.0.0.1:3210/api/readiness" ]] || reject "curl $*"',
      'read -r count < "$JARVIS_VM_GATE_TEST_CURL_COUNT"',
      'count=$((count + 1))',
      'printf "%s\\n" "$count" > "$JARVIS_VM_GATE_TEST_CURL_COUNT"',
      '(( count >= JARVIS_VM_GATE_TEST_READY_AFTER )) || exit 7',
      'printf "{\\"ok\\":true}\\n"',
    ]),
    writeFixtureExecutable(bin, 'date', [
      'record date "$@"',
      '[[ "$#" -eq 1 && "$1" == "+%s" ]] || reject "date $*"',
      'read -r now < "$JARVIS_VM_GATE_TEST_CLOCK"',
      'printf "%s\\n" "$now"',
      'printf "%s\\n" "$((now + 1))" > "$JARVIS_VM_GATE_TEST_CLOCK"',
    ]),
    writeFixtureExecutable(bin, 'sleep', [
      'record sleep "$@"',
      '[[ "$#" -eq 1 && "$1" == "1" ]] || reject "sleep $*"',
    ]),
    writeFixtureExecutable(bin, 'journalctl', [
      'record journalctl "$@"',
      '[[ "$*" == "--user -b --no-pager -n 80 -u jarvis.service -u jarvis-terminal-host.service" ]] || reject "journalctl $*"',
      'printf "fixture journal for boot readiness timeout\\n"',
    ]),
  ]);
  return { root, bin, commandLog, curlCount, clock, readyAfter };
}

async function writeFixtureExecutable(bin, name, body, declarations = []) {
  const script = [
    '#!/bin/bash',
    'set -euo pipefail',
    'record() {',
    '  local command_name="$1"',
    '  shift',
    '  printf "%s" "$command_name" >> "$JARVIS_VM_GATE_TEST_COMMAND_LOG"',
    '  for argument in "$@"; do printf "\\t%s" "$argument" >> "$JARVIS_VM_GATE_TEST_COMMAND_LOG"; done',
    '  printf "\\n" >> "$JARVIS_VM_GATE_TEST_COMMAND_LOG"',
    '}',
    'reject() { printf "fixture command rejected: %s\\n" "$*" >&2; exit 97; }',
    ...declarations,
    ...body,
    '',
  ].join('\n');
  await writeFile(join(bin, name), script, { mode: 0o700 });
}

function runBootReadiness(fixture, timeoutSeconds) {
  return spawnSync('/bin/bash', ['-s', '--', bootReadinessHelper, String(timeoutSeconds)], {
    encoding: 'utf8',
    input: 'set -Eeuo pipefail\nsource "$1"\nwait_for_boot_readiness "$2"\n',
    env: {
      HOME: fixture.root,
      PATH: fixture.bin,
      JARVIS_VM_GATE_NODE: process.execPath,
      JARVIS_VM_GATE_TEST_CLOCK: fixture.clock,
      JARVIS_VM_GATE_TEST_COMMAND_LOG: fixture.commandLog,
      JARVIS_VM_GATE_TEST_CURL_COUNT: fixture.curlCount,
      JARVIS_VM_GATE_TEST_READY_AFTER: String(fixture.readyAfter),
    },
  });
}
