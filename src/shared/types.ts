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
