/**
 * gpuProfiler.js — Live non-stalling GPU Pass Profiler across WebGL2
 * (`EXT_disjoint_timer_query_webgl2`) and WebGPU (`timestamp-query`) with graceful
 * CPU frame-time fallback when hardware timestamp queries are absent.
 */

const PASS_KEYS = ['raymarch', 'taa', 'bloom', 'composite'];
const HISTORY_LEN = 60;

function createRollingHistory() {
  return {
    raymarch: 0,
    taa: 0,
    bloom: 0,
    composite: 0,
    total: 0,
    cpuMs: 0,
    history: new Float32Array(HISTORY_LEN),
    historyCount: 0,
    historyCursor: 0,
  };
}

function pushSample(metrics, { raymarch = 0, taa = 0, bloom = 0, composite = 0, cpuMs = 0 }) {
  const total = raymarch + taa + bloom + composite;
  const alpha = metrics.historyCount === 0 ? 1.0 : 0.18;
  metrics.raymarch += (raymarch - metrics.raymarch) * alpha;
  metrics.taa += (taa - metrics.taa) * alpha;
  metrics.bloom += (bloom - metrics.bloom) * alpha;
  metrics.composite += (composite - metrics.composite) * alpha;
  metrics.total += (total - metrics.total) * alpha;
  metrics.cpuMs += (cpuMs - metrics.cpuMs) * alpha;

  const val = metrics.hardwareSupported ? total : cpuMs;
  metrics.history[metrics.historyCursor] = val;
  metrics.historyCursor = (metrics.historyCursor + 1) % HISTORY_LEN;
  if (metrics.historyCount < HISTORY_LEN) metrics.historyCount++;
}

export function extractOrderedHistory(metrics) {
  const n = metrics.historyCount || 0;
  const out = new Array(n);
  const start = n < HISTORY_LEN ? 0 : metrics.historyCursor;
  for (let i = 0; i < n; i++) {
    out[i] = metrics.history[(start + i) % HISTORY_LEN];
  }
  return out;
}

/**
 * Non-nesting WebGL2 GPU timer profiler using `EXT_disjoint_timer_query_webgl2`.
 * Falls back cleanly to CPU wall-clock timings if hardware queries are unsupported.
 */
