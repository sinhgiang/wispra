# Changelog

## v0.1.9 — 2026-06-14

### New features
- **Modes** — Switch how AI cleanup processes your speech: General, Professional, Vietnamese, Casual, or create custom modes with your own prompt. Quick-switch via tray menu or Settings.
- **Custom vocabulary** — Add proper nouns, names, and technical terms that must be spelled exactly (e.g. "Nguyễn Văn A", "GPT-4o"). Applied automatically when AI cleanup is on.
- **File transcription** — New "Transcribe" tab: drop any audio/video file (MP3, MP4, WAV, M4A, FLAC, OGG, WebM…) and get a text transcript in seconds.
- **Local / Offline mode** — New "Local" provider option for Ollama, LocalAI, and LM Studio. Configure your server URL, STT model, and LLM model — no API key required.
- **Account section** — Shows your current BYOK plan and a preview of the upcoming Wispra Pro subscription.

### Improvements
- Tray icon right-click now shows a **Mode** submenu — switch modes without opening Settings.
- Overlay bubble shows a small mode badge during recording when a non-default mode is active.
- Onboarding banner now highlights Vietnamese and 95+ language support.
- AI cleanup filler word removal is now per-mode (Casual mode keeps natural fillers).

## v0.1.8 — 2026-06-01

### New features
- Full **Settings UI redesign** — modern toggle switches, provider cards, animated hotkey display, dark mode.
- **AI cleanup** — optional post-processing with Groq LLaMA / OpenAI GPT to fix spelling, add punctuation, and remove filler words (ừm, à, ý là, um, like…).
- **Onboarding banner** — first-run 3-step guide when no API key is set.
- AI cleanup now uses `llama-3.3-70b-versatile` (fixes Vietnamese diacritic corruption from previous model).
- Auto-open Settings after an update installs.

## v0.1.2 — 2026-05-15

- Auto-update via GitHub Releases (electron-updater).
- Notification + dialog when update downloads successfully.
- Auto-check for updates on startup (3-second delay).

## v0.1.0 — 2026-05-01

- Initial release: global hotkey dictation, Groq Whisper transcription, text injection into any app.
- Floating overlay icon, tray menu, Settings (API key, hotkey, language, launch at login).
- Transcript history with copy button.
- Windows NSIS installer.
