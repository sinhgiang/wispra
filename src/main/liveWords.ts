import { createHash } from 'crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

// ── Live words in Meeting ────────────────────────────────────────────────────
// Grey, provisional words shown within about a second of being spoken, until Groq's text for
// that stretch arrives and replaces them (Groq's free tier cannot do this itself: 20
// requests a minute, each billed as at least 10 s — see docs/research/live-words-vi.md).
//
// Runs on this computer, free: the sherpa-onnx addon (already used for speaker recognition)
// with the Vietnamese Zipformer transducer `sherpa-onnx-zipformer-vi-int8-2025-04-20`
// (Apache-2.0, ~77 MB, downloaded once and SHA-256 checked). The model is not a streaming
// one, so the stretch spoken since the recorder's last cut is decoded again and again as it
// grows ("simulated streaming", as sherpa-onnx documents it), at a pace that follows how long
// a decode takes, so it never keeps the main process busy. Vietnamese only: with the spoken
// language set to another one, nothing is shown.

export const LIVE_MODEL_BASE = 'https://huggingface.co/csukuangfj/sherpa-onnx-zipformer-vi-int8-2025-04-20/resolve/main'
export const LIVE_MODEL_FILES: Array<{ name: string; sha256: string }> = [
  { name: 'encoder-epoch-12-avg-8.int8.onnx', sha256: 'b3abdef7a660fea7faf5e076b3c7613b0fc98406707103784d018189bb522124' },
  { name: 'decoder-epoch-12-avg-8.onnx', sha256: 'd1d27cca84c824a8acf5ce6edf0f2c0880cfe295d2e69b95134de1707e1d9998' },
  { name: 'joiner-epoch-12-avg-8.int8.onnx', sha256: '38ec49e1c18e4feb0cad4de13e25c83a866cf56f4a66f22e8ff579d591a69a46' },
  { name: 'tokens.txt', sha256: 'f536d03c2e95ebd2930cf0abec88e823bd17d3c1933da7ae6a82db3b80605e15' }
]

const SAMPLE_RATE = 16_000
/** Decode again once this much new audio arrived… */
const MIN_NEW_SAMPLES = SAMPLE_RATE / 4
/** …and at most this often — or every 2× the last decode's time, if that is longer. */
const MIN_INTERVAL_MS = 250
/** The stretch decoded is capped (a chunk is at most 20 s; this is a safety net). */
const MAX_SECONDS = 30
/**
 * Once the part not yet settled is longer than this, its beginning — up to a pause — is
 * decoded one last time and its words kept, so every later decode only covers the tail and
 * stays quick however long someone speaks without a break.
 */
const SETTLE_AFTER_SAMPLES = 6 * SAMPLE_RATE
/** What stays unsettled after settling: at least this much of the end. */
const KEEP_TAIL_SAMPLES = 1.5 * SAMPLE_RATE

interface SherpaAsr {
  OfflineRecognizer: new (config: unknown) => {
    createStream: () => { acceptWaveform: (w: { sampleRate: number; samples: Float32Array }) => void }
    decode: (stream: unknown) => void
    getResult: (stream: unknown) => { text: string }
  }
}

export interface LiveWordsDeps {
  dir: string
  loadAddon: () => SherpaAsr | null
  download: (url: string) => Promise<Uint8Array>
  /** Live words are on and the recording's spoken language allows them. */
  active: () => boolean
  /** The current provisional text of the stretch that began at `fromMs` ('' clears it). */
  onWords: (fromMs: number, text: string) => void
  now?: () => number
  /** For the checks: told when a decode finishes, with how many seconds of the stretch it covered. */
  onDecoded?: (seconds: number) => void
}

export interface LiveWords {
  /** Downloads the model the first time. Resolves whether live words can run. */
  prepare: () => Promise<boolean>
  ready: () => boolean
  /** The recorder cut a chunk at `atMs`: what follows is a new stretch. */
  cut: (atMs: number) => void
  /** 16 kHz mono 16-bit PCM ending at `atMs`. */
  push: (pcm: Uint8Array, atMs: number) => void
  /** The recording ended or was paused: forget the stretch. */
  reset: () => void
  /** For the checks: how long the last decode took (ms). */
  lastDecodeMs: () => number
}

/** The model's text as words to show: "NHỮNG NƠI ĐÃ" → "những nơi đã". */
export function displayText(raw: string): string {
  return raw.trim().toLocaleLowerCase('vi').replace(/\s+/g, ' ')
}

