#!/bin/bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly GATE_ROOT="${JARVIS_VM_GATE_ROOT:-/tmp/jarvis-release-gate-duFf9r/vm}"
readonly CONTAINER_IMAGE="${JARVIS_VM_GATE_IMAGE:-jarvis-isolated-test:gate-20260911}"
readonly EXPECTED_IMAGE_ID="${JARVIS_VM_GATE_EXPECTED_IMAGE_ID:-}"
readonly CLOUD_IMAGE_NAME="noble-server-cloudimg-amd64.img"
readonly CLOUD_IMAGE_URL="https://cloud-images.ubuntu.com/noble/current/$CLOUD_IMAGE_NAME"
readonly CLOUD_SUMS_URL="https://cloud-images.ubuntu.com/noble/current/SHA256SUMS"
readonly CONTEXT_ROOT="/tmp/jarvis-release-gate-duFf9r/context-v2"
readonly RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
readonly RUN_ROOT="$GATE_ROOT/runs/$RUN_ID"
readonly IMAGE_ROOT="$GATE_ROOT/images"
readonly BASE_IMAGE="$IMAGE_ROOT/$CLOUD_IMAGE_NAME"
readonly SERIAL_LOG="$RUN_ROOT/serial.log"
readonly QEMU_LOG="$RUN_ROOT/qemu.log"
readonly SUMMARY_FILE="$RUN_ROOT/summary.txt"
readonly RUNTIME_METADATA="$RUN_ROOT/runtime-metadata.txt"
readonly SOURCE_REPORT="$RUN_ROOT/source-content-validation.json"

payload_container=''
iso_container=''

fail() {
  printf 'VM gate host error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$payload_container" ]]; then
    docker rm --force "$payload_container" >/dev/null 2>&1 || true
  fi
  if [[ -n "$iso_container" ]]; then
    docker rm --force "$iso_container" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$RUN_ROOT/staging" "$RUN_ROOT/seed-input"
  rm -f -- "$RUN_ROOT/overlay.qcow2" "$RUN_ROOT/seed.iso"
  printf 'VM gate cleanup: removed containers, staging, seed ISO, and writable overlay\n'
  printf 'VM gate retained evidence: %s\n' "$RUN_ROOT"
  exit "$status"
}
trap cleanup EXIT

case "$GATE_ROOT" in
  /tmp/jarvis-release-gate-*/vm) ;;
  *) fail "JARVIS_VM_GATE_ROOT must match /tmp/jarvis-release-gate-*/vm" ;;
esac

[[ "$REPO_ROOT" == "/home/liz.izatt/jarvis" ]] \
  || fail "this approved gate is pinned to /home/liz.izatt/jarvis"
[[ -f "$REPO_ROOT/deploy/systemd/install.sh" ]] || fail "installer is missing"
[[ -f "$CONTEXT_ROOT/.jarvis-container-context.json" ]] || fail "approved context-v2 is missing"
[[ -r /dev/kvm && -w /dev/kvm ]] || fail "KVM is not accessible"

for command in curl docker git node qemu-img sha256sum tar timeout /usr/bin/qemu-system-x86_64; do
  command -v "$command" >/dev/null || fail "required host command is unavailable: $command"
done
docker_image_id="$(docker image inspect --format '{{.Id}}' "$CONTAINER_IMAGE")" \
  || fail "container image is unavailable: $CONTAINER_IMAGE"
