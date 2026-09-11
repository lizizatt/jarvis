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
readonly DEPLOYMENT_INDEX="${JARVIS_CONFIG_DIR}/deployments.tsv"
readonly EFFECTIVE_ENVIRONMENT="${JARVIS_CONFIG_DIR}/effective.env"
readonly INSTALLED_SELF_MANIFEST="${JARVIS_CONFIG_DIR}/self.deployment.json"
readonly PUBLICATION_RECOVERY="${JARVIS_CONFIG_DIR}/install-publication.json"
readonly DEPLOYMENT_TEMPLATE="$SCRIPT_DIR/managed-deployment.service.template"
readonly RECONCILE_TOOL="$REPO_ROOT/tools/reconcile-deployments.mjs"
readonly RESOLVE_INSTALLATION_TOOL="$REPO_ROOT/tools/resolve-installation.mjs"

core_only=false
managed_manifests=()
cli_manifests=false
for argument in "$@"; do
  case "$argument" in
    --core-only)
      core_only=true
      ;;
    --*)
      echo "ERROR: Unknown option: $argument"
      echo "Usage: $0 [--core-only | /absolute/path/to/jarvis.deployment.json ...]"
      exit 1
      ;;
    *)
      managed_manifests+=("$argument")
      cli_manifests=true
      ;;
  esac
