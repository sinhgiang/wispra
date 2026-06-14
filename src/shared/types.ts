export type AppState = 'idle' | 'recording' | 'processing' | 'error'

export interface StatePayload {
  state: AppState
  /** Short user-facing message, set when state === 'error'. */
  message?: string
}

export type SttProvider = 'groq' | 'openai' | 'local'

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
}

export interface TranscriptEntry {
  id: string
  text: string
  /** ISO timestamp. */
  createdAt: string
  /** Detected or pinned language code, if known. */
  language?: string
  durationSeconds?: number
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
