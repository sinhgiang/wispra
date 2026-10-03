import { readFileSync, statSync } from 'fs'
import type { FileTranscribeResult, Settings } from '@shared/types'
import { transcribe } from './transcribe'

/**
 * Wispra Cloud's transcription endpoint runs on Vercel, which refuses request bodies over
 * 4.5 MB. A bigger file is stopped here with a clear message instead of a bare HTTP 413.
 */
export const CLOUD_FILE_MAX_BYTES = 4 * 1024 * 1024

/** The audio type for a file name, from its extension. */
export function detectMime(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    webm: 'audio/webm',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska'
  }
  return map[ext] ?? 'audio/mpeg'
}

export interface TranscribeFileDeps {
  settings: () => Pick<Settings, 'provider' | 'groqApiKey' | 'openaiApiKey' | 'localBaseUrl' | 'localSttModel' | 'vocabulary'>
  /** The signed-in session's token for Wispra Cloud, or null when signed out. */
  getToken: () => Promise<string | null>
  sttTerms: (vocabulary: string[]) => string[]
  applyReplacements: (text: string) => string
}

/**
 * The Transcribe tab: one audio/video file → its text, through whichever route the user
 * chose on the Account page — Wispra Cloud (signed-in session) or their own key. Never throws.
 */
export async function transcribeFileAt(filePath: string, language: string, deps: TranscribeFileDeps): Promise<FileTranscribeResult> {
  try {
    const { provider, groqApiKey, openaiApiKey, localBaseUrl, localSttModel, vocabulary } = deps.settings()
    let proxyToken: string | undefined
    if (provider === 'proxy') {
      proxyToken = (await deps.getToken()) ?? undefined
      if (!proxyToken) return { ok: false, error: 'Not signed in — sign in on the Account tab to use Wispra Cloud.' }
      if (statSync(filePath).size > CLOUD_FILE_MAX_BYTES) {
        return {
          ok: false,
          error:
            'This file is over 4 MB, the most Wispra Cloud can take in one go. Use a shorter file, or choose "Use my own Groq API key" on the Account tab.'
        }
      }
    }
    const buf = readFileSync(filePath)
    const { text } = await transcribe(
      new Uint8Array(buf),
      provider,
      groqApiKey,
      openaiApiKey,
      language,
      detectMime(filePath),
      localBaseUrl,
      localSttModel,
      // The length of a file is not known here; the server is told nothing rather than a wrong number.
      0,
      proxyToken,
      deps.sttTerms(vocabulary)
    )
    if (!text) return { ok: false, error: 'No speech detected in the file.' }
    return { ok: true, text: deps.applyReplacements(text) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Transcription failed.' }
  }
}
