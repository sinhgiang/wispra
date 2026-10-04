import type { MeetingAudioSource } from '@shared/types'
import { MeetingRecorder, type MeetingChunk } from './recorder'

// ── The one recorder of this window ──────────────────────────────────────────
// Meeting Mode records in the Settings window's renderer, but the Meeting tab (the
// MeetingPanel component) is unmounted whenever another tab is shown and mounted again
// when the user comes back — often in the middle of a recording. The recorder and the
// main process's capture commands (start / pause / resume / stop) therefore live here,
// once per window, not in the component: a component that registered them itself left
// its listeners behind on every unmount, and the next Start ran one recorder per visit
// to the tab — the same audio transcribed two or three times over.
//
// The panel only displays: it subscribes to the level and to resume errors while it is
// mounted, and its subscriptions are removed when it unmounts.

const recorder = new MeetingRecorder()
let installed = false
let audioSource: MeetingAudioSource = 'mic'
const levelListeners = new Set<(level: number) => void>()
const resumeErrorListeners = new Set<(message: string) => void>()

const onLevel = (level: number): void => {
  for (const fn of levelListeners) fn(level)
}

function sendChunk(chunk: MeetingChunk): void {
  void chunk.blob.arrayBuffer().then((buffer) => {
    window.api.meetingChunkCaptured(buffer, {
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      startedAt: chunk.startedAt,
      mimeType: chunk.mimeType,
      voice: chunk.voice
    })
  })
}

function sourceLabel(source: MeetingAudioSource): string {
  return source === 'system' ? 'system audio' : source === 'both' ? 'microphone/system audio' : 'microphone'
}

/** Registers the capture commands once for this window. Safe to call on every mount. */
export function installCaptureHost(): void {
  if (installed) return
  installed = true
  window.api.onMeetingCaptureStart(() => {
    recorder.start(onLevel, sendChunk, audioSource).catch((err: unknown) => {
      recorder.stop()
      const detail = err instanceof Error ? err.message : 'access denied or unavailable'
      window.api.meetingCaptureFailed(`Could not start capture (${sourceLabel(audioSource)}): ${detail}`)
    })
  })
  window.api.onMeetingCapturePause(() => {
    recorder.pause()
    onLevel(0)
  })
  window.api.onMeetingCaptureResume(() => {
    recorder.resume(onLevel, sendChunk).catch(() => {
      // Don't end the whole session over a resume hiccup (e.g. another app briefly
      // holding the mic): back to paused, which the recorder is still consistent with.
      for (const fn of resumeErrorListeners) fn('Could not resume — the microphone may be in use by another app. Try Resume again.')
      window.api.meetingPause()
    })
  })
  window.api.onMeetingCaptureStop(() => {
    recorder.stop()
    onLevel(0)
  })
}

export const captureHost = {
  /** The source the next Start records from (the choice on the Start-recording screen). */
  setAudioSource(source: MeetingAudioSource): void {
    audioSource = source
  },
  /** Switches the source of a recording in progress; rejects when the new source cannot be opened. */
  async switchAudioSource(source: MeetingAudioSource): Promise<void> {
    await recorder.switchAudioSource(source, onLevel, sendChunk)
    audioSource = source
  },
  /** Milliseconds along the recording's active (non-paused) timeline; 0 when not recording. */
  getActiveMs(): number {
    return recorder.getActiveMs()
  },
  /** Number of recorders that are capturing right now: 0 or 1 (read by the automated checks). */
  activeRecorders(): number {
    return recorder.isActive ? 1 : 0
  },
  onLevel(fn: (level: number) => void): () => void {
    levelListeners.add(fn)
    return () => levelListeners.delete(fn)
  },
  onResumeError(fn: (message: string) => void): () => void {
    resumeErrorListeners.add(fn)
    return () => resumeErrorListeners.delete(fn)
  }
}
