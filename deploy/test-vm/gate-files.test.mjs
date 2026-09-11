import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
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

  const startUserManager = bootstrap.indexOf('systemctl start "user@$gate_uid.service"');
  const runGuestGate = bootstrap.indexOf('/bin/bash "$GATE_SCRIPT" "$PHASE"');
  assert.ok(startUserManager >= 0 && runGuestGate > startUserManager);
});
