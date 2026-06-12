# SpeToText

Speak anywhere, get text typed into any app.

SpeToText is a system-wide voice dictation app for Windows and macOS. Press the global hotkey (default **Ctrl+Shift+Space**) or click the floating microphone icon, speak in any language (auto-detected, including Vietnamese), and the transcribed text is typed straight into whatever app or text field you have focused — browser, editor, chat, anything.

## Features

- 🎙️ **Dictate anywhere** — floating always-on-top icon + global hotkey work in every app
- 🌍 **99+ languages, auto-detected** — powered by Whisper Large v3 Turbo on Groq
- ⚡ **Fast** — transcription typically returns in ~1–2 seconds
- 📋 **Clipboard-safe** — your clipboard content is restored after each dictation
- 🕘 **History** — review and copy recent dictations
- ⚙️ **Configurable** — custom hotkey, pinned language, launch at login, auto-stop

## Getting started

1. Install dependencies and run:
   ```bash
   npm install
   npm run dev
   ```
2. Create a free API key at [console.groq.com/keys](https://console.groq.com/keys).
3. Paste it in **Settings → Groq API Key → Save & Test** (Settings opens automatically on first run; later via right-click on the floating icon or the tray menu).
4. Focus any text field, press **Ctrl+Shift+Space**, speak, press it again — your words appear as text.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Run in development mode |
| `npm run typecheck` | TypeScript check |
| `npm run build:win` | Build the Windows installer (NSIS) into `dist/` |
| `npm run build:mac` | Build the macOS DMG (requires a Mac) |

## Architecture (short version)

Electron + React + TypeScript. The main process owns a single dictation state machine (`idle → recording → processing → idle`); the floating overlay window captures the mic with MediaRecorder and never takes focus; transcription runs on Groq (`whisper-large-v3-turbo`); text is injected via clipboard + simulated paste, then the clipboard is restored. See [CLAUDE.md](CLAUDE.md) for the full conventions.
