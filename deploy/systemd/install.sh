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
readonly JAM_SERVICE_NAME="jarvis-jam-assistant"
readonly NODE_EXECUTABLE="$(command -v node || true)"
readonly COPILOT_EXECUTABLE="$(command -v copilot || true)"
readonly TAILSCALE_EXECUTABLE="$(command -v tailscale || true)"
readonly JAM_ASSISTANT_ROOT="${JARVIS_JAM_ASSISTANT_ROOT:-${HOME}/scratch/jam_assistant}"
readonly TOOL_PATH="$(dirname "$NODE_EXECUTABLE"):$(dirname "$COPILOT_EXECUTABLE")"

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
if [[ ! -f "$JAM_ASSISTANT_ROOT/package.json" ]]; then
  echo "ERROR: Jam Assistant package.json not found at $JAM_ASSISTANT_ROOT"
  echo "Set JARVIS_JAM_ASSISTANT_ROOT if the checkout lives elsewhere."
  exit 1
fi

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

# Substitute paths in template and install
SERVICE_FILE="$SYSTEMD_USER_DIR/${SERVICE_NAME}.service"
TERMINAL_SERVICE_FILE="$SYSTEMD_USER_DIR/${TERMINAL_SERVICE_NAME}.service"
JAM_SERVICE_FILE="$SYSTEMD_USER_DIR/${JAM_SERVICE_NAME}.service"
TERMINAL_RUNNER="$JARVIS_CONFIG_DIR/run-terminal-host.sh"
JAM_RUNNER="$JARVIS_CONFIG_DIR/run-jam-assistant.sh"
sed \
  -e "s|@@REPO_ROOT@@|$REPO_ROOT|g" \
  -e "s|@@NODE_EXECUTABLE@@|$NODE_EXECUTABLE|g" \
  "$SCRIPT_DIR/terminal-host.sh.template" > "$TERMINAL_RUNNER"
chmod 700 "$TERMINAL_RUNNER"
sed \
  -e "s|@@JAM_ASSISTANT_ROOT@@|$JAM_ASSISTANT_ROOT|g" \
  -e "s|@@TAILSCALE_EXECUTABLE@@|$TAILSCALE_EXECUTABLE|g" \
  "$SCRIPT_DIR/jam-assistant-runner.sh.template" > "$JAM_RUNNER"
chmod 700 "$JAM_RUNNER"
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
sed \
  -e "s|%h|$HOME|g" \
  -e "s|@@JAM_ASSISTANT_ROOT@@|$JAM_ASSISTANT_ROOT|g" \
  -e "s|@@TAILSCALE_EXECUTABLE@@|$TAILSCALE_EXECUTABLE|g" \
  -e "s|@@TOOL_PATH@@|$TOOL_PATH|g" \
  -e "s|@@JAM_RUNNER@@|$JAM_RUNNER|g" \
  "$SCRIPT_DIR/jarvis-jam-assistant.service.template" > "$JAM_SERVICE_FILE"

echo "  ✓ Installed $SERVICE_FILE, $TERMINAL_SERVICE_FILE, and $JAM_SERVICE_FILE"
echo ""

# Enable and start the service
echo "[5/6] Enabling and starting service..."
systemctl --user daemon-reload
systemctl --user enable "$TERMINAL_SERVICE_NAME"
systemctl --user enable "$SERVICE_NAME"
systemctl --user enable "$JAM_SERVICE_NAME"
systemctl --user restart "$TERMINAL_SERVICE_NAME"
systemctl --user restart "$JAM_SERVICE_NAME"
systemctl --user restart "$SERVICE_NAME"
echo "  ✓ Service enabled and started"
echo ""

# Verify
echo "[6/6] Verifying installation..."
ready=''
for attempt in $(seq 1 60); do
  if systemctl --user is-active "$SERVICE_NAME" > /dev/null \
    && systemctl --user is-active "$JAM_SERVICE_NAME" > /dev/null \
    && curl --fail --silent --show-error --max-time 1 http://127.0.0.1:3210/api/health > /dev/null \
    && curl --fail --silent --show-error --max-time 1 http://127.0.0.1:4173/ > /dev/null; then
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
  echo "  systemctl --user status $JAM_SERVICE_NAME"
  echo ""
  echo "To view logs:"
  echo "  journalctl --user -u $SERVICE_NAME -f"
  echo "  journalctl --user -u $JAM_SERVICE_NAME -f"
  echo ""
  echo "To stop the service:"
  echo "  systemctl --user stop $SERVICE_NAME"
  echo ""
  echo "Access Jarvis at: http://127.0.0.1:3210"
  echo ""
  echo "To enable phone access over Tailscale, run on this laptop:"
  echo "  tailscale serve --bg http://127.0.0.1:3210"
  echo "  # Jam Assistant is managed privately at https://<tailnet-host>:4173/"
  echo ""
else
  echo "  ✗ Services failed readiness verification. Check logs:"
  echo "  journalctl --user -u $SERVICE_NAME -u $JAM_SERVICE_NAME -n 40"
  exit 1
fi