done
if [[ "$core_only" == true && ${#managed_manifests[@]} -gt 0 ]]; then
  echo "ERROR: --core-only cannot be combined with deployment manifests"
  exit 1
fi
selection_mode=preserve
if [[ "$core_only" == true || "$cli_manifests" == true ]]; then
  selection_mode=replace
elif [[ -n "${JARVIS_JAM_ASSISTANT_MANIFEST:-}" || -n "${JARVIS_ALESIS_MANIFEST:-}" ]]; then
  selection_mode=replace
  [[ -z "${JARVIS_JAM_ASSISTANT_MANIFEST:-}" ]] || managed_manifests+=("$JARVIS_JAM_ASSISTANT_MANIFEST")
  [[ -z "${JARVIS_ALESIS_MANIFEST:-}" ]] || managed_manifests+=("$JARVIS_ALESIS_MANIFEST")
fi

echo "=== Jarvis Systemd Installation ==="
echo "Repository: $REPO_ROOT"
echo "Systemd config: $SYSTEMD_USER_DIR"
echo ""

# Check prerequisites
echo "[1/6] Checking prerequisites..."
for cmd in node npm curl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' not found in PATH. Please install it first."
    exit 1
  fi
done
if [[ "$NODE_EXECUTABLE" != /* ]]; then
  echo "ERROR: 'node' must resolve to an absolute path"
  exit 1
fi
build_path="${JARVIS_BUILD_PATH:-${PATH:-}}"
if [[ -z "$build_path" || "$build_path" == :* || "$build_path" == *: || "$build_path" == *::* ]]; then
  echo "ERROR: Build PATH must contain only non-empty absolute directory entries"
  exit 1
fi
IFS=: read -r -a build_path_entries <<< "$build_path"
for path_entry in "${build_path_entries[@]}"; do
  if [[ "$path_entry" != /* || "$path_entry" == *$'\n'* || "$path_entry" == *$'\r'* || "$path_entry" == *$'\t'* ]]; then
    echo "ERROR: Build PATH must contain only non-empty absolute directory entries"
    exit 1
  fi
done
readonly BUILD_PATH="$build_path"
if [[ -f "$PUBLICATION_RECOVERY" ]]; then
  echo "  Recovering interrupted installation publication..."
  "$NODE_EXECUTABLE" "$RESOLVE_INSTALLATION_TOOL" recover --recovery-file "$PUBLICATION_RECOVERY"
fi
for manifest in "$REPO_ROOT/jarvis.deployment.json" "${managed_manifests[@]}"; do
  if [[ "$manifest" != /* ]]; then
    echo "ERROR: Deployment manifest path must be absolute: $manifest"
    exit 1
  fi
  if [[ ! -f "$manifest" ]]; then
    echo "ERROR: Deployment manifest not found at $manifest"
    exit 1
  fi
done

tool_path_entries=("$(dirname "$NODE_EXECUTABLE")")
if [[ -n "$COPILOT_EXECUTABLE" ]]; then
  if [[ "$COPILOT_EXECUTABLE" != /* ]]; then
    echo "ERROR: 'copilot' must resolve to an absolute path"
    exit 1
  fi
  tool_path_entries+=("$(dirname "$COPILOT_EXECUTABLE")")
fi
tool_path_entries+=(/usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /snap/bin /opt/nodejs/bin)
for path_entry in "${tool_path_entries[@]}"; do
  if [[ "$path_entry" != /* || "$path_entry" == *:* || "$path_entry" == *$'\n'* || "$path_entry" == *$'\r'* ]]; then
    echo "ERROR: Service PATH entries must be absolute paths without separators or control characters"
    exit 1
  fi
done
printf -v TOOL_PATH '%s:' "${tool_path_entries[@]}"
readonly TOOL_PATH="${TOOL_PATH%:}"

resolve_arguments=(
  resolve
  --operator-env "$JARVIS_CONFIG_DIR/.env"
  --previous-effective-env "$EFFECTIVE_ENVIRONMENT"
  --default-registry "$JARVIS_CONFIG_DIR/deployments.json"
  --selection "$selection_mode"
)
for manifest in "${managed_manifests[@]}"; do
  resolve_arguments+=(--manifest "$manifest")
done
if ! installation_plan="$($NODE_EXECUTABLE "$RESOLVE_INSTALLATION_TOOL" "${resolve_arguments[@]}")"; then
  exit 1
fi
managed_manifests=()
effective_host=''
effective_port=''
deployment_registry=''
previous_deployment_registry=''
server_health_url=''
allow_insecure=''
while IFS=$'\t' read -r key value; do
  case "$key" in
    HOST) effective_host="$value" ;;
    PORT) effective_port="$value" ;;
    REGISTRY) deployment_registry="$value" ;;
    PREVIOUS_REGISTRY) previous_deployment_registry="$value" ;;
    HEALTH_URL) server_health_url="$value" ;;
    ALLOW_INSECURE) allow_insecure="$value" ;;
    MANIFEST) managed_manifests+=("$value") ;;
    *) echo "ERROR: Invalid installation plan entry: $key"; exit 1 ;;
  esac
done <<< "$installation_plan"
if [[ -z "$effective_host" || -z "$effective_port" || -z "$deployment_registry" || -z "$previous_deployment_registry" || -z "$server_health_url" || -z "$allow_insecure" ]]; then
  echo "ERROR: Installation plan is incomplete"
  exit 1
fi
if [[ "$server_health_url" != */api/health ]]; then
  echo "ERROR: Effective health URL must end in /api/health"
  exit 1
fi
readonly DEPLOYMENT_REGISTRY="$deployment_registry"
readonly PREVIOUS_DEPLOYMENT_REGISTRY="$previous_deployment_registry"
readonly SERVER_BASE_URL="${server_health_url%/api/health}"
readonly SERVER_READINESS_URL="$SERVER_BASE_URL/api/readiness"
readonly SERVER_PWA_URL="$SERVER_BASE_URL/"

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
mkdir -p "$SYSTEMD_USER_DIR"
stage_dir="$(mktemp -d "$JARVIS_CONFIG_DIR/.install-stage.XXXXXX")"
trap 'rm -rf "$stage_dir"' EXIT
stage_config_dir="$stage_dir/config"
stage_systemd_dir="$stage_dir/systemd"
mkdir -p "$stage_config_dir" "$stage_systemd_dir"
echo "  ✓ Created $JARVIS_CONFIG_DIR"

# Stage .env.sample if .env doesn't exist
staged_operator_environment=''
if [[ ! -f "$JARVIS_CONFIG_DIR/.env" ]]; then
  if [[ -f "$REPO_ROOT/.env.sample" ]]; then
    staged_operator_environment="$stage_config_dir/operator.env"
    cp "$REPO_ROOT/.env.sample" "$staged_operator_environment"
  fi
fi
staged_effective_environment="$stage_config_dir/effective.env"
staged_self_manifest="$stage_config_dir/self.deployment.json"
$NODE_EXECUTABLE "$RESOLVE_INSTALLATION_TOOL" write \
  --effective-env "$staged_effective_environment" --self-output "$staged_self_manifest" \
  --self-template "$REPO_ROOT/jarvis.deployment.json" --host "$effective_host" \
  --port "$effective_port" --registry "$DEPLOYMENT_REGISTRY" --health-url "$server_health_url" \
  --allow-insecure "$allow_insecure"
echo ""

# Prepare systemd outputs without changing the installed definitions
echo "[4/6] Installing systemd service..."
SERVICE_FILE="$SYSTEMD_USER_DIR/${SERVICE_NAME}.service"
TERMINAL_SERVICE_FILE="$SYSTEMD_USER_DIR/${TERMINAL_SERVICE_NAME}.service"
TERMINAL_RUNNER="$JARVIS_CONFIG_DIR/run-terminal-host.sh"
staged_service_file="$stage_systemd_dir/${SERVICE_NAME}.service"
staged_terminal_service_file="$stage_systemd_dir/${TERMINAL_SERVICE_NAME}.service"
staged_terminal_runner="$stage_config_dir/run-terminal-host.sh"
staged_registry="$stage_config_dir/deployments.json"
staged_index="$stage_config_dir/deployments.tsv"
sed \
  -e "s|@@REPO_ROOT@@|$REPO_ROOT|g" \
  -e "s|@@NODE_EXECUTABLE@@|$NODE_EXECUTABLE|g" \
  "$SCRIPT_DIR/terminal-host.sh.template" > "$staged_terminal_runner"
chmod 700 "$staged_terminal_runner"
sed \
  -e "s|%h|$HOME|g" \
  -e "s|@@REPO_ROOT@@|$REPO_ROOT|g" \
  -e "s|@@NODE_EXECUTABLE@@|$NODE_EXECUTABLE|g" \
  -e "s|@@TOOL_PATH@@|$TOOL_PATH|g" \
  "$SCRIPT_DIR/jarvis.service.template" > "$staged_service_file"
sed \
  -e "s|%h|$HOME|g" \
  -e "s|@@REPO_ROOT@@|$REPO_ROOT|g" \
  -e "s|@@TERMINAL_RUNNER@@|$TERMINAL_RUNNER|g" \
  "$SCRIPT_DIR/jarvis-terminal-host.service.template" > "$staged_terminal_service_file"
PATH="$TOOL_PATH" "$NODE_EXECUTABLE" "$RECONCILE_TOOL" --build --build-path "$BUILD_PATH" \
  --output "$staged_index" \
  --registry "$staged_registry" --systemd-dir "$stage_systemd_dir" --template "$DEPLOYMENT_TEMPLATE" \
  --previous-registry "$PREVIOUS_DEPLOYMENT_REGISTRY" --previous-index "$DEPLOYMENT_INDEX" \
  --selection "$selection_mode" \
  --self-manifest "$staged_self_manifest" --self-provenance "$REPO_ROOT/jarvis.deployment.json" \
  "${managed_manifests[@]}"
managed_units=()
health_urls=()
while IFS=$'\t' read -r unit deployment_health_url; do
  [[ -z "$unit" ]] && continue
  managed_units+=("$unit")
  [[ -z "$deployment_health_url" ]] || health_urls+=("$deployment_health_url")
done < "$staged_index"

publication_arguments=(
  publish --recovery-file "$PUBLICATION_RECOVERY"
  --entry "$staged_terminal_runner" "$TERMINAL_RUNNER"
  --entry "$staged_service_file" "$SERVICE_FILE"
  --entry "$staged_terminal_service_file" "$TERMINAL_SERVICE_FILE"
)
if [[ -n "$staged_operator_environment" ]]; then
  publication_arguments+=(--entry "$staged_operator_environment" "$JARVIS_CONFIG_DIR/.env")
fi
for unit in "${managed_units[@]}"; do
  publication_arguments+=(--entry "$stage_systemd_dir/$unit" "$SYSTEMD_USER_DIR/$unit")
done
publication_arguments+=(
  --entry "$staged_self_manifest" "$INSTALLED_SELF_MANIFEST"
  --entry "$staged_index" "$DEPLOYMENT_INDEX"
  --entry "$staged_registry" "$DEPLOYMENT_REGISTRY"
  --entry "$staged_effective_environment" "$EFFECTIVE_ENVIRONMENT"
)
"$NODE_EXECUTABLE" "$RESOLVE_INSTALLATION_TOOL" "${publication_arguments[@]}"

retiring_units=()
retirement_phases=()
retirement_was_active=()
retirement_replacements=()
if ! installation_inventory="$($NODE_EXECUTABLE "$RESOLVE_INSTALLATION_TOOL" inventory --registry "$DEPLOYMENT_REGISTRY")"; then
  exit 1
fi
while IFS=$'\t' read -r kind unit phase was_active replacement; do
  [[ -z "$kind" ]] && continue
  case "$kind" in
    MANAGED) ;;
    RETIRING)
      retiring_units+=("$unit")
      retirement_phases+=("$phase")
      retirement_was_active+=("$was_active")
      retirement_replacements+=("$replacement")
      ;;
    *) echo "ERROR: Invalid installation inventory entry: $kind"; exit 1 ;;
  esac