export function createWebGLPassProfiler(gl) {
  const ext = gl?.getExtension ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  const hardwareSupported = Boolean(ext && typeof gl.beginQuery === 'function');

  const state = {
    backend: 'webgl2',
    enabled: false,
    disposed: false,
    hardwareSupported,
    ...createRollingHistory(),
    pendingFrames: [],
    currentPasses: [],
    activePass: null,
    cpuStartMs: 0,
    passCpuStartMs: 0,
    cpuAccum: { raymarch: 0, taa: 0, bloom: 0, composite: 0 },
  };

  function pollCompletedFrames() {
    if (!hardwareSupported || !gl || gl.isContextLost?.()) return;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    if (disjoint) {
      for (const frame of state.pendingFrames) {
        for (const p of frame.passes) {
          gl.deleteQuery(p.query);
        }
      }
      state.pendingFrames.length = 0;
      return;
    }

    while (state.pendingFrames.length > 0) {
      const oldest = state.pendingFrames[0];
      const lastPass = oldest.passes[oldest.passes.length - 1];
      if (!lastPass) {
        state.pendingFrames.shift();
        continue;
      }
      const ready = gl.getQueryParameter(lastPass.query, gl.QUERY_RESULT_AVAILABLE);
      if (!ready) break;

      state.pendingFrames.shift();
      const sums = { raymarch: 0, taa: 0, bloom: 0, composite: 0 };
      for (const p of oldest.passes) {
        const ns = Number(gl.getQueryParameter(p.query, gl.QUERY_RESULT) || 0);
        gl.deleteQuery(p.query);
        if (p.category in sums) {
          sums[p.category] += ns * 1e-6;
        }
      }
      pushSample(state, { ...sums, cpuMs: oldest.cpuMs });
    }
  }

  return {
    backend: 'webgl2',
    get enabled() {
      return state.enabled;
    },
    get hardwareSupported() {
      return state.hardwareSupported;
    },
    setEnabled(next) {
      state.enabled = Boolean(next);
    },
    beginFrame() {
      if (state.disposed) return;
      pollCompletedFrames();
      state.cpuStartMs = performance.now();
      state.currentPasses = [];
      state.activePass = null;
      state.cpuAccum = { raymarch: 0, taa: 0, bloom: 0, composite: 0 };
    },
    beginPass(category) {
      if (!state.enabled || state.disposed) return;
      if (state.activePass) {
        // Guard against accidental nested calls (WebGL2 forbids nested TIME_ELAPSED)
        this.endPass();
      }
      const cat = PASS_KEYS.includes(category) ? category : 'raymarch';
      state.passCpuStartMs = performance.now();
      if (hardwareSupported && gl && !gl.isContextLost?.()) {
        const query = gl.createQuery();
        if (query) {
          gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
          state.activePass = { category: cat, query };
          return;
        }
      }
      state.activePass = { category: cat, query: null };
    },
    endPass() {
      if (!state.activePass) return;
      const p = state.activePass;
      state.activePass = null;
      const elapsedCpu = Math.max(0, performance.now() - state.passCpuStartMs);
      state.cpuAccum[p.category] = (state.cpuAccum[p.category] || 0) + elapsedCpu;
      if (p.query && hardwareSupported && gl && !gl.isContextLost?.()) {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        state.currentPasses.push(p);
      }
    },
    endFrame() {
      if (state.activePass) this.endPass();
      if (!state.enabled || state.disposed) return;
      const frameCpu = Math.max(0, performance.now() - state.cpuStartMs);
      if (hardwareSupported && state.currentPasses.length > 0) {
        if (state.pendingFrames.length > 8) {
          const drop = state.pendingFrames.shift();
          for (const p of drop.passes) gl.deleteQuery(p.query);
        }
        state.pendingFrames.push({ passes: state.currentPasses, cpuMs: frameCpu });
        state.currentPasses = [];
      } else {
        pushSample(state, { ...state.cpuAccum, cpuMs: frameCpu });
      }
    },
    getMetrics() {
      return {
        backend: 'webgl2',
        enabled: state.enabled,
        hardwareSupported: state.hardwareSupported,
        raymarchMs: Number(state.raymarch.toFixed(3)),
        taaMs: Number(state.taa.toFixed(3)),
        bloomMs: Number(state.bloom.toFixed(3)),
        compositeMs: Number(state.composite.toFixed(3)),
        totalMs: Number((state.hardwareSupported ? state.total : state.cpuMs).toFixed(3)),
        cpuMs: Number(state.cpuMs.toFixed(3)),
        history: extractOrderedHistory(state),
      };
    },
    dispose() {
      state.disposed = true;
      if (state.activePass?.query && gl && !gl.isContextLost?.()) {
        try {
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          gl.deleteQuery(state.activePass.query);
        } catch {
          // Ignore teardown errors
        }
      }
      state.activePass = null;
      for (const p of state.currentPasses) {
        if (p.query) gl?.deleteQuery?.(p.query);
      }
      for (const frame of state.pendingFrames) {
        for (const p of frame.passes) {
          if (p.query) gl?.deleteQuery?.(p.query);
        }
      }
      state.currentPasses.length = 0;
      state.pendingFrames.length = 0;
    },
  };
}

/**
 * Non-blocking WebGPU GPU pass profiler using `timestamp-query` and a 3-slot MAP_READ ring.
 */
