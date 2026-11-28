#!/usr/bin/env node
/**
 * Unified Metadata Registry Generator & Drift Guard (`scripts/sync-metadata.mjs`).
 *
 * Reads canonical `shared/sims.json` and `shared/physicsTour.json` and generates/verifies zero-fetch JS ESM
 * (`shared/simRegistry.js`, `home/catalogData.js`, `shared/ui/physicsTourData.js`) and zero-dependency Rust
 * `const` tables (`desktop/src/sims/registry.rs`, `desktop/src/ui/tour_data.rs`).
 *
 * Usage:
 *   node scripts/sync-metadata.mjs --check   # Verify all generated files match shared/sims.json (default)
 *   node scripts/sync-metadata.mjs --write   # Regenerate JS and Rust metadata modules
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_REL = 'shared/sims.json';
const TOUR_REL = 'shared/physicsTour.json';

function jsStr(value) {
  return JSON.stringify(String(value));
}

function rsStr(value) {
  return JSON.stringify(String(value));
}

function parseHexRgb(hex, label) {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!m) {
    throw new Error(`Invalid hex color "${hex}" for ${label}`);
  }
  return [
    `0x${m[1].toLowerCase()}`,
    `0x${m[2].toLowerCase()}`,
    `0x${m[3].toLowerCase()}`,
  ];
}

const RUST_CATEGORIES = {
  gr: 'SimCategory::GeneralRelativity',
  exotic: 'SimCategory::ExoticMetrics',
  astro: 'SimCategory::Astrophysics',
  sr: 'SimCategory::SpecialRelativity',
};

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('shared/sims.json must export a root object.');
  }
  const { categories, simulators } = manifest;
  if (!Array.isArray(categories) || categories.length < 2) {
    throw new Error('shared/sims.json must declare a non-empty categories array.');
  }
  if (!Array.isArray(simulators) || simulators.length < 8) {
    throw new Error(`shared/sims.json must declare at least 8 simulators (found ${simulators?.length ?? 0}).`);
  }

  const seenIds = new Set();
  const seenDirs = new Set();
  const seenHandles = new Set();
  const seenAliases = new Set();

  for (const sim of simulators) {
    for (const key of [
      'id', 'rustVariant', 'dir', 'index', 'shortLabel', 'shortTitle', 'title',
      'windowTitle', 'launchLabel', 'ariaLabel', 'debugHandle', 'accentVar',
      'cliFlag', 'description', 'category', 'categoryLabel', 'tagline',
      'accent', 'accentBright', 'preview', 'previewAlt', 'equation',
      'metricName', 'specialControl',
    ]) {
      if (typeof sim[key] !== 'string' || sim[key].trim().length === 0) {
        throw new Error(`Simulator "${sim.id || '?'}" missing string field "${key}".`);
      }
    }
    if (typeof sim.cardClass !== 'string') {
      throw new Error(`Simulator "${sim.id}" cardClass must be a string.`);
    }
    if (!RUST_CATEGORIES[sim.category]) {
      throw new Error(`Simulator "${sim.id}" has unknown category "${sim.category}".`);
    }
    if (!Array.isArray(sim.aliases) || sim.aliases.length === 0) {
      throw new Error(`Simulator "${sim.id}" must declare non-empty aliases.`);
    }
    if (!Array.isArray(sim.highlights) || sim.highlights.length !== 3) {
      throw new Error(`Simulator "${sim.id}" must declare 3 highlights.`);
    }
    if (!Array.isArray(sim.specs) || sim.specs.length !== 3) {
      throw new Error(`Simulator "${sim.id}" must declare 3 specs.`);
    }
    if (!Array.isArray(sim.presets) || sim.presets.length !== 6) {
      throw new Error(`Simulator "${sim.id}" must declare 6 presets.`);
    }
    if (seenIds.has(sim.id)) throw new Error(`Duplicate simulator id: ${sim.id}`);
    if (seenDirs.has(sim.dir)) throw new Error(`Duplicate simulator dir: ${sim.dir}`);
    if (seenHandles.has(sim.debugHandle)) throw new Error(`Duplicate debugHandle: ${sim.debugHandle}`);
    seenIds.add(sim.id);
    seenDirs.add(sim.dir);
    seenHandles.add(sim.debugHandle);

    for (const alias of sim.aliases) {
      const norm = String(alias).trim().toLowerCase();
      if (!norm || seenAliases.has(norm)) {
        throw new Error(`Duplicate or empty alias "${alias}" on simulator "${sim.id}".`);
      }
      seenAliases.add(norm);
    }
  }
}

function renderSimRegistryJs(manifest) {
  const categories = manifest.categories
    .filter((c) => c.id !== 'all')
    .map((c) => `  Object.freeze({ id: ${jsStr(c.id)}, label: ${jsStr(c.label)} }),`);

  const entries = manifest.simulators.map((sim) => {
    const aliases = sim.aliases.map(jsStr).join(', ');
    return [
      '  Object.freeze({',
      `    id: ${jsStr(sim.id)},`,
      `    dir: ${jsStr(sim.dir)},`,
      `    index: ${jsStr(sim.index)},`,
      `    shortLabel: ${jsStr(sim.shortLabel)},`,
      `    title: ${jsStr(sim.title)},`,
      `    ariaLabel: ${jsStr(sim.ariaLabel)},`,
      `    debugHandle: ${jsStr(sim.debugHandle)},`,
      `    accentVar: ${jsStr(sim.accentVar)},`,
      `    cardClass: ${jsStr(sim.cardClass)},`,
      `    category: ${jsStr(sim.category)},`,
      `    categoryLabel: ${jsStr(sim.categoryLabel)},`,
      `    tagline: ${jsStr(sim.tagline)},`,
      `    accent: ${jsStr(sim.accent)},`,
      `    accentBright: ${jsStr(sim.accentBright)},`,
      `    aliases: Object.freeze([${aliases}]),`,
      `    description: ${jsStr(sim.description)},`,
      '  }),',
    ].join('\n');
  });

  return [
    `// AUTO-GENERATED by scripts/sync-metadata.mjs from ${MANIFEST_REL}. Do not edit directly.`,
    '/**',
    ' * Canonical registry of all Interstellar Spacetime Simulators.',
    ' * Single source of truth for root routing, fallback cards, top-right nav switcher,',
    ' * launch/test tooling, and shared verification scripts.',
    ' */',
    '',
    'export const SIM_CATEGORIES = Object.freeze([',
    ...categories,
    ']);',
    '',
    'export const SIMULATORS = Object.freeze([',
    ...entries,
    ']);',
    '',
    '/**',
    ' * Finds a simulator entry by its canonical `id`.',
    ' * @param {string} id',
    ' */',
    'export function getSimById(id) {',
    "  const key = String(id || '').trim().toLowerCase();",
    '  return SIMULATORS.find((sim) => sim.id === key) || null;',
    '}',
    '',
    '/**',
    ' * Resolves any CLI/URL alias (or directory name) to its simulator entry.',
    ' * Returns `SIMULATORS[0]` (blackhole) when empty/unmatched unless `strict` is true.',
    ' * @param {string} raw',
    ' * @param {{ strict?: boolean }} [options]',
    ' */',
    'export function resolveSimByAlias(raw, { strict = false } = {}) {',
    "  const key = String(raw || '').trim().toLowerCase();",
    '  if (!key) {',
    '    return strict ? null : SIMULATORS[0];',
    '  }',
    '  const found = SIMULATORS.find(',
    '    (sim) => sim.id === key || sim.dir === key || sim.aliases.includes(key)',
    '  );',
    '  if (found) return found;',
    '  return strict ? null : SIMULATORS[0];',
    '}',
    '',
  ].join('\n');
}

