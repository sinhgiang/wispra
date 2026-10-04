import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { VoiceRecognitionState } from '@shared/types'
import { enrol, matchVoice, MIN_SPEECH_SECONDS, type StoredVoice } from './voiceprintLogic'

// ── Recognising speakers by voice ────────────────────────────────────────────
// On by default (the owner's decision, 2026-10-04); the user can turn it off and see or forget
// every remembered voice on Settings → Learned. A voice is biometric data, so everything stays
// on this computer:
//   • the speaker-embedding model (CAM++ zh+en from 3D-Speaker, Apache-2.0, run with the
//     sherpa-onnx addon, Apache-2.0) is downloaded once, checked against its SHA-256;
//   • remembered voices are vectors of numbers — never audio — in voices.bin, encrypted with
//     the operating system's own store (Electron safeStorage: DPAPI on Windows, the Keychain
//     on macOS); without that encryption the feature does not turn on;
//   • the vectors of each Meeting paragraph are kept, encrypted, next to it
//     (sessions/<id>.bin), so a name given later — typed, or said in the recording — can
//     teach Wispra that voice. They go when the session, the voice list or the feature goes.
// A voice is learned only from a name the user gave or one said in the recording, never
// from a name Wispra itself guessed by voice.

export const MODEL_FILE = '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx'
export const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/${MODEL_FILE}`
export const MODEL_SHA256 = 'aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2'
const SAMPLE_RATE = 16_000

/** The parts of sherpa-onnx-node used here. */
interface SherpaAddon {
  SpeakerEmbeddingExtractor: new (config: { model: string; numThreads?: number; debug?: boolean }) => {
    dim: number
    createStream: () => { acceptWaveform: (w: { sampleRate: number; samples: Float32Array }) => void }
    compute: (stream: unknown, enableExternalBuffer?: boolean) => Float32Array
  }
}

interface SessionVoices {
  vectors: Record<string, number[]>
  /** segment id → the (lower-case) name it was learned as. */
  learned: Record<string, string>
}

export interface VoiceprintDeps {
  /** Folder for the model, the voice list and the paragraph vectors. */
  dir: string
  /** The OS-backed encryption (safeStorage); null when the system offers none. */
  crypto: { encrypt: (plain: string) => Buffer; decrypt: (data: Buffer) => string } | null
  /** Loads sherpa-onnx-node; null when it cannot run here. */
  loadAddon: () => SherpaAddon | null
  /** Downloads `url` and resolves its bytes. */
  download: (url: string) => Promise<Uint8Array>
  enabled: () => boolean
  onChange: () => void
}

export interface Voiceprints {
  state: () => VoiceRecognitionState
  /** Gets the model ready (downloads it the first time). Resolves false when it cannot be used. */
  prepare: () => Promise<boolean>
  /** The voice vector of 16 kHz mono 16-bit PCM, or null (off, not ready, or under MIN_SPEECH_SECONDS). */
  embed: (pcm16: Uint8Array) => number[] | null
  /** Name of the remembered voice this vector clearly belongs to, or null. */
  recognise: (embedding: number[]) => string | null
  /** Keeps a paragraph segment's vector with its session. */
  keepSegment: (sessionId: string, segmentId: string, embedding: number[]) => void
  /** Learns `name` from the kept vectors of these segments. */
  learn: (sessionId: string, segmentIds: string[], name: string) => void
  forget: (id: string) => void
  forgetAll: () => void
  /** The session was deleted. */
  dropSession: (sessionId: string) => void
}

export function createVoiceprints(deps: VoiceprintDeps): Voiceprints {
  const modelPath = join(deps.dir, 'models', MODEL_FILE)
  const libraryPath = join(deps.dir, 'voices.bin')
  const sessionsDir = join(deps.dir, 'sessions')
  let addon: SherpaAddon | null | undefined
  let extractor: InstanceType<SherpaAddon['SpeakerEmbeddingExtractor']> | null = null
  let model: VoiceRecognitionState['model'] = existsSync(modelPath) ? 'ready' : 'missing'
  let modelError: string | undefined
  let preparing: Promise<boolean> | null = null
  let voices: StoredVoice[] | null = null
  /** Per session: each segment's voice vector, and which segments already taught which name. */
  const sessionCache = new Map<string, SessionVoices>()

  const getAddon = (): SherpaAddon | null => {
    if (addon === undefined) {
      try {
        addon = deps.loadAddon()
      } catch {
        addon = null
      }
    }
    return addon
  }

  const readEncrypted = <T>(path: string, fallback: T): T => {
    if (!deps.crypto || !existsSync(path)) return fallback
    try {
      return JSON.parse(deps.crypto.decrypt(readFileSync(path))) as T
    } catch {
      return fallback
    }
  }
  const writeEncrypted = (path: string, value: unknown): void => {
    if (!deps.crypto) return
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(`${path}.tmp`, deps.crypto.encrypt(JSON.stringify(value)))
    renameSync(`${path}.tmp`, path)
  }

  const library = (): StoredVoice[] => (voices ??= readEncrypted<{ voices?: StoredVoice[] }>(libraryPath, {}).voices ?? [])
  const saveLibrary = (next: StoredVoice[]): void => {
    voices = next
    writeEncrypted(libraryPath, { version: 1, voices: next })
    deps.onChange()
  }

  const sessionFile = (id: string): string => join(sessionsDir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.bin`)
  const sessionVoices = (id: string): SessionVoices => {
    let data = sessionCache.get(id)
    if (!data) {
      const read = readEncrypted<Partial<SessionVoices>>(sessionFile(id), {})
      data = { vectors: read.vectors ?? {}, learned: read.learned ?? {} }
      sessionCache.set(id, data)
    }
    return data
  }

  const ready = (): boolean => deps.enabled() && !!deps.crypto && model === 'ready' && !!getAddon()

  return {
    state: () => ({
      enabled: deps.enabled(),
      available: !!getAddon() && !!deps.crypto,
      model,
      ...(modelError ? { error: modelError } : {}),
      voices: library().map(({ id, name, samples, createdAt, updatedAt, lastMatchedAt }) => ({ id, name, samples, createdAt, updatedAt, ...(lastMatchedAt ? { lastMatchedAt } : {}) }))
    }),

    prepare() {
      if (model === 'ready') return Promise.resolve(!!getAddon() && !!deps.crypto)
      preparing ??= (async () => {
        model = 'downloading'
        modelError = undefined
        deps.onChange()
        try {
          const bytes = await deps.download(MODEL_URL)
          const hash = createHash('sha256').update(bytes).digest('hex')
          if (hash !== MODEL_SHA256) throw new Error('The downloaded voice model is not the expected file.')
          mkdirSync(join(modelPath, '..'), { recursive: true })
          writeFileSync(`${modelPath}.tmp`, bytes)
          renameSync(`${modelPath}.tmp`, modelPath)
          model = 'ready'
          return !!getAddon() && !!deps.crypto
        } catch (err) {
          model = 'failed'
          modelError = err instanceof Error ? err.message : 'Could not download the voice model.'
          return false
        } finally {
          preparing = null
          deps.onChange()
        }
      })()
      return preparing
    },

    embed(pcm16) {
      if (!ready() || pcm16.length < MIN_SPEECH_SECONDS * SAMPLE_RATE * 2) return null
      try {
        extractor ??= new (getAddon()!.SpeakerEmbeddingExtractor)({ model: modelPath, numThreads: 1, debug: false })
        const view = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength - (pcm16.byteLength % 2))
        const samples = new Float32Array(view.byteLength / 2)
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768
        const stream = extractor.createStream()
        stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
        // Electron does not allow memory shared with native code ("external buffers"): copy.
        return Array.from(extractor.compute(stream, false), (x) => Math.round(x * 1e5) / 1e5)
      } catch (err) {
        console.error('[voice] could not compute a voice vector:', err)
        return null
      }
    },

    recognise(embedding) {
      if (!ready()) return null
      const match = matchVoice(embedding, library())
      if (!match) return null
      const now = new Date().toISOString()
      // Remembered at most once a day per voice: it is only shown as "last recognised".
      if (!match.voice.lastMatchedAt || Date.parse(now) - Date.parse(match.voice.lastMatchedAt) > 86_400_000) {
        saveLibrary(library().map((v) => (v.id === match.voice.id ? { ...v, lastMatchedAt: now } : v)))
      }
      return match.voice.name
    },

    keepSegment(sessionId, segmentId, embedding) {
      if (!deps.crypto) return
      const data = sessionVoices(sessionId)
      data.vectors[segmentId] = embedding
      writeEncrypted(sessionFile(sessionId), data)
    },

    learn(sessionId, segmentIds, name) {
      if (!deps.enabled() || !deps.crypto || !name.trim()) return
      const data = sessionVoices(sessionId)
      const key = name.trim().toLocaleLowerCase()
      // Each segment teaches a name once: a live outline saved again, or the same rename, adds nothing.
      const fresh = segmentIds.filter((id) => Array.isArray(data.vectors[id]) && data.learned[id] !== key)
      if (fresh.length === 0) return
      for (const id of fresh) data.learned[id] = key
      writeEncrypted(sessionFile(sessionId), data)
      saveLibrary(enrol(library(), name, fresh.map((id) => data.vectors[id]), new Date().toISOString(), randomUUID))
    },

    forget(id) {
      saveLibrary(library().filter((v) => v.id !== id))
    },

    forgetAll() {
      saveLibrary([])
      sessionCache.clear()
      rmSync(sessionsDir, { recursive: true, force: true })
      try {
        if (existsSync(libraryPath)) unlinkSync(libraryPath)
      } catch {
        /* already gone */
      }
      deps.onChange()
    },

    dropSession(sessionId) {
      sessionCache.delete(sessionId)
      try {
        if (existsSync(sessionFile(sessionId))) unlinkSync(sessionFile(sessionId))
      } catch {
        /* already gone */
      }
    }
  }
}

/** Every file this feature keeps, for "Forget all" checks. */
export function listVoiceFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    if (!existsSync(d)) return
    for (const name of readdirSync(d, { withFileTypes: true })) {
      if (name.isDirectory()) walk(join(d, name.name))
      else out.push(join(d, name.name))
    }
  }
  walk(dir)
  return out
}
