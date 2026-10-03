# Wispra

System-wide voice dictation desktop app (Windows + macOS). Press the global hotkey (default `Ctrl+Shift+Space`, `Cmd+Shift+Space` on macOS) or click the floating icon anywhere → record voice → transcribe via Groq Whisper (`whisper-large-v3-turbo`, auto language detection incl. Vietnamese) → type the text into whatever app/field is focused.

## Language rule (IMPORTANT)

- ALL code, UI strings, comments, commit messages, docs, and release notes are in **ENGLISH** (global product).
- When chatting with the project owner, explain things in **VIETNAMESE**.

## Commands

- `npm run dev` — start the app in dev mode (electron-vite)
- `npm run typecheck` — TypeScript check for all processes
- `npm run check:content-rate-limit` — automated check (same setup as check:content-retry, plus generateMeetingContent against a stub `fetch`): a Website/social request that gets HTTP 429 waits as the provider asks and tries again, the tab says it is waiting for the per-minute limit, and a limit that never clears is reported as such
- `npm run build` — bundle main/preload/renderer
- `npm run check:content-retry` — automated check (builds, then runs the Meeting tab in Electron with stub IPC, no API key): opening the Mind map / Website / social tabs calls no AI and shows a "Create …" button; pressing it calls the generator once, a failure offers "Try again" once more
- `npm run check:mind-map-background` — automated check (same setup, plus the job code against a fake slow / rate-limited provider): the mind map job survives leaving the tab, the session and the page, continues after a failure or an app restart without redoing finished parts, and stops with a reason at its time limits
- `npm run check:ai-quota` — automated check (same setup, plus the main-process AI functions against a fake server answering HTTP 402): every AI text feature when Wispra Cloud's monthly AI allowance is used up
- `npm run check:cloud-switch` — automated check (same setup, plus the routing code against a stub `fetch`): the Account page's Wispra Cloud / own-key choice changes only `provider` and never removes or shows a saved key; AI text, transcription and the Transcribe tab go through Wispra Cloud or straight to Groq accordingly
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
- Auto-learned vocabulary (`autoVocab.ts`) only biases the Whisper prompt via `lexicon.sttTerms`. Never turn it into lexicon entries, replacements, or the AI-cleanup "preserve spelling" list (`llmTerms`): History holds recogniser output, so recurring wrong spellings look right. `wellKnownNames.ts` is a yardstick for spotting mishearings, never vocabulary or text to write.
- Meeting mind map (`mindMap.ts` makes the AI calls, `mindMapLogic.ts` is the pure parsing/validation): built only when the user presses "Create mind map", cached on the session as `mindMap`. Opening a Mind map, Website or social tab must never call the AI by itself — an empty tab shows a "Create …" button. A long transcript is outlined in parts and merged — never sample both ends like the summary does. Its text follows the session's "Website & social posts" language (`languageConfig.website`), not the spoken or Summary language. The renderer draws it with plain SVG (`mindMapRenderer.ts`); do not add a diagram library.
- A mind map is built by a background job of the main process (`mindMapJobs.ts`), one per session: the renderer only mirrors job statuses (`MEETING_MIND_MAP_PROGRESS`, `MEETING_GET_MIND_MAP_JOBS`) and must never own, restart or cancel a run by what it happens to show. Every finished part is checkpointed in `userData/mind-map-jobs/<session id>.json`, so a stopped or interrupted job continues instead of starting over. A run paces itself to the provider (waits out HTTP 429 for as long as `retry-after` says, then goes one part at a time; cuts a "too large" part in two), holds its next call while a dictation is being processed, and has a time limit per part and in total (`MIND_MAP_*_TIME_LIMIT_MS`) — it always ends with a map or a stated reason, never a spinner that cannot end. An answer that cannot be read as JSON (Groq's HTTP 400 "Failed to generate JSON", empty or broken content) is not a refusal: `callJson` asks again, the last time without JSON mode, then the part is cut in two; if it still fails the job stops as `bad-answer` — never tell the user to check their key or plan for it.
- Every chat-completion call goes through `aiQuota.fetch` (`src/main/aiQuota.ts`), never bare `fetch`: it recognises Wispra Cloud's "AI allowance used up" answer (HTTP 402 with `code: "ai_quota_exceeded"`) so the UI can say so. Never retry that answer, and dictation must still type the raw text.
- Where transcription and AI text go is `settings.provider` alone: `proxy` = Wispra Cloud (signed-in session; the only route counted toward the account's minutes and AI allowance), `groq` / `openai` / `local` = straight to that provider. The user picks it on the Account page (`AiRouteChoice` in `Account.tsx`); switching must never clear a saved key, and a key's value is never rendered. Every feature reads the provider at call time — never cache it.
- OS login item goes through `loginItem.ts` only. An unpackaged (dev) run shares the installed app's default registry value name, so it must never sync at startup or on unrelated settings changes; it only writes its own `Wispra (dev)` entry when the user flips "Launch at login".

## Manual test checklist (run before ending a work session)

1. `npm run dev` starts without errors; tray icon and floating icon appear.
2. Focus Notepad (or any text field), press the hotkey, speak Vietnamese and English → correct text is typed in, prior clipboard content is restored.
3. Press the hotkey twice quickly / click the icon while processing → no double recording, no stuck state.
4. Disconnect network and dictate → error notification, app returns to idle.
5. Change the hotkey in Settings → new hotkey works immediately; restart → settings persist.