function renderCatalogDataJs(manifest) {
  const categories = manifest.categories.map(
    (c) => `  Object.freeze({ id: ${jsStr(c.id)}, label: ${jsStr(c.label)} }),`
  );

  const metaBlocks = manifest.simulators.map((sim) => {
    const highlights = sim.highlights.map((h) => `      ${jsStr(h)},`);
    const specs = sim.specs.map(
      (s) => `      Object.freeze({ label: ${jsStr(s.label)}, value: ${jsStr(s.value)} }),`
    );
    const presets = sim.presets.map((p) =>
      [
        '      Object.freeze({',
        `        id: ${jsStr(p.id)},`,
        `        name: ${jsStr(p.name)},`,
        `        summary: ${jsStr(p.summary)},`,
        '      }),',
      ].join('\n')
    );

    return [
      `  ${/^[A-Za-z_$][\w$]*$/.test(sim.id) ? sim.id : jsStr(sim.id)}: Object.freeze({`,
      `    index: ${jsStr(sim.index)},`,
      `    category: ${jsStr(sim.category)},`,
      `    categoryLabel: ${jsStr(sim.categoryLabel)},`,
      `    tagline: ${jsStr(sim.tagline)},`,
      `    accent: ${jsStr(sim.accent)},`,
      `    accentBright: ${jsStr(sim.accentBright)},`,
      `    preview: ${jsStr(sim.preview)},`,
      `    previewAlt: ${jsStr(sim.previewAlt)},`,
      `    equation: ${jsStr(sim.equation)},`,
      `    metricName: ${jsStr(sim.metricName)},`,
      `    cliFlag: ${jsStr(sim.cliFlag)},`,
      `    specialControl: ${jsStr(sim.specialControl)},`,
      '    highlights: Object.freeze([',
      ...highlights,
      '    ]),',
      '    specs: Object.freeze([',
      ...specs,
      '    ]),',
      '    presets: Object.freeze([',
      ...presets,
      '    ]),',
      '  }),',
    ].join('\n');
  });

  return [
    `// AUTO-GENERATED by scripts/sync-metadata.mjs from ${MANIFEST_REL}. Do not edit directly.`,
    '/**',
    ` * Canonical Homepage catalog metadata & physics dossiers for all ${manifest.simulators.length} Interstellar`,
    ' * Spacetime Simulators. Pure ES module, zero dependencies.',
    ' */',
    '',
    'export const CATEGORIES = Object.freeze([',
    ...categories,
    ']);',
    '',
    'export const SIM_CATALOG_META = Object.freeze({',
    ...metaBlocks,
    '});',
    '',
  ].join('\n');
}

