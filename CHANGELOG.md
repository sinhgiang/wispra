# Changelog

## v0.2.6 — 2026-06-24

### Bug fixes
- **Recording stops mid-speech** — Switched all users to Toggle mode: recording now only stops when you press the hotkey or click the icon. Auto-stop on silence is disabled. Maximum recording duration extended from 5 to 10 minutes.

## v0.2.5 — 2026-06-24

### Bug fixes
- **"Like, share, subscribe" hallucination** — Added a blocklist of known Whisper training-data phrases. Even when `no_speech_prob` is low (ambient noise), these phantom phrases are now silently discarded.
- **Recording stops mid-speech** — Silence auto-stop threshold increased from 1.5 s to 3 s, preventing natural pauses between sentences from triggering a premature stop.
- **Vietnamese (and all languages) missing capitalization** — AI post-processing now explicitly capitalizes the first word of every sentence and all proper nouns, matching what you'd expect from a transcription editor.

## v0.2.4 — 2026-06-17

### Bug fixes
- **Text pasted into wrong window on multi-monitor setups** — When clicking on a second monitor during recording, Wispra now attaches to the correct foreground thread before switching focus, and polls until the OS confirms the switch before sending Ctrl+V. Text reliably lands in the right window.
- **Floating icon disappearing after extended use** — Two separate causes fixed: (1) silent renderer crash (GPU/memory pressure) now destroys and recreates the overlay window automatically; (2) Windows stripping `alwaysOnTop` when a full-screen app launches is now corrected by re-applying on every `show` event.
- **"Like, share, subscribe" hallucination when using Wispra Cloud** — The proxy path now uses `verbose_json` response format and filters silence segments by `no_speech_prob` threshold, matching the direct Groq path.

## v0.2.1 — 2026-06-15

### Bug fixes
- **Hotkey not working after Windows restart** — some startup apps (Vietnamese IME, system tools) briefly grab hotkeys during login. Wispra now retries registration silently after 3 seconds so the hotkey works reliably when launched at login.
- **Overlay icon not appearing** — if the overlay window renderer crashed (GPU error, system event), pressing the hotkey would do nothing. Wispra now detects this and recreates the overlay window automatically before showing it.

## v0.2.0 — 2026-06-14

### New features
- **Smart mode routing** — App silently detects language and context: Vietnamese speech auto-applies Vietnamese AI cleanup; Zalo and email clients apply their matching mode — all without any UI toggle.
- **History by topic** — Dictation history now groups by AI-detected topic (Email, Meeting, Tasks, Notes, Message, General) with clickable hashtag filters (#Email, #General…).
- **History period tabs** — Filter history by All / Today / Yesterday / 3 days ago / This week / Older.
- **AI summary per topic** — Click "Summarize with AI" inside any topic filter to get a bullet-point summary of everything you dictated on that topic.
- **Time saved typing** — Hero banner at the top of History showing how many hours and minutes you saved vs. typing at 40 WPM.
- **Sound feedback** — Rising tone on recording start, two descending tones on error (Web Audio API — works even when Windows system sounds are muted).
- **Undo last injection** — Say "delete that" or "xóa cái đó" to undo the last dictation (Ctrl+Z).
- **Done animation** — Overlay bubble flashes green after successful text injection.
- **Voice commands** — Speak punctuation and formatting: "new paragraph", "period", "comma", "open quote", and more — no AI needed.
- **Text templates / voice snippets** — Define keyword → expansion pairs (e.g. "mysig" → your full email signature). Supports `[date]` and `[time]` placeholders.
- **Context-aware AI** — Detects the focused app (Outlook, VS Code, Zalo, etc.) and adds a context hint to the AI cleanup prompt.
- **Usage statistics** — Total dictations, minutes, words, this-week count, current streak, most active day — shown above history.
- **Export history** — Export transcript history as TXT, Markdown, or CSV via native save dialog.
- **Continuous mode** — Auto-restarts recording after each paste. Press hotkey or click icon once to exit the loop.
- **Preview before paste** — Shows transcribed text for 2.5 s before injecting so you can review it first.
- **Auto-stop on silence** — Recording stops automatically after 1.5 s of silence.
- **Zalo mode** — Built-in mode for casual Vietnamese chat in Zalo.
- **Email mode** — Built-in mode for professional email composition.

### Improvements
- Settings window opens automatically after install (not just on first run with no API key).
- AI post-processing is now **enabled by default** — existing installs are migrated automatically.
- Overlay position is clamped to the screen work area so the icon never gets clipped at screen edges.
- Installer launches the app immediately after installation completes.
- Settings versioning system added so future default changes migrate existing users correctly.

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
