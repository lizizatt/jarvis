#!/bin/bash
set -uo pipefail

readonly SENTINEL_PATH=/etc/jarvis-disposable-vm-gate
readonly SENTINEL_VALUE=JARVIS_DISPOSABLE_VM_GATE_V1
readonly GATE_USER=gate
readonly GATE_HOME=/home/gate
readonly GATE_SCRIPT=/opt/jarvis-vm-gate/guest-gate.sh
readonly PHASE="${1:-}"

exec > >(tee -a /var/log/jarvis-vm-gate.log /dev/ttyS0) 2>&1

poweroff_after_failure() {
  local detail="$1"
  printf 'VM_GATE|RESULT|FAIL|bootstrap=%s|detail=%s\n' "$PHASE" "$detail"
  sync
  systemctl poweroff --no-block || true
  exit 1
}

[[ "$PHASE" == phase1 || "$PHASE" == phase2 ]] \
  || poweroff_after_failure invalid-phase
[[ "$(id -u)" -eq 0 ]] || poweroff_after_failure not-root
[[ -f "$SENTINEL_PATH" ]] || poweroff_after_failure missing-sentinel
[[ "$(<"$SENTINEL_PATH")" == "$SENTINEL_VALUE" ]] \
  || poweroff_after_failure invalid-sentinel
[[ "$(< /proc/1/comm)" == systemd ]] || poweroff_after_failure pid1-is-not-systemd
[[ -b /dev/vda ]] || poweroff_after_failure disposable-virtio-disk-missing
[[ -x "$GATE_SCRIPT" ]] || poweroff_after_failure guest-script-missing

gate_uid="$(id -u "$GATE_USER")" || poweroff_after_failure gate-user-missing
[[ "$gate_uid" == 2000 ]] || poweroff_after_failure unexpected-gate-uid

loginctl enable-linger "$GATE_USER" || poweroff_after_failure enable-linger
systemctl start "user@$gate_uid.service" || poweroff_after_failure start-user-manager
[[ -S "/run/user/$gate_uid/bus" ]] || poweroff_after_failure user-bus-missing

printf 'VM_GATE|BOOTSTRAP|%s|START\n' "$PHASE"
if ! runuser --user "$GATE_USER" -- env \
  HOME="$GATE_HOME" \
  USER="$GATE_USER" \
  LOGNAME="$GATE_USER" \
  PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin \
  XDG_RUNTIME_DIR="/run/user/$gate_uid" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$gate_uid/bus" \
  JARVIS_VM_GATE_SENTINEL="$SENTINEL_VALUE" \
  /bin/bash "$GATE_SCRIPT" "$PHASE"; then
  poweroff_after_failure guest-script
fi

if [[ "$PHASE" == phase1 ]]; then
  [[ -f "$GATE_HOME/.jarvis-vm-gate/phase1-complete" ]] \
    || poweroff_after_failure phase1-marker-missing
  systemctl enable jarvis-vm-gate-phase2.service \
    || poweroff_after_failure enable-phase2
  printf 'VM_GATE|BOOTSTRAP|phase1|REBOOT\n'
  sync
  systemctl reboot
else
  systemctl disable jarvis-vm-gate-phase2.service >/dev/null 2>&1 || true
  printf 'VM_GATE|BOOTSTRAP|phase2|POWEROFF\n'
  sync
  systemctl poweroff
fi