function renderRustRegistry(manifest) {
  const entries = manifest.simulators.map((sim) => {
    const accent = parseHexRgb(sim.accent, `${sim.id}.accent`);
    const accentBright = parseHexRgb(sim.accentBright, `${sim.id}.accentBright`);
    const aliasesInline = sim.aliases.map(rsStr).join(', ');
    const aliasesLines =
      aliasesInline.length <= 60
        ? [`        aliases: &[${aliasesInline}],`]
        : [
            '        aliases: &[',
            ...sim.aliases.map((a) => `            ${rsStr(a)},`),
            '        ],',
          ];
    const highlights = sim.highlights.map((h) => `            ${rsStr(h)},`);
    const specs = sim.specs.map(
      (s) => `            (${rsStr(s.label)}, ${rsStr(s.value)}),`
    );
    const presets = sim.presets.map((p) =>
      [
        '            (',
        `                ${rsStr(p.name)},`,
        `                ${rsStr(p.summary)},`,
        '            ),',
      ].join('\n')
    );

    return [
      '    SimRegistryEntry {',
      `        id: SimId::${sim.rustVariant},`,
      `        index: ${rsStr(sim.index)},`,
      `        cli_name: ${rsStr(sim.id)},`,
      `        switch_label: ${rsStr(sim.shortLabel)},`,
      `        window_title: ${rsStr(sim.windowTitle)},`,
      ...aliasesLines,
      `        category: ${RUST_CATEGORIES[sim.category]},`,
      `        category_label: ${rsStr(sim.categoryLabel)},`,
      `        title: ${rsStr(sim.title)},`,
      `        short_title: ${rsStr(sim.shortTitle)},`,
      `        tagline: ${rsStr(sim.tagline)},`,
      `        description: ${rsStr(sim.description)},`,
      `        equation: ${rsStr(sim.equation)},`,
      `        metric_name: ${rsStr(sim.metricName)},`,
      `        accent_rgb: [${accent.join(', ')}],`,
      `        accent_bright_rgb: [${accentBright.join(', ')}],`,
      `        special_control: ${rsStr(sim.specialControl)},`,
      '        highlights: [',
      ...highlights,
      '        ],',
      '        specs: [',
      ...specs,
      '        ],',
      '        presets: [',
      ...presets,
      '        ],',
      '    },',
    ].join('\n');
  });

  const matchArms = manifest.simulators.map(
    (sim, idx) => `        SimId::${sim.rustVariant} => &SIM_REGISTRY[${idx}],`
  );

  const catLabel = (id, fallback) =>
    manifest.categories.find((c) => c.id === id)?.label || fallback;

  return [
    `// AUTO-GENERATED by scripts/sync-metadata.mjs from ${MANIFEST_REL}. Do not edit directly.`,
    '',
    'use crate::sims::SimId;',
    '',
    '#[derive(Copy, Clone, Debug, Eq, PartialEq)]',
    'pub enum SimCategory {',
    '    GeneralRelativity,',
    '    ExoticMetrics,',
    '    Astrophysics,',
    '    SpecialRelativity,',
    '}',
    '',
    'impl SimCategory {',
    '    pub const ALL: [SimCategory; 4] = [',
    '        SimCategory::GeneralRelativity,',
    '        SimCategory::ExoticMetrics,',
    '        SimCategory::Astrophysics,',
    '        SimCategory::SpecialRelativity,',
    '    ];',
    '',
    '    pub const fn label(self) -> &\'static str {',
    '        match self {',
    `            SimCategory::GeneralRelativity => ${rsStr(catLabel('gr', 'General Relativity'))},`,
    `            SimCategory::ExoticMetrics => ${rsStr(catLabel('exotic', 'Exotic Metrics'))},`,
    `            SimCategory::Astrophysics => ${rsStr(catLabel('astro', 'Astrophysics'))},`,
    `            SimCategory::SpecialRelativity => ${rsStr(catLabel('sr', 'Special Relativity'))},`,
    '        }',
    '    }',
    '}',
    '',
    'pub struct SimRegistryEntry {',
    '    pub id: SimId,',
    "    pub index: &'static str,",
    "    pub cli_name: &'static str,",
    "    pub switch_label: &'static str,",
    "    pub window_title: &'static str,",
    "    pub aliases: &'static [&'static str],",
    '    pub category: SimCategory,',
    "    pub category_label: &'static str,",
    "    pub title: &'static str,",
    "    pub short_title: &'static str,",
    "    pub tagline: &'static str,",
    "    pub description: &'static str,",
    "    pub equation: &'static str,",
    "    pub metric_name: &'static str,",
    '    pub accent_rgb: [u8; 3],',
    '    pub accent_bright_rgb: [u8; 3],',
    "    pub special_control: &'static str,",
    "    pub highlights: [&'static str; 3],",
    "    pub specs: [(&'static str, &'static str); 3],",
    "    pub presets: [(&'static str, &'static str); 6],",
    '}',
    '',
    `pub const SIM_REGISTRY: [SimRegistryEntry; ${manifest.simulators.length}] = [`,
    ...entries,
    '];',
    '',
    'pub const fn registry_entry(id: SimId) -> &\'static SimRegistryEntry {',
    '    match id {',
    ...matchArms,
    '    }',
    '}',
    '',
    'pub fn resolve_sim_id(raw: &str) -> Option<SimId> {',
    '    let key = raw.trim().to_ascii_lowercase();',
    '    for entry in &SIM_REGISTRY {',
    '        if entry.aliases.iter().any(|&a| a == key) {',
    '            return Some(entry.id);',
    '        }',
    '    }',
    '    None',
    '}',
    '',
  ].join('\n');
}

