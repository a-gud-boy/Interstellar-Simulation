---
trigger: glob
globs: "**/src/shaders/**, **/src/engine/Web*Renderer.js"
---

# Dual-Backend Shader & Renderer Parity

All simulators maintain 1:1 visual and physical parity between **WebGL2** (`WebGLRenderer.js`, `*.frag.js`, `*.glsl.js`) and **WebGPU** (`WebGPURenderer.js`, `*.wgsl.js`).

## Mandatory Rules

1. **Symmetric Edits**: Any change to physics equations, geodesic integrators, volumetric transfer, uniforms, buffer layouts, or HDR post-processing (`TAA`, bloom, anamorphic flare, AgX composite) in one backend **must** be mirrored in the other backend in the same change.
2. **Uniform Alignment & Padding**:
   - Pack WGSL `var<uniform>` structs (and WebGL2 `layout(std140)` UBOs where used) strictly as 16-byte aligned `vec4` members (`vec4f`/`vec4<f32>` or `vec4i`) with explicit trailing padding so total byte size is a multiple of 16.
   - Keep `ArrayBuffer` byte allocation, `Float32Array` / `Int32Array` write indices, and struct member order in exact lockstep—never write integer fields through `Float32Array` when WGSL declares `vec4i` (or vice versa).
   - Consult the active simulation's own `.agents/rules/<sim>.md` file for its exact uniform struct sizes, typed-array offsets, and UBO vs. discrete-uniform contract.
3. **WebGPU Per-Pass Uniform Isolation**: Use dedicated `GPUBuffer` instances per pass (e.g., per bloom mip level and each separable anamorphic pass). Never reuse one uniform buffer across multiple `device.queue.writeBuffer(...)` calls inside a single command submission, or earlier passes will read overwritten values.
4. **Locked Resource Bindings & NaN Safety**:
   - Keep WGSL `@group(0) @binding(N)` indices contiguous (`0..N-1`) and WebGL2 texture units (`TEXTURE0..N`) locked to the contract checked by `physics_check.mjs`.
   - Preserve IEEE NaN/Inf guards (`isBadFloat` / `sanitizeHdr` / safe hyperbolic clamps) across both backends, especially for NVIDIA WebGPU and `rg11b10ufloat` / `rgba16float` HDR render targets.
5. **Mandatory Verification**: After editing any shader or renderer file, run the edited simulation's contract suite and confirm zero failures:
   ```bash
   node <sim>/tests/physics_check.mjs
   ```
