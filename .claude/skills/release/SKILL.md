---
name: release
description: Release process for Wispra — bump version, check, build the Windows installer, publish the GitHub release (the macOS build follows by itself), verify auto-update, and give every version its entry on the website's Updates page. Use when the user asks to cut a release or build an installer for distribution.
---

# Release Wispra

Every version is a GitHub release of `sinhgiang/wispra` with **8 files**. Missing any of them breaks auto-update
or the website.

## 1. Bump the version (its own pull request)

- On a branch, `npm version X.Y.Z --no-git-tag-version` (semver: patch = fixes, minor = features). Only
  `package.json` and `package-lock.json` change. Open a pull request; the owner merges it.
- The release is built from `origin/master` after that merge — the macOS workflow builds from the tag's source, so
  the tag must point at a commit whose `package.json` says `X.Y.Z`.

## 2. Check before building (on a clean checkout of `origin/master`)

- `npm run typecheck` and every `npm run check:*` listed in `CLAUDE.md` must pass.
- Scan the changes since the previous tag: no `.env`, key, token or password, no `.internal/` folder.
- Do not commit `tsconfig.*.tsbuildinfo`.

## 3. Build Windows

- `npm run build:win -- --publish never` → `dist/Wispra-Setup-X.Y.Z.exe`, its `.blockmap` and `dist/latest.yml`.
- Look inside the asar for the new features, and check that the sha512 in `latest.yml` matches the installer.

## 4. Release notes and screenshot (every version)

- **Notes**: English, written for users, not developers — what is new, improved or fixed, and what to do about it.
  Group them under `## New`, `## Improved`, `## Fixed`. Keep a copy in `dist/release-notes-vX.Y.Z.md`.
- **Title**: `vX.Y.Z — <headline>` (for example `v0.6.6 — The meeting table fills in while you talk`); the Updates
  page shows the headline.
- **`screenshot.png`**: one screenshot of the app showing the version's main new feature, attached to the release
  under exactly that name — 1600 × 1000 (16:10), dark theme, under 500 KB. Sample content only — never the owner's real recordings, session titles, email address,
  keys or machine paths. Take it from the automated checks' throwaway windows (the `check:*` scripts write PNGs
  when `CHECK_SHOTS=<folder>` is set) or a similar stub-data window, never from the owner's running app.
- The website's Updates page (https://wispra-web.vercel.app/updates) reads the releases — title, notes and
  `screenshot.png` — so **every published version gets its Updates entry this way, without waiting to be asked**
  (standing rule of the owner, 2026-10-04). The format the site reads is described in `docs/UPDATES.md` of
  `sinhgiang/wispra-web`. After publishing, open the Updates page and check the new entry shows (within an hour).

## 5. Publish

```
gh release create vX.Y.Z --draft --target <master commit> --title "vX.Y.Z — <headline>" --notes-file dist/release-notes-vX.Y.Z.md \
  dist/Wispra-Setup-X.Y.Z.exe dist/Wispra-Setup-X.Y.Z.exe.blockmap dist/latest.yml screenshot.png
gh release edit vX.Y.Z --draft=false --latest
```

- Publishing starts the **Build macOS** workflow (`.github/workflows/build-mac.yml`), which adds
  `Wispra-X.Y.Z-universal.dmg`, `Wispra-X.Y.Z-universal.zip`, their two `.blockmap` files and `latest-mac.yml`.
  Wait for it (`gh run watch`).
- Then the release has 8 files: the 3 Windows files, the 5 macOS files — plus `screenshot.png`.

## 6. Verify

- Download `latest.yml` and `latest-mac.yml` from the release: both say `X.Y.Z`. `latest.yml` and the Windows
  blockmap are identical to the local build; the installer's sha256 (GitHub asset `digest`) matches the local file.
- Auto-update: with electron-updater (`forceDevUpdateConfig`) and `package.json` set to the previous version, the
  app is offered `X.Y.Z`; set to `X.Y.Z`, it is told there is no update. Never install over or close the owner's
  running Wispra.
- The website's Updates page shows the new version with its screenshot.

## Notes

- Unsigned Windows builds trigger SmartScreen warnings — expected until code signing is set up.
- Record the release in the project's status file: link, tag and commit, the files, what was checked and what was
  not.