done <<< "$installation_inventory"

echo "  ✓ Installed Jarvis and ${#managed_units[@]} managed deployment units"
echo ""

# Enable and start the service
echo "[5/6] Enabling and starting service..."
restore_retiring_units() {
  local stop_replacements="$1"
  local rollback_failed=false
  local index unit replacement
  for index in "${!retiring_units[@]}"; do
    replacement="${retirement_replacements[$index]}"
    if [[ "$stop_replacements" == true && "$replacement" != - ]]; then
      systemctl --user stop "$replacement" || rollback_failed=true
      systemctl --user disable "$replacement" || rollback_failed=true
    fi
  done
  for index in "${!retiring_units[@]}"; do
    unit="${retiring_units[$index]}"
    if [[ "${retirement_was_active[$index]}" == true ]]; then
      "$NODE_EXECUTABLE" "$RESOLVE_INSTALLATION_TOOL" retirement \
        --registry "$DEPLOYMENT_REGISTRY" --unit "$unit" --phase pending --was-active true \
        || rollback_failed=true
      systemctl --user enable "$unit" || rollback_failed=true
      systemctl --user restart "$unit" || rollback_failed=true
      retirement_phases[$index]=pending
    fi
  done
  if [[ "$rollback_failed" == true ]]; then
    echo "ERROR: Failed to fully restore previously active retiring units; retry the installer after inspecting service status" >&2
  fi
}

