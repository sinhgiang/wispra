export type AppState = 'idle' | 'recording' | 'processing' | 'previewing' | 'done' | 'error'

export interface StatePayload {
  state: AppState
  /** Short user-facing message, set when state === 'error'. */
  message?: string
}

export type SttProvider = 'groq' | 'openai' | 'local' | 'proxy'

export interface Mode {
  id: string
  name: string
  /** Custom LLM system prompt. Empty string = use the built-in default prompt. */
  prompt: string
  /** ISO-639-1 code or "auto". Overrides the global language setting when active. */
  language: string
  removeFiller: boolean
  /** Built-in modes cannot be deleted, only edited. */
  builtIn?: boolean
}

/** A voice-triggered text expansion template. */
export interface Template {
  id: string
  /** Phrase to say that triggers this template (case-insensitive match). */
  keyword: string
  /** Text to inject when the keyword is matched. Supports [date] and [time] variables. */
  expansion: string
}

/** Maps an app process name pattern to a Mode and optional AI context hint. */
export interface AppContextRule {
  /** Lowercase substring matched against the process name (e.g. "outlook", "slack"). */
  appPattern: string
  /** Mode ID to use when this app is focused. Empty = don't switch mode. */
  modeId: string
  /** Extra hint appended to the AI system prompt for this app context. */
  contextHint: string
}

export interface Settings {
  provider: SttProvider
  groqApiKey: string
  openaiApiKey: string
  /** Electron accelerator string, e.g. "CommandOrControl+Shift+Space". */
  hotkey: string
  /** ISO-639-1 code ("vi", "en", ...) or "auto" for automatic detection. */
  language: string
  launchAtLogin: boolean
  /** Auto-stop recording after this many minutes. */
  autoStopMinutes: number
  autoUpdate: boolean
  aiPostProcess: boolean
  /** List of dictation modes. */
  modes: Mode[]
  /** ID of the currently active mode. */
  activeMode: string
  /** Custom words/phrases that must be spelled exactly as given. */
  vocabulary: string[]
  /** Base URL for the local STT/LLM server (e.g. Ollama, LocalAI, LM Studio). */
  localBaseUrl: string
  /** Model name for local speech-to-text (passed to /audio/transcriptions). */
  localSttModel: string
  /** Model name for local AI cleanup (passed to /chat/completions). */
  localLlmModel: string
  /** 'toggle' = press to start, press again to stop. 'auto-stop' = stops automatically on silence. */
  inputMode: 'toggle' | 'auto-stop'
  /** Play a system beep when recording starts / errors. */
  soundFeedback: boolean
  /** Show a text preview near the cursor for 2.5s before pasting. */
  previewBeforePaste: boolean
  /** Match spoken commands (new paragraph, delete that, etc.) instead of injecting. */
  voiceCommandsEnabled: boolean
  /** Auto-detect the focused app and adjust AI prompt accordingly. */
  contextAwareEnabled: boolean
  /** User-defined app → mode mapping for context-aware AI. */
  appContextRules: AppContextRule[]
  /** Voice-triggered text expansion templates. */
  templates: Template[]
  /** After injection, automatically start recording again for hands-free dictation. */
  continuousMode: boolean
  /** Incremented when defaults change, so migrations can upgrade old saved settings. */
  settingsVersion: number
}

export interface TranscriptEntry {
  id: string
  text: string
  /** ISO timestamp. */
  createdAt: string
  /** Detected or pinned language code, if known. */
  language?: string
  durationSeconds?: number
  /** Auto-detected topic: 'Email' | 'Meeting' | 'Tasks' | 'Notes' | 'Message' | 'General' */
  topic?: string
}

export interface HotkeyResult {
  ok: boolean
  /** Set when ok === false, e.g. the hotkey is taken by another app. */
  error?: string
}

export interface ApiKeyTestResult {
  ok: boolean
  error?: string
}

/** Wispra cloud account info (returned when user is signed in). */
export interface AccountInfo {
  email: string
  plan: 'free' | 'pro'
  /** Seconds used this month. */
  usageSeconds: number
  /** Monthly limit in seconds, or null if unlimited (Pro). */
  limitSeconds: number | null
  /** Polar.sh checkout URL for upgrading. */
  subscribeUrl: string | null
  /** Google profile photo URL. */
  avatarUrl?: string
}

export interface UsageStats {
  totalDictations: number
  totalMinutes: number
  totalWords: number
  thisWeekDictations: number
  thisWeekMinutes: number
  streak: number
  mostActiveDay: string
}

export type FileTranscribeResult =
  | { ok: true; text: string }
  | { ok: false; error: string }

