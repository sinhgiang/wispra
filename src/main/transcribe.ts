import {
  GROQ_API_BASE,
  GROQ_STT_MODEL,
  OPENAI_API_BASE,
  OPENAI_STT_MODEL,
  TRANSCRIBE_RETRIES,
  TRANSCRIBE_TIMEOUT_MS,
  WISPRA_API_BASE
} from '@shared/constants'
import type { ApiKeyTestResult, SttProvider } from '@shared/types'

interface ProviderConfig {
  base: string
  model: string
  apiKey: string
}

interface VerboseSegment {
  text: string
  no_speech_prob: number
}

interface VerboseResponse {
  text?: string
  language?: string
  segments?: VerboseSegment[]
}

/** Discard segments where Whisper is >50% confident there is no real speech (hallucination guard). */
const NO_SPEECH_THRESHOLD = 0.5

/**
 * Phrases Whisper hallucinates from its training data (mostly YouTube outros) when
 * audio is near-silent or contains only ambient noise/trailing silence after real
 * speech. These appear even with low no_speech_prob because the model is
 * "confident" it heard something — but it's always wrong. Matched as a substring
 * against each individual SENTENCE (see filterKnownHallucinations below), not the
 * whole transcript, so one hallucinated sentence tacked onto real speech doesn't
 * wipe out the real part with it.
 */
const HALLUCINATION_PHRASES = [
  // English YouTube outros
  'like and subscribe',
  'like, share and subscribe',
  'like, comment and subscribe',
  'please like and subscribe',
  'please subscribe',
  "don't forget to subscribe",
  'subscribe to my channel',
  'thank you for watching',
  'thanks for watching',
  'see you in the next video',
  'see you next time',
  // Vietnamese YouTube outros — Whisper's Vietnamese training data is saturated
  // with these (e.g. "Ghiền Mì Gõ", a real VN YouTube channel that shows up as a
  // hallucination constantly, regardless of what the user actually watches).
  'cảm ơn các bạn đã theo dõi',
  'cảm ơn các bạn đã xem',
  'cảm ơn mọi người đã xem',
  'cảm ơn quý vị đã theo dõi',
  'cảm ơn bạn đã theo dõi',
  'hẹn gặp lại các bạn',
  'hẹn gặp lại trong video',
  'hẹn gặp lại ở video',
  'hãy subscribe',
  'nhớ subscribe',
  'nhớ like',
  'đăng ký kênh',
  'like và subscribe',
  'đừng quên đăng ký',
  'không bỏ lỡ những video',
  'không bỏ lỡ video',
  'video hấp dẫn',
  'ghiền mì gõ',
]

/**
 * Whisper's optional "prompt" field. Two effects, both documented by OpenAI's own
 * prompting guide: (1) the model tends to mirror the prompt's writing style, so a
 * fully-accented, punctuated Vietnamese prompt makes fully-accented, punctuated
 * Vietnamese output more likely — this directly helps disambiguate unclear/tonal
 * speech instead of guessing at the nearest plausible-sounding word; (2) listing
 * proper nouns/jargon primes the model to recognize them correctly during
 * transcription itself, rather than relying on the AI cleanup step to guess a fix
 * after the fact (which can't recover a word that was misheard as something else
 * entirely). Kept short — Whisper only attends to roughly the last 224 tokens of it.
 */
function buildSttPrompt(language: string, vocabulary?: string[]): string | undefined {
  const parts: string[] = []
  if (language === 'vi') {
    parts.push(
      'Đây là bản ghi âm tiếng Việt, có dấu đầy đủ, viết hoa đầu câu và tên riêng, có dấu chấm và dấu phẩy rõ ràng.'
    )
  }
  if (vocabulary && vocabulary.length > 0) {
    const terms = vocabulary.slice(0, 30).join(', ')
    parts.push(
      language === 'vi' ? `Các từ/tên riêng cần giữ nguyên: ${terms}.` : `Keep these terms spelled exactly: ${terms}.`
    )
  }
  const prompt = parts.join(' ').trim()
  return prompt.length > 0 ? prompt : undefined
}

/** Splits on sentence-ending punctuation or newlines, keeping each piece trimmed. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Words 4+ characters long, lowercased — short function words are skipped since they'd coincidentally overlap with plenty of unrelated real speech too. */
function distinctiveWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[.,!?:;"…]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4)
  )
}

/**
 * Catches a distinct Whisper failure mode from the one HALLUCINATION_PHRASES
 * targets: given the `prompt` param (buildSttPrompt) as prior "context",
 * unclear/near-silent audio sometimes makes the model just continue or
 * paraphrase that context instead of admitting it heard nothing, rather than
 * looping a training-data phrase. Caught the same way real plagiarism
 * detectors work — not an exact-substring match (the model paraphrases, it
 * doesn't quote), but a sentence that reuses most of the prompt's own
 * distinctive wording is never something a real speaker produces by
 * coincidence.
 */