export function createLiveWords(deps: LiveWordsDeps): LiveWords {
  const now = deps.now ?? Date.now
  const modelDir = join(deps.dir, 'live-words')
  const has = (): boolean => LIVE_MODEL_FILES.every((f) => existsSync(join(modelDir, f.name)))
  let recognizer: InstanceType<SherpaAsr['OfflineRecognizer']> | null = null
  let preparing: Promise<boolean> | null = null
  let addonOk: boolean | undefined
  let fromMs = 0
  let buffer = new Float32Array(0)
  let decodedSamples = 0
  let lastDecodeAt = 0
  let decodeMs = 0
  let shown = ''
  /** Words of the settled beginning of the stretch (see SETTLE_AFTER_SAMPLES). */
  let settled = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  const addon = (): SherpaAsr | null => {
    try {
      const a = deps.loadAddon()
      addonOk = !!a
      return a
    } catch {
      addonOk = false
      return null
    }
  }

  const getRecognizer = (): InstanceType<SherpaAsr['OfflineRecognizer']> | null => {
    if (recognizer) return recognizer
    const a = addon()
    if (!a || !has()) return null
    const file = (name: string): string => join(modelDir, name)
    recognizer = new a.OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: file(LIVE_MODEL_FILES[0].name), decoder: file(LIVE_MODEL_FILES[1].name), joiner: file(LIVE_MODEL_FILES[2].name) },
        tokens: file(LIVE_MODEL_FILES[3].name),
        numThreads: 2,
        provider: 'cpu',
        debug: 0
      }
    })
    return recognizer
  }

  const show = (text: string): void => {
    if (text === shown) return
    shown = text
    deps.onWords(fromMs, text)
  }

  const recognise = (rec: InstanceType<SherpaAsr['OfflineRecognizer']>, samples: Float32Array): string => {
    const stream = rec.createStream()
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
    rec.decode(stream)
    return displayText(rec.getResult(stream).text)
  }

  /** The quietest 50 ms in the unsettled audio that leaves at least KEEP_TAIL_SAMPLES after it. */
  const pauseToSettleAt = (): number => {
    const win = SAMPLE_RATE / 20
    let best = buffer.length - KEEP_TAIL_SAMPLES
    let bestEnergy = Infinity
    for (let start = Math.floor(buffer.length - KEEP_TAIL_SAMPLES - win); start >= SAMPLE_RATE * 2; start -= win) {
      let e = 0
      for (let i = start; i < start + win; i++) e += buffer[i] * buffer[i]
      if (e < bestEnergy) {
        bestEnergy = e
        best = start + win / 2
      }
    }
    return Math.floor(best)
  }

  const decode = (): void => {
    timer = null
    if (!deps.active() || buffer.length === 0) return
    const rec = getRecognizer()
    if (!rec) return
    const started = now()
    try {
      if (buffer.length > SETTLE_AFTER_SAMPLES) {
        const at = pauseToSettleAt()
        settled = [settled, recognise(rec, buffer.subarray(0, at))].filter(Boolean).join(' ')
        buffer = buffer.slice(at)
      }
      show([settled, recognise(rec, buffer)].filter(Boolean).join(' '))
    } catch (err) {
      console.error('[meeting] live words could not decode:', err)
    }
    decodedSamples = buffer.length
    decodeMs = now() - started
    lastDecodeAt = now()
    deps.onDecoded?.(buffer.length / SAMPLE_RATE)
    schedule()
  }

  function schedule(): void {
    if (timer || buffer.length - decodedSamples < MIN_NEW_SAMPLES) return
    const wait = Math.max(0, lastDecodeAt + Math.max(MIN_INTERVAL_MS, decodeMs * 2) - now())
    timer = setTimeout(decode, wait)
  }

  return {
    prepare() {
      // Loading the model takes about a second and a half: done here (when a recording starts),
      // not on the first words, so they show at once.
      if (has()) return Promise.resolve(getRecognizer() !== null)
      preparing ??= (async () => {
        try {
          mkdirSync(modelDir, { recursive: true })
          for (const f of LIVE_MODEL_FILES) {
            const target = join(modelDir, f.name)
            if (existsSync(target)) continue
            const bytes = await deps.download(`${LIVE_MODEL_BASE}/${f.name}`)
            if (createHash('sha256').update(bytes).digest('hex') !== f.sha256) throw new Error(`${f.name} is not the expected file`)
            writeFileSync(`${target}.tmp`, bytes)
            renameSync(`${target}.tmp`, target)
          }
          return getRecognizer() !== null
        } catch (err) {
          console.error('[meeting] could not get the live-words model:', err)
          return false
        } finally {
          preparing = null
        }
      })()
      return preparing
    },

    ready: () => has() && addonOk !== false,

    cut(atMs) {
      if (timer) clearTimeout(timer)
      timer = null
      // The finished stretch stays on screen (as `fromMs`) until Groq's text replaces it.
      fromMs = atMs
      buffer = new Float32Array(0)
      decodedSamples = 0
      shown = ''
      settled = ''
    },

    push(pcm, atMs) {
      if (!deps.active() || pcm.length < 2) return
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2))
      const samples = new Float32Array(view.byteLength / 2)
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768
      void atMs
      const joined = new Float32Array(buffer.length + samples.length)
      joined.set(buffer, 0)
      joined.set(samples, buffer.length)
      // Only the last MAX_SECONDS are decoded (a safety net: the recorder cuts chunks at 20 s).
      buffer = joined.length > MAX_SECONDS * SAMPLE_RATE ? joined.slice(joined.length - MAX_SECONDS * SAMPLE_RATE) : joined
      decodedSamples = Math.min(decodedSamples, buffer.length)
      schedule()
    },

    reset() {
      if (timer) clearTimeout(timer)
      timer = null
      buffer = new Float32Array(0)
      decodedSamples = 0
      shown = ''
      settled = ''
      fromMs = 0
    },

    lastDecodeMs: () => decodeMs
  }
}
