#!/bin/bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

project="$TMP_DIR/project"
systemd_dir="$TMP_DIR/systemd"
registry="$TMP_DIR/deployments.json"
index="$TMP_DIR/deployments.tsv"
mkdir -p "$project/deploy"
cat > "$project/deploy/run-jarvis.sh" <<'RUNNER'
#!/bin/sh
exit 0
RUNNER
chmod 700 "$project/deploy/run-jarvis.sh"
cat > "$project/build.mjs" <<'BUILD'
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('built', import.meta.url), 'yes');
BUILD
cat > "$project/jarvis.deployment.json" <<'MANIFEST'
{
  "version": 1,
  "id": "fixture",
  "name": "Fixture",
  "kind": "managed",
  "systemdUnit": "jarvis-fixture.service",
  "runner": "deploy/run-jarvis.sh",
  "build": ["node", "build.mjs"],
  "healthUrl": "http://127.0.0.1:9999/health",
  "actions": ["start", "stop", "restart"]
}
MANIFEST

node "$ROOT/tools/reconcile-deployments.mjs" --build --output "$index" --registry "$registry" \
  --systemd-dir "$systemd_dir" --template "$SCRIPT_DIR/managed-deployment.service.template" \
  "$ROOT/jarvis.deployment.json" "$project/jarvis.deployment.json"

grep -Fq $'jarvis-fixture.service\thttp://127.0.0.1:9999/health' "$index"
grep -Fq '/jarvis.deployment.json"' "$registry"
grep -Fq 'ExecStart="'"$project"'/deploy/run-jarvis.sh"' "$systemd_dir/jarvis-fixture.service"
grep -Fq 'WorkingDirectory='"$project" "$systemd_dir/jarvis-fixture.service"
test "$(cat "$project/built")" = yes
systemd-analyze verify "$systemd_dir/jarvis-fixture.service"
bash -n "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/uninstall.sh" "$SCRIPT_DIR/test.sh"
echo "generic managed deployment validation passed"
