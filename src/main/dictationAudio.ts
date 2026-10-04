import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync, ftruncateSync, fstatSync } from 'fs'
import { join } from 'path'
import type { PendingDictation } from '@shared/types'

// ── Dictation audio on disk ──────────────────────────────────────────────────
// Every dictation is written to a WAV file in the app's data folder while it is being
// recorded (the overlay streams 16 kHz mono 16-bit PCM here about once a second), so:
//   • a recording can be as long as the user likes — nothing holds it all in memory;
//   • nothing said is ever lost: the file exists before anything is sent anywhere, and if
//     the transcription fails the file stays, listed as "waiting", until "Try again" turns
//     it into text or the user deletes it. It is removed once its text is saved.
// A file left "recording" when the app quits (crash, power loss) is finished and listed as
// waiting at the next start.

export const DICTATION_SAMPLE_RATE = 16_000
const BYTES_PER_SECOND = DICTATION_SAMPLE_RATE * 2
const HEADER_BYTES = 44
/** Silence kept after the last speech when the end of a recording is trimmed. */
const TRIM_PAD_SECONDS = 0.3
/** RMS (0..1) below which a 20 ms window counts as silence for trimming. */
const TRIM_SILENCE_RMS = 0.01
/** The end is searched for speech at most this far back; never more than 90% is trimmed. */
const TRIM_SEARCH_SECONDS = 120

function header(dataBytes: number): Buffer {
  const b = Buffer.alloc(HEADER_BYTES)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + dataBytes, 4)
  b.write('WAVE', 8)
  b.write('fmt ', 12)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(DICTATION_SAMPLE_RATE, 24)
  b.writeUInt32LE(BYTES_PER_SECOND, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(dataBytes, 40)
  return b
}

/** Where the last speech ends in the PCM of `fd` (bytes after the header), searching back from the end. */
function speechEnd(fd: number, dataBytes: number): number {
  const window = Math.round(DICTATION_SAMPLE_RATE * 0.02) * 2
  const searchBytes = Math.min(dataBytes, TRIM_SEARCH_SECONDS * BYTES_PER_SECOND)
  const start = dataBytes - searchBytes
  const buf = Buffer.alloc(searchBytes)
  readSync(fd, buf, 0, searchBytes, HEADER_BYTES + start)
  for (let end = searchBytes; end - window >= 0; end -= window) {
    let sum = 0
    for (let i = end - window; i < end; i += 2) {
      const s = buf.readInt16LE(i) / 32768
      sum += s * s
    }
    if (Math.sqrt(sum / (window / 2)) > TRIM_SILENCE_RMS) {
      return Math.min(dataBytes, start + end + Math.round(TRIM_PAD_SECONDS * BYTES_PER_SECOND / 2) * 2)
    }
  }
  return start === 0 ? dataBytes : start // all silent at the end of a long file: keep up to the search window
}

export interface DictationAudio {
  /** Starts a new recording file; returns its id. Finishes any recording still open. */
  begin: () => string
  /** Appends 16-bit PCM to the open recording. */
  append: (pcm: Uint8Array) => void
  /**
   * Closes the open recording: trims the silence after the last speech (Whisper invents text
   * on trailing silence) and writes the final WAV header. Null when nothing was recorded.
   */
  finish: () => { id: string; path: string; seconds: number } | null
  read: (id: string) => Uint8Array
  /** The recording could not be turned into text: keep it, listed as waiting, with why. */
  markFailed: (id: string, error: string) => void
  /** Its text is saved (or the user deleted it): the file goes. */
  remove: (id: string) => void
  pending: () => PendingDictation[]
  /** Finishes recordings left open by a previous run and lists them as waiting. Call once at startup. */
  recover: () => void
}

export function createDictationAudio(dir: string, onChange?: () => void): DictationAudio {
  let open: { id: string; fd: number; bytes: number } | null = null
  const listFile = join(dir, 'pending.json')
  const fileOf = (id: string): string => join(dir, `${id}.wav`)

  const readList = (): PendingDictation[] => {
    try {
      const list = JSON.parse(readFileSync(listFile, 'utf8')) as PendingDictation[]
      return Array.isArray(list) ? list.filter((p) => existsSync(fileOf(p.id))) : []
    } catch {
      return []
    }
  }
  const writeList = (list: PendingDictation[]): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${listFile}.tmp`, JSON.stringify(list, null, 2))
    renameSync(`${listFile}.tmp`, listFile)
    onChange?.()
  }

  function close(trim: boolean): { id: string; path: string; seconds: number } | null {
    if (!open) return null
    const { id, fd } = open
    open = null
    let dataBytes = fstatSync(fd).size - HEADER_BYTES
    dataBytes -= dataBytes % 2
    if (dataBytes <= 0) {
      closeSync(fd)
      unlinkSync(fileOf(id))
      return null
    }
    if (trim) {
      const end = Math.max(speechEnd(fd, dataBytes), Math.ceil((dataBytes * 0.1) / 2) * 2)
      if (end < dataBytes) dataBytes = end
    }
    ftruncateSync(fd, HEADER_BYTES + dataBytes)
    writeSync(fd, header(dataBytes), 0, HEADER_BYTES, 0)
    closeSync(fd)
    return { id, path: fileOf(id), seconds: dataBytes / BYTES_PER_SECOND }
  }

  return {
    begin() {
      close(false)
      mkdirSync(dir, { recursive: true })
      let id = String(Date.now())
      while (existsSync(fileOf(id))) id = String(Number(id) + 1)
      const fd = openSync(fileOf(id), 'w+')
      writeSync(fd, header(0), 0, HEADER_BYTES, 0)
      open = { id, fd, bytes: 0 }
      return id
    },

    append(pcm) {
      if (!open || pcm.length === 0) return
      writeSync(open.fd, pcm, 0, pcm.length - (pcm.length % 2), HEADER_BYTES + open.bytes)
      open.bytes += pcm.length - (pcm.length % 2)
    },

    finish: () => close(true),

    read: (id) => new Uint8Array(readFileSync(fileOf(id))),

    markFailed(id, error) {
      if (!existsSync(fileOf(id))) return
      const seconds = Math.max(0, (statSync(fileOf(id)).size - HEADER_BYTES) / BYTES_PER_SECOND)
      const list = readList().filter((p) => p.id !== id)
      list.unshift({ id, createdAt: new Date(Number(id) || Date.now()).toISOString(), seconds, error })
      writeList(list)
    },

    remove(id) {
      try {
        if (existsSync(fileOf(id))) unlinkSync(fileOf(id))
      } catch {
        /* already gone */
      }
      const list = readList()
      if (list.some((p) => p.id === id)) writeList(list.filter((p) => p.id !== id))
    },

    pending: readList,

    recover() {
      let files: string[] = []
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.wav'))
      } catch {
        return
      }
      const listed = new Set(readList().map((p) => p.id))
      for (const file of files) {
        const id = file.slice(0, -4)
        if (listed.has(id)) continue
        // Left open by a run that ended mid-recording: give it a proper header and list it.
        try {
          const fd = openSync(fileOf(id), 'r+')
          open = { id, fd, bytes: Math.max(0, fstatSync(fd).size - HEADER_BYTES) }
          const done = close(false)
          if (done) this.markFailed(id, 'Wispra was closed before this recording was transcribed.')
        } catch {
          /* unreadable: leave it */
        }
      }
    }
  }
}
