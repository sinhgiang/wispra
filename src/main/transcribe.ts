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
  proxyToken?: string
): Promise<TranscribeResult> {
  // Wispra cloud proxy provider
  if (provider === 'proxy') {
    if (!proxyToken) throw noRetry('Not signed in — open Account settings to log in')
    let lastError: Error = new Error('Transcription failed')
    for (let attempt = 0; attempt <= TRANSCRIBE_RETRIES; attempt++) {
      try {
        return await requestViaProxy(audio, proxyToken, language, mimeType, durationSeconds)
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
      return await requestTranscription(audio, config, language, mimeType)
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
  durationSeconds: number
): Promise<TranscribeResult> {
  const ext = mimeToExt(mimeType)
  const form = new FormData()
  form.append('file', new Blob([audio as BlobPart], { type: mimeType }), `audio.${ext}`)
  form.append('model', GROQ_STT_MODEL)
  form.append('response_format', 'json')
  if (language && language !== 'auto') form.append('language', language)

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

  const data = (await response.json()) as { text?: string; language?: string }
  const text = (data.text ?? '').trim()
  const raw = data.language?.toLowerCase()
  const detectedLanguage = raw === 'vietnamese' ? 'vi' : raw === 'english' ? 'en' : raw
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
  mimeType: string
): Promise<TranscribeResult> {
  const ext = mimeToExt(mimeType)
  const form = new FormData()
  form.append('file', new Blob([audio as BlobPart], { type: mimeType }), `audio.${ext}`)
  form.append('model', config.model)
  form.append('response_format', 'json')
  if (language && language !== 'auto') form.append('language', language)

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

  const data = (await response.json()) as { text?: string; language?: string }
  const text = (data.text ?? '').trim()
  // Normalise language code: Whisper may return "vietnamese" or "vi" depending on model.
  const raw = data.language?.toLowerCase()
  const detectedLanguage = raw === 'vietnamese' ? 'vi' : raw === 'english' ? 'en' : raw
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
