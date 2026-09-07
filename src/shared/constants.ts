import type { Mode, Settings } from './types'

export const DEFAULT_MODES: Mode[] = [
  {
    id: 'general',
    name: 'General',
    prompt: '',
    language: 'auto',
    removeFiller: true,
    builtIn: true
  },
  {
    id: 'professional',
    name: 'Professional',
    prompt: 'Rewrite as polished, professional prose. Fix all punctuation and grammar. Remove filler words. Use formal vocabulary. Keep the original language and all content.',
    language: 'auto',
    removeFiller: true,
    builtIn: true
  },
  {
    id: 'vietnamese',
    name: 'Vietnamese',
    prompt: 'Fix Vietnamese diacritics and tones. Capitalize the first word of every sentence and all proper nouns (names of people, places, organizations). Add punctuation: comma (,) between clauses and after introductory phrases, period (.) at the end of each sentence, question mark (?) for questions. Remove filler words (ừm, à, ý là, kiểu, thì là, thì, mà). Do not translate or change the meaning.',
    language: 'vi',
    removeFiller: true,
    builtIn: true
  },
  {
    id: 'casual',
    name: 'Casual',
    prompt: 'Fix only obvious spelling errors and missing end punctuation. Keep the natural, conversational tone and phrasing.',
    language: 'auto',
    removeFiller: false,
    builtIn: true
  },
  {
    id: 'zalo',
    name: 'Zalo',
    prompt: 'Fix Vietnamese diacritics and spelling for a casual Zalo chat message. Keep the informal, friendly tone. Short sentences preferred. Do not add formal greetings or closings.',
    language: 'vi',
    removeFiller: true,
    builtIn: true
  },
  {
    id: 'email',
    name: 'Email',
    prompt: 'Format as a professional email. Fix grammar, spelling, and punctuation. Start with an appropriate greeting, end with an appropriate closing. Keep the same language as the input.',
    language: 'auto',
    removeFiller: true,
    builtIn: true
  }
]

export const DEFAULT_SETTINGS: Settings = {
  provider: 'proxy',
  groqApiKey: '',
  openaiApiKey: '',
  hotkey: 'CommandOrControl+Shift+Space',
  language: 'auto',
  launchAtLogin: false,
  autoStopMinutes: 10,
  autoUpdate: true,
  aiPostProcess: true,
  modes: DEFAULT_MODES,
  activeMode: 'general',
  vocabulary: [],
  localBaseUrl: 'http://localhost:11434/v1',
  localSttModel: 'whisper',
  localLlmModel: 'llama3.2',
  inputMode: 'toggle',
  soundFeedback: true,
  previewBeforePaste: false,
  voiceCommandsEnabled: true,
  contextAwareEnabled: false,
  appContextRules: [],
  templates: [],
  continuousMode: false,
  settingsVersion: 2
}

// ── Wispra cloud (Phase 3) ───────────────────────────────────────────────────
// FILL IN these values after creating your Supabase project and Polar product.
// The anon key and URL are safe to include in the app bundle (they are public by design).
export const SUPABASE_URL = 'https://tpiycamfsagesjeciubg.supabase.co'
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRwaXljYW1mc2FnZXNqZWNpdWJnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0OTA1MTAsImV4cCI6MjA5NzA2NjUxMH0.qxMVAbBSsBhWOeB5Xak_eQthjcI-wXGo87P7bVcoStU'
export const WISPRA_API_BASE = 'https://wispra-web.vercel.app'
export const POLAR_CHECKOUT_URL = 'https://buy.polar.sh/YOUR_PRODUCT_LINK'
/** Free tier limit in seconds (30 minutes per month). */
export const FREE_LIMIT_SECONDS = 30 * 60

export const GROQ_API_BASE = 'https://api.groq.com/openai/v1'
// Full large-v3, not the "-turbo" distilled variant: turbo drops the decoder from 32 to 4
// layers for ~8x speed, at a real accuracy cost on non-English/tonal languages like
// Vietnamese. Transcription already happens after recording stops (not live/streaming),
// so the extra ~1-2s latency is worth it for materially better Vietnamese accuracy.
export const GROQ_STT_MODEL = 'whisper-large-v3'

export const OPENAI_API_BASE = 'https://api.openai.com/v1'
export const OPENAI_STT_MODEL = 'whisper-1'
export const TRANSCRIBE_TIMEOUT_MS = 120_000
export const TRANSCRIBE_RETRIES = 1

/** How long the error state is shown before returning to idle. */
export const ERROR_DISPLAY_MS = 4_000
/** Delay between simulated paste and clipboard restore. */
export const CLIPBOARD_RESTORE_DELAY_MS = 400
export const MAX_HISTORY_ENTRIES = 100

export const OVERLAY_SIZE = 64
/** Extra height for the preview text area below the bubble. */
export const OVERLAY_PREVIEW_HEIGHT = 180
/** Milliseconds to delay before auto-pasting when previewBeforePaste is on. */
export const PREVIEW_DELAY_MS = 2500
/** RMS level below which audio is considered silence for auto-stop mode. */
export const SILENCE_THRESHOLD = 0.018
/** Milliseconds of continuous silence before auto-stopping in auto-stop mode. */
export const SILENCE_DURATION_MS = 3000

// ── Meeting mode chunk cutting (reuses SILENCE_THRESHOLD as the "is this silence" level) ────
/** Natural-pause chunk cut: silence duration that ends a chunk once speech has started. */
export const MEETING_SOFT_CUT_MS = 800
/** Safety-net chunk cut: max continuous speech duration before force-cutting without a pause. */
export const MEETING_HARD_CAP_MS = 20_000
/**
 * A level reading above SILENCE_THRESHOLD must hold continuously for this long before
 * ChunkCutter treats it as real speech at all. Filters out a single spurious reading
 * (e.g. faint mic pickup of the computer's own speaker output) so it can never by itself
 * force a full chunk to be cut and sent for transcription — at the 100ms sampling tick
 * rate (see LEVEL_TICK_MS in recorder.ts), this requires 2+ consecutive above-threshold
 * ticks, which real speech always clears but a one-tick blip cannot.
 */
export const MEETING_MIN_SPEECH_MS = 200
/**
 * Meeting Mode safety net: if a recording sits this long with no real (non-empty)
 * transcribed speech at all, auto-stop it exactly like a manual Stop — covers a
 * recording left running by mistake, or Mic-only picking up nothing while background/
 * computer audio plays with the user saying nothing.
 */
export const MEETING_SILENCE_AUTO_STOP_MS = 5 * 60_000
/** Milliseconds to keep the overlay visible after injection (for done animation). */
export const DONE_DISPLAY_MS = 1400

/** Languages offered in Settings (Whisper supports many more via "auto"). */
export const LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'auto', label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'es', label: 'Spanish' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ru', label: 'Russian' },
  { code: 'th', label: 'Thai' },
  { code: 'id', label: 'Indonesian' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ar', label: 'Arabic' }
]
