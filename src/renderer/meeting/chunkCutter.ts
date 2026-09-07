import { MEETING_HARD_CAP_MS, MEETING_MIN_SPEECH_MS, MEETING_SOFT_CUT_MS, SILENCE_THRESHOLD } from '@shared/constants'

/**
 * Pure decision logic for where to cut a continuous mic stream into chunks.
 * No DOM/MediaRecorder dependency, so it can be unit-tested with synthetic
 * level readings — real speech is not required to verify the cut rules.
 *
 * Rules:
 *  - A level reading above SILENCE_THRESHOLD must hold continuously for at least
 *    MEETING_MIN_SPEECH_MS before it's treated as real speech at all — a single
 *    spurious reading (e.g. faint mic pickup of the computer's own speaker
 *    output) resets instead of accumulating, so it can never by itself force a
 *    chunk to be cut and sent for transcription.
 *  - Nothing is cut until speech has actually been confirmed since the last cut.
 *    A chunk sitting in pure (or only briefly, spuriously interrupted) silence
 *    never fires — this avoids spamming near-empty chunks while nobody is
 *    talking, and is the main defense against transcribing/hallucinating on
 *    audio that was never real speech to begin with.
 *  - Once speech is confirmed: a natural pause (silence for MEETING_SOFT_CUT_MS)
 *    ends the chunk at that pause.
 *  - Safety net: a chunk is force-cut after MEETING_HARD_CAP_MS of speech even
 *    without a pause, so one long monologue can't grow unbounded.
 */
export class ChunkCutter {
  private chunkStartedAt: number
  private speechStartedAt: number | null = null
  private silenceStartedAt: number | null = null
  /** First moment of the current unbroken above-threshold streak — not yet "confirmed" as real speech until it holds for MEETING_MIN_SPEECH_MS. Cleared the instant the level drops back to silence, so brief spikes never carry over into the next streak. */
  private pendingSpeechAt: number | null = null

  constructor(now: number) {
    this.chunkStartedAt = now
  }

  /** Feed one level reading (0..1 RMS, same scale as the existing overlay recorder). Returns true if this reading should end the current chunk. */
  update(level: number, now: number): boolean {
    const isSpeech = level > SILENCE_THRESHOLD

    if (isSpeech) {
      if (this.pendingSpeechAt === null) this.pendingSpeechAt = now
      if (this.speechStartedAt === null && now - this.pendingSpeechAt >= MEETING_MIN_SPEECH_MS) {
        this.speechStartedAt = this.pendingSpeechAt
      }
      this.silenceStartedAt = null
    } else {
      this.pendingSpeechAt = null
      if (this.silenceStartedAt === null) this.silenceStartedAt = now
    }

    if (this.speechStartedAt === null) return false // nothing confirmed yet — still silent (or only briefly, spuriously not) since last cut

    const softCut = this.silenceStartedAt !== null && now - this.silenceStartedAt >= MEETING_SOFT_CUT_MS
    const hardCut = now - this.speechStartedAt >= MEETING_HARD_CAP_MS
    return softCut || hardCut
  }

  /** Call right after `update()` returns true, before feeding the next reading. */
  reset(now: number): void {
    this.chunkStartedAt = now
    this.speechStartedAt = null
    this.silenceStartedAt = null
    this.pendingSpeechAt = null
  }

  get startedAt(): number {
    return this.chunkStartedAt
  }
}
