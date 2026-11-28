#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_PATH="${SCRIPT_DIR}/shared/sims.json"
SIM_TARGET="home"
SIM_DIR=""
SIM_LABEL="Interstellar Observatory Homepage"
HOST="127.0.0.1"
START_PORT=8080
MODE="chrome"
BACKEND=""
DRY_RUN=0
EXTRA_ARGS=()

usage() {
  cat <<'EOF'
Usage: ./launch.sh [OPTIONS] [-- EXTRA_BROWSER_ARGS...]

Global launcher for the Interstellar Spacetime Simulators (resolved dynamically
from shared/sims.json) on NVIDIA GPU with live WebGL2/WebGPU switching,
cross-simulation navigation, and native Rust desktop launch.

Simulation Options:
  --home, --hub         Open Interstellar Observatory Homepage (default)
  --blackhole           Open Gargantua Black Hole Simulator
  --wormhole            Open Morris-Thorne Wormhole Simulator
  --binary, --binary-bh Open Binary Black Hole Inspiral & GW Lensing Simulator
  --warp, --warp-drive  Open Alcubierre Warp Drive Simulator
  --supernova, --snr    Open Supernova Remnant & Nebula Simulator
  --pulsar, --magnetar  Open Magnetar & Millisecond Pulsar Simulator
  --starflight, --sf    Open Relativistic Starflight Simulator
  --lens-cluster, --lens Open Gravitational Lensing Observatory
  --tde, --tidal        Open Tidal Disruption Event Observatory
  --sim <name>          Select target: home | any canonical ID or alias in shared/sims.json

Backend Options:
  --webgpu, -w          Start directly in WebGPU backend (?backend=webgpu)
  --webgl2, --webgl     Start directly in WebGL2 backend (default)

Target / Browser Options:
  --chrome              Launch in Google Chrome / Chromium in dark mode (default)
  --firefox, -f         Launch in Firefox (with NVIDIA WebGL2 + WebGPU enabled)
  --desktop, -d         Launch native Rust desktop binary (desktop/run.sh)
  --dry-run             Resolve target/URL from shared/sims.json and exit without launching
  --help, -h            Show this help message
EOF
}

resolve_sim_json() {
  python3 - "$MANIFEST_PATH" "$1" <<'PY'
import json, sys

manifest_path, raw = sys.argv[1], sys.argv[2].strip().lower()
if raw in ("home", "hub", "index", "observatory"):
    print("home\t\tInterstellar Observatory Homepage")
    sys.exit(0)

with open(manifest_path, "r", encoding="utf-8") as fh:
    data = json.load(fh)

for sim in data.get("simulators", []):
    aliases = [a.strip().lower() for a in sim.get("aliases", [])]
    if raw == sim.get("id", "").lower() or raw == sim.get("dir", "").lower() or raw in aliases:
        label = sim.get("launchLabel") or sim.get("title") or sim["id"]
        print(f"{sim['id']}\t{sim['dir']}\t{label}")
        sys.exit(0)

sys.exit(1)
PY
}

set_sim_target() {
  local resolved
  if ! resolved="$(resolve_sim_json "$1")"; then
    echo "Error: unknown simulation '${1}' (not found in ${MANIFEST_PATH})." >&2
    exit 1
  fi
  IFS=$'\t' read -r SIM_TARGET SIM_DIR SIM_LABEL <<< "${resolved}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --home|--hub)
      set_sim_target "home"
      shift
      ;;
    --sim)
      if [[ $# -lt 2 ]]; then
        echo "Error: --sim requires an argument ('home' or any simulator alias in shared/sims.json)." >&2
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
    --desktop|-d)
      MODE="desktop"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
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
    --*)
      if resolved="$(resolve_sim_json "${1#--}")"; then
        IFS=$'\t' read -r SIM_TARGET SIM_DIR SIM_LABEL <<< "${resolved}"
        shift
      else
        EXTRA_ARGS+=("$1")
        shift
      fi
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

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

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "DRY_RUN target=${SIM_TARGET} dir=${SIM_DIR:-<root>} mode=${MODE} backend=${BACKEND:-default} label=${SIM_LABEL} query=${QUERY:-none}"
  exit 0
fi

if [[ "${MODE}" == "desktop" ]]; then
  DESKTOP_RUNNER="${SCRIPT_DIR}/desktop/run.sh"
  if [[ ! -x "${DESKTOP_RUNNER}" ]]; then
    echo "Error: desktop launcher not found or not executable: ${DESKTOP_RUNNER}" >&2
    exit 1
  fi
  echo "Launching native Rust desktop simulator (--sim ${SIM_TARGET})..."
  exec "${DESKTOP_RUNNER}" --sim "${SIM_TARGET}" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
fi

if [[ -n "${SIM_DIR}" ]]; then
  APP_DIR="${SCRIPT_DIR}/${SIM_DIR}"
  if [[ ! -d "${APP_DIR}" ]]; then
    echo "Error: application directory not found: ${APP_DIR}" >&2
    exit 1
  fi
elif [[ ! -f "${SCRIPT_DIR}/index.html" ]]; then
  echo "Error: homepage not found: ${SCRIPT_DIR}/index.html" >&2
  exit 1
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

# Serve repo root so relative switcher URLs resolve across all simulators
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

if [[ -n "${SIM_DIR}" ]]; then
  URL="http://${HOST}:${PORT}/${SIM_DIR}/${QUERY}"
else
  URL="http://${HOST}:${PORT}/${QUERY}"
fi

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
