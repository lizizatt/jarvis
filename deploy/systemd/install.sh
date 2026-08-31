#!/bin/bash
set -euo pipefail

# Jarvis Systemd Installation Script
# Installs Jarvis as a per-user systemd service with auto-restart on failure.

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
readonly JARVIS_CONFIG_DIR="${HOME}/.config/jarvis"
readonly SERVICE_NAME="jarvis"
readonly TERMINAL_SERVICE_NAME="jarvis-terminal-host"
readonly NODE_EXECUTABLE="$(command -v node || true)"
readonly COPILOT_EXECUTABLE="$(command -v copilot || true)"
readonly TOOL_PATH="$(dirname "$NODE_EXECUTABLE"):$(dirname "$COPILOT_EXECUTABLE")"
readonly DEPLOYMENT_REGISTRY="${JARVIS_DEPLOYMENT_REGISTRY:-${JARVIS_CONFIG_DIR}/deployments.json}"
readonly DEPLOYMENT_INDEX="${JARVIS_CONFIG_DIR}/deployments.tsv"
readonly JAM_MANIFEST="${JARVIS_JAM_ASSISTANT_MANIFEST:-${HOME}/scratch/jam_assistant/jarvis.deployment.json}"
readonly ALESIS_MANIFEST="${JARVIS_ALESIS_MANIFEST:-${HOME}/scratch/alesis/jarvis.deployment.json}"
readonly DEPLOYMENT_TEMPLATE="$SCRIPT_DIR/managed-deployment.service.template"
readonly RECONCILE_TOOL="$REPO_ROOT/tools/reconcile-deployments.mjs"
readonly DEPLOYMENT_MANIFESTS=("$REPO_ROOT/jarvis.deployment.json" "$JAM_MANIFEST" "$ALESIS_MANIFEST")

echo "=== Jarvis Systemd Installation ==="
echo "Repository: $REPO_ROOT"
echo "Systemd config: $SYSTEMD_USER_DIR"
echo ""

# Check prerequisites
echo "[1/6] Checking prerequisites..."
for cmd in node npm tailscale curl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' not found in PATH. Please install it first."
    exit 1
  fi
done
for manifest in "${DEPLOYMENT_MANIFESTS[@]}"; do
  if [[ ! -f "$manifest" ]]; then
    echo "ERROR: Deployment manifest not found at $manifest"
    exit 1
  fi
done

NODE_VERSION=$(node --version | sed 's/v//')
echo "  ✓ Node.js $NODE_VERSION"
echo "  ✓ npm $(npm --version)"
echo ""

# Build the project
echo "[2/6] Building Jarvis..."
cd "$REPO_ROOT"
npm run build > /dev/null 2>&1 || {
  echo "ERROR: Build failed. Check 'npm run build' output."
  exit 1
}
echo "  ✓ Server and web built successfully"
echo ""

# Create config directory
echo "[3/6] Setting up configuration..."
mkdir -p "$JARVIS_CONFIG_DIR"
echo "  ✓ Created $JARVIS_CONFIG_DIR"

# Copy .env.sample if .env doesn't exist
if [[ ! -f "$JARVIS_CONFIG_DIR/.env" ]]; then
  if [[ -f "$REPO_ROOT/.env.sample" ]]; then
    cp "$REPO_ROOT/.env.sample" "$JARVIS_CONFIG_DIR/.env"
    echo "  ✓ Copied .env.sample to $JARVIS_CONFIG_DIR/.env"
  fi
fi
echo ""

# Create systemd directory
echo "[4/6] Installing systemd service..."
mkdir -p "$SYSTEMD_USER_DIR"

# Substitute paths in templates and reconcile project-owned declarations
SERVICE_FILE="$SYSTEMD_USER_DIR/${SERVICE_NAME}.service"
TERMINAL_SERVICE_FILE="$SYSTEMD_USER_DIR/${TERMINAL_SERVICE_NAME}.service"
TERMINAL_RUNNER="$JARVIS_CONFIG_DIR/run-terminal-host.sh"
sed \
  -e "s|@@REPO_ROOT@@|$REPO_ROOT|g" \
  -e "s|@@NODE_EXECUTABLE@@|$NODE_EXECUTABLE|g" \
  "$SCRIPT_DIR/terminal-host.sh.template" > "$TERMINAL_RUNNER"
