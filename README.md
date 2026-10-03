<p align="center">
  <a href="https://wispra-web.vercel.app"><img src="resources/icon.png" alt="Wispra" width="96" height="96"></a>
</p>

<h1 align="center">Wispra</h1>

<p align="center">
  <strong>AI voice dictation and meeting notes for any app on Windows and macOS.</strong><br>
  Speak anywhere. Get clean text typed where your cursor is.
</p>

<p align="center">
  <a href="https://wispra-web.vercel.app"><strong>wispra-web.vercel.app</strong></a>
</p>

<p align="center">
  <a href="https://wispra-web.vercel.app">Website</a> ·
  <a href="https://github.com/sinhgiang/wispra/releases/latest">Download</a> ·
  <a href="https://github.com/sinhgiang/wispra/releases">Release notes</a> ·
  <a href="https://github.com/sinhgiang/wispra/issues">Report an issue</a>
</p>

---

Wispra is a desktop app that turns speech into text in whatever app you are using. Press one hotkey
(`Ctrl+Shift+Space`, or `Cmd+Shift+Space` on macOS) or click the floating microphone, speak, and the words
appear in the focused text field: an email, a chat, a document, a code editor, a browser form. The spoken
language is detected automatically, Vietnamese and English included, and an optional AI pass removes filler
words and fixes punctuation before the text is typed.

For longer conversations, Meeting Mode records a meeting or a call, transcribes it as it goes, and then turns
it into a topic-by-topic transcript with action items, a summary, a mind map and ready-to-post content.

