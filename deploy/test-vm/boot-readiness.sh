#!/bin/bash

readonly JARVIS_VM_GATE_READINESS_URL=http://127.0.0.1:3210/api/readiness
readonly JARVIS_VM_GATE_CORE_UNITS=(jarvis.service jarvis-terminal-host.service)

boot_readiness_probe() {
  local body unit
  for unit in "${JARVIS_VM_GATE_CORE_UNITS[@]}"; do
    [[ "$(systemctl --user is-active "$unit" 2>/dev/null)" == active ]] || return 1
    [[ "$(systemctl --user is-enabled "$unit" 2>/dev/null)" == enabled ]] || return 1
  done
  body="$(curl --fail --silent --max-time 1 "$JARVIS_VM_GATE_READINESS_URL" 2>/dev/null)" \
    || return 1
  "${JARVIS_VM_GATE_NODE:-node}" --input-type=commonjs -e \
    'const value=JSON.parse(process.argv[1]); if (value.ok !== true) process.exit(1);' \
    "$body" >/dev/null 2>&1
}

boot_readiness_diagnostics() {
  local unit
  printf 'VM_GATE|DIAGNOSTICS|boot-readiness|BEGIN\n'
  for unit in "${JARVIS_VM_GATE_CORE_UNITS[@]}"; do
    printf 'VM_GATE|STATE|boot-readiness|BEGIN|unit=%s\n' "$unit"
    systemctl --user show "$unit" --no-pager \
      --property=LoadState,ActiveState,SubState,Result,UnitFileState || true
    printf 'VM_GATE|STATE|boot-readiness|END|unit=%s\n' "$unit"
  done
  printf 'VM_GATE|JOURNAL|boot-readiness|BEGIN\n'
  journalctl --user -b --no-pager -n 80 \
    -u jarvis.service -u jarvis-terminal-host.service || true
  printf 'VM_GATE|JOURNAL|boot-readiness|END\n'
  printf 'VM_GATE|DIAGNOSTICS|boot-readiness|END\n'
}

wait_for_boot_readiness() {
  local timeout_seconds="${1:-60}"
  local attempts=0 deadline now
  [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || {
    printf 'ASSERTION FAILED: invalid boot readiness timeout: %s\n' "$timeout_seconds" >&2
    return 1
  }

  deadline=$(( $(date +%s) + timeout_seconds ))
  while true; do
    ((attempts += 1))
    if boot_readiness_probe; then
      printf 'VM_GATE|ASSERT|boot-readiness|PASS|attempts=%s\n' "$attempts"
      return 0
    fi
    now="$(date +%s)"
    if (( now >= deadline )); then
      boot_readiness_diagnostics
      printf 'ASSERTION FAILED: core services did not become ready within %ss\n' \
        "$timeout_seconds" >&2
      return 1
    fi
    sleep 1
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf 'Source this helper from the guarded disposable guest gate; do not run it directly.\n' >&2
  exit 1
fi