function validatePhysicsTour(tourData, manifest) {
  if (!tourData || typeof tourData !== 'object' || Array.isArray(tourData)) {
    throw new Error(`${TOUR_REL} must export a root object keyed by simulator ID.`);
  }
  for (const sim of manifest.simulators) {
    const simTour = tourData[sim.id];
    if (!simTour || typeof simTour !== 'object') {
      throw new Error(`${TOUR_REL} missing entry for simulator "${sim.id}".`);
    }
    for (const preset of sim.presets) {
      const entry = simTour[preset.id];
      if (!entry || typeof entry !== 'object') {
        throw new Error(`${TOUR_REL} missing preset "${sim.id}.${preset.id}".`);
      }
      for (const field of ['headline', 'summary', 'formula']) {
        if (typeof entry[field] !== 'string' || entry[field].trim().length === 0) {
          throw new Error(`${TOUR_REL} "${sim.id}.${preset.id}" missing non-empty "${field}".`);
        }
      }
      if (!Array.isArray(entry.callouts) || entry.callouts.length < 3 || entry.callouts.length > 4) {
        throw new Error(`${TOUR_REL} "${sim.id}.${preset.id}" must declare 3-4 callouts.`);
      }
      for (const c of entry.callouts) {
        for (const f of ['id', 'title', 'metric', 'detail']) {
          if (typeof c[f] !== 'string' || c[f].trim().length === 0) {
            throw new Error(`${TOUR_REL} "${sim.id}.${preset.id}" callout missing "${f}".`);
          }
        }
        if (typeof c.x !== 'number' || c.x < 0.1 || c.x > 0.9 || typeof c.y !== 'number' || c.y < 0.15 || c.y > 0.85) {
          throw new Error(`${TOUR_REL} "${sim.id}.${preset.id}.${c.id}" has out-of-bounds coordinates (${c.x}, ${c.y}).`);
        }
      }
    }
  }
}

