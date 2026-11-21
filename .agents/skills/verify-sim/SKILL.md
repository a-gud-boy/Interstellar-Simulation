---
name: verify-sim
description: >-
  Runs the full deterministic verification suite (physics_check.mjs, Chrome X11
  NVIDIA browser_qa.mjs, and Firefox Wayland WebGPU firefox_qa.mjs) for a target
  Interstellar Simulation directory, checks display and GPU prerequisites
  gracefully, and summarizes pass/fail counts and key metrics from
  qa_report.json and firefox_qa_report.json.
---

# Verify Simulation (`verify-sim`)

Execute the three-tier verification sequence for one target simulation directory (`<sim>` ∈ `blackhole-sim`, `wormhole-sim`, `binary-bh-sim`, `warp-drive-sim`). Always run commands from the **repository root**.

## Rules

- **Never start `./launch.sh`** before running `browser_qa.mjs` or `firefox_qa.mjs` — both scripts spawn and close their own internal local HTTP server.
- **Never run `firefox_qa.mjs` with `--headless`** — the script enforces headed Wayland with `dom.webgpu.allow-present-without-readback = false` and `MOZ_LOG=WebGPU:4`.
- **Fail fast on physics**: if `physics_check.mjs` exits non-zero, stop immediately and do not run browser QA until the contract/physics failure is fixed.
- **Distinguish SKIPPED vs. FAILED**: check display, browser, and GPU prerequisites before each browser suite so headless or display-less environments report a clear **SKIPPED** status instead of a misleading crash.

## Verification Sequence

### 1. Resolve Target Simulation

Identify `<sim>` from the user's request or the active edited simulation directory (`blackhole-sim`, `wormhole-sim`, `binary-bh-sim`, or `warp-drive-sim`). If ambiguous, ask before running.

### 2. Stage 1 — Physics & Dual-Backend Contract Suite (Fail Fast)

Run:

```bash
node <sim>/tests/physics_check.mjs
```

- Check exit code (`0` = PASS, non-zero = FAIL) and capture the `SUMMARY: N passed, M failed...` line.
- **If exit code ≠ 0**: list all `[FAIL]` lines and stop immediately.

### 3. Stage 2 — Chrome X11 NVIDIA Browser QA

First check prerequisites cleanly:

```bash
test -n "${DISPLAY:-}" && test -x /usr/bin/google-chrome && command -v nvidia-smi >/dev/null && nvidia-smi >/dev/null 2>&1
```

- **If prerequisites are missing**: mark Chrome QA as **SKIPPED** and state the exact missing prerequisite (`DISPLAY`, `/usr/bin/google-chrome`, or `nvidia-smi`/NVIDIA GPU). Continue to Stage 3.
- **If prerequisites are met**: run directly (no `./launch.sh`, no CLI flags):

```bash
node <sim>/tests/browser_qa.mjs
```

- Record exit code (`0` = PASS, non-zero = FAIL) and count `[PASS]` / `[FAIL]` lines from stdout/stderr.

### 4. Stage 3 — Firefox Wayland NVIDIA WebGPU QA

First check prerequisites cleanly:

```bash
test -n "${WAYLAND_DISPLAY:-}" && command -v firefox >/dev/null && command -v nvidia-smi >/dev/null && nvidia-smi >/dev/null 2>&1
```

- **If prerequisites are missing**: mark Firefox QA as **SKIPPED** and state the exact missing prerequisite (`WAYLAND_DISPLAY`, `firefox` in `PATH`, or `nvidia-smi`/NVIDIA GPU).
- **If prerequisites are met**: run directly (no `./launch.sh`, no `--headless`, no CLI flags):

```bash
node <sim>/tests/firefox_qa.mjs
```

- Record exit code (`0` = PASS, non-zero = FAIL) and count `[PASS]` / `[FAIL]` lines from stdout/stderr.

### 5. Stage 4 — Summarize Metrics from JSON Reports

For every browser suite that ran (not skipped), read its JSON report under `<sim>/tests/screenshots/` and extract key metrics:

```bash
node -e '
const fs = require("fs");
const sim = process.argv[1];
const qaPath = `${sim}/tests/screenshots/qa_report.json`;
const ffPath = `${sim}/tests/screenshots/firefox_qa_report.json`;
if (fs.existsSync(qaPath)) {
  const q = JSON.parse(fs.readFileSync(qaPath, "utf8"));
  console.log("CHROME_QA:", JSON.stringify({
    webglRenderer: q.diagWebGLInit?.webglRenderer,
    webgpuAdapter: q.diagWebGPU?.adapterInfo,
    fpsWebGL: q.liveFpsWebGL ?? q.diagWebGLInit?.fps,
    fpsWebGPU: q.liveFpsWebGPU ?? q.diagWebGPU?.fps,
    skyFetches: `${q.skyFetchesBeforeSwitch} -> ${q.skyFetchesAfterSwitch}`,
    errors: {
      consoleErrors: q.errors?.consoleErrors?.length ?? 0,
      exceptions: q.errors?.exceptions?.length ?? 0,
      failedRequests: q.errors?.failedRequests?.length ?? 0,
    },
  }));
}
if (fs.existsSync(ffPath)) {
  const f = JSON.parse(fs.readFileSync(ffPath, "utf8"));
  const steps = Object.fromEntries(
    Object.entries(f.report?.steps || {}).map(([k, v]) => [
      k,
      { backend: v?.diag?.backend, fps: v?.fps, pngBytes: v?.pngBytes, diagErrors: v?.diag?.errors?.length ?? 0 },
    ])
  );
  console.log("FIREFOX_QA:", JSON.stringify({
    sawFirefoxOnNvidia: f.sawFirefoxOnNvidia,
    runtimeErrors: f.report?.runtimeErrors?.length ?? 0,
    steps,
  }));
}
' <sim>
```

### 6. Report Format

Present a concise summary table for `<sim>`:

| Suite | Status | Assertions | Key Metrics |
| :--- | :--- | :--- | :--- |
| `physics_check.mjs` | PASS / FAIL | `X passed, Y failed` | Runtime / failed checks |
| `browser_qa.mjs` | PASS / FAIL / SKIPPED (`reason`) | `X passed, Y failed` | WebGL2 & WebGPU FPS, NVIDIA adapter, sky fetches `1 -> 1`, 0 console/runtime/network errors |
| `firefox_qa.mjs` | PASS / FAIL / SKIPPED (`reason`) | `X passed, Y failed` | `sawFirefoxOnNvidia`, 0 runtime errors, WebGPU/WebGL2/round-trip FPS & PNG bytes |

If any suite failed, list its `[FAIL]` lines directly beneath the table along with clickable links to the relevant report JSON file.
