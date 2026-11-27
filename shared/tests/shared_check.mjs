#!/usr/bin/env node
/**
 * Shared-layer contract & integrity test suite (`shared/tests/shared_check.mjs`):
 *  - Verifies JS syntax (`node --check`) across all `shared/` and `scripts/` modules
 *  - Verifies `simRegistry.js` uniqueness, directories, and alias resolution
 *  - Enforces single canonical `shared/assets/milkyway_4k.jpg` (no stray duplicate copies)
 *  - Validates dual-backend `physicalLuts.js`, `skyLoader.js`, `common.*`, and `post.*` profiles
 *  - Verifies all 7 simulator `index.html` files link `../shared/ui/base.css` and declare canonical `data-current-sim`
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

let passed = 0;
let failed = 0;

function assert(cond, msg, detail = '') {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${msg}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`);
  }
}

function collectFiles(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'target' || entry.name === 'screenshots') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, predicate, out);
    else if (entry.isFile() && predicate(full, entry.name)) out.push(full);
  }
  return out;
}

console.log('\n=== 1. Shared & Script JS Syntax Verification ===');
const sharedJsFiles = [
  ...collectFiles(path.join(REPO_ROOT, 'shared'), (f) => f.endsWith('.js') || f.endsWith('.mjs')),
  ...collectFiles(path.join(REPO_ROOT, 'scripts'), (f) => f.endsWith('.js') || f.endsWith('.mjs')),
].sort();

assert(sharedJsFiles.length >= 10, `Discovered ${sharedJsFiles.length} JS/MJS modules under shared/ and scripts/`);
for (const full of sharedJsFiles) {
  const rel = path.relative(REPO_ROOT, full);
  try {
    execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
    assert(true, `JS syntax OK: ${rel}`);
  } catch (err) {
    assert(false, `JS syntax ERROR: ${rel}`, err.stderr?.toString().trim() || err.message);
  }
}

console.log('\n=== 2. Simulator Registry & Canonical Asset Deduplication ===');
const { SIMULATORS, getSimById, resolveSimByAlias } = await import(
  path.join(REPO_ROOT, 'shared/simRegistry.js')
);

const ids = SIMULATORS.map((s) => s.id);
const dirs = SIMULATORS.map((s) => s.dir);
const handles = SIMULATORS.map((s) => s.debugHandle);
const allAliases = SIMULATORS.flatMap((s) => s.aliases);

assert(
  SIMULATORS.length === 7 &&
    new Set(ids).size === 7 &&
    new Set(dirs).size === 7 &&
    new Set(handles).size === 7 &&
    new Set(allAliases).size === allAliases.length,
  'SIMULATORS registry declares 7 unique IDs, dirs, debugHandles, and disjoint aliases',
  ids.join(', ')
);

const missingDirs = dirs.filter((d) => !fs.existsSync(path.join(REPO_ROOT, d, 'index.html')));
assert(
  missingDirs.length === 0,
  'All 7 simulator directories exist with index.html',
  missingDirs.length ? `missing: ${missingDirs.join(', ')}` : '7/7 OK'
);

assert(
  getSimById('pulsar')?.dir === 'sims/pulsar' &&
    resolveSimByAlias('gargantua')?.id === 'blackhole' &&
    resolveSimByAlias('bbh')?.id === 'binary' &&
    resolveSimByAlias('alcubierre')?.id === 'warp' &&
    resolveSimByAlias('snr')?.id === 'supernova' &&
    resolveSimByAlias('magnetar')?.id === 'pulsar' &&
    resolveSimByAlias('sf')?.id === 'starflight' &&
    resolveSimByAlias('unknown', { strict: true }) === null &&
    resolveSimByAlias('')?.id === 'blackhole',
  'simRegistry resolveSimByAlias & getSimById resolve all aliases and strict fallback cleanly'
);

const milkywayFiles = collectFiles(REPO_ROOT, (_f, name) => name === 'milkyway_4k.jpg').map((f) =>
  path.relative(REPO_ROOT, f).split(path.sep).join('/')
);
const canonicalSkyPath = path.join(REPO_ROOT, 'shared/assets/milkyway_4k.jpg');
const skyBytes = fs.existsSync(canonicalSkyPath) ? fs.statSync(canonicalSkyPath).size : 0;
assert(
  milkywayFiles.length === 1 &&
    milkywayFiles[0] === 'shared/assets/milkyway_4k.jpg' &&
    skyBytes > 3_000_000,
  'Single canonical milkyway_4k.jpg at shared/assets/milkyway_4k.jpg (zero duplicate copies)',
  `files=[${milkywayFiles.join(', ')}], bytes=${skyBytes}`
);

console.log('\n=== 3. Shared HTML / CSS / Engine / Switcher Wiring Across All 7 Simulators ===');
const baseCss = fs.readFileSync(path.join(REPO_ROOT, 'shared/ui/base.css'), 'utf8');
assert(baseCss.includes('.sim-canvas') && baseCss.includes('.sim-switcher'), 'shared/ui/base.css defines .sim-canvas and .sim-switcher');

const simAppShellSrc = fs.readFileSync(path.join(REPO_ROOT, 'shared/engine/SimAppShell.js'), 'utf8');
assert(
  simAppShellSrc.includes("'../ui/simSwitcher.js'") && simAppShellSrc.includes("'../assets/skyLoader.js'"),
  'shared/engine/SimAppShell.js imports ../ui/simSwitcher.js and ../assets/skyLoader.js'
);

for (const sim of SIMULATORS) {
  const html = fs.readFileSync(path.join(REPO_ROOT, sim.dir, 'index.html'), 'utf8');
  const mainJs = fs.readFileSync(path.join(REPO_ROOT, sim.dir, 'src/main.js'), 'utf8');
  const glJs = fs.readFileSync(path.join(REPO_ROOT, sim.dir, 'src/engine/WebGLRenderer.js'), 'utf8');
  const gpuJs = fs.readFileSync(path.join(REPO_ROOT, sim.dir, 'src/engine/WebGPURenderer.js'), 'utf8');
  const camJs = fs.readFileSync(path.join(REPO_ROOT, sim.dir, 'src/engine/CameraController.js'), 'utf8');
  const ffQaJs = fs.readFileSync(path.join(REPO_ROOT, sim.dir, 'tests/firefox_qa.mjs'), 'utf8');
  const ok =
    html.includes('../../shared/ui/base.css') &&
    html.includes('class="sim-canvas"') &&
    html.includes(`data-current-sim="${sim.id}"`) &&
    !html.includes('sim-switch-link') &&
    mainJs.includes('../../../shared/engine/SimAppShell.js') &&
    glJs.includes('../../../../shared/engine/SharedWebGLPostPipeline.js') &&
    gpuJs.includes('../../../../shared/engine/SharedWebGPUPostPipeline.js') &&
    camJs.includes('../../../../shared/engine/BaseCamera.js') &&
    ffQaJs.includes('../../../shared/testing/firefoxQaRunner.mjs');
  assert(
    ok,
    `${sim.dir} cleanly wired to base.css, SimAppShell, SharedWeb{GL,GPU}PostPipeline, BaseCamera, and firefoxQaRunner`
  );

  const engineDir = path.join(REPO_ROOT, sim.dir, 'src/engine');
  const expectedEngine = ['CameraController.js', 'Physics.js', 'Presets.js', 'WebGLRenderer.js', 'WebGPURenderer.js'];
  const actualEngine = fs.readdirSync(engineDir).filter((f) => f.endsWith('.js')).sort();
  assert(
    JSON.stringify(actualEngine) === JSON.stringify(expectedEngine),
    `${sim.dir}/src/engine has canonical 5-file layout (${actualEngine.join(', ')})`
  );
}

console.log('\n=== 3b. Shared Engine & Testing Export Contracts ===');
const baseCamMod = await import(path.join(REPO_ROOT, 'shared/engine/BaseCamera.js'));
const glPostMod = await import(path.join(REPO_ROOT, 'shared/engine/SharedWebGLPostPipeline.js'));
const gpuPostMod = await import(path.join(REPO_ROOT, 'shared/engine/SharedWebGPUPostPipeline.js'));
const appShellMod = await import(path.join(REPO_ROOT, 'shared/engine/SimAppShell.js'));
const ffRunnerMod = await import(path.join(REPO_ROOT, 'shared/testing/firefoxQaRunner.mjs'));

assert(
  typeof baseCamMod.stepCriticallyDamped === 'function' &&
    typeof baseCamMod.stepCriticallyDampedInto === 'function' &&
    typeof baseCamMod.computeSphericalOrbitBasis === 'function' &&
    typeof baseCamMod.computeSphericalOrbitBasisInto === 'function' &&
    typeof baseCamMod.applyLocalLookTriad === 'function' &&
    typeof baseCamMod.applyLocalLookTriadInto === 'function' &&
    typeof baseCamMod.createCanvasRectCache === 'function' &&
    typeof baseCamMod.normalizeWheelDelta === 'function' &&
    typeof baseCamMod.clamp === 'function' &&
    typeof baseCamMod.wrapAngleDelta === 'function' &&
    typeof baseCamMod.easeOutCubic === 'function' &&
    typeof baseCamMod.easeInOutCubic === 'function' &&
    typeof glPostMod.SharedWebGLPostPipeline === 'function' &&
    typeof glPostMod.detectWebGLHdrFormats === 'function' &&
    typeof gpuPostMod.SharedWebGPUPostPipeline === 'function' &&
    typeof appShellMod.createSimApp === 'function' &&
    typeof ffRunnerMod.runSimFirefoxQA === 'function',
  'shared/engine/*.js and shared/testing/firefoxQaRunner.mjs export all required APIs'
);

// Verify zero-alloc BaseCamera helpers match allocating counterparts and cache canvas rects
{
  const pairOut = [0, 0];
  const pairRef = baseCamMod.stepCriticallyDamped(1.2, -0.4, 2.5, 13.5, 0.016);
  baseCamMod.stepCriticallyDampedInto(pairOut, 1.2, -0.4, 2.5, 13.5, 0.016);
  const posOut = [0, 0, 0];
  const matOut = new Float32Array(9);
  const orbRef = baseCamMod.computeSphericalOrbitBasis(0.7, 0.35, -0.15);
  baseCamMod.computeSphericalOrbitBasisInto(posOut, matOut, 0.7, 0.35, -0.15);
  const lookOut = new Float32Array(9);
  const lookRef = baseCamMod.applyLocalLookTriad(orbRef.right, orbRef.up, orbRef.forward, 0.4, -0.2, 0.1);
  baseCamMod.applyLocalLookTriadInto(lookOut, orbRef.right, orbRef.up, orbRef.forward, 0.4, -0.2, 0.1);

  let widthReads = 0;
  const mockCanvas = {
    get clientWidth() {
      widthReads++;
      return 1280;
    },
    clientHeight: 720,
    getBoundingClientRect: () => ({ width: 1280, height: 720 }),
  };
  const rectCache = baseCamMod.createCanvasRectCache(() => mockCanvas);
  const r1 = rectCache.getRect();
  const r2 = rectCache.getRect();
  rectCache.invalidate();
  const r3 = rectCache.getRect();
  rectCache.dispose();

  const approxEq = (a, b) => Math.abs(a - b) < 1e-5;
  assert(
    approxEq(pairOut[0], pairRef[0]) &&
      approxEq(pairOut[1], pairRef[1]) &&
      approxEq(posOut[0], orbRef.posUnit[0]) &&
      approxEq(matOut[0], orbRef.right[0]) &&
      approxEq(matOut[8], orbRef.forward[2]) &&
      approxEq(lookOut[0], lookRef.right[0]) &&
      approxEq(lookOut[8], lookRef.forward[2]) &&
      r1 === r2 &&
      r1.width === 1280 &&
      r1.height === 720 &&
      r3.width === 1280 &&
      widthReads === 2,
    'Zero-alloc BaseCamera helpers match references & createCanvasRectCache caches DOM reads'
  );
}

// Verify detectWebGLHdrFormats splits hdrSpec (R11F_G11F_B10F) and taaSpec (RGBA16F)
{
  let probeInternalFmt = 0;
  const mockHdrGl = {
    RGBA16F: 0x881a,
    R11F_G11F_B10F: 0x8c3a,
    RGBA8: 0x8058,
    RGBA: 0x1908,
    RGB: 0x1907,
    HALF_FLOAT: 0x140b,
    UNSIGNED_BYTE: 0x1401,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812f,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    createFramebuffer: () => ({}),
    createTexture: () => ({}),
    bindTexture: () => {},
    texParameteri: () => {},
    texImage2D: (_t, _l, internalFormat) => {
      probeInternalFmt = internalFormat;
    },
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    checkFramebufferStatus: () => (probeInternalFmt ? 0x8cd5 : 0),
    deleteTexture: () => {},
    deleteFramebuffer: () => {},
  };
  const fmts = glPostMod.detectWebGLHdrFormats(mockHdrGl, true, true);
  assert(
    fmts.hdrSpec?.name === 'R11F_G11F_B10F' && fmts.taaSpec?.name === 'RGBA16F',
    'detectWebGLHdrFormats selects hybrid R11F_G11F_B10F HDR + RGBA16F TAA targets'
  );
}

// Verify all 7 CameraController.js use createCanvasRectCache without pointermove reflows
const camReflowFree = SIMULATORS.every((sim) => {
  const src = fs.readFileSync(path.join(REPO_ROOT, sim.dir, 'src/engine/CameraController.js'), 'utf8');
  return src.includes('createCanvasRectCache') && !src.includes('getBoundingClientRect');
});
const appShellSrc = fs.readFileSync(path.join(REPO_ROOT, 'shared/engine/SimAppShell.js'), 'utf8');
assert(
  camReflowFree &&
    appShellSrc.includes('fpsRing') &&
    !appShellSrc.includes('frameTimestamps.shift') &&
    appShellSrc.includes('reduced-glass') &&
    appShellSrc.includes('setInteractiveDragScale'),
  'All 7 CameraController.js eliminate getBoundingClientRect reflows & SimAppShell uses O(1) fpsRing + perf toggles'
);

const sharedGlPostSrc = fs.readFileSync(path.join(REPO_ROOT, 'shared/engine/SharedWebGLPostPipeline.js'), 'utf8');
const postGlslAll = Object.values((await import(path.join(REPO_ROOT, 'shared/shaders/post.glsl.js'))).createPostShadersGLSL('default')).join('\n');
const postGlUniforms = [];
{
  const re = /\buniform\s+(?:highp\s+|mediump\s+|lowp\s+)?\w+\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/g;
  let m;
  while ((m = re.exec(postGlslAll)) !== null) {
    if (!postGlUniforms.includes(m[1])) postGlUniforms.push(m[1]);
  }
}
const unboundSharedGlPost = postGlUniforms.filter((u) => !sharedGlPostSrc.includes(u));
assert(
  postGlUniforms.length > 0 && unboundSharedGlPost.length === 0,
  'shared/engine/SharedWebGLPostPipeline.js binds all uniforms declared in shared/shaders/post.glsl.js',
  `bound=${postGlUniforms.length}, missing=[${unboundSharedGlPost.join(',')}]`
);

console.log('\n=== 4. Shared Dual-Backend Assets & Post Optics Profile Parity ===');
const lutsMod = await import(path.join(REPO_ROOT, 'shared/assets/physicalLuts.js'));
const skyMod = await import(path.join(REPO_ROOT, 'shared/assets/skyLoader.js'));
const commonGlsl = await import(path.join(REPO_ROOT, 'shared/shaders/common.glsl.js'));
const commonWgsl = await import(path.join(REPO_ROOT, 'shared/shaders/common.wgsl.js'));
const { POST_OPTICS_PROFILES } = await import(path.join(REPO_ROOT, 'shared/shaders/postConfig.js'));
const postGlslMod = await import(path.join(REPO_ROOT, 'shared/shaders/post.glsl.js'));
const postWgslMod = await import(path.join(REPO_ROOT, 'shared/shaders/post.wgsl.js'));

globalThis.GPUTextureUsage = globalThis.GPUTextureUsage || {
  TEXTURE_BINDING: 4,
  COPY_DST: 2,
  RENDER_ATTACHMENT: 16,
};
const gpuCalls = [];
const mockDevice = {
  createTexture: (desc) => ({ desc, createView: () => ({ id: 'mockView' }) }),
  queue: {
    writeTexture: (dst, _data, _layout, size) => {
      gpuCalls.push({ desc: dst.texture.desc, size });
    },
  },
};
const glCalls = [];
const mockGl = {
  TEXTURE_2D: 0x0de1, RGBA16F: 0x881a, RGBA8: 0x8058, RGBA: 0x1908,
  HALF_FLOAT: 0x140b, UNSIGNED_BYTE: 0x1401, TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MAG_FILTER: 0x2800, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
  NEAREST: 0x2600, LINEAR: 0x2601, LINEAR_MIPMAP_LINEAR: 0x2703,
  REPEAT: 0x2901, CLAMP_TO_EDGE: 0x812f, UNPACK_FLIP_Y_WEBGL: 0x9240,
  NO_ERROR: 0,
  createTexture: () => ({ id: 'mockGlTex' }),
  bindTexture: () => {},
  texParameteri: () => {},
  texParameterf: () => {},
  pixelStorei: () => {},
  getExtension: () => null,
  getError: () => 0,
  generateMipmap: () => {},
  texImage2D: (_t, _l, internalFormat, width, height, _b, _f, _type, data) => {
    glCalls.push({ internalFormat, width, height, len: data?.length });
  },
};

const lutStartMs = performance.now();
const bb512 = lutsMod.getBlackbodyData(512);
const bn128 = lutsMod.getBlueNoiseData(128);
const lutElapsedMs = performance.now() - lutStartMs;
assert(
  lutElapsedMs < 50 &&
    bb512.halfData instanceof Uint16Array &&
    bb512.halfData.length === 512 * 4 &&
    bb512.byteData instanceof Uint8Array &&
    bb512.byteData.length === 512 * 4 &&
    bn128 instanceof Uint8Array &&
    bn128.length === 128 * 128 * 4 &&
    new Set(bn128.subarray(0, 256)).size > 32,
  'Pre-baked getBlackbodyData(512) & getBlueNoiseData(128) decode cleanly in <50ms',
  `${lutElapsedMs.toFixed(2)}ms`
);

const gpuBb = lutsMod.createBlackbodyLUT(mockDevice, 512);
const glBb = lutsMod.createBlackbodyLUT(mockGl, 512);
const gpuBn = lutsMod.createBlueNoiseLUT(mockDevice, 128);
const glBn = lutsMod.createBlueNoiseLUT(mockGl, 128);
const phGpu = skyMod.createPlaceholderSkyTextureWebGPU(mockDevice);
const phGl = skyMod.createPlaceholderSkyTextureWebGL(mockGl);
const texAGpu = skyMod.createProceduralSkyTextureWebGPU(mockDevice, null, 64, 32);
const texBGpu = skyMod.createExoticNebulaTextureBWebGPU(mockDevice, null, 64, 32);
const texAGl = skyMod.createProceduralSkyTextureWebGL(mockGl, 64, 32);
const texBGl = skyMod.createExoticNebulaTextureBWebGL(mockGl, 64, 32);

assert(
  Boolean(gpuBb && glBb && gpuBn && glBn && phGpu && phGl && texAGpu && texBGpu && texAGl && texBGl) &&
    gpuCalls.length === 5 &&
    glCalls.length === 5 &&
    skyMod.DEFAULT_SKY_URL.endsWith('/shared/assets/milkyway_4k.jpg'),
  'physicalLuts.js and skyLoader.js support placeholders + single- and dual-universe WebGL2 + WebGPU uploads'
);

const forbiddenGlsl = /\b(isnan|isinf|inversesqrt|dFdx|dFdy|gl_FragCoord|gl_VertexID|texelFetch|textureGrad)\s*\(/;
for (const profileName of Object.keys(POST_OPTICS_PROFILES)) {
  const p = POST_OPTICS_PROFILES[profileName];
  const gl = postGlslMod.createPostShadersGLSL(profileName);
  const wg = postWgslMod.createPostShadersWGSL(profileName);
  const glOk = Object.values(gl).every((s) => s.includes('#version 300 es'));
  const wgOk = Object.values(wg).every((s) => s.includes('@fragment') && !forbiddenGlsl.test(s));
  const profileOk =
    Array.isArray(p.coreTint) &&
    p.coreTint.length === 3 &&
    p.coreTint.every(Number.isFinite) &&
    Array.isArray(p.outerTint) &&
    p.outerTint.length === 3 &&
    p.outerTint.every(Number.isFinite) &&
    Number.isFinite(p.fringeStart) &&
    Number.isFinite(p.fringeMix) &&
    Number.isFinite(p.bloomGain) &&
    Number.isFinite(p.anamorphicGain);
  const uniformParityOk =
    gl.ANAMORPHIC_FRAG.includes('uniform vec4 uTintInnerEdge;') &&
    gl.ANAMORPHIC_FRAG.includes('uniform vec4 uTintOuterMix;') &&
    wg.ANAMORPHIC_WGSL.includes('tint_inner_edge') &&
    wg.ANAMORPHIC_WGSL.includes('tint_outer_mix') &&
    gl.COMPOSITE_FRAG.includes('uniform float uBloomGain;') &&
    gl.COMPOSITE_FRAG.includes('uniform float uAnamorphicGain;') &&
    wg.COMPOSITE_WGSL.includes('weights_pad') &&
    wg.COMPOSITE_WGSL.includes('u.weights_pad.x') &&
    wg.COMPOSITE_WGSL.includes('u.weights_pad.y');
  assert(
    glOk && wgOk && profileOk && uniformParityOk,
    `Post shader profile '${profileName}' passes GLSL <-> WGSL uniform parity`
  );
}

const postGlDefault = postGlslMod.createPostShadersGLSL('default');
const postWgDefault = postWgslMod.createPostShadersWGSL('default');
const postContractOk =
  !postGlslAll.includes('exp(-abs(float(i))') &&
  !postGlDefault.ANAMORPHIC_FRAG.includes('exp(') &&
  !postWgDefault.ANAMORPHIC_WGSL.includes('exp(') &&
  postGlDefault.COMPOSITE_FRAG.includes('r2 > 0.04') &&
  postWgDefault.COMPOSITE_WGSL.includes('r2 > 0.04') &&
  !postGlDefault.BLOOM_DOWNSAMPLE_FRAG.includes('isBadFloat') &&
  !postWgDefault.BLOOM_DOWNSAMPLE_WGSL.includes('isBadFloat');
assert(
  postContractOk,
  'Phase P2 post shaders eliminate anamorphic exp(), guard composite CA (r2 > 0.04), and drop redundant downsample NaN guards'
);

const expectedGradTable = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
  [1, 1, 0], [-1, 1, 0], [0, -1, 1], [0, -1, -1],
];
const gradMaskOk = expectedGradTable.every(([ex, ey, ez], idx) => {
  const shift = idx << 1;
  const gx = ((0x52552222 >>> shift) & 3) - 1;
  const gy = ((0x0a22550a >>> shift) & 3) - 1;
  const gz = ((0x250a0a55 >>> shift) & 3) - 1;
  return gx === ex && gy === ey && gz === ez;
});

assert(
  commonGlsl.FULLSCREEN_VERT.includes('#version 300 es') &&
    commonGlsl.NOISE_BAKE_FRAG.includes('#version 300 es') &&
    commonGlsl.NOISE_BAKE_FRAG.includes('0x52552222u') &&
    commonGlsl.SKY_BAKE_FRAG.includes('#version 300 es') &&
    commonGlsl.SKY_BAKE_FRAG.includes('uniform int uUniverse;') &&
    commonWgsl.MIPMAP_WGSL.includes('@fragment') &&
    commonWgsl.NOISE_BAKE_COMPUTE_WGSL.includes('@compute') &&
    commonWgsl.NOISE_BAKE_COMPUTE_WGSL.includes('0x52552222u') &&
    commonWgsl.SKY_BAKE_WGSL.includes('@fragment') &&
    !forbiddenGlsl.test(commonWgsl.NOISE_BAKE_COMPUTE_WGSL) &&
    !forbiddenGlsl.test(commonWgsl.SKY_BAKE_WGSL) &&
    gradMaskOk,
  'Shared common.glsl.js & common.wgsl.js shader contracts + branchless grad masks valid'
);

console.log('\n=== 5. Observatory Homepage Contract, Catalog & Preview Assets ===');
const homeFiles = [
  'index.html',
  'home/styles.css',
  'home/app.js',
  'home/catalogData.js',
  'shared/tests/homepage_qa.mjs',
];
for (const rel of homeFiles) {
  const full = path.join(REPO_ROOT, rel);
  const exists = fs.existsSync(full) && fs.statSync(full).size > 0;
  assert(exists, `Homepage file exists and is non-empty: ${rel}`);
}

for (const rel of ['home/app.js', 'home/catalogData.js', 'shared/tests/homepage_qa.mjs']) {
  const full = path.join(REPO_ROOT, rel);
  try {
    execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
    assert(true, `JS syntax OK: ${rel}`);
  } catch (err) {
    assert(false, `JS syntax ERROR: ${rel}`, err.stderr?.toString().trim() || err.message);
  }
}

const catalogMod = await import(path.join(REPO_ROOT, 'home/catalogData.js'));
const { CATEGORIES, SIM_CATALOG_META } = catalogMod;
const expectedCategoryIds = ['all', 'gr', 'exotic', 'astro', 'sr'];
assert(
  Array.isArray(CATEGORIES) &&
    expectedCategoryIds.every((cid) => CATEGORIES.some((c) => c.id === cid && typeof c.label === 'string' && c.label.length > 0)),
  'home/catalogData.js exports valid CATEGORIES',
  Array.isArray(CATEGORIES) ? CATEGORIES.map((c) => c.id).join(', ') : 'missing'
);

let totalPreviewBytes = 0;
let allPreviewsValid = true;
const previewDetails = [];
for (const sim of SIMULATORS) {
  const meta = SIM_CATALOG_META?.[sim.id];
  const expectedPreview = `./home/previews/${sim.id}.webp`;
  const metaOk =
    Boolean(meta) &&
    typeof meta.index === 'string' &&
    typeof meta.category === 'string' &&
    expectedCategoryIds.includes(meta.category) &&
    meta.category !== 'all' &&
    typeof meta.categoryLabel === 'string' &&
    meta.categoryLabel.length > 0 &&
    typeof meta.tagline === 'string' &&
    meta.tagline.length > 0 &&
    typeof meta.accent === 'string' &&
    /^#[0-9a-fA-F]{6}$/.test(meta.accent) &&
    meta.preview === expectedPreview &&
    typeof meta.previewAlt === 'string' &&
    meta.previewAlt.length > 0 &&
    typeof meta.equation === 'string' &&
    meta.equation.length > 0 &&
    typeof meta.metricName === 'string' &&
    meta.metricName.length > 0 &&
    Array.isArray(meta.highlights) &&
    meta.highlights.length === 3 &&
    Array.isArray(meta.specs) &&
    meta.specs.length === 3 &&
    meta.specs.every((s) => s && typeof s.label === 'string' && typeof s.value === 'string') &&
    Array.isArray(meta.presets) &&
    meta.presets.length >= 6 &&
    meta.presets.every((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.summary === 'string');

  assert(
    metaOk,
    `SIM_CATALOG_META['${sim.id}'] contract valid`,
    meta ? `presets=${meta.presets?.length ?? 0}, category=${meta.category}` : 'missing entry'
  );

  const webpRel = `home/previews/${sim.id}.webp`;
  const webpFull = path.join(REPO_ROOT, webpRel);
  let webpOk = false;
  let sizeBytes = 0;
  if (fs.existsSync(webpFull)) {
    const buf = fs.readFileSync(webpFull);
    sizeBytes = buf.length;
    totalPreviewBytes += sizeBytes;
    const isRiffWebp =
      buf.length >= 12 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP';
    webpOk = isRiffWebp && sizeBytes > 0 && sizeBytes <= 160 * 1024;
  }
  if (!webpOk) allPreviewsValid = false;
  previewDetails.push(`${sim.id}:${(sizeBytes / 1024).toFixed(1)}KB`);
  assert(
    webpOk,
    `Preview WebP valid & lightweight (<=160 KB): ${webpRel}`,
    `${(sizeBytes / 1024).toFixed(1)} KB`
  );
}

assert(
  allPreviewsValid && totalPreviewBytes > 0 && totalPreviewBytes <= 900 * 1024,
  'Total size of all 7 homepage preview WebPs is <= 900 KB',
  `${(totalPreviewBytes / 1024).toFixed(1)} KB (${previewDetails.join(', ')})`
);

const rootHtml = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
const homeAppJs = fs.readFileSync(path.join(REPO_ROOT, 'home/app.js'), 'utf8');
const gpuInitPattern = /getContext\s*\(\s*['"]webgl|navigator\.gpu\.requestAdapter\s*\(/i;
assert(
  !gpuInitPattern.test(rootHtml) && !gpuInitPattern.test(homeAppJs) && !/<canvas\b/i.test(rootHtml),
  'Homepage (index.html + home/app.js) does NOT instantiate WebGL/WebGPU contexts or <canvas>'
);
assert(
  rootHtml.includes('./shared/simRegistry.js') &&
    rootHtml.includes('resolveSimByAlias') &&
    rootHtml.includes("params.get('sim')") &&
    rootHtml.includes('window.location.replace'),
  'Root index.html preserves fast-path ?sim= redirect routing via shared/simRegistry.js'
);

console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