function renderPhysicsTourDataJs(tourData) {
  return [
    `// AUTO-GENERATED by scripts/sync-metadata.mjs from ${TOUR_REL}. Do not edit directly.`,
    '/**',
    ' * Canonical Interactive Physics Tour annotations & reticle callouts for all 8',
    ' * Interstellar Simulation engines and 48 curated presets.',
    ' */',
    '',
    `export const PHYSICS_TOUR_DATA = Object.freeze(${JSON.stringify(tourData, null, 2)});`,
    '',
    'export function getPresetTour(simId, presetId) {',
    '  const simTours = PHYSICS_TOUR_DATA[simId];',
    '  if (!simTours) return null;',
    '  if (presetId && simTours[presetId]) return simTours[presetId];',
    '  const firstKey = Object.keys(simTours)[0];',
    '  return firstKey ? simTours[firstKey] : null;',
    '}',
    '',
  ].join('\n');
}

function renderRustTourData(tourData, manifest) {
  const staticBlocks = [];
  const simMatchArms = [];

  for (const sim of manifest.simulators) {
    const simConst = sim.id.replace(/-/g, '_').toUpperCase();
    const presetEntries = [];
    for (const preset of sim.presets) {
      const tour = tourData[sim.id][preset.id];
      const calloutConstName = `CALLOUTS_${simConst}_${preset.id.replace(/-/g, '_').toUpperCase()}`;
      const calloutItems = tour.callouts.map((c) =>
        [
          '    TourCallout {',
          `        id: ${rsStr(c.id)},`,
          `        title: ${rsStr(c.title)},`,
          `        metric: ${rsStr(c.metric)},`,
          `        x: ${Number(c.x).toFixed(4)},`,
          `        y: ${Number(c.y).toFixed(4)},`,
          `        detail: ${rsStr(c.detail)},`,
          '    },',
        ].join('\n')
      );
      staticBlocks.push(
        `static ${calloutConstName}: [TourCallout; ${tour.callouts.length}] = [\n${calloutItems.join('\n')}\n];`
      );
      presetEntries.push(
        [
          '    PresetTour {',
          `        preset_id: ${rsStr(preset.id)},`,
          `        headline: ${rsStr(tour.headline)},`,
          `        summary: ${rsStr(tour.summary)},`,
          `        formula: ${rsStr(tour.formula)},`,
          `        callouts: &${calloutConstName},`,
          '    },',
        ].join('\n')
      );
    }
    const simArrName = `TOURS_${simConst}`;
    staticBlocks.push(
      `static ${simArrName}: [PresetTour; ${sim.presets.length}] = [\n${presetEntries.join('\n')}\n];`
    );
    simMatchArms.push(`        SimId::${sim.rustVariant} => &${simArrName},`);
  }

  return [
    `// AUTO-GENERATED by scripts/sync-metadata.mjs from ${TOUR_REL}. Do not edit directly.`,
    '',
    'use crate::sims::SimId;',
    '',
    'pub struct TourCallout {',
    "    pub id: &'static str,",
    "    pub title: &'static str,",
    "    pub metric: &'static str,",
    '    pub x: f32,',
    '    pub y: f32,',
    "    pub detail: &'static str,",
    '}',
    '',
    'pub struct PresetTour {',
    "    pub preset_id: &'static str,",
    "    pub headline: &'static str,",
    "    pub summary: &'static str,",
    "    pub formula: &'static str,",
    "    pub callouts: &'static [TourCallout],",
    '}',
    '',
    ...staticBlocks,
    '',
    "pub fn preset_tour(sim: SimId, preset_id: &str) -> &'static PresetTour {",
    "    let list: &'static [PresetTour] = match sim {",
    ...simMatchArms,
    '    };',
    '    list.iter()',
    '        .find(|t| t.preset_id == preset_id)',
    '        .unwrap_or(&list[0])',
    '}',
    '',
  ].join('\n');
}

