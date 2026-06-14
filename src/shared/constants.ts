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
    prompt: 'Correct all Vietnamese diacritics and tones carefully. Fix punctuation. Remove Vietnamese filler words (ừm, à, ý là, kiểu, thì là). Do not translate or change the content.',
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
  }
]

export const DEFAULT_SETTINGS: Settings = {
  provider: 'openai',
  groqApiKey: '',
  openaiApiKey: '',
  hotkey: 'CommandOrControl+Shift+Space',
  language: 'auto',
  launchAtLogin: false,
  autoStopMinutes: 5,
  autoUpdate: true,
  aiPostProcess: false,
  modes: DEFAULT_MODES,
  activeMode: 'general',
  vocabulary: [],
  localBaseUrl: 'http://localhost:11434/v1',
  localSttModel: 'whisper',
  localLlmModel: 'llama3.2'
}

export const GROQ_API_BASE = 'https://api.groq.com/openai/v1'
export const GROQ_STT_MODEL = 'whisper-large-v3-turbo'

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
