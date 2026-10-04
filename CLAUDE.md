# Wispra

System-wide voice dictation desktop app (Windows + macOS). Press the global hotkey (default `Ctrl+Shift+Space`, `Cmd+Shift+Space` on macOS) or click the floating icon anywhere → record voice → transcribe via Groq Whisper (`whisper-large-v3-turbo`, auto language detection incl. Vietnamese) → type the text into whatever app/field is focused.

## Language rule (IMPORTANT)

- ALL code, UI strings, comments, commit messages, docs, and release notes are in **ENGLISH** (global product).
- When chatting with the project owner, explain things in **VIETNAMESE**.

## Commands

- `npm run dev` — start the app in dev mode (electron-vite)
- `npm run typecheck` — TypeScript check for all processes
- `npm run check:content-rate-limit` — automated check (same setup as check:content-retry, plus generateMeetingContent against a stub `fetch`): a Website/social request that gets HTTP 429 waits as the provider asks and tries again, the tab says it is waiting for the per-minute limit, and a limit that never clears is reported as such
- `npm run check:daily-limit` — automated check (same setup, plus the AI calls against a stub provider): the provider's daily limit (Groq TPD/RPD) is not waited out and the Mind map, Transcript, Summary and Website/social tabs say "daily limit" with the numbers and the reset time; a per-minute limit is still waited out
- `npm run check:ai-fallback` — automated check (same setup, plus the AI calls against stub Groq and Cloudflare): on a daily limit the AI text features go on with Groq gpt-oss-20b, then Cloudflare Workers AI, and say so; the Cloudflare fields on the Account page are tested before saving and never shown again
- `npm run build` — bundle main/preload/renderer
- `npm run check:transcript-columns` — automated check (same setup, plus the outline functions against a fake AI): the Transcript tab's four columns — topics, action items, speaker names, the By topic / List switch, narrow windows, dark theme
- `npm run check:live-transcript` — automated check (same setup, plus the live outline engine and the session queue against a fake AI, and Chromium's fake microphone): pressing Start shows the four-column Transcript table at once, the transcript runs into it, topics and action items are named part by part while recording (only finished parts are sent), speaker names from the recording and by hand, the daily limit and backups, Stop naming what was left, one recorder after reopening the Meeting tab, and a duplicate chunk ignored
- `npm run check:cloud-long-dictation` — automated check (stub of the Wispra Cloud endpoint that refuses bodies over 4.5 MB like Vercel, plus the real overlay recorder with Chromium's fake microphone for `CHECK_RECORD_SECONDS`, default 185 s): long dictations go to Wispra Cloud in parts under the limit, cut at pauses, and come back as one text; server errors show their own reason
- `npm run check:account-plan` — automated check (same setup, plus `accountInfoFrom` on the answers of Wispra Cloud's GET /api/usage): an unlimited account shows "Wispra Cloud · Unlimited" with no bar and no maximum; Free, Pro and older servers as before
- `npm run check:auto-ai-new-only` — automated check (same setup): opening a recording made before `Settings.autoAiSince` makes no AI call in any tab and offers "Create topics and action items"; a newer recording still gets its topics by itself
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
- Transcript outline (`outline.ts` makes the AI calls, `outlineLogic.ts` is the pure parsing): the topics, action items and speaker names behind the Transcript tab's four columns (`TranscriptColumns.tsx`). Built right after Stop (or on first open of an older session), cached on the session as `outline`, written in the session's "Summary" language. Topics always cover the whole transcript; action items are only what the recording states — a topic without one stays empty, never prompt the model to fill it. Speaker names come only from what is said (self-introduction), from the user's edits (`speakerNames`), or from "Both"-mode audio levels (`voice.ts`: You / Others) — no voice recognition, no voiceprints.
- While a meeting records, its Transcript tab is the same four-column table (`TranscriptColumns` with `live`). `liveOutline.ts` names topics as they finish: it sends the part after the named topics (`openFromSegmentId` on the outline) once it is `LIVE_OUTLINE_MIN_CHARS` long and again each `LIVE_OUTLINE_STEP_CHARS`, keeps only the topics followed by another one, and stops sending for that recording at a daily limit with no backup left. After Stop, `generateSessionOutline` outlines only the rest (`remainingSegments`) and joins it. An answer that arrives after Stop is handed back by `end()` and saved only once Stop has written the session.
- Meeting capture lives once per window in `captureHost.ts` (the recorder and the start / pause / resume / stop commands), never in the `MeetingPanel` component: the panel is unmounted on every tab switch, and its own IPC listeners must be removed on unmount (the meeting `on…` functions in the preload return an unsubscribe). A panel that left them behind ran one recorder per visit to the tab — the same audio transcribed several times. `enqueueChunk` also ignores a chunk starting within `DUPLICATE_CHUNK_START_MS` of one already taken.
- AI work starts by itself only for recordings made after `Settings.autoAiSince` (stamped once, at the first start of a version with this rule — `main()` in `index.ts`). Older recordings get nothing by themselves, only "Create …" buttons: an owner with many old recordings must not spend the provider's daily allowance just by opening them.
- Meeting mind map (`mindMap.ts` makes the AI calls, `mindMapLogic.ts` is the pure parsing/validation): built only when the user presses "Create mind map", cached on the session as `mindMap`. Opening a Mind map, Website or social tab must never call the AI by itself — an empty tab shows a "Create …" button. A long transcript is outlined in parts and merged — never sample both ends like the summary does. Its text follows the session's "Website & social posts" language (`languageConfig.website`), not the spoken or Summary language. The renderer draws it with plain SVG (`mindMapRenderer.ts`); do not add a diagram library.
- A mind map is built by a background job of the main process (`mindMapJobs.ts`), one per session: the renderer only mirrors job statuses (`MEETING_MIND_MAP_PROGRESS`, `MEETING_GET_MIND_MAP_JOBS`) and must never own, restart or cancel a run by what it happens to show. Every finished part is checkpointed in `userData/mind-map-jobs/<session id>.json`, so a stopped or interrupted job continues instead of starting over. A run paces itself to the provider (waits out HTTP 429 for as long as `retry-after` says, then goes one part at a time; cuts a "too large" part in two), holds its next call while a dictation is being processed, and has a time limit per part and in total (`MIND_MAP_*_TIME_LIMIT_MS`) — it always ends with a map or a stated reason, never a spinner that cannot end. An answer that cannot be read as JSON (Groq's HTTP 400 "Failed to generate JSON", empty or broken content) is not a refusal: `callJson` asks again, the last time without JSON mode, then the part is cut in two; if it still fails the job stops as `bad-answer` — never tell the user to check their key or plan for it.
- An HTTP 429 is read with `parseRateLimit` (`rateLimit.ts`), from the provider's message first (Wispra Cloud passes Groq's message on but not its headers): a per-minute limit is waited out and the request sent again; a per-day limit (Groq TPD/RPD) never is — it is reported as `DailyLimitInfo` (used / allowed, reset time) and the UI says "daily limit". Never call a daily limit "per-minute".
- Backups for AI text (`resolveBackupRoutes` in `postprocess.ts`): own Groq key → Groq `openai/gpt-oss-20b` (its own daily allowance), then Cloudflare Workers AI `@cf/openai/gpt-oss-120b` when an account id + token are saved. Switch ONLY on a daily limit (`createRouter` in `mindMap.ts` for the mind map / outline, `withBackupRoutes` for summary / posts), never on a per-minute one, and record the backup's name on the result (`backupModel`, `session.backupModels`) so the UI says so. Cloudflare's JSON mode does not list gpt-oss-120b: call it with `jsonMode: false` and take the JSON out of the text. Transcription never moves off the chosen provider. Every Workers AI request goes through `cloudflareBudget` (`cloudflareBudget.ts`, called from `aiQuota.fetch`): it estimates neurons from tokens (31,818 per million input, 68,182 per million output for gpt-oss-120b, Cloudflare price page), keeps the UTC day's count in `userData/cloudflare-usage.json`, and refuses a request that could take the day past the free 10,000 neurons — a Workers Paid account must never be charged because of Wispra. Cloudflare's own "daily allocation used up" is recognised only as documented (HTTP 429 with code 3036, `isDailyAllocation` in `rateLimit.ts`) — never by loose words like "daily" or "neurons".
- Wispra Cloud runs on Vercel, which refuses request bodies over 4.5 MB (HTTP 413 FUNCTION_PAYLOAD_TOO_LARGE, plain text) before Wispra's code runs. Dictation WAV is 32 KB/s, so `transcribe()` sends anything over `CLOUD_UPLOAD_MAX_BYTES` in parts (`splitWav` in `wavSplit.ts`, cut at the quietest moment before the limit) and joins the text; a part that still fails fails the whole dictation. Never let a server error become "No speech detected": `safeErrorDetail` reads `{error: {message}}`, `{error: "…"}` and plain text.
- Every chat-completion call goes through `aiQuota.fetch` (`src/main/aiQuota.ts`), never bare `fetch`: it recognises Wispra Cloud's "AI allowance used up" answer (HTTP 402 with `code: "ai_quota_exceeded"`) so the UI can say so. Never retry that answer, and dictation must still type the raw text.
- Where transcription and AI text go is `settings.provider` alone: `proxy` = Wispra Cloud (signed-in session; the only route counted toward the account's minutes and AI allowance), `groq` / `openai` / `local` = straight to that provider. The user picks it on the Account page (`AiRouteChoice` in `Account.tsx`); switching must never clear a saved key, and a key's value is never rendered. Every feature reads the provider at call time — never cache it.
- OS login item goes through `loginItem.ts` only. An unpackaged (dev) run shares the installed app's default registry value name, so it must never sync at startup or on unrelated settings changes; it only writes its own `Wispra (dev)` entry when the user flips "Launch at login".

## Manual test checklist (run before ending a work session)

1. `npm run dev` starts without errors; tray icon and floating icon appear.
2. Focus Notepad (or any text field), press the hotkey, speak Vietnamese and English → correct text is typed in, prior clipboard content is restored.
3. Press the hotkey twice quickly / click the icon while processing → no double recording, no stuck state.
4. Disconnect network and dictate → error notification, app returns to idle.
5. Change the hotkey in Settings → new hotkey works immediately; restart → settings persist.
