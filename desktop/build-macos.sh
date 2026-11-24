#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_PATH="${SCRIPT_DIR}/Cargo.toml"
BUNDLE_ROOT="${SCRIPT_DIR}/target/macos-bundle"
APP_NAME="Interstellar"
BIN_NAME="interstellar-desktop"

usage() {
  cat <<'EOF'
Usage: ./build-macos.sh [OPTIONS]

Build and package Interstellar Simulation for macOS as an .app bundle, .zip, and .dmg.
Must be run on macOS (Darwin) with Xcode Command Line Tools and Rust installed.

Options:
  --universal   Build Universal Binary (arm64 + x86_64 via lipo) [default]
  --arm64       Build Apple Silicon binary (aarch64-apple-darwin)
  --x86_64      Build Intel binary (x86_64-apple-darwin)
  --native      Build for the current Mac host architecture only
  --help, -h    Show this help message

Environment:
  APPLE_SIGN_IDENTITY   Optional codesign identity (defaults to ad-hoc "-")
EOF
}

MODE="universal"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --universal)
      MODE="universal"
      shift
      ;;
    --arm64)
      MODE="arm64"
      shift
      ;;
    --x86_64)
      MODE="x86_64"
      shift
      ;;
    --native)
      MODE="native"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown option '$1'." >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[interstellar-desktop] Error: build-macos.sh must be run on macOS (Darwin)." >&2
  echo "If you are on Linux, use the GitHub Actions workflow (.github/workflows/build-macos.yml)." >&2
  exit 1
fi

for cmd in cargo rustup codesign ditto hdiutil; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "[interstellar-desktop] Error: required tool '${cmd}' not found in PATH." >&2
    exit 1
  fi
done

if [[ "${MODE}" == "native" ]]; then
  case "$(uname -m)" in
    arm64|aarch64)
      MODE="arm64"
      ;;
    x86_64)
      MODE="x86_64"
      ;;
    *)
      echo "[interstellar-desktop] Error: unsupported host architecture '$(uname -m)'." >&2
      exit 1
      ;;
  esac
fi

ensure_target() {
  local target="$1"
  if ! rustup target list --installed | grep -qx "${target}"; then
    echo "[interstellar-desktop] Installing Rust target ${target}..."
    rustup target add "${target}"
  fi
}

