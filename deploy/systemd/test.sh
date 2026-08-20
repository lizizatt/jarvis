#!/bin/bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly TMP_DIR="$(mktemp -d)"
runner_pid=''
cleanup_test() {
  if [ -n "$runner_pid" ]; then
    kill -TERM "$runner_pid" >/dev/null 2>&1 || true
    wait "$runner_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup_test EXIT

runner="$TMP_DIR/run-jam-assistant.sh"
unit="$TMP_DIR/jarvis-jam-assistant.service"
log="$TMP_DIR/commands.log"
fake_bin="$TMP_DIR/bin"
mkdir -p "$fake_bin"

sed -e "s|@@JAM_ASSISTANT_ROOT@@|$ROOT|g" \
  -e 's|@@TAILSCALE_EXECUTABLE@@|/usr/bin/tailscale|g' \
  "$SCRIPT_DIR/jam-assistant-runner.sh.template" > "$runner"
chmod 700 "$runner"
sed -e "s|%h|$HOME|g" \
  -e "s|@@JAM_ASSISTANT_ROOT@@|$ROOT|g" \
  -e "s|@@JAM_RUNNER@@|$runner|g" \
  "$SCRIPT_DIR/jarvis-jam-assistant.service.template" > "$unit"

systemd-analyze verify "$unit"
bash -n "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/uninstall.sh" "$SCRIPT_DIR/test.sh" "$runner"
grep -Fq -- '--strictPort' "$runner"
grep -Fq -- '--https="$tailscale_port"' "$runner"
! grep -Fq -- '--https=443' "$runner"

cat > "$fake_bin/tailscale" <<'FAKE_TAILSCALE'
#!/bin/sh
printf 'tailscale %s\n' "$*" >> "$COMMAND_LOG"
exit 0
FAKE_TAILSCALE
cat > "$fake_bin/npm" <<'FAKE_NPM'
#!/bin/sh
printf 'npm %s\n' "$*" >> "$COMMAND_LOG"
node -e 'require("http").createServer((_request, response) => response.end("ready")).listen(4173, "127.0.0.1")' &
server_pid=$!
trap 'kill "$server_pid" >/dev/null 2>&1 || true; wait "$server_pid" >/dev/null 2>&1 || true; exit 0' INT TERM
wait "$server_pid"
FAKE_NPM
chmod 700 "$fake_bin"/*

COMMAND_LOG="$log" PATH="$fake_bin:$PATH" \
  JARVIS_TAILSCALE_EXECUTABLE="$fake_bin/tailscale" \
  JARVIS_JAM_ASSISTANT_TAILSCALE_PORT=4173 \
  "$runner" &
runner_pid=$!
for attempt in $(seq 1 20); do
  if grep -Fq 'tailscale serve --yes --https=4173 http://127.0.0.1:4173' "$log" 2>/dev/null; then break; fi
  sleep 0.1
done
grep -Fq 'tailscale serve --yes --https=4173 off' "$log"
grep -Fq 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort' "$log"
kill -TERM "$runner_pid"
wait "$runner_pid" || true
runner_pid=''
test "$(grep -Fc 'tailscale serve --yes --https=4173 off' "$log")" -ge 2
! grep -Fq -- '--https=443' "$log"
echo "systemd Jam Assistant lifecycle validation passed"
