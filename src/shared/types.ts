export type AppState = 'idle' | 'recording' | 'processing' | 'error'

export interface StatePayload {
  state: AppState
  /** Short user-facing message, set when state === 'error'. */
  message?: string
}

export type SttProvider = 'groq' | 'openai'

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

export type UpdateStatus =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; percent: number }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string }
