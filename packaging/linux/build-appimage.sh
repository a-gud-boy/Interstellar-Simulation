#!/usr/bin/env bash
set -euo pipefail

# build-appimage.sh — Assemble a compliant AppDir and optionally package Interstellar-linux-x86_64.AppImage.
#
# Usage:
#   ./packaging/linux/build-appimage.sh [--bin <path>] [--out <dir>] [--dir-only]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_ID="io.github.a_gud_boy.InterstellarDesktop"

BIN_PATH="${REPO_ROOT}/desktop/target/release/interstellar-desktop"
OUT_DIR="${REPO_ROOT}/desktop/target/release-bundle"
DIR_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bin)
      BIN_PATH="$2"
      shift 2
      ;;
    --out)
      OUT_DIR="$2"
      shift 2
      ;;
    --dir-only)
      DIR_ONLY=1
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--bin <binary>] [--out <bundle-dir>] [--dir-only]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "${BIN_PATH}" ]]; then
  echo "Error: binary not found at ${BIN_PATH}" >&2
  exit 1
fi

DESKTOP_FILE="${REPO_ROOT}/packaging/linux/${APP_ID}.desktop"
METAINFO_FILE="${REPO_ROOT}/packaging/linux/${APP_ID}.metainfo.xml"
ICON_PNG="${REPO_ROOT}/shared/assets/app-icon-256.png"
ICON_SVG="${REPO_ROOT}/shared/assets/app-icon.svg"

for req in "${DESKTOP_FILE}" "${METAINFO_FILE}" "${ICON_PNG}" "${ICON_SVG}"; do
  if [[ ! -f "${req}" ]]; then
    echo "Error: missing required packaging asset: ${req}" >&2
    exit 1
  fi
done

mkdir -p "${OUT_DIR}"
APP_DIR="${OUT_DIR}/Interstellar.AppDir"
rm -rf "${APP_DIR}"
mkdir -p \
  "${APP_DIR}/usr/bin" \
  "${APP_DIR}/usr/share/applications" \
  "${APP_DIR}/usr/share/metainfo" \
  "${APP_DIR}/usr/share/icons/hicolor/256x256/apps" \
  "${APP_DIR}/usr/share/icons/hicolor/scalable/apps"

install -m 755 "${BIN_PATH}" "${APP_DIR}/usr/bin/interstellar-desktop"
install -m 644 "${DESKTOP_FILE}" "${APP_DIR}/${APP_ID}.desktop"
install -m 644 "${DESKTOP_FILE}" "${APP_DIR}/usr/share/applications/${APP_ID}.desktop"
install -m 644 "${METAINFO_FILE}" "${APP_DIR}/usr/share/metainfo/${APP_ID}.metainfo.xml"
install -m 644 "${ICON_PNG}" "${APP_DIR}/${APP_ID}.png"
install -m 644 "${ICON_PNG}" "${APP_DIR}/.DirIcon"
install -m 644 "${ICON_PNG}" "${APP_DIR}/usr/share/icons/hicolor/256x256/apps/${APP_ID}.png"
install -m 644 "${ICON_SVG}" "${APP_DIR}/usr/share/icons/hicolor/scalable/apps/${APP_ID}.svg"

cat > "${APP_DIR}/AppRun" <<'APPRUN'
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${HERE}/usr/bin/interstellar-desktop" "$@"
APPRUN
chmod 755 "${APP_DIR}/AppRun"

echo "AppDir assembled at ${APP_DIR}"

if [[ "${DIR_ONLY}" -eq 1 ]]; then
  echo "--dir-only requested; skipping appimagetool invocation."
  exit 0
fi

APPIMAGETOOL_BIN="${APPIMAGETOOL:-$(command -v appimagetool || true)}"
if [[ -z "${APPIMAGETOOL_BIN}" ]]; then
  echo "Error: appimagetool not found in PATH (set APPIMAGETOOL or pass --dir-only)" >&2
  exit 1
fi

OUT_IMAGE="${OUT_DIR}/Interstellar-linux-x86_64.AppImage"
APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 "${APPIMAGETOOL_BIN}" "${APP_DIR}" "${OUT_IMAGE}"
chmod 755 "${OUT_IMAGE}"
echo "Built AppImage: ${OUT_IMAGE}"
