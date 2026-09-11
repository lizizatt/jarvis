#!/bin/bash
set -euo pipefail

# Jarvis Systemd Uninstallation Script
# Removes Jarvis systemd service and optionally backs up configuration.

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
readonly JARVIS_CONFIG_DIR="${HOME}/.config/jarvis"
readonly DEPLOYMENT_INDEX="${JARVIS_CONFIG_DIR}/deployments.tsv"
readonly SERVICE_NAME="jarvis"
readonly TERMINAL_SERVICE_NAME="jarvis-terminal-host"
readonly NODE_EXECUTABLE="$(command -v node || true)"
readonly RESOLVE_INSTALLATION_TOOL="$REPO_ROOT/tools/resolve-installation.mjs"
if [[ "$NODE_EXECUTABLE" != /* ]]; then
  echo "ERROR: 'node' must resolve to an absolute path"
  exit 1
fi
if ! registry_plan="$($NODE_EXECUTABLE "$RESOLVE_INSTALLATION_TOOL" registry \
  --operator-env "$JARVIS_CONFIG_DIR/.env" --previous-effective-env "$JARVIS_CONFIG_DIR/effective.env" \
  --default-registry "$JARVIS_CONFIG_DIR/deployments.json")"; then
  exit 1
fi
deployment_registry=''
while IFS=$'\t' read -r key value; do
  case "$key" in
    REGISTRY) deployment_registry="$value" ;;
    *) echo "ERROR: Invalid registry plan entry: $key"; exit 1 ;;
  esac
done <<< "$registry_plan"
if [[ -z "$deployment_registry" ]]; then
  echo "ERROR: Registry plan is incomplete"
  exit 1
fi
readonly DEPLOYMENT_REGISTRY="$deployment_registry"
managed_units=()
if ! installation_inventory="$($NODE_EXECUTABLE "$RESOLVE_INSTALLATION_TOOL" inventory \
  --registry "$DEPLOYMENT_REGISTRY" --legacy-index "$DEPLOYMENT_INDEX")"; then
  exit 1
fi
while IFS=$'\t' read -r kind unit _phase; do
  [[ -z "$kind" ]] && continue
  case "$kind" in
    MANAGED|RETIRING) managed_units+=("$unit") ;;
    *) echo "ERROR: Invalid installation inventory entry: $kind"; exit 1 ;;
  esac
done <<< "$installation_inventory"

echo "=== Jarvis Systemd Uninstallation ==="
echo ""

# Check if service exists
SERVICE_FILE="$SYSTEMD_USER_DIR/${SERVICE_NAME}.service"
if [[ ! -f "$SERVICE_FILE" ]]; then
  echo "ERROR: Service file not found at $SERVICE_FILE"
  echo "Jarvis may not be installed or already uninstalled."
  exit 1
fi

echo "This will uninstall Jarvis systemd service."
echo ""
echo "The configuration directory will NOT be deleted:"
echo "  $JARVIS_CONFIG_DIR"
echo ""
echo "Your data will NOT be deleted:"
echo "  ~/.jarvis"
echo ""

# Confirm
read -p "Continue with uninstallation? (y/N) " -r confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi
echo ""

# Stop the service
echo "[1/4] Stopping service..."
if systemctl --user is-active "$SERVICE_NAME" > /dev/null 2>&1; then
  systemctl --user stop "$SERVICE_NAME"
  echo "  ✓ Service stopped"
else
  echo "  ℹ Service was not running"
fi
systemctl --user stop "$TERMINAL_SERVICE_NAME" > /dev/null 2>&1 || true
if (( ${#managed_units[@]} > 0 )); then systemctl --user stop "${managed_units[@]}" > /dev/null 2>&1 || true; fi
echo ""

# Disable the service
echo "[2/4] Disabling service..."
systemctl --user disable "$SERVICE_NAME" > /dev/null 2>&1 || true
systemctl --user disable "$TERMINAL_SERVICE_NAME" > /dev/null 2>&1 || true
if (( ${#managed_units[@]} > 0 )); then systemctl --user disable "${managed_units[@]}" > /dev/null 2>&1 || true; fi
echo "  ✓ Service disabled"
echo ""

# Remove systemd file
echo "[3/4] Removing systemd unit file..."
rm -f "$SERVICE_FILE"
rm -f "$SYSTEMD_USER_DIR/${TERMINAL_SERVICE_NAME}.service" "$JARVIS_CONFIG_DIR/run-terminal-host.sh"
for unit in "${managed_units[@]}"; do rm -f "$SYSTEMD_USER_DIR/$unit"; done
systemctl --user daemon-reload
echo "  ✓ Removed $SERVICE_FILE"
echo ""

# Optional backup
echo "[4/4] Configuration status..."
if [[ -d "$JARVIS_CONFIG_DIR" ]] && [[ -n "$(ls -A "$JARVIS_CONFIG_DIR" 2>/dev/null)" ]]; then
  echo "  ℹ Configuration preserved at: $JARVIS_CONFIG_DIR"
  echo "  ℹ If you want to back it up:"
  echo "      tar czf ~/jarvis-config-backup.tar.gz $JARVIS_CONFIG_DIR"
fi

if [[ -d "$HOME/.jarvis" ]]; then
  echo "  ℹ Data preserved at: ~/.jarvis"
  echo "  ℹ If you want to back it up:"
  echo "      tar czf ~/jarvis-data-backup.tar.gz ~/.jarvis"
fi
echo ""

echo "=== Uninstallation Complete ==="
echo ""
echo "To reinstall, run: bash deploy/systemd/install.sh"