CARGO_VERSION="$(sed -n 's/^version = "\([^"]*\)"/\1/p' "${MANIFEST_PATH}" | head -n 1)"
CARGO_VERSION="${CARGO_VERSION:-0.1.0-beta}"
BUNDLE_VERSION="${CARGO_VERSION%%-*}"
SHORT_VERSION="$(sed -n 's/^pub const APP_VERSION: &str = "\([^"]*\)";/\1/p' "${SCRIPT_DIR}/src/lib.rs" | head -n 1)"
SHORT_VERSION="${SHORT_VERSION:-${CARGO_VERSION}}"

APP_DIR="${BUNDLE_ROOT}/${APP_NAME}.app"
CONTENTS_DIR="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
RESOURCES_DIR="${CONTENTS_DIR}/Resources"
OUT_BIN="${MACOS_DIR}/${BIN_NAME}"

rm -rf "${APP_DIR}"
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}"

if [[ "${MODE}" == "universal" ]]; then
  if ! command -v lipo >/dev/null 2>&1; then
    echo "[interstellar-desktop] Error: 'lipo' not found in PATH (install Xcode Command Line Tools)." >&2
    exit 1
  fi
  ensure_target "aarch64-apple-darwin"
  ensure_target "x86_64-apple-darwin"

  echo "[interstellar-desktop] Building aarch64-apple-darwin release binary..."
  cargo build --release --target aarch64-apple-darwin --manifest-path "${MANIFEST_PATH}"

  echo "[interstellar-desktop] Building x86_64-apple-darwin release binary..."
  cargo build --release --target x86_64-apple-darwin --manifest-path "${MANIFEST_PATH}"

  ARM_BIN="${SCRIPT_DIR}/target/aarch64-apple-darwin/release/${BIN_NAME}"
  X64_BIN="${SCRIPT_DIR}/target/x86_64-apple-darwin/release/${BIN_NAME}"
  echo "[interstellar-desktop] Creating Universal Binary via lipo..."
  lipo -create "${ARM_BIN}" "${X64_BIN}" -output "${OUT_BIN}"
elif [[ "${MODE}" == "arm64" ]]; then
  ensure_target "aarch64-apple-darwin"
  echo "[interstellar-desktop] Building aarch64-apple-darwin release binary..."
  cargo build --release --target aarch64-apple-darwin --manifest-path "${MANIFEST_PATH}"
  cp "${SCRIPT_DIR}/target/aarch64-apple-darwin/release/${BIN_NAME}" "${OUT_BIN}"
else
  ensure_target "x86_64-apple-darwin"
  echo "[interstellar-desktop] Building x86_64-apple-darwin release binary..."
  cargo build --release --target x86_64-apple-darwin --manifest-path "${MANIFEST_PATH}"
  cp "${SCRIPT_DIR}/target/x86_64-apple-darwin/release/${BIN_NAME}" "${OUT_BIN}"
fi

chmod +x "${OUT_BIN}"

cat > "${CONTENTS_DIR}/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Interstellar</string>
  <key>CFBundleDisplayName</key>
  <string>Interstellar Simulation</string>
  <key>CFBundleIdentifier</key>
  <string>io.github.agudboy.interstellar-desktop</string>
  <key>CFBundleVersion</key>
  <string>${BUNDLE_VERSION}</string>
  <key>CFBundleShortVersionString</key>
  <string>${SHORT_VERSION}</string>
  <key>CFBundleExecutable</key>
  <string>${BIN_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.education</string>
</dict>
</plist>
EOF

if [[ -n "${APPLE_SIGN_IDENTITY:-}" && "${APPLE_SIGN_IDENTITY}" != "-" ]]; then
  echo "[interstellar-desktop] Signing ${APP_DIR} with identity '${APPLE_SIGN_IDENTITY}'..."
  codesign --force --deep --options runtime --timestamp --sign "${APPLE_SIGN_IDENTITY}" "${APP_DIR}"
else
  echo "[interstellar-desktop] Ad-hoc signing ${APP_DIR}..."
  codesign --force --deep --sign - "${APP_DIR}"
fi

ZIP_PATH="${BUNDLE_ROOT}/Interstellar-macos-${MODE}.zip"
DMG_PATH="${BUNDLE_ROOT}/Interstellar-macos-${MODE}.dmg"
rm -f "${ZIP_PATH}" "${DMG_PATH}"

echo "[interstellar-desktop] Packaging ${ZIP_PATH}..."
ditto -c -k --sequesterRsrc --keepParent "${APP_DIR}" "${ZIP_PATH}"

STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/interstellar-dmg-XXXXXX")"
cleanup() {
  if [[ -n "${STAGE_DIR:-}" && -d "${STAGE_DIR}" ]]; then
    rm -rf "${STAGE_DIR}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

ditto "${APP_DIR}" "${STAGE_DIR}/${APP_NAME}.app"
ln -s /Applications "${STAGE_DIR}/Applications"

echo "[interstellar-desktop] Packaging ${DMG_PATH}..."
hdiutil create \
  -volname "Interstellar Simulation" \
  -srcfolder "${STAGE_DIR}" \
  -ov \
  -format UDZO \
  "${DMG_PATH}"

ls -lh "${ZIP_PATH}" "${DMG_PATH}"
echo "[interstellar-desktop] macOS bundle ready:"
echo "  App: ${APP_DIR}"
echo "  Zip: ${ZIP_PATH}"
echo "  Dmg: ${DMG_PATH}"
