#!/bin/bash
set -euo pipefail

# Jarvis Systemd Uninstallation Script
# Removes Jarvis systemd service and optionally backs up configuration.

readonly SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
readonly JARVIS_CONFIG_DIR="${HOME}/.config/jarvis"
readonly SERVICE_NAME="jarvis"
readonly TERMINAL_SERVICE_NAME="jarvis-terminal-host"
readonly DEPLOYMENT_REGISTRY="${JARVIS_DEPLOYMENT_REGISTRY:-${JARVIS_CONFIG_DIR}/deployments.json}"
managed_units=()
if [[ -f "$DEPLOYMENT_REGISTRY" ]]; then
  while IFS= read -r unit; do managed_units+=("$unit"); done < <(node -e '
    const fs = require("node:fs");
    const registry = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const manifestPath of registry.manifests ?? []) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.kind === "managed" && /^jarvis-[a-z0-9-]+\.service$/.test(manifest.systemdUnit)) console.log(manifest.systemdUnit);
    }
  ' "$DEPLOYMENT_REGISTRY")
fi

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
