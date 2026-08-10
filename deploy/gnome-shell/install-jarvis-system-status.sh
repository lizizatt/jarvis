#!/usr/bin/env bash
set -euo pipefail

extension_uuid='jarvis-system-status@jarvis'
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_dir="$script_dir/$extension_uuid"
target_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$extension_uuid"

if [[ ! -f "$source_dir/metadata.json" || ! -f "$source_dir/extension.js" ]]; then
  printf 'Jarvis GNOME extension files are missing from %s\n' "$source_dir" >&2
  exit 1
fi

mkdir -p "$(dirname "$target_dir")"
rm -rf "$target_dir"
cp -a "$source_dir" "$target_dir"

printf 'Installed %s. Log out and back in so GNOME Shell discovers it, then enable it with:\n  gnome-extensions enable %s\n' "$extension_uuid" "$extension_uuid"
