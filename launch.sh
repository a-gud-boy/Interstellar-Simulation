#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SIM_TARGET="blackhole"
HOST="127.0.0.1"
START_PORT=8080
MODE="chrome"
BACKEND=""
EXTRA_ARGS=()

usage() {
  cat <<'EOF'
Usage: ./launch.sh [OPTIONS] [-- EXTRA_BROWSER_ARGS...]

Global launcher for the Interstellar Spacetime Simulators (Gargantua Black Hole
and Morris-Thorne Traversable Wormhole) on NVIDIA GPU with live WebGL2/WebGPU
switching and cross-simulation navigation.

Simulation Options:
  --blackhole           Open Gargantua Black Hole Simulator (default)
  --wormhole            Open Morris-Thorne Wormhole Simulator
  --sim <name>          Select simulation: blackhole | wormhole

Backend Options:
  --webgpu, -w          Start directly in WebGPU backend (?backend=webgpu)
  --webgl2, --webgl     Start directly in WebGL2 backend (default)

Browser Options:
  --chrome              Launch in Google Chrome / Chromium in dark mode (default)
  --firefox, -f         Launch in Firefox (with NVIDIA WebGL2 + WebGPU enabled)
  --help, -h            Show this help message
EOF
}

set_sim_target() {
  local raw="${1,,}"
  case "${raw}" in
    blackhole|blackhole-sim|gargantua|bh)
      SIM_TARGET="blackhole"
      ;;
    wormhole|wormhole-sim|wh)
      SIM_TARGET="wormhole"
      ;;
    *)
      echo "Error: unknown simulation '${1}'. Expected 'blackhole' or 'wormhole'." >&2
      exit 1
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --blackhole)
      SIM_TARGET="blackhole"
      shift
      ;;
    --wormhole)
      SIM_TARGET="wormhole"
      shift
      ;;
    --sim)
      if [[ $# -lt 2 ]]; then
        echo "Error: --sim requires an argument ('blackhole' or 'wormhole')." >&2
        exit 1
      fi
      set_sim_target "$2"
      shift 2
      ;;
    --sim=*)
      set_sim_target "${1#*=}"
      shift
      ;;
    --webgpu|-w|webgpu)
      BACKEND="webgpu"
      shift
      ;;
    --webgl2|--webgl|webgl2|webgl)
      BACKEND="webgl2"
      shift
      ;;
    --firefox|-f)
      MODE="firefox"
      shift
      ;;
    --chrome)
      MODE="chrome"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      EXTRA_ARGS+=("$@")
      break
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ "${SIM_TARGET}" == "wormhole" ]]; then
  SIM_DIR="wormhole-sim"
  SIM_LABEL="Wormhole Sim"
else
  SIM_DIR="blackhole-sim"
  SIM_LABEL="Gargantua Black Hole Sim"
fi

APP_DIR="${SCRIPT_DIR}/${SIM_DIR}"
if [[ ! -d "${APP_DIR}" ]]; then
  echo "Error: application directory not found: ${APP_DIR}" >&2
  exit 1
fi

if [[ "${BACKEND}" == "webgpu" ]]; then
  BACKEND_LABEL="WebGPU (switchable to WebGL2 in Controls)"
  QUERY="?backend=webgpu"
elif [[ "${BACKEND}" == "webgl2" ]]; then
  BACKEND_LABEL="WebGL2 (switchable to WebGPU in Controls)"
  QUERY="?backend=webgl2"
else
  BACKEND_LABEL="WebGL2 default (switchable to WebGPU in Controls)"
  QUERY=""
fi

# Pick the first available local port starting at 8080
PORT="$(python3 - "$HOST" "$START_PORT" <<'PY'
import socket, sys
host = sys.argv[1]
port = int(sys.argv[2])
for p in range(port, port + 100):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, p))
            print(p)
            sys.exit(0)
        except OSError:
            continue
sys.exit(1)
PY
)"

if [[ -z "${PORT}" ]]; then
  echo "Error: could not find a free port starting at ${START_PORT}." >&2
  exit 1
fi

BROWSER=""
if [[ "${MODE}" == "firefox" ]]; then
  if command -v firefox >/dev/null 2>&1; then
    BROWSER="firefox"
  else
    echo "Error: firefox was not found in PATH." >&2
    exit 1
  fi