**Get it at [wispra-web.vercel.app](https://wispra-web.vercel.app)** — or download the installer from the
[latest release](https://github.com/sinhgiang/wispra/releases/latest).

## Table of contents

- [The problem](#the-problem)
- [How Wispra solves it](#how-wispra-solves-it)
- [Who it is for](#who-it-is-for)
- [Features](#features)
  - [Dictation in any app](#dictation-in-any-app)
  - [AI cleanup, modes and voice commands](#ai-cleanup-modes-and-voice-commands)
  - [Learning your words and style](#learning-your-words-and-style)
  - [Meeting Mode](#meeting-mode)
  - [From a meeting to finished content](#from-a-meeting-to-finished-content)
  - [File transcription](#file-transcription)
  - [History and statistics](#history-and-statistics)
  - [Wispra Cloud, your own key, or a local server](#wispra-cloud-your-own-key-or-a-local-server)
  - [Working within AI provider limits](#working-within-ai-provider-limits)
  - [Your data](#your-data)
- [How it works, step by step](#how-it-works-step-by-step)
- [Ways to run transcription and AI](#ways-to-run-transcription-and-ai)
- [FAQ](#faq)
- [Tech stack](#tech-stack)
- [Repository](#repository)
- [Get started](#get-started)

## The problem

Most people speak about three times faster than they type, yet almost everything we write still goes through a
keyboard: replies, emails, tickets, notes, prompts for AI tools. Dictation has existed for years, but in
practice it falls short:

- **It is tied to one app.** Dictation built into a word processor or a phone keyboard does not help in a chat
  window, a code editor or a web form.
- **The raw text needs fixing.** Speech recognition writes down every "um", misses punctuation and misspells
  names, so the time saved by speaking is lost in editing.
- **Mixed languages break it.** People who switch between Vietnamese and English, or any two languages, often
  have to change a setting every time.
- **Meetings are a separate problem.** A recording of an hour-long call is not notes. Someone still has to find
  the decisions, the action items and who said what, and then write it up.

## How Wispra solves it

Wispra sits on top of every app instead of inside one:

1. A global hotkey or the floating icon starts recording, from anywhere, without taking focus away from the app
   you are typing into.
2. The audio is transcribed by Whisper, which detects the spoken language by itself.
3. An optional AI pass cleans the text up in the style you choose — without summarising it or dropping detail.
4. Wispra pastes the text into the focused field and restores whatever was on your clipboard before.

For meetings, Wispra keeps the transcript, splits it into topics with their action items and speakers, and
produces a summary, a mind map and posts from it — only when you ask for them.

## Who it is for

- **Anyone who writes a lot on a computer** and would rather say it: emails, chat replies, documents, notes,
  prompts for AI assistants.
- **Multilingual users**, in particular people who speak Vietnamese and English, who want the right language
  picked up without touching a setting.
- **Founders, managers and teams in meetings**, who want a structured record of each call — topics, decisions,
  action items — without taking notes by hand.
- **Creators and marketers**, who want to turn a talk, interview or meeting into a blog article and social posts.
- **Developers and privacy-minded users**, who want to use their own Groq or OpenAI key, or a local
  OpenAI-compatible server.

## Features

### Dictation in any app

**One hotkey, every app.** The default hotkey is `Ctrl+Shift+Space` (`Cmd+Shift+Space` on macOS) and can be
changed in Settings. Press it to start, press it again to stop. A floating, always-on-top microphone icon does
the same with a click. The icon never takes keyboard focus, so the text lands in the app you were using.

**Text typed where the cursor is.** Wispra pastes the result into the focused field and then restores your
previous clipboard content. On setups with several monitors it waits for the right window to be in front before
pasting.

**Automatic language detection.** Whisper detects the spoken language on each recording, so you can switch
between languages freely. You can also pin one language in Settings.

**Built for real use.** Recordings stop only when you press the hotkey or click the icon (up to 10 minutes per
dictation). A silent recording is caught before transcription — nothing is typed and no quota is used — and
phrases Whisper is known to invent on near-silent audio are filtered out.

**Comfort options.** Sound cues when recording starts or fails, a short preview of the text before it is pasted,
a continuous mode that starts the next recording right after each paste, and launch at login.

### AI cleanup, modes and voice commands

**AI cleanup.** An optional pass with a large language model fixes spelling and punctuation, capitalises
sentences and names, and removes filler words (in Vietnamese as well as English). It is told never to summarise
or merge sentences, and a length check falls back to the original transcript if the AI shortens it too much.

**Modes.** Choose how the cleanup writes: General, Professional, Vietnamese, Casual, Zalo (casual Vietnamese
chat) or Email, or create your own mode with your own instructions. Switch from the tray menu or Settings.

**App-aware.** Wispra notices which app you are dictating into and gives the cleanup a matching hint, so a chat
message and an email are not written the same way.

**Voice commands.** Say "new paragraph", "period", "comma", "open quote" and similar to format as you speak, or
"delete that" to undo the last dictation.

**Templates.** Define a keyword and the text it expands to — an email signature, an address, a standard reply —
with `[date]` and `[time]` placeholders.

### Learning your words and style

**Custom vocabulary.** Add names, product names and technical terms that must be spelled exactly.

**Learning from your fixes.** Edit a dictation in History and Wispra remembers the correction: fixed once, it
becomes a hint for the AI cleanup; fixed again, it is replaced automatically. Wispra also suggests recurring
mishearings and names from your History and meetings, and only applies a suggestion when you accept it.

**Recognition tuned to you.** Names and terms you use often are picked up from History and Meetings and passed to
Whisper as a hint, so they are recognised better next time. You can review and remove them in Settings → Learned.

**Writing style.** Habits Wispra notices in your own corrections, plus notes you write yourself, are passed to the
AI cleanup. A private scorecard shows whether learning reduces the fixes you make, and every part of learning
can be switched off or reset.

### Meeting Mode

**Record a meeting or a call.** Record your microphone, the computer's audio (what is playing in a call), or
both. The transcript builds up while you speak, and you can pause and stop at any time.

**Transcript in four columns.** A finished recording shows time and speaker, topic, transcript and action items
side by side. Topics always cover the whole recording. Action items are only what was actually said — a topic
without one stays empty. A By topic / List switch shows all action items as one list, and clicking one jumps to
where it was said.

**Speaker names, without voiceprints.** Names said in the recording ("I'm Linh", "over to Sơn") label the
paragraphs they speak. When recording both sides, paragraphs are marked You or Others from where the sound came
from. Click a label to rename a speaker everywhere. There is no voice recognition and nothing about anyone's
voice is stored.

**Ask about a recording.** A chat next to each meeting answers questions about its transcript, live or
afterwards, and highlights the part of the transcript the answer comes from.

**Spaces.** Group recordings into spaces, for example by client or project.

### From a meeting to finished content

**Summary.** A thorough summary with one section per topic, so the middle of a long meeting is not skipped.

**Mind map.** The meeting as a map of its topics and points. Long recordings are outlined part by part, so a
multi-hour meeting is covered end to end. Click a point to jump to it in the transcript, export the map as PNG or
copy it as a Markdown outline. The map is built in the background: you can keep working, dictate or close the
window, and a map that was interrupted continues from where it stopped instead of starting again.

**Website and social posts.** One click writes a blog article (with title and meta description) or posts for
Facebook, Instagram, LinkedIn and X from the meeting.

**Your choice of languages.** Each recording can have its own language for the summary and for the posts,
independent of the language that was spoken.

**Nothing runs until you ask.** The Mind map, Website and social tabs show a "Create …" button and do not call
the AI until you press it. Topics and action items are created automatically only for new recordings; older
recordings offer a button instead, so opening them does not use your AI allowance.

### File transcription

The Transcribe tab takes an audio or video file — MP3, MP4, WAV, M4A, FLAC, OGG, WebM and more — and returns a
text transcript.

### History and statistics

**History.** Every dictation is kept, grouped by topic (Email, Meeting, Tasks, Notes, Message, General) and by
day, with copy, edit and an AI summary per topic. Export it as TXT, Markdown or CSV.

**Statistics.** Total dictations, minutes and words, your streak, your most active day, and an estimate of the
time saved compared with typing at 40 words per minute.

### Wispra Cloud, your own key, or a local server

**Wispra Cloud.** Sign in and use Wispra without an API key. Cloud use counts toward your account's monthly
minutes and AI allowance, and Wispra says clearly when an allowance is used up — dictation then keeps working
and types the text as transcribed, without the AI cleanup.

**Your own key.** Use your own Groq key (or OpenAI) and Wispra calls the provider directly. Switching between
Wispra Cloud and your own key never deletes a saved key, and a saved key is never shown again.

**Local server.** Point Wispra at Ollama, LocalAI or LM Studio for transcription and AI on your own machine,
with no API key.

**Cloud sync (opt-in).** Off by default. When turned on, a copy of your History, Meetings and learned words is
kept in your Wispra account.

**Connect your AI assistant.** A private, read-only link lets assistants such as ChatGPT, Claude or Cursor read
your synced dictations and meetings. The link is masked, can expire and can be changed at any time. A local MCP
server in [`mcp-server/`](mcp-server/README.md) offers the same read-only access over stdio, without the cloud.

### Working within AI provider limits

Free AI plans have limits per minute and per day. Wispra tells them apart:

- **Per-minute limits** are waited out, and the request is sent again on its own.
- **Daily limits** are reported as such, with how much was used, the limit and when it resets — Wispra does not
  keep a spinner going for hours.
- **Backup models.** With your own Groq key, when the main model reaches its daily limit, the AI text features
  continue with Groq's smaller `gpt-oss-20b`, then with Cloudflare Workers AI if you add a Cloudflare account.
  Text written by a backup model says so. Wispra counts its own Cloudflare use and stops for the day before the
  free daily allocation is used up. Transcription always stays on the provider you chose.

### Your data

- **Audio is not kept.** Dictation and meeting audio is sent to the transcription provider you chose; Wispra
  stores the text, not the recording.
- **Local by default.** Settings, History and Meetings are plain JSON files in the app's data folder on your
  computer. Nothing is copied to the cloud unless you turn on cloud sync.
- **Keys stay hidden.** API keys and tokens are never shown again after saving, and are tested before they are
  saved.
- **Read-only sharing.** The AI assistant link and the local MCP server can only read; they cannot record,
  change or delete anything.

## How it works, step by step

1. **Install Wispra** from the [latest release](https://github.com/sinhgiang/wispra/releases/latest). Settings
   opens on first launch.
2. **Choose how to transcribe.** Sign in to Wispra Cloud, or paste a free Groq API key from
   [console.groq.com/keys](https://console.groq.com/keys), or point Wispra at a local server.
3. **Click into any text field** and press `Ctrl+Shift+Space` (`Cmd+Shift+Space` on macOS), or click the
   floating icon.
4. **Speak, then press the hotkey again.** The overlay shows that Wispra is recording, then processing.
5. **Wispra transcribes** the audio with Whisper and detects the language.
6. **AI cleanup** (if on) fixes punctuation and spelling and removes filler words, in the current mode and with
   your vocabulary.
7. **The text is pasted** into the focused field, and your clipboard is restored. The dictation is added to
   History.
8. **For a meeting,** open Meeting Mode, choose the audio source and start. After Stop, the Transcript tab fills
   in its topics and action items; press Create for a mind map, an article or posts.
9. **Wispra updates itself.** New versions are offered from GitHub Releases in Settings → Updates.

## Ways to run transcription and AI

| | Wispra Cloud | Your own Groq key | Your own OpenAI key | Local server |
|---|---|---|---|---|
| Account or key | Wispra account | Groq API key | OpenAI API key | None |
| Transcription | Whisper, through Wispra Cloud | Groq `whisper-large-v3` | OpenAI `whisper-1` | Your server's model |
| AI text | Through Wispra Cloud | Groq `openai/gpt-oss-120b` | OpenAI `gpt-4o-mini` | Your server's model (Ollama, LocalAI, LM Studio) |
| Backup AI on a daily limit | — | Groq `gpt-oss-20b`, then Cloudflare Workers AI (optional) | — | — |
| What is counted | Your account's monthly minutes and AI allowance | Your Groq plan's limits | Your OpenAI account | Nothing |

The Wispra Cloud plans and the current allowance are shown in Settings → Account.

## FAQ

**Which apps does Wispra work with?**
Any app with a text field: browsers, email, chat apps, office apps, code editors. Wispra pastes into whatever is
focused.

**Which languages does it understand?**
Whisper detects the spoken language automatically and supports 95+ languages, including Vietnamese and English.
You can also pin one language in Settings.

**Do I need an API key?**
No. You can sign in to Wispra Cloud instead. If you prefer, use your own Groq or OpenAI key, or a local server.

**Will it rewrite what I said?**
Only if AI cleanup is on, and then only to fix punctuation, spelling and filler words in the mode you chose. It
is instructed not to summarise, and if the result comes back much shorter, Wispra types the original transcript
instead.

**Does Wispra keep my audio?**
No. Audio goes to the transcription provider you chose. Wispra keeps the text on your computer.

**Can it record online meetings?**
Yes. Meeting Mode can record the computer's audio, your microphone, or both.

**Does it recognise who is speaking by their voice?**
No. Speaker names come only from what is said in the recording, from your own edits, or — when recording both
sides — from whether the sound came from your microphone or from the computer.

**What happens when my AI provider's limit is reached?**
A per-minute limit is waited out. A daily limit is reported with when it resets; with your own Groq key, the AI
text features can continue on backup models. Dictation still types the transcribed text.

**Can my AI assistant read my notes?**
Yes, if you choose: turn on cloud sync and share the private read-only link, or use the local MCP server.

**Is the Windows installer signed?**
Not yet. Windows SmartScreen may show a warning; choose "More info" → "Run anyway".

## Tech stack

| Layer | Technology |
|---|---|
| Desktop app | Electron 34, electron-vite, TypeScript 5 |
| UI | React 19; the mind map is drawn with plain SVG |
| Speech to text | Whisper on Groq (`whisper-large-v3`), OpenAI `whisper-1`, or a local OpenAI-compatible server |
| AI text | Groq `openai/gpt-oss-120b` and `gpt-oss-20b`, Cloudflare Workers AI `@cf/openai/gpt-oss-120b`, OpenAI `gpt-4o-mini`, or a local model |
| Text injection | Clipboard paste via PowerShell `SendKeys` on Windows and AppleScript on macOS — no native input libraries |
| Storage | Plain JSON files in the app's data folder |
| Packaging and updates | electron-builder (Windows NSIS installer, macOS universal DMG), electron-updater with GitHub Releases |
| AI assistant access | Local MCP server over stdio (`mcp-server/`) |

The main process owns all state: one state machine (`idle → recording → processing → idle`) receives every
trigger, and every error path returns it to idle, so the app is never left stuck. The windows only display that
state.

## Repository

The source code is published here for transparency. No open-source license is granted (`package.json` declares
`UNLICENSED`): the code belongs to the owner of Wispra and may not be copied, distributed or reused without
permission.

Conventions and architecture notes for contributors are in [CLAUDE.md](CLAUDE.md); release history is on the
[Releases page](https://github.com/sinhgiang/wispra/releases).

## Get started

**Use the app**

- Download the latest version: [GitHub Releases](https://github.com/sinhgiang/wispra/releases/latest)
  (`Wispra-Setup-<version>.exe` for Windows, `Wispra-<version>-universal.dmg` for macOS)
- Learn more: [wispra-web.vercel.app](https://wispra-web.vercel.app)
- Report a problem or ask a question: [GitHub Issues](https://github.com/sinhgiang/wispra/issues)

**Build from source**

```bash
npm install
npm run dev          # run in development mode
npm run typecheck    # TypeScript check for all processes
npm run build:win    # Windows installer into dist/
npm run build:mac    # macOS DMG (requires a Mac)
```

Automated checks for the meeting features run with `npm run check:<name>`; the full list is in
[CLAUDE.md](CLAUDE.md#commands).