chmod 700 "$TERMINAL_RUNNER"
sed \
  -e "s|%h|$HOME|g" \
  -e "s|@@REPO_ROOT@@|$REPO_ROOT|g" \
  -e "s|@@NODE_EXECUTABLE@@|$NODE_EXECUTABLE|g" \
  -e "s|@@TOOL_PATH@@|$TOOL_PATH|g" \
  "$SCRIPT_DIR/jarvis.service.template" > "$SERVICE_FILE"
sed \
  -e "s|%h|$HOME|g" \
  -e "s|@@REPO_ROOT@@|$REPO_ROOT|g" \
  -e "s|@@TERMINAL_RUNNER@@|$TERMINAL_RUNNER|g" \
  "$SCRIPT_DIR/jarvis-terminal-host.service.template" > "$TERMINAL_SERVICE_FILE"
PATH="$TOOL_PATH:$PATH" "$NODE_EXECUTABLE" "$RECONCILE_TOOL" --build --output "$DEPLOYMENT_INDEX" \
  --registry "$DEPLOYMENT_REGISTRY" --systemd-dir "$SYSTEMD_USER_DIR" --template "$DEPLOYMENT_TEMPLATE" \
  "${DEPLOYMENT_MANIFESTS[@]}"
managed_units=()
health_urls=()
while IFS=$'\t' read -r unit health_url; do
  [[ -z "$unit" ]] && continue
  managed_units+=("$unit")
  [[ -z "$health_url" ]] || health_urls+=("$health_url")
done < "$DEPLOYMENT_INDEX"

echo "  ✓ Installed Jarvis and ${#managed_units[@]} managed deployment units"
echo ""

# Enable and start the service
echo "[5/6] Enabling and starting service..."
systemctl --user daemon-reload
systemctl --user enable "$TERMINAL_SERVICE_NAME"
systemctl --user enable "$SERVICE_NAME"
systemctl --user enable "${managed_units[@]}"
systemctl --user restart "$TERMINAL_SERVICE_NAME"
systemctl --user restart "${managed_units[@]}"
systemctl --user restart "$SERVICE_NAME"
echo "  ✓ Service enabled and started"
echo ""

# Verify
echo "[6/6] Verifying installation..."
ready=''
for attempt in $(seq 1 60); do
  healthy=true
  systemctl --user is-active "$SERVICE_NAME" "${managed_units[@]}" > /dev/null || healthy=false
  curl --fail --silent --show-error --max-time 1 http://127.0.0.1:3210/api/health > /dev/null || healthy=false
  for health_url in "${health_urls[@]}"; do
    curl --fail --silent --show-error --max-time 1 "$health_url" > /dev/null || healthy=false
  done
  if [[ "$healthy" == true ]]; then
    ready=true
    break
  fi
  sleep 1
done
if [[ -n "$ready" ]]; then
  echo "  ✓ Service is running"
  echo ""
  echo "=== Installation Complete ==="
  echo ""
  echo "To check status:"
  echo "  systemctl --user status $SERVICE_NAME"
  echo "  systemctl --user status ${managed_units[*]}"
  echo ""
  echo "To view logs:"
  echo "  journalctl --user -u $SERVICE_NAME -f"
  echo "  journalctl --user ${managed_units[*]/#/-u } -f"
  echo ""
  echo "To stop the service:"
  echo "  systemctl --user stop $SERVICE_NAME"
  echo ""
  echo "Access Jarvis at: http://127.0.0.1:3210"
  echo ""
  echo "To enable phone access over Tailscale, run on this laptop:"
  echo "  tailscale serve --bg http://127.0.0.1:3210"
  echo "  # Managed deployments publish their declared private Tailscale endpoints."
  echo ""
else
  echo "  ✗ Services failed readiness verification. Check logs:"
  echo "  journalctl --user -u $SERVICE_NAME ${managed_units[*]/#/-u } -n 40"
  exit 1
fi