[[ "$docker_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || fail "container image inspection returned an invalid immutable ID"
image_id_evidence=recorded
if [[ -n "$EXPECTED_IMAGE_ID" ]]; then
  [[ "$EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || fail "JARVIS_VM_GATE_EXPECTED_IMAGE_ID must be a full sha256 image ID"
  [[ "$docker_image_id" == "$EXPECTED_IMAGE_ID" ]] \
    || fail "container image ID does not match JARVIS_VM_GATE_EXPECTED_IMAGE_ID"
  image_id_evidence=matched-expected-id
fi
printf '[host] resolved container reference %s once to immutable ID %s\n' \
  "$CONTAINER_IMAGE" "$docker_image_id"

mkdir -p "$IMAGE_ROOT" "$RUN_ROOT/staging" "$RUN_ROOT/seed-input"
touch "$SERIAL_LOG" "$QEMU_LOG"

printf '[host] downloading the published Ubuntu checksum list\n'
curl --fail --location --silent --show-error --retry 3 \
  --output "$RUN_ROOT/SHA256SUMS" "$CLOUD_SUMS_URL"
expected_image_sha="$({
  awk -v image="$CLOUD_IMAGE_NAME" '$2 == image || $2 == "*" image { print $1; exit }' \
    "$RUN_ROOT/SHA256SUMS"
})"
[[ "$expected_image_sha" =~ ^[0-9a-f]{64}$ ]] || fail "published checksum was not found"

if [[ ! -f "$BASE_IMAGE" ]]; then
  printf '[host] downloading Ubuntu 24.04 cloud image\n'
  curl --fail --location --silent --show-error --retry 3 \
    --output "$BASE_IMAGE.partial" "$CLOUD_IMAGE_URL"
  mv "$BASE_IMAGE.partial" "$BASE_IMAGE"
fi
actual_image_sha="$(sha256sum "$BASE_IMAGE" | awk '{print $1}')"
[[ "$actual_image_sha" == "$expected_image_sha" ]] \
  || fail "Ubuntu cloud image checksum mismatch"
printf '[host] verified Ubuntu image sha256=%s\n' "$actual_image_sha"

created_container="$(docker create "$docker_image_id" true)" \
  || fail "could not create payload container from immutable image ID"
[[ "$created_container" =~ ^[0-9a-f]{64}$ ]] \
  || fail "docker create returned an invalid payload container ID"
payload_container="$created_container"
docker cp "$payload_container:/workspace" "$RUN_ROOT/staging/workspace"
mkdir -p "$RUN_ROOT/staging/usr"
docker cp "$payload_container:/usr/local" "$RUN_ROOT/staging/usr/local"
docker rm "$payload_container" >/dev/null
payload_container=''

node "$SCRIPT_DIR/verify-source-content.mjs" \
  "$CONTEXT_ROOT" "$RUN_ROOT/staging/workspace" "$SOURCE_REPORT"
read -r context_sha tested_source_sha tested_source_count omitted_source_count < <(
  node --input-type=commonjs -e '
    const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write([report.approvedManifestSha256, report.testedSourceContentSha256,
      report.tested.length, report.omitted.length].join(" ") + "\n");
  ' "$SOURCE_REPORT"
)
[[ "$context_sha" =~ ^[0-9a-f]{64}$ && "$tested_source_sha" =~ ^[0-9a-f]{64}$ ]] \
  || fail "source content report returned invalid hashes"
[[ "$tested_source_count" =~ ^[1-9][0-9]*$ && "$omitted_source_count" =~ ^[0-9]+$ ]] \
  || fail "source content report returned invalid file counts"
printf '[host] matched %s image source files to approved context-v2; %s approved files were omitted\n' \
  "$tested_source_count" "$omitted_source_count"
printf '[host] explicit source and omission report: %s\n' "$SOURCE_REPORT"

git_revision="$(git -C "$REPO_ROOT" rev-parse HEAD)"
tar --create --file "$RUN_ROOT/seed-input/payload.tar" \
  --owner=0 --group=0 --numeric-owner -C "$RUN_ROOT/staging" workspace usr/local
payload_sha="$(sha256sum "$RUN_ROOT/seed-input/payload.tar" | awk '{print $1}')"
printf '%s  payload.tar\n' "$payload_sha" > "$RUN_ROOT/seed-input/payload.sha256"
cp "$SOURCE_REPORT" "$RUN_ROOT/seed-input/source-content-validation.json"

{
  printf 'RUN_UTC=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'GIT_REVISION=%s\n' "$git_revision"
  printf 'DOCKER_IMAGE_REFERENCE=%s\n' "$CONTAINER_IMAGE"
  printf 'DOCKER_IMAGE_ID=%s\n' "$docker_image_id"
  printf 'IMAGE_ID_EVIDENCE=%s\n' "$image_id_evidence"
  printf 'CONTEXT_MANIFEST_SHA256=%s\n' "$context_sha"
  printf 'TESTED_SOURCE_CONTENT_SHA256=%s\n' "$tested_source_sha"
  printf 'TESTED_SOURCE_FILE_COUNT=%s\n' "$tested_source_count"
  printf 'OMITTED_APPROVED_SOURCE_FILE_COUNT=%s\n' "$omitted_source_count"
  printf 'PAYLOAD_SHA256=%s\n' "$payload_sha"
  printf 'UBUNTU_IMAGE_SHA256=%s\n' "$actual_image_sha"
} > "$RUN_ROOT/seed-input/candidate-meta"
{
  cat "$RUN_ROOT/seed-input/candidate-meta"
  printf 'SOURCE_CONTENT_VALIDATION_REPORT=%s\n' "$SOURCE_REPORT"
  printf 'OMITTED_APPROVED_SOURCE_FILES_BEGIN\n'
  node --input-type=commonjs -e '
    const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    for (const path of report.omitted) process.stdout.write(`${JSON.stringify(path)}\n`);
  ' "$SOURCE_REPORT"
  printf 'OMITTED_APPROVED_SOURCE_FILES_END\n'
  printf 'GIT_STATUS_BEGIN\n'
  git -C "$REPO_ROOT" status --short
  printf 'GIT_STATUS_END\n'
} > "$RUN_ROOT/host-metadata.txt"

cp "$SCRIPT_DIR/user-data" "$SCRIPT_DIR/meta-data" "$SCRIPT_DIR/bootstrap.sh" \
  "$SCRIPT_DIR/guest-gate.sh" "$SCRIPT_DIR/boot-readiness.sh" \
  "$SCRIPT_DIR/jarvis-vm-gate-phase2.service" \
  "$RUN_ROOT/seed-input/"

created_container="$(docker create --user root --entrypoint /bin/bash "$docker_image_id" \
  -lc 'apt-get update && apt-get install --yes --no-install-recommends genisoimage && genisoimage -quiet -output /seed.iso -volid cidata -joliet -rock /seed-input' \
  )" || fail "could not create seed ISO container from immutable image ID"
[[ "$created_container" =~ ^[0-9a-f]{64}$ ]] \
  || fail "docker create returned an invalid seed ISO container ID"
iso_container="$created_container"
docker cp "$RUN_ROOT/seed-input" "$iso_container:/seed-input"
docker start --attach "$iso_container"
docker cp "$iso_container:/seed.iso" "$RUN_ROOT/seed.iso"
docker rm "$iso_container" >/dev/null
iso_container=''

qemu-img create -q -f qcow2 -F qcow2 -b "$BASE_IMAGE" "$RUN_ROOT/overlay.qcow2" 20G

printf '[host] starting isolated QEMU guest: 4 CPUs, 4 GiB RAM, KVM, no NIC, no shared filesystem\n'
set +e
timeout --signal=TERM --kill-after=30s 15m \
  /usr/bin/qemu-system-x86_64 \
  -name jarvis-release-gate \
  -machine accel=kvm \
  -cpu host \
  -smp 4 \
  -m 4096 \
  -display none \
  -serial "file:$SERIAL_LOG" \
  -monitor none \
  -nic none \
  -drive "file=$RUN_ROOT/overlay.qcow2,if=virtio,format=qcow2" \
  -drive "file=$RUN_ROOT/seed.iso,if=ide,media=cdrom,format=raw,readonly=on" \
  2> "$QEMU_LOG"
qemu_status=$?
set -e

if [[ "$qemu_status" -eq 124 ]]; then
  fail "QEMU exceeded the 15-minute safety timeout"
fi
[[ "$qemu_status" -eq 0 ]] || fail "QEMU exited with status $qemu_status; see $QEMU_LOG"

if grep -Fq 'VM_GATE|RESULT|FAIL|' "$SERIAL_LOG"; then
  guest_failure="$(grep -F 'VM_GATE|RESULT|FAIL|' "$SERIAL_LOG" | tail -n 1)"
  fail "guest reported failure: $guest_failure"
fi

required_phases=(
  1-preflight
  2-fresh-core
  3-registry-migration
  4-failure-recovery
  5-rename-removal
  6-slow-action
  7-reboot
  8-uninstall
)
for phase in "${required_phases[@]}"; do
  grep -Fq "VM_GATE|PHASE|$phase|PASS|" "$SERIAL_LOG" \
    || fail "missing PASS marker for phase $phase"
done
grep -Fq 'VM_GATE|RESULT|PARTIAL|' "$SERIAL_LOG" \
  || fail "guest did not report the required PARTIAL lifecycle result"
if grep -Fq 'VM_GATE|RESULT|PASS|' "$SERIAL_LOG"; then
  fail "guest incorrectly reported a full PASS without an actual older revision"
fi

runtime_line="$(grep -E '^VM_GATE\|RUNTIME\|node=v[^|[:space:]]+\|npm=[^|[:space:]]+$' \
  "$SERIAL_LOG" | tail -n 1)" || fail "guest runtime metadata is missing or invalid"
runtime_payload="${runtime_line#VM_GATE|RUNTIME|}"
node_version="${runtime_payload%%|*}"
npm_version="${runtime_payload#*|}"
node_version="${node_version#node=}"
npm_version="${npm_version#npm=}"
{
  printf 'NODE_VERSION=%s\n' "$node_version"
  printf 'NPM_VERSION=%s\n' "$npm_version"
} > "$RUNTIME_METADATA"

grep -E '^VM_GATE\|(IMAGE|RUNTIME|CAPABILITY|PHASE|RESULT)\|' "$SERIAL_LOG" > "$SUMMARY_FILE"
printf '[host] PARTIAL: eight lifecycle phases completed without historical-revision upgrade evidence\n'
printf '[host] serial evidence: %s\n' "$SERIAL_LOG"
printf '[host] phase summary: %s\n' "$SUMMARY_FILE"
printf '[host] guest runtime metadata: %s\n' "$RUNTIME_METADATA"