function isPromptEcho(sentence: string, promptWords: Set<string>): boolean {
  if (promptWords.size === 0) return false
  const words = [...distinctiveWords(sentence)]
  if (words.length < 3) return false
  const overlap = words.filter((w) => promptWords.has(w)).length
  return overlap / words.length >= 0.5
}

/**
 * Drops sentences matching a known hallucination phrase or echoing the STT
 * prompt itself, and collapses a sentence repeated 3+ times verbatim —
 * Whisper's other common failure mode on silence/noise is looping the same
 * line over and over regardless of wording.
 */
function filterKnownHallucinations(text: string, sttPrompt?: string): string {
  const seen = new Map<string, number>()
  const kept: string[] = []
  const promptWords = sttPrompt ? distinctiveWords(sttPrompt) : new Set<string>()

  for (const sentence of splitSentences(text)) {
    const normalized = sentence.toLowerCase().replace(/[.,!?。，！？]+/g, '').trim()
    if (!normalized) continue
    if (HALLUCINATION_PHRASES.some((p) => normalized.includes(p))) continue
    if (isPromptEcho(normalized, promptWords)) continue

    const count = (seen.get(normalized) ?? 0) + 1
    seen.set(normalized, count)
    if (count > 2) continue

    kept.push(sentence)
  }

  return kept.join(' ').trim()
}

function getConfig(
  provider: SttProvider,
  groqKey: string,
  openaiKey: string,
  localBaseUrl: string,
  localSttModel: string
): ProviderConfig {
  if (provider === 'openai') return { base: OPENAI_API_BASE, model: OPENAI_STT_MODEL, apiKey: openaiKey }
  if (provider === 'local') return { base: localBaseUrl, model: localSttModel, apiKey: 'local' }
  return { base: GROQ_API_BASE, model: GROQ_STT_MODEL, apiKey: groqKey }
}

export interface TranscribeResult {
  text: string
  /** ISO 639-1 code detected by Whisper, e.g. "vi", "en". Undefined for local provider. */
  detectedLanguage?: string
}

export async function transcribe(
  audio: Uint8Array,
  provider: SttProvider,
  groqKey: string,
  openaiKey: string,
  language: string,
  mimeType = 'audio/webm',
  localBaseUrl = 'http://localhost:11434/v1',
  localSttModel = 'whisper',
  durationSeconds = 0,
  proxyToken?: string,
  vocabulary?: string[]
): Promise<TranscribeResult> {
  // Wispra cloud proxy provider
  if (provider === 'proxy') {
    if (!proxyToken) throw noRetry('Not signed in — open Account settings to log in')
    let lastError: Error = new Error('Transcription failed')
    for (let attempt = 0; attempt <= TRANSCRIBE_RETRIES; attempt++) {
      try {
        return await requestViaProxy(audio, proxyToken, language, mimeType, durationSeconds, vocabulary)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (lastError.name === 'NoRetryError') throw lastError
      }
    }
    throw lastError
  }

  const config = getConfig(provider, groqKey, openaiKey, localBaseUrl, localSttModel)
  if (provider !== 'local' && !config.apiKey) {
    const name = provider === 'openai' ? 'OpenAI' : 'Groq'
    throw new Error(`No ${name} API key set — open Settings and add your key`)
  }

  let lastError: Error = new Error('Transcription failed')
  for (let attempt = 0; attempt <= TRANSCRIBE_RETRIES; attempt++) {
    try {
      return await requestTranscription(audio, config, language, mimeType, vocabulary)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (lastError.name === 'NoRetryError') throw lastError
    }
  }
  throw lastError
}

