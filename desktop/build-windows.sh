#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="x86_64-pc-windows-msvc"
OUT_BIN="${SCRIPT_DIR}/target/${TARGET}/release/interstellar-desktop.exe"

if ! command -v cargo-xwin >/dev/null 2>&1; then
  echo "[interstellar-desktop] cargo-xwin not found. Install it with:" >&2
  echo "  cargo install --locked cargo-xwin" >&2
  exit 1
fi

if ! rustup target list --installed | grep -qx "${TARGET}"; then
  echo "[interstellar-desktop] Installing Rust target ${TARGET}..."
  rustup target add "${TARGET}"
fi

SYSROOT="$(rustc --print sysroot)"
HOST_TUPLE="$(rustc -vV | sed -n 's/^host: //p')"
RUST_LLD="${SYSROOT}/lib/rustlib/${HOST_TUPLE}/bin/rust-lld"

if [[ -x "${RUST_LLD}" && -z "${CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER:-}" ]]; then
  export CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER="${RUST_LLD}"
fi

export RUSTFLAGS="-C target-feature=+crt-static -C link-arg=/IGNORE:4099 ${RUSTFLAGS:-}"

echo "[interstellar-desktop] Cross-compiling Windows release binary (${TARGET})..."
cargo xwin build \
  --release \
  --target "${TARGET}" \
  --manifest-path "${SCRIPT_DIR}/Cargo.toml" \
  "$@"

ls -lh "${OUT_BIN}"
echo "[interstellar-desktop] Built: ${OUT_BIN}"
