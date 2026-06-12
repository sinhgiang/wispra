import {
  GROQ_API_BASE,
  GROQ_STT_MODEL,
  OPENAI_API_BASE,
  OPENAI_STT_MODEL,
  TRANSCRIBE_RETRIES,
  TRANSCRIBE_TIMEOUT_MS
} from '@shared/constants'
import type { ApiKeyTestResult, SttProvider } from '@shared/types'

interface ProviderConfig {
  base: string
  model: string
  apiKey: string
}

function getConfig(provider: SttProvider, groqKey: string, openaiKey: string): ProviderConfig {
  if (provider === 'openai') {
    return { base: OPENAI_API_BASE, model: OPENAI_STT_MODEL, apiKey: openaiKey }
  }
  return { base: GROQ_API_BASE, model: GROQ_STT_MODEL, apiKey: groqKey }
}

export async function transcribe(
  audio: Uint8Array,
  provider: SttProvider,
  groqKey: string,
  openaiKey: string,
  language: string,
  mimeType = 'audio/webm'
): Promise<string> {
  const config = getConfig(provider, groqKey, openaiKey)
  if (!config.apiKey) {
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
): Promise<string> {
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

  const data = (await response.json()) as { text?: string }
  return (data.text ?? '').trim()
}

export async function testApiKey(
  provider: SttProvider,
  apiKey: string
): Promise<ApiKeyTestResult> {
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