else
  for candidate in google-chrome chromium chromium-browser; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      BROWSER="${candidate}"
      break
    fi
  done
  if [[ -z "${BROWSER}" ]]; then
    echo "Error: neither google-chrome nor chromium was found in PATH (try --firefox)." >&2
    exit 1
  fi
fi

SERVER_PID=""
PROFILE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/interstellar-${MODE}-XXXXXX")"
cleanup() {
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  if [[ -n "${PROFILE_DIR}" ]] && [[ -d "${PROFILE_DIR}" ]]; then
    rm -rf "${PROFILE_DIR}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Serve Trial root so relative ../wormhole-sim/ and ../blackhole-sim/ switcher URLs both resolve
python3 -m http.server "${PORT}" --bind "${HOST}" --directory "${SCRIPT_DIR}" >/dev/null 2>&1 &
SERVER_PID=$!

# Wait briefly for the local server to begin accepting connections
python3 - "$HOST" "$PORT" <<'PY'
import socket, sys, time
host, port = sys.argv[1], int(sys.argv[2])
for _ in range(50):
    try:
        with socket.create_connection((host, port), timeout=0.1):
            sys.exit(0)
    except OSError:
        time.sleep(0.05)
sys.exit(1)
PY

URL="http://${HOST}:${PORT}/${SIM_DIR}/${QUERY}"

echo "Serving ${SCRIPT_DIR} (${SIM_LABEL} · ${BACKEND_LABEL}) at ${URL} (PID ${SERVER_PID})"
echo "Launching ${BROWSER} on NVIDIA GPU (press Ctrl-C or close the browser window to stop)..."

if [[ "${MODE}" == "firefox" ]]; then
  # Always enable WebGPU + readback workaround alongside WebGL2 on NVIDIA Wayland so live switching works
  cat > "${PROFILE_DIR}/user.js" <<'EOF'
user_pref("dom.webgpu.enabled", true);
user_pref("gfx.webgpu.ignore-blocklist", true);
// Avoid Wayland DMABUF zero-copy swapchain hangs on Linux NVIDIA (Mozilla Bug 1927839)
user_pref("dom.webgpu.allow-present-without-readback", false);
EOF
  __NV_PRIME_RENDER_OFFLOAD=1 \
  __NV_PRIME_RENDER_OFFLOAD_PROVIDER=NVIDIA-G0 \
  __GLX_VENDOR_LIBRARY_NAME=nvidia \
  __VK_LAYER_NV_optimus=NVIDIA_only \
  __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/10_nvidia.json \
  VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/nvidia_icd.json \
  "${BROWSER}" \
    --no-remote \
    --profile "${PROFILE_DIR}" \
    "${URL}" "${EXTRA_ARGS[@]}"
else
  # Seed Chrome profile preferences for dark mode UI
  mkdir -p "${PROFILE_DIR}/Default"
  cat > "${PROFILE_DIR}/Default/Preferences" <<'EOF'
{"browser":{"theme":{"color_scheme":2,"color_scheme2":2}},"extensions":{"theme":{"id":"","system_theme":0}}}
EOF

  # Enable BOTH WebGL2 (ANGLE GL) and WebGPU (Vulkan without --use-angle=vulkan) on NVIDIA GPU
  GTK_THEME=Adwaita:dark \
  __NV_PRIME_RENDER_OFFLOAD=1 \
  __NV_PRIME_RENDER_OFFLOAD_PROVIDER=NVIDIA-G0 \
  __GLX_VENDOR_LIBRARY_NAME=nvidia \
  __VK_LAYER_NV_optimus=NVIDIA_only \
  VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/nvidia_icd.json \
  "${BROWSER}" \
    --ozone-platform=x11 \
    --enable-unsafe-webgpu \
    --enable-features=Vulkan,WebUIDarkMode \
    --force-dark-mode \
    --ignore-gpu-blocklist \
    --gtk-version=3 \
    --user-data-dir="${PROFILE_DIR}" \
    --no-first-run \
    --no-default-browser-check \
    "${URL}" "${EXTRA_ARGS[@]}"
fi
