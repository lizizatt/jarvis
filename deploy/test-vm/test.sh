#!/bin/bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for script in "$SCRIPT_DIR/run-gate.sh" "$SCRIPT_DIR/guest-gate.sh" \
  "$SCRIPT_DIR/boot-readiness.sh" "$SCRIPT_DIR/bootstrap.sh" "$SCRIPT_DIR/test.sh"; do
  bash -n "$script"
done
node --test "$SCRIPT_DIR"/*.test.mjs
