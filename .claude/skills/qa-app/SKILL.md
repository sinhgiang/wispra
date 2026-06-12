---
name: qa-app
description: End-to-end manual QA checklist for the Wispra dictation app. Use after implementing or changing any feature that touches recording, hotkeys, transcription, or text injection.
---

# QA the Wispra app

Run the app with `npm run dev`, then walk through this checklist. Report each item as PASS/FAIL with notes. Ask the user to perform the microphone/speech steps and report back — you cannot speak into the mic yourself.

## Core dictation flow
1. Tray icon appears; floating overlay icon appears and is draggable; it never steals focus (click it while Notepad is focused — the Notepad caret must keep blinking).
2. Focus Notepad. Press `Ctrl+Shift+Space` → overlay turns into recording state. Speak English. Press again → text appears in Notepad within a few seconds.
3. Repeat speaking Vietnamese with language = Auto → Vietnamese text with correct diacritics.
4. Clipboard: copy some text first, dictate, then press Ctrl+V → the ORIGINAL clipboard content pastes (clipboard was restored).

## Robustness
5. Press the hotkey twice rapidly → exactly one recording session; no stuck state.
6. Click the overlay icon while state is `processing` → ignored gracefully.
7. Kill the network, dictate → error notification appears, state returns to idle within ~5s.
8. Enter an invalid API key, dictate → clear error message pointing to Settings.
9. Leave recording running → auto-stops at the configured limit (default 5 min).

## Settings
10. Change hotkey → effective immediately without restart; conflicting/taken hotkey shows an error instead of silently failing.
11. Pin language to Vietnamese → transcription forced to Vietnamese.
12. Toggle "Launch at login" → reflected in OS settings.
13. Restart the app → all settings and history persist.

## History
14. Each dictation appears at the top of History; "Copy" copies the text; "Clear" empties the list.