function summarizeFirstDiff(expected, actual) {
  const expLines = expected.split('\n');
  const actLines = actual.split('\n');
  const maxLines = Math.max(expLines.length, actLines.length);
  const diffs = [];
  for (let i = 0; i < maxLines; i++) {
    if (expLines[i] !== actLines[i]) {
      diffs.push(
        `    line ${i + 1}:\n      expected: ${JSON.stringify(expLines[i] ?? '<EOF>')}\n      actual  : ${JSON.stringify(actLines[i] ?? '<EOF>')}`
      );
      if (diffs.length >= 3) break;
    }
  }
  return diffs.join('\n');
}

function parseArgs(argv) {
  let mode = 'check';
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/sync-metadata.mjs [--check | --write]');
      process.exit(0);
    } else if (arg === '--write') {
      mode = 'write';
    } else if (arg === '--check') {
      mode = 'check';
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    }
  }
  return mode;
}

function main() {
  const mode = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(REPO_ROOT, MANIFEST_REL);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  validateManifest(manifest);

  const tourPath = path.join(REPO_ROOT, TOUR_REL);
  const tourData = JSON.parse(fs.readFileSync(tourPath, 'utf8'));
  validatePhysicsTour(tourData, manifest);

  const outputs = [
    ['shared/simRegistry.js', renderSimRegistryJs(manifest)],
    ['home/catalogData.js', renderCatalogDataJs(manifest)],
    ['desktop/src/sims/registry.rs', renderRustRegistry(manifest)],
    ['shared/ui/physicsTourData.js', renderPhysicsTourDataJs(tourData)],
    ['desktop/src/ui/tour_data.rs', renderRustTourData(tourData, manifest)],
  ];

  let written = 0;
  let unchanged = 0;
  let drifted = 0;

  for (const [relPath, expected] of outputs) {
    const outPath = path.join(REPO_ROOT, relPath);
    const exists = fs.existsSync(outPath);
    const actual = exists ? fs.readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n') : null;

    if (mode === 'write') {
      if (actual === expected) {
        unchanged++;
        console.log(`  [OK]   ${relPath} (unchanged)`);
      } else {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, expected, 'utf8');
        written++;
        console.log(`  [SYNC] ${relPath}`);
      }
    } else if (!exists) {
      drifted++;
      console.error(`  [FAIL] ${relPath} is missing.`);
    } else if (actual !== expected) {
      drifted++;
      console.error(`  [FAIL] ${relPath} is out of sync with ${MANIFEST_REL}:`);
      console.error(summarizeFirstDiff(expected, actual));
    } else {
      unchanged++;
      console.log(`  [PASS] ${relPath}`);
    }
  }

  if (mode === 'write') {
    console.log(`\nMetadata sync complete: ${written} updated, ${unchanged} unchanged (${outputs.length} total).`);
    process.exit(0);
  }

  if (drifted > 0) {
    console.error(
      `\nMetadata drift detected in ${drifted} file(s). Run: node scripts/sync-metadata.mjs --write`
    );
    process.exit(1);
  }

  console.log(`\nMetadata check passed: ${unchanged}/${outputs.length} generated targets match ${MANIFEST_REL}.`);
}

main();
