# Wispra

System-wide voice dictation desktop app (Windows + macOS). Press the global hotkey (default `Ctrl+Shift+Space`, `Cmd+Shift+Space` on macOS) or click the floating icon anywhere → record voice → transcribe via Groq Whisper (`whisper-large-v3-turbo`, auto language detection incl. Vietnamese) → type the text into whatever app/field is focused.

## Language rule (IMPORTANT)

- ALL code, UI strings, comments, commit messages, docs, and release notes are in **ENGLISH** (global product).
- When chatting with the project owner, explain things in **VIETNAMESE**.

## Commands

- `npm run dev` — start the app in dev mode (electron-vite)
- `npm run typecheck` — TypeScript check for all processes
- `npm run build` — bundle main/preload/renderer
- `npm run build:win` — build Windows NSIS installer
- `npm run build:mac` — build macOS DMG (requires a Mac)
- `node scripts/generate-icons.js` — regenerate PNG icons in `resources/`

## Architecture

Three Electron processes; the **main process owns all state**:

```
hotkey/tray/overlay-click ─→ state machine (src/main/state.ts)
  idle ─→ recording ─→ processing ─→ idle
                ↘ error (auto-returns to idle after a few seconds)
recording: overlay renderer captures mic via MediaRecorder (webm/opus)
processing: main calls Groq API (src/main/transcribe.ts, 30s timeout + 1 retry)
           → injects text (src/main/inject.ts: save clipboard → paste → restore)
           → appends to history (src/main/history.ts)
```

- `src/shared/ipc.ts` — the ONLY place IPC channel names are defined. Never hardcode channel strings elsewhere.
- `src/shared/types.ts` — types shared across processes. `src/shared/constants.ts` — defaults/limits.
- `src/main/state.ts` — the ONLY place app state changes. All triggers (hotkey, clicks) call into it; renderers only display state.
- `src/preload/index.ts` — contextBridge whitelist; renderers never get raw Node/Electron APIs.
- `src/renderer/overlay/` — floating always-on-top icon (non-focusable window so it never steals focus from the target app).
- `src/renderer/settings/` — settings + history UI.

## Conventions and guardrails

- The overlay window MUST stay `focusable: false` — if it steals focus, pasted text lands in the overlay instead of the user's app.
- Every error path must return the state machine to `idle` (use `try/finally`). The app must never be stuck in `processing`.
- Text injection goes through the serial queue in `inject.ts`; never paste from anywhere else.
- No native input-simulation deps (robotjs, nut.js). Paste simulation uses PowerShell `SendKeys` on Windows and AppleScript on macOS.
- No new runtime npm dependencies without a strong reason — main process uses Node built-ins + Electron APIs + `fetch` only.
- Settings/history are plain JSON files in `app.getPath('userData')` (see `store.ts`, `history.ts`).

## Manual test checklist (run before ending a work session)

1. `npm run dev` starts without errors; tray icon and floating icon appear.
2. Focus Notepad (or any text field), press the hotkey, speak Vietnamese and English → correct text is typed in, prior clipboard content is restored.
3. Press the hotkey twice quickly / click the icon while processing → no double recording, no stuck state.
4. Disconnect network and dictate → error notification, app returns to idle.
5. Change the hotkey in Settings → new hotkey works immediately; restart → settings persist.
