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
  getSimById('pulsar')?.dir === 'pulsar-sim' &&
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

console.log('\n=== 3. Shared HTML / CSS / Switcher Wiring Across All 7 Simulators ===');
const baseCss = fs.readFileSync(path.join(REPO_ROOT, 'shared/ui/base.css'), 'utf8');
assert(baseCss.includes('.sim-canvas') && baseCss.includes('.sim-switcher'), 'shared/ui/base.css defines .sim-canvas and .sim-switcher');

for (const sim of SIMULATORS) {
  const html = fs.readFileSync(path.join(REPO_ROOT, sim.dir, 'index.html'), 'utf8');
  const mainJs = fs.readFileSync(path.join(REPO_ROOT, sim.dir, 'src/main.js'), 'utf8');
  const ok =
    html.includes('../shared/ui/base.css') &&
    html.includes('class="sim-canvas"') &&
    html.includes(`data-current-sim="${sim.id}"`) &&
    !html.includes('sim-switch-link') &&
    mainJs.includes('../../shared/ui/simSwitcher.js') &&
    mainJs.includes('../../shared/assets/skyLoader.js');
  assert(ok, `${sim.dir} cleanly wired to shared/ui/base.css, simSwitcher.js, and skyLoader.js`);
}

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

const gpuBb = lutsMod.createBlackbodyLUT(mockDevice, 512);
const glBb = lutsMod.createBlackbodyLUT(mockGl, 512);
const gpuBn = lutsMod.createBlueNoiseLUT(mockDevice, 128);
const glBn = lutsMod.createBlueNoiseLUT(mockGl, 128);
const texAGpu = skyMod.createProceduralSkyTextureWebGPU(mockDevice, null, 64, 32);
const texBGpu = skyMod.createExoticNebulaTextureBWebGPU(mockDevice, null, 64, 32);
const texAGl = skyMod.createProceduralSkyTextureWebGL(mockGl, 64, 32);
const texBGl = skyMod.createExoticNebulaTextureBWebGL(mockGl, 64, 32);

assert(
  Boolean(gpuBb && glBb && gpuBn && glBn && texAGpu && texBGpu && texAGl && texBGl) &&
    gpuCalls.length === 4 &&
    glCalls.length === 4 &&
    skyMod.DEFAULT_SKY_URL.endsWith('/shared/assets/milkyway_4k.jpg'),
  'physicalLuts.js and skyLoader.js support single- and dual-universe WebGL2 + WebGPU uploads'
);

const forbiddenGlsl = /\b(isnan|isinf|inversesqrt|dFdx|dFdy|gl_FragCoord|gl_VertexID|texelFetch|textureGrad)\s*\(/;
for (const profileName of Object.keys(POST_OPTICS_PROFILES)) {
  const p = POST_OPTICS_PROFILES[profileName];
  const gl = postGlslMod.createPostShadersGLSL(profileName);
  const wg = postWgslMod.createPostShadersWGSL(profileName);
  const glOk = Object.values(gl).every((s) => s.includes('#version 300 es'));
  const wgOk = Object.values(wg).every((s) => s.includes('@fragment') && !forbiddenGlsl.test(s));
  const bloomToken = String(p.bloomGain);
  const anaToken = String(p.anamorphicGain);
  const parityOk =
    gl.COMPOSITE_FRAG.includes(bloomToken) &&
    wg.COMPOSITE_WGSL.includes(bloomToken) &&
    gl.COMPOSITE_FRAG.includes(anaToken) &&
    wg.COMPOSITE_WGSL.includes(anaToken);
  assert(glOk && wgOk && parityOk, `Post shader profile '${profileName}' passes GLSL <-> WGSL parity`);
}

assert(
  commonGlsl.FULLSCREEN_VERT.includes('#version 300 es') &&
    commonGlsl.NOISE_BAKE_FRAG.includes('#version 300 es') &&
    commonWgsl.MIPMAP_WGSL.includes('@fragment') &&
    commonWgsl.NOISE_BAKE_COMPUTE_WGSL.includes('@compute') &&
    !forbiddenGlsl.test(commonWgsl.NOISE_BAKE_COMPUTE_WGSL),
  'Shared common.glsl.js & common.wgsl.js shader contracts valid'
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
