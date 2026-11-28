#!/usr/bin/env node
/**
 * render-packaging.mjs — Zero-dependency desktop packaging manifest generator & validator.
 *
 * Reads the canonical version from `desktop/Cargo.toml` and generates/verifies:
 *   - packaging/linux/io.github.a_gud_boy.InterstellarDesktop.desktop
 *   - packaging/linux/io.github.a_gud_boy.InterstellarDesktop.metainfo.xml
 *   - packaging/flatpak/io.github.a_gud_boy.InterstellarDesktop.yml
 *   - packaging/homebrew/interstellar-desktop.rb
 *   - packaging/winget/a-gud-boy.InterstellarDesktop.yaml
 *   - packaging/winget/a-gud-boy.InterstellarDesktop.installer.yaml
 *   - packaging/winget/a-gud-boy.InterstellarDesktop.locale.en-US.yaml
 *
 * Usage:
 *   node scripts/render-packaging.mjs --write
 *   node scripts/render-packaging.mjs --check
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const REPO_OWNER = 'a-gud-boy';
const REPO_NAME = 'Interstellar-Simulation';
const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
const APP_ID = 'io.github.a_gud_boy.InterstellarDesktop';
const WINGET_ID = 'a-gud-boy.InterstellarDesktop';

function readCargoVersion() {
  const cargoPath = path.join(REPO_ROOT, 'desktop', 'Cargo.toml');
  const raw = fs.readFileSync(cargoPath, 'utf8');
  const match = raw.match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error(`Could not find package version in ${cargoPath}`);
  }
  return match[1];
}

function readReleaseTag(fallbackVersion) {
  const libPath = path.join(REPO_ROOT, 'desktop', 'src', 'lib.rs');
  if (fs.existsSync(libPath)) {
    const raw = fs.readFileSync(libPath, 'utf8');
    const match = raw.match(/pub const APP_VERSION:\s*&str\s*=\s*"([^"]+)"/);
    if (match) {
      return `v${match[1].trim().replace(/\s+/g, '-')}`;
    }
  }
  return `v${fallbackVersion}`;
}

function renderDesktopEntry(version) {
  return `[Desktop Entry]
Type=Application
Name=Interstellar Observatory
GenericName=Relativistic Spacetime Simulator
Comment=Nine real-time WebGPU relativistic ray-tracing simulators in native Rust
Exec=interstellar-desktop %U
Icon=${APP_ID}
Terminal=false
Categories=Science;Astronomy;Physics;Education;
Keywords=relativity;black-hole;astrophysics;wgpu;raytracing;simulation;
StartupNotify=true
StartupWMClass=interstellar-desktop
X-AppImage-Version=${version}
`;
}

function renderMetainfoXml(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${APP_ID}</id>
  <name>Interstellar Observatory</name>
  <summary>Real-time relativistic spacetime GPU ray-tracing suite</summary>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>
  <developer id="io.github.a_gud_boy">
    <name>Interstellar Simulation Contributors</name>
  </developer>
  <description>
    <p>
      Interstellar Observatory brings nine real-time relativistic GPU ray-tracing
      simulators powered by Rust, wgpu, and egui: Kerr Black Hole (Gargantua),
      Morris-Thorne Wormhole, Binary Black Holes, Alcubierre Warp Drive, Volumetric
      Supernova Remnant, Magnetar Pulsar, Relativistic Starflight, Gravitational
      Lensing Observatory, and Tidal Disruption Event.
    </p>
  </description>
  <launchable type="desktop-id">${APP_ID}.desktop</launchable>
  <url type="homepage">${REPO_URL}</url>
  <url type="bugtracker">${REPO_URL}/issues</url>
  <provides>
    <binary>interstellar-desktop</binary>
  </provides>
  <releases>
    <release version="${version}" date="2026-11-28">
      <description>
        <p>Universal in-sim Help Menu across all nine web and native desktop simulators.</p>
      </description>
    </release>
  </releases>
  <content_rating type="oars-1.1" />
</component>
`;
}

function renderFlatpakManifest(version, releaseTag) {
  return `app-id: ${APP_ID}
runtime: org.freedesktop.Platform
runtime-version: "24.08"
sdk: org.freedesktop.Sdk
sdk-extensions:
  - org.freedesktop.Sdk.Extension.rust-stable
command: interstellar-desktop
finish-args:
  - --share=ipc
  - --socket=wayland
  - --socket=fallback-x11
  - --device=dri
  - --filesystem=xdg-pictures:create
modules:
  - name: interstellar-desktop
    buildsystem: simple
    build-options:
      append-path: /usr/lib/sdk/rust-stable/bin
      env:
        CARGO_HOME: /run/build/interstellar-desktop/cargo
    build-commands:
      - cargo build --release --offline --manifest-path desktop/Cargo.toml
      - install -Dm755 desktop/target/release/interstellar-desktop /app/bin/interstellar-desktop
      - install -Dm644 packaging/linux/${APP_ID}.desktop /app/share/applications/${APP_ID}.desktop
      - install -Dm644 packaging/linux/${APP_ID}.metainfo.xml /app/share/metainfo/${APP_ID}.metainfo.xml
      - install -Dm644 shared/assets/app-icon-256.png /app/share/icons/hicolor/256x256/apps/${APP_ID}.png
      - install -Dm644 shared/assets/app-icon.svg /app/share/icons/hicolor/scalable/apps/${APP_ID}.svg
    sources:
      - type: git
        url: ${REPO_URL}.git
        tag: ${releaseTag}
`;
}

function renderHomebrewCask(version, releaseTag) {
  return `cask "interstellar-desktop" do
  version "${version}"
  sha256 :no_check # Update to release DMG sha256 on tagged publication

  url "${REPO_URL}/releases/download/${releaseTag}/Interstellar-macos-universal.dmg"
  name "Interstellar Observatory"
  desc "Nine real-time relativistic GPU ray-tracing simulators in native Rust and Metal"
  homepage "${REPO_URL}"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "Interstellar.app"
  binary "#{appdir}/Interstellar.app/Contents/MacOS/interstellar-desktop"

  zap trash: [
    "~/Library/Application Support/interstellar-desktop",
    "~/Library/Preferences/io.github.a-gud-boy.Interstellar.plist",
    "~/Pictures/Interstellar",
  ]
end
`;
}

function renderWingetVersionManifest(version) {
  return `# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.6.0.schema.json
PackageIdentifier: ${WINGET_ID}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.6.0
`;
}

function renderWingetInstallerManifest(version, releaseTag) {
  return `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.6.0.schema.json
PackageIdentifier: ${WINGET_ID}
PackageVersion: ${version}
InstallerType: zip
NestedInstallerType: portable
NestedInstallerFiles:
  - RelativeFilePath: interstellar-desktop.exe
    PortableCommandAlias: interstellar-desktop
Installers:
  - Architecture: x64
    InstallerUrl: ${REPO_URL}/releases/download/${releaseTag}/Interstellar-windows-x86_64.zip
    InstallerSha256: 0000000000000000000000000000000000000000000000000000000000000000 # Update to release ZIP sha256 on tagged publication
ManifestType: installer
ManifestVersion: 1.6.0
`;
}

function renderWingetLocaleManifest(version) {
  return `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.6.0.schema.json
PackageIdentifier: ${WINGET_ID}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: Interstellar Simulation Contributors
PublisherUrl: ${REPO_URL}
PublisherSupportUrl: ${REPO_URL}/issues
PackageName: Interstellar Observatory
PackageUrl: ${REPO_URL}
License: MIT
ShortDescription: Nine real-time relativistic GPU ray-tracing simulators built with Rust and wgpu.
Tags:
  - astrophysics
  - relativity
  - black-hole
  - webgpu
  - wgpu
  - raytracing
ManifestType: defaultLocale
ManifestVersion: 1.6.0
`;
}

function buildFileMap(version, releaseTag) {
  return new Map([
    [`packaging/linux/${APP_ID}.desktop`, renderDesktopEntry(version)],
    [`packaging/linux/${APP_ID}.metainfo.xml`, renderMetainfoXml(version)],
    [`packaging/flatpak/${APP_ID}.yml`, renderFlatpakManifest(version, releaseTag)],
    [`packaging/homebrew/interstellar-desktop.rb`, renderHomebrewCask(version, releaseTag)],
    [`packaging/winget/${WINGET_ID}.yaml`, renderWingetVersionManifest(version)],
    [`packaging/winget/${WINGET_ID}.installer.yaml`, renderWingetInstallerManifest(version, releaseTag)],
    [`packaging/winget/${WINGET_ID}.locale.en-US.yaml`, renderWingetLocaleManifest(version)],
  ]);
}

function main() {
  const args = new Set(process.argv.slice(2));
  const writeMode = args.has('--write');
  const checkMode = args.has('--check') || !writeMode;

  const version = readCargoVersion();
  const releaseTag = readReleaseTag(version);
  const expectedFiles = buildFileMap(version, releaseTag);

  if (writeMode) {
    for (const [relPath, content] of expectedFiles) {
      const absPath = path.join(REPO_ROOT, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, 'utf8');
      console.log(`WROTE ${relPath} (v${version})`);
    }
    return;
  }

  if (checkMode) {
    let mismatches = 0;
    for (const [relPath, expected] of expectedFiles) {
      const absPath = path.join(REPO_ROOT, relPath);
      if (!fs.existsSync(absPath)) {
        console.error(`MISSING ${relPath}`);
        mismatches++;
        continue;
      }
      const actual = fs.readFileSync(absPath, 'utf8');
      if (actual !== expected) {
        console.error(`DRIFT ${relPath} (run: node scripts/render-packaging.mjs --write)`);
        mismatches++;
      } else {
        console.log(`OK ${relPath} (v${version})`);
      }
    }
    if (mismatches > 0) {
      process.exitCode = 1;
    }
  }
}

main();