export function createWebGPUPassProfiler(device) {
  const MAX_SLOTS = 64; // Up to 32 render passes (begin+end) per frame
  const RING_LEN = 3;
  const hardwareSupported = Boolean(device?.features?.has?.('timestamp-query'));

  const state = {
    backend: 'webgpu',
    enabled: false,
    disposed: false,
    hardwareSupported,
    ...createRollingHistory(),
    querySet: null,
    resolveBuffer: null,
    ring: [],
    passRecords: [],
    nextQueryIdx: 0,
    cpuStartMs: 0,
    activeSlot: null,
  };

  if (hardwareSupported) {
    state.querySet = device.createQuerySet({
      label: 'gpu-profiler-qs',
      type: 'timestamp',
      count: MAX_SLOTS,
    });
    state.resolveBuffer = device.createBuffer({
      label: 'gpu-profiler-resolve',
      size: MAX_SLOTS * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    for (let i = 0; i < RING_LEN; i++) {
      state.ring.push({
        buffer: device.createBuffer({
          label: `gpu-profiler-stage-${i}`,
          size: MAX_SLOTS * 8,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
        inFlight: false,
        passes: [],
        cpuMs: 0,
      });
    }
  }

  return {
    backend: 'webgpu',
    get enabled() {
      return state.enabled;
    },
    get hardwareSupported() {
      return state.hardwareSupported;
    },
    setEnabled(next) {
      state.enabled = Boolean(next);
    },
    beginFrame() {
      if (state.disposed) return;
      state.cpuStartMs = performance.now();
      state.passRecords = [];
      state.nextQueryIdx = 0;
      state.activeSlot = null;
    },
    timestampWritesFor(category) {
      if (!state.enabled || state.disposed || !hardwareSupported || !state.querySet) {
        return undefined;
      }
      if (state.nextQueryIdx + 2 > MAX_SLOTS) {
        return undefined;
      }
      const beginIdx = state.nextQueryIdx;
      const endIdx = state.nextQueryIdx + 1;
      state.nextQueryIdx += 2;
      const cat = PASS_KEYS.includes(category) ? category : 'raymarch';
      state.passRecords.push({ category: cat, beginIdx, endIdx });
      return {
        querySet: state.querySet,
        beginningOfPassWriteIndex: beginIdx,
        endOfPassWriteIndex: endIdx,
      };
    },
    endFrame(encoder) {
      if (!state.enabled || state.disposed) return;
      const frameCpu = Math.max(0, performance.now() - state.cpuStartMs);
      if (!hardwareSupported || !encoder || state.passRecords.length === 0) {
        pushSample(state, { cpuMs: frameCpu });
        return;
      }
      const slot = state.ring.find((s) => !s.inFlight);
      if (!slot) {
        // Staging ring saturated: skip copy rather than blocking
        return;
      }
      const count = state.nextQueryIdx;
      encoder.resolveQuerySet(state.querySet, 0, count, state.resolveBuffer, 0);
      encoder.copyBufferToBuffer(state.resolveBuffer, 0, slot.buffer, 0, count * 8);
      slot.passes = state.passRecords.slice();
      slot.cpuMs = frameCpu;
      slot.inFlight = true;
      state.activeSlot = slot;
    },
    afterSubmit() {
      const slot = state.activeSlot;
      state.activeSlot = null;
      if (!slot || state.disposed) return;
      const passes = slot.passes;
      const cpuMs = slot.cpuMs;
      slot.buffer
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          if (state.disposed) {
            try {
              slot.buffer.unmap();
            } catch {
              // Ignore unmap on disposed device
            }
            slot.inFlight = false;
            return;
          }
          try {
            const view = new BigUint64Array(slot.buffer.getMappedRange());
            const sums = { raymarch: 0, taa: 0, bloom: 0, composite: 0 };
            for (const p of passes) {
              const t0 = view[p.beginIdx];
              const t1 = view[p.endIdx];
              if (t1 >= t0) {
                const ms = Number(t1 - t0) * 1e-6;
                if (ms < 500.0 && p.category in sums) {
                  sums[p.category] += ms;
                }
              }
            }
            pushSample(state, { ...sums, cpuMs });
          } finally {
            try {
              slot.buffer.unmap();
            } catch {
              // Ignore unmap error
            }
            slot.inFlight = false;
          }
        })
        .catch(() => {
          slot.inFlight = false;
        });
    },
    getMetrics() {
      return {
        backend: 'webgpu',
        enabled: state.enabled,
        hardwareSupported: state.hardwareSupported,
        raymarchMs: Number(state.raymarch.toFixed(3)),
        taaMs: Number(state.taa.toFixed(3)),
        bloomMs: Number(state.bloom.toFixed(3)),
        compositeMs: Number(state.composite.toFixed(3)),
        totalMs: Number((state.hardwareSupported ? state.total : state.cpuMs).toFixed(3)),
        cpuMs: Number(state.cpuMs.toFixed(3)),
        history: extractOrderedHistory(state),
      };
    },
    dispose() {
      state.disposed = true;
      state.activeSlot = null;
      try {
        state.querySet?.destroy?.();
      } catch {
        // Ignore teardown errors
      }
      try {
        state.resolveBuffer?.destroy?.();
      } catch {
        // Ignore teardown errors
      }
      for (const slot of state.ring) {
        try {
          slot.buffer.destroy();
        } catch {
          // Ignore teardown errors
        }
      }
    },
  };
}
