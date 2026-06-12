---
name: release
description: Release process for Wispra — bump version, build installers, smoke-test, write changelog. Use when the user asks to cut a release or build an installer for distribution.
---

# Release Wispra

1. **Pre-flight**: `npm run typecheck` and `npm run build` must pass clean. Run the `qa-app` skill checklist if anything touching dictation changed since the last release.
2. **Bump version** in `package.json` (semver: patch = fixes, minor = features). Keep `CHANGELOG.md` updated: add a `## vX.Y.Z — YYYY-MM-DD` section in English, user-facing wording.
3. **Build**:
   - Windows: `npm run build:win` → installer in `dist/`.
   - macOS: `npm run build:mac` (requires a Mac; signing/notarization needs the Apple Developer account — skip locally if unavailable and note it).
4. **Smoke-test the installed build** (not the dev build): install from `dist/`, launch, dictate once into Notepad, check tray menu Quit works and no second instance can start.
5. **Notes**: unsigned Windows builds trigger SmartScreen warnings — expected until the Azure Trusted Signing setup (commercialization phase).