async function requestViaProxy(
  audio: Uint8Array,
  token: string,
  language: string,
  mimeType: string,
  durationSeconds: number,
  vocabulary?: string[]
): Promise<TranscribeResult> {
  const ext = mimeToExt(mimeType)
  const form = new FormData()
  form.append('file', new Blob([audio as BlobPart], { type: mimeType }), `audio.${ext}`)
  form.append('model', GROQ_STT_MODEL)
  // verbose_json gives per-segment no_speech_prob so we can filter hallucinations
  form.append('response_format', 'verbose_json')
  if (language && language !== 'auto') form.append('language', language)
  // Note: only takes effect once the proxy backend (wispra-web) relays "prompt" to Groq.
  const sttPrompt = buildSttPrompt(language, vocabulary)
  if (sttPrompt) form.append('prompt', sttPrompt)

  let response: Response
  try {
    response = await fetch(`${WISPRA_API_BASE}/api/transcribe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Audio-Duration-Seconds': String(Math.ceil(durationSeconds)),
      },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error('Transcription timed out — check your connection')
    }
    throw new Error('Network error — check your connection')
  }

  if (!response.ok) {
    const detail = await safeErrorDetail(response)
    if (response.status === 401) throw noRetry('Session expired — sign in again in Account settings')
    if (response.status === 402) throw noRetry(detail || 'Monthly free limit reached — upgrade to Pro in Account settings')
    throw new Error(detail || `Transcription failed (HTTP ${response.status})`)
  }

  const data = (await response.json()) as VerboseResponse
  const raw = data.language?.toLowerCase()
  const detectedLanguage = raw === 'vietnamese' ? 'vi' : raw === 'english' ? 'en' : raw

  // Filter silence/hallucination segments — same threshold as direct Groq path
  let text: string
  if (data.segments && data.segments.length > 0) {
    const speechSegments = data.segments.filter(s => s.no_speech_prob < NO_SPEECH_THRESHOLD)
    text = speechSegments.map(s => s.text).join('').trim()
  } else {
    text = (data.text ?? '').trim()
  }

  // Block known Whisper training-data hallucinations (YouTube phrases etc.) and prompt-echo.
  text = filterKnownHallucinations(text, sttPrompt)

  return { text, detectedLanguage }
}

function mimeToExt(mime: string): string {
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('webm')) return 'webm'
  return 'webm'
}

async function requestTranscription(
  audio: Uint8Array,
  config: ProviderConfig,
  language: string,
  mimeType: string,
  vocabulary?: string[]
): Promise<TranscribeResult> {
  const ext = mimeToExt(mimeType)
  const form = new FormData()
  form.append('file', new Blob([audio as BlobPart], { type: mimeType }), `audio.${ext}`)
  form.append('model', config.model)
  form.append('response_format', 'verbose_json')
  if (language && language !== 'auto') form.append('language', language)
  const sttPrompt = buildSttPrompt(language, vocabulary)
  if (sttPrompt) form.append('prompt', sttPrompt)

  let response: Response
  try {
    response = await fetch(`${config.base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error('Transcription timed out — check your connection')
    }
    throw new Error('Network error — check your connection')
  }

  if (!response.ok) {
    const detail = await safeErrorDetail(response)
    if (response.status === 401) throw noRetry('Invalid API key — check Settings')
    if (response.status === 413) throw noRetry('Recording too long — try a shorter dictation')
    if (response.status === 429) throw new Error('Rate limited — wait a moment and try again')
    throw new Error(detail || `Transcription failed (HTTP ${response.status})`)
  }

  const data = (await response.json()) as VerboseResponse
  const raw = data.language?.toLowerCase()
  const detectedLanguage = raw === 'vietnamese' ? 'vi' : raw === 'english' ? 'en' : raw

  // Filter out segments Whisper flagged as likely silence/hallucination
  let text: string
  if (data.segments && data.segments.length > 0) {
    const speechSegments = data.segments.filter(s => s.no_speech_prob < NO_SPEECH_THRESHOLD)
    text = speechSegments.map(s => s.text).join('').trim()
  } else {
    text = (data.text ?? '').trim()
  }

  // Block known Whisper training-data hallucinations (YouTube phrases etc.) and prompt-echo.
  text = filterKnownHallucinations(text, sttPrompt)

  return { text, detectedLanguage }
}

export async function testApiKey(
  provider: SttProvider,
  apiKey: string,
  localBaseUrl?: string
): Promise<ApiKeyTestResult> {
  if (provider === 'local') {
    const base = localBaseUrl ?? 'http://localhost:11434/v1'
    try {
      const response = await fetch(`${base}/models`, {
        headers: { Authorization: 'Bearer local' },
        signal: AbortSignal.timeout(5_000)
      })
      if (response.ok) return { ok: true }
      return { ok: false, error: `Server responded with HTTP ${response.status}` }
    } catch {
      return { ok: false, error: 'Cannot connect — make sure your local server is running' }
    }
  }

  if (!apiKey) return { ok: false, error: 'API key is empty' }
  const base = provider === 'openai' ? OPENAI_API_BASE : GROQ_API_BASE
  try {
    const response = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000)
    })
    if (response.ok) return { ok: true }
    if (response.status === 401) return { ok: false, error: 'Invalid API key' }
    return { ok: false, error: `Unexpected response (HTTP ${response.status})` }
  } catch {
    return { ok: false, error: 'Network error — check your connection' }
  }
}

function noRetry(message: string): Error {
  const err = new Error(message)
  err.name = 'NoRetryError'
  return err
}

async function safeErrorDetail(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    return body.error?.message ?? null
  } catch {
    return null
  }
}
