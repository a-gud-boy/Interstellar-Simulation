#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${SCRIPT_DIR}/target/release/interstellar-desktop"

if [[ -f /usr/share/vulkan/icd.d/nvidia_icd.json && -z "${VK_ICD_FILENAMES:-}" ]]; then
  export VK_ICD_FILENAMES="/usr/share/vulkan/icd.d/nvidia_icd.json"
fi

if command -v cargo >/dev/null 2>&1; then
  cargo build --release --manifest-path "${SCRIPT_DIR}/Cargo.toml"
elif [[ ! -x "${BIN}" ]]; then
  echo "[interstellar-desktop] Error: release binary not found (${BIN}) and 'cargo' is not in PATH." >&2
  exit 1
fi

exec "${BIN}" "$@"