export type UpdateStatus =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; percent: number }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string }

// ── Meeting mode (long-form continuous recording) ────────────────────────────
// Fully additive — separate from the short-dictate flow above (AppState, TranscriptEntry, etc).

/** Which audio to capture: microphone only, system/loopback audio only, or both mixed together. */
export type MeetingAudioSource = 'mic' | 'system' | 'both'

/**
 * Per-session language choices, picked once on the "Start recording" screen and
 * carried for the session's whole lifetime (content tabs read it back even when
 * generated long after the recording stopped). Each field is an ISO-639-1 code
 * from LANGUAGES in constants.ts, or "auto":
 * - input: STT hint for every audio chunk. "auto" lets Whisper detect per chunk
 *   instead of forcing one language — this is what fixes speaking English while
 *   the global Dictate language is pinned to Vietnamese (or vice versa).
 * - transcript: language the live transcript is displayed/saved in. "auto" =
 *   same as spoken (plain transcription, the default and cheapest path). Any
 *   other value runs each segment through a translation call after STT — e.g.
 *   speak English, read the transcript in Vietnamese.
 * - summary/website/facebook/instagram/linkedin/twitter: target language for
 *   that piece of AI-generated output. "auto" = same language as the transcript
 *   (the prior, only behavior). Independent per field — e.g. summary in
 *   Vietnamese while the Website article is generated in English.
 */
export interface MeetingLanguageConfig {
  input: string
  transcript: string
  summary: string
  website: string
  facebook: string
  instagram: string
  linkedin: string
  twitter: string
}

export type MeetingState = 'idle' | 'recording' | 'paused' | 'stopping' | 'error'

/** One paragraph of a meeting transcript, built from one or more transcribed audio chunks. */
export interface MeetingSegment {
  id: string
  text: string
  /** Milliseconds along the session's active (non-paused) timeline. */
  startMs: number
  endMs: number
  /** ISO wall-clock timestamp captured when this segment's audio started recording — shown to the user as "at 14:05". */
  startedAt: string
  /** True if this segment starts a new paragraph (word-count threshold or detected topic shift). */
  isNewParagraph: boolean
  topicLabel?: string
}

export interface MeetingSession {
  id: string
  /** AI-generated short title (like ChatGPT auto-naming a conversation). Defaults to a date/time label until generated. */
  title: string
  /** AI-generated summary of the whole session, written once recording stops. Undefined until generation finishes (or if it fails, e.g. offline). */
  summary?: string
  /** ISO timestamp. */
  createdAt: string
  durationMs: number
  audioSource: MeetingAudioSource
  segments: MeetingSegment[]
  /** 'summarizing' = recording just stopped, title/summary generation in flight. */
  status: 'recording' | 'summarizing' | 'stopped'
  /** Ready-to-post content per platform, generated on demand (see generateMeetingContent in postprocess.ts) the first time the user opens that platform's tab. Undefined per-field until generated. */
  content?: MeetingContent
  /** Language choices picked on the "Start recording" screen. Undefined for sessions recorded before this field existed — treated the same as all-"auto". */
  languageConfig?: MeetingLanguageConfig
}

/** Which platform's ready-to-post content to generate/show for a stopped meeting session. */
export type ContentPlatform = 'website' | 'facebook' | 'instagram' | 'linkedin' | 'twitter'

/** Ready-to-post content generated from a meeting transcript, one field per platform. Cached on the session once generated so re-opening a tab doesn't re-call the LLM. */
export interface MeetingContent {
  /** SEO blog/website article — a single piece, not variants. */
  website?: { title: string; metaDescription: string; body: string }
  /** 3 distinct ready-to-post variants per platform (see CONTENT_PROMPTS in postprocess.ts for what each variant is). */
  facebook?: string[]
  instagram?: string[]
  linkedin?: string[]
  /** Internal key kept as "twitter" (the platform's long-standing name in code/APIs); shown to the user as "X". */
  twitter?: string[]
}

/** Result of one generateMeetingContent() call — tagged by platform since website's shape differs from the social platforms' variant-list shape. */
export type MeetingContentResult =
  | { platform: 'website'; title: string; metaDescription: string; body: string }
  | { platform: 'facebook' | 'instagram' | 'linkedin' | 'twitter'; posts: string[] }

/** Lightweight entry for the session list (sidebar) — avoids loading full segment text for every row. */
export interface MeetingSessionSummary {
  id: string
  title: string
  createdAt: string
  durationMs: number
  audioSource: MeetingAudioSource
  status: 'recording' | 'summarizing' | 'stopped'
}