prepare_retiring_units() {
  local index unit was_active
  for index in "${!retiring_units[@]}"; do
    unit="${retiring_units[$index]}"
    if [[ "${retirement_phases[$index]}" == pending ]]; then
      was_active="${retirement_was_active[$index]}"
      if [[ "$was_active" == unknown ]]; then
        if systemctl --user is-active "$unit" > /dev/null; then
          was_active=true
        else
          was_active=false
        fi
        "$NODE_EXECUTABLE" "$RESOLVE_INSTALLATION_TOOL" retirement \
          --registry "$DEPLOYMENT_REGISTRY" --unit "$unit" --phase pending --was-active "$was_active" \
          || return
        retirement_was_active[$index]="$was_active"
      fi
      systemctl --user stop "$unit" || return
      systemctl --user disable "$unit" || return
      "$NODE_EXECUTABLE" "$RESOLVE_INSTALLATION_TOOL" retirement \
        --registry "$DEPLOYMENT_REGISTRY" --unit "$unit" --phase disabled || return
      retirement_phases[$index]=disabled
    fi
  done
}

activate_services() {
  systemctl --user daemon-reload || return
  systemctl --user enable "$TERMINAL_SERVICE_NAME" || return
  systemctl --user enable "$SERVICE_NAME" || return
  if [[ ${#managed_units[@]} -gt 0 ]]; then
    systemctl --user enable "${managed_units[@]}" || return
  fi
  systemctl --user restart "$TERMINAL_SERVICE_NAME" || return
  if [[ ${#managed_units[@]} -gt 0 ]]; then
    systemctl --user restart "${managed_units[@]}" || return
  fi
  systemctl --user restart "$SERVICE_NAME" || return
}

if prepare_retiring_units; then
  :
else
  activation_status=$?
  restore_retiring_units false
  exit "$activation_status"
fi
if activate_services; then
  :
else
  activation_status=$?
  restore_retiring_units true
  exit "$activation_status"
fi
echo "  ✓ Service enabled and started"
echo ""

# Verify
echo "[6/6] Verifying installation..."
ready=''
required_units=("$SERVICE_NAME" "$TERMINAL_SERVICE_NAME" "${managed_units[@]}")
inactive_units=()
failed_health_urls=()
liveness_ok=false
readiness_ok=false
pwa_ok=false
readiness_detail=''
readiness_body_file="$stage_dir/readiness-body"
readiness_error_file="$stage_dir/readiness-error"
for attempt in $(seq 1 60); do
  healthy=true
  inactive_units=()
  for unit in "${required_units[@]}"; do
    if ! systemctl --user is-active "$unit" > /dev/null; then
      inactive_units+=("$unit")
      healthy=false
    fi
  done
  if curl --fail --silent --show-error --max-time 1 "$server_health_url" > /dev/null; then
    liveness_ok=true
  else
    liveness_ok=false
    healthy=false
  fi
  : > "$readiness_body_file"
  : > "$readiness_error_file"
  readiness_http_status=''
  if readiness_http_status="$(curl --silent --show-error --max-time 1 \
    --output "$readiness_body_file" --write-out '%{http_code}' "$SERVER_READINESS_URL" \
    2> "$readiness_error_file")" \
    && [[ "$readiness_http_status" =~ ^[23][0-9][0-9]$ ]]; then
    readiness_ok=true
    readiness_detail=''
  else
    readiness_ok=false
    healthy=false
    if [[ -s "$readiness_body_file" ]]; then
      readiness_detail="$(<"$readiness_body_file")"
    elif [[ -s "$readiness_error_file" ]]; then
      readiness_detail="$(<"$readiness_error_file")"
    else
      readiness_detail="HTTP status $readiness_http_status"
    fi
  fi
  if curl --fail --silent --show-error --max-time 1 "$SERVER_PWA_URL" > /dev/null; then
    pwa_ok=true
  else
    pwa_ok=false
    healthy=false
  fi
  failed_health_urls=()
  for health_url in "${health_urls[@]}"; do
    if ! curl --fail --silent --show-error --max-time 1 "$health_url" > /dev/null; then
      failed_health_urls+=("$health_url")
      healthy=false
    fi
  done
  if [[ "$healthy" == true ]]; then
    ready=true
    break
  fi
  sleep 1
done
if [[ -n "$ready" ]]; then
  for unit in "${retiring_units[@]}"; do
    rm -f "$SYSTEMD_USER_DIR/$unit"
  done
  if [[ ${#retiring_units[@]} -gt 0 ]]; then
    systemctl --user daemon-reload
  fi
  for unit in "${retiring_units[@]}"; do
    "$NODE_EXECUTABLE" "$RESOLVE_INSTALLATION_TOOL" retirement \
      --registry "$DEPLOYMENT_REGISTRY" --unit "$unit" --phase complete
  done
  echo "  ✓ Service is running"
  echo ""
  echo "=== Installation Complete ==="
  echo ""
  echo "To check status:"
  echo "  systemctl --user status $SERVICE_NAME"
  if [[ ${#managed_units[@]} -gt 0 ]]; then
    echo "  systemctl --user status ${managed_units[*]}"
  fi
  echo ""
  echo "To view logs:"
  echo "  journalctl --user -u $SERVICE_NAME -f"
  if [[ ${#managed_units[@]} -gt 0 ]]; then
    echo "  journalctl --user ${managed_units[*]/#/-u } -f"
  fi
  echo ""
  echo "To stop the service:"
  echo "  systemctl --user stop $SERVICE_NAME"
  echo ""
  echo "Access Jarvis at: ${server_health_url%/api/health}"
  echo ""
  echo "To enable phone access over Tailscale, run on this laptop:"
  echo "  tailscale serve --bg ${server_health_url%/api/health}"
  echo "  # Managed deployments publish their declared private Tailscale endpoints."
  echo ""
else
  echo "  ✗ Services failed readiness verification after 60 attempts:"
  for unit in "${inactive_units[@]}"; do
    echo "    - Required unit is not active: $unit"
  done
  if [[ "$liveness_ok" != true ]]; then
    echo "    - Jarvis liveness failed: $server_health_url"
  fi
  if [[ "$readiness_ok" != true ]]; then
    echo "    - Jarvis readiness failed: $SERVER_READINESS_URL"
    if [[ -n "$readiness_detail" ]]; then
      echo "      $readiness_detail"
    fi
  fi
  if [[ "$pwa_ok" != true ]]; then
    echo "    - PWA entry failed: $SERVER_PWA_URL"
  fi
  for health_url in "${failed_health_urls[@]}"; do
    echo "    - Managed deployment health failed: $health_url"
  done
  echo "  Check status and logs:"
  echo "    systemctl --user status ${required_units[*]}"
  echo "    journalctl --user -u $SERVICE_NAME -u $TERMINAL_SERVICE_NAME -n 40"
  restore_retiring_units true
  exit 1
fi
