// ── Cutting a long WAV dictation into parts small enough to upload ───────────
// Dictation audio is 16 kHz mono 16-bit WAV (see encodeWav in the overlay's recorder.ts),
// 32 KB per second. Wispra Cloud runs on Vercel, which refuses a request body over 4.5 MB
// (HTTP 413 FUNCTION_PAYLOAD_TOO_LARGE) before Wispra's own code even sees it — about
// 2 min 20 s of speech. A longer dictation is therefore sent in parts and the texts are
// joined. Each cut is made at the quietest moment shortly before the size limit, so a word
// is not split in two. Pure: no Electron, no network.

export interface WavFormat {
  sampleRate: number
  channels: number
  bitsPerSample: number
  /** Byte offset and length of the PCM samples (the "data" chunk). */
  dataOffset: number
  dataLength: number
}

export interface WavPart {
  audio: Uint8Array
  /** Length of this part's audio, in seconds. */
  seconds: number
}

/** How far back from the size limit a cut may move to find a pause. */
const SEARCH_BACK_SECONDS = 10
/** Length of the windows compared when looking for the quietest moment. */
const PAUSE_WINDOW_SECONDS = 0.05

/** Reads a RIFF/WAVE header; null for anything that is not uncompressed PCM WAV. */
export function parseWav(bytes: Uint8Array): WavFormat | null {
  if (bytes.length < 12) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let format: Omit<WavFormat, 'dataOffset' | 'dataLength'> | null = null
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      if (view.getUint16(body, true) !== 1) return null // not PCM
      format = { channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bitsPerSample: view.getUint16(body + 14, true) }
    } else if (id === 'data') {
      if (!format || format.channels < 1 || format.sampleRate < 1 || format.bitsPerSample % 8 !== 0) return null
      return { ...format, dataOffset: body, dataLength: Math.min(size, bytes.length - body) }
    }
    offset = body + size + (size % 2)
  }
  return null
}

/** A standard 44-byte header followed by `pcm`. */
function wavFile(format: WavFormat, pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.length)
  const view = new DataView(out.buffer)
  const write = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i)
  }
  const blockAlign = (format.channels * format.bitsPerSample) / 8
  write(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, format.channels, true)
  view.setUint32(24, format.sampleRate, true)
  view.setUint32(28, format.sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, format.bitsPerSample, true)
  write(36, 'data')
  view.setUint32(40, pcm.length, true)
  out.set(pcm, 44)
  return out
}

/**
 * The frame (from `from` up to `to`) where the quietest window starts. Only 16-bit PCM is
 * measured; other sample sizes are cut at `to`.
 */
function quietestFrame(pcm: Uint8Array, format: WavFormat, from: number, to: number): number {
  if (format.bitsPerSample !== 16 || to - from <= 0) return to
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const frameBytes = format.channels * 2
  const window = Math.max(1, Math.round(format.sampleRate * PAUSE_WINDOW_SECONDS))
  let best = to
  let bestEnergy = Infinity
  // Latest windows first, so of two equally quiet moments the later one (the bigger part) wins.
  for (let start = to - window; start >= from; start -= window) {
    let energy = 0
    for (let frame = start; frame < start + window; frame++) {
      const sample = view.getInt16(frame * frameBytes, true)
      energy += sample * sample
    }
    if (energy < bestEnergy) {
      bestEnergy = energy
      best = start + Math.floor(window / 2)
    }
  }
  return best
}

/**
 * Cuts a WAV into parts of at most `maxBytes` each (header included), at pauses. Returns
 * the audio as a single part when it already fits, and null when it is not a WAV this can
 * cut (then the caller says the recording is too long instead of sending it).
 */
export function splitWav(bytes: Uint8Array, maxBytes: number): WavPart[] | null {
  const format = parseWav(bytes)
  if (!format) return bytes.length <= maxBytes ? [{ audio: bytes, seconds: 0 }] : null
  const frameBytes = (format.channels * format.bitsPerSample) / 8
  const pcm = bytes.subarray(format.dataOffset, format.dataOffset + format.dataLength - (format.dataLength % frameBytes))
  const totalFrames = pcm.length / frameBytes
  const seconds = (frames: number): number => frames / format.sampleRate
  if (bytes.length <= maxBytes) return [{ audio: bytes, seconds: seconds(totalFrames) }]

  const maxFrames = Math.floor((maxBytes - 44) / frameBytes)
  if (maxFrames < format.sampleRate) return null // under a second per part: something is off
  const searchFrames = Math.min(Math.floor(maxFrames / 2), Math.round(format.sampleRate * SEARCH_BACK_SECONDS))
  const parts: WavPart[] = []
  for (let start = 0; start < totalFrames; ) {
    let end = Math.min(totalFrames, start + maxFrames)
    if (end < totalFrames) end = quietestFrame(pcm, format, end - searchFrames, end)
    parts.push({ audio: wavFile(format, pcm.subarray(start * frameBytes, end * frameBytes)), seconds: seconds(end - start) })
    start = end
  }
  return parts
}
