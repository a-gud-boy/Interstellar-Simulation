#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${SCRIPT_DIR}/target/release/interstellar-desktop"

if [[ -f /usr/share/vulkan/icd.d/nvidia_icd.json && -z "${VK_ICD_FILENAMES:-}" ]]; then
  export VK_ICD_FILENAMES="/usr/share/vulkan/icd.d/nvidia_icd.json"
fi

if [[ ! -x "${BIN}" ]]; then
  echo "[interstellar-desktop] Building release binary..."
  cargo build --release --manifest-path "${SCRIPT_DIR}/Cargo.toml"
fi

exec "${BIN}" "$@"
