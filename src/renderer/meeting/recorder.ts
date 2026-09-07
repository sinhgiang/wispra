import type { MeetingAudioSource } from '@shared/types'
import { ChunkCutter } from './chunkCutter'

export interface MeetingChunk {
  blob: Blob
  mimeType: string
  /** Milliseconds along the session's active (non-paused) timeline. */
  startMs: number
  endMs: number
  /** ISO wall-clock timestamp when this chunk's audio started recording. */
  startedAt: string
}

/**
 * Level sampling / chunk-cut-decision tick rate. A meeting can run for hours while
 * the user works in another app (window minimized/occluded/unfocused), so this loop
 * uses setInterval rather than requestAnimationFrame: rAF is tied to actually painting
 * a frame and can stop firing entirely once there's nothing to composite, whereas
 * setInterval keeps running (see also the `backgroundThrottling: false` webPreference
 * on the meeting window, which stops Chromium from throttling it down further).
 */
const LEVEL_TICK_MS = 100

/**
 * Continuous audio capture for Meeting Mode (mic, system audio, or both — see
 * `audioSource` below), split into silence/hard-cap-bounded chunks with zero
 * gaps: a fresh MediaRecorder is started on the same live stream an instant
 * before the previous one is stopped (the "ping-pong" technique), so no audio
 * between two chunks is ever missed.
 *
 * Cut timing decisions come from ChunkCutter (chunkCutter.ts) — pure logic,
 * unit-tested separately. This class only owns the DOM/MediaRecorder wiring.
 *
 * pause()/resume() release and re-acquire the mic (so the OS mic indicator
 * correctly turns off while paused) but keep the same session timeline: all
 * startMs/endMs values are measured along activeMs(), which excludes any time
 * spent paused, so chunk-cut and hard-cap timing stay correct across a pause.
 *
 * `audioSource` ('mic' | 'system' | 'both', chosen on the Start-recording screen)
 * decides which stream(s) feed everything below. 'system' and 'both' capture
 * desktop/loopback audio via getDisplayMedia() (see acquireSystemStream) instead
 * of a new npm dependency — main/index.ts's setDisplayMediaRequestHandler grants
 * it automatically with no OS picker. 'both' mixes mic + system into one combined
 * MediaStream via the Web Audio API (acquireMixedStream) so the rest of this
 * class (ping-pong MediaRecorder, level analyser) can keep treating `this.stream`
 * as a single ordinary stream, unmodified.
 */
export class MeetingRecorder {
  private stream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private active: MediaRecorder | null = null
  private mimeType = ''
  private intervalId: ReturnType<typeof setInterval> | null = null
  private cutter: ChunkCutter | null = null
  private sessionStartedAt = 0
  /** Total milliseconds spent paused so far (completed pauses only). */
  private pausedAccumMs = 0
  private pauseStartedAt = 0
  private paused = false
  private onChunk: ((chunk: MeetingChunk) => void) | null = null
  private running = false
  private audioSource: MeetingAudioSource = 'mic'
  /**
   * Raw streams acquired for the current segment beyond `this.stream` itself —
   * populated only in 'both' mode, where `this.stream` is a synthetic mixed-down
   * stream from `mixContext` and stopping its tracks does NOT stop the original
   * mic/system tracks feeding into it. Always stopped alongside `this.stream` in
   * releaseCapture() so the mic/screen-capture indicators actually turn off.
   */
  private sourceStreams: MediaStream[] = []
  /** AudioContext used only to mix mic+system into one stream in 'both' mode — separate from the one monitorLevel() creates for the analyser. */
  private mixContext: AudioContext | null = null

  get isActive(): boolean {
    return this.running
  }

  get isPaused(): boolean {
    return this.paused
  }

  /** Milliseconds along the session's active (non-paused) timeline, right now — 0 if not running. Drives the UI's elapsed timer, correctly frozen across a pause. */
  getActiveMs(): number {
    return this.running ? this.activeMs() : 0
  }

  /** Milliseconds along the session's active (non-paused) timeline, right now. */
  private activeMs(): number {
    return Date.now() - this.sessionStartedAt - this.pausedAccumMs
  }

  /** Starts continuous capture. `onLevel` drives the live waveform UI; `onChunk` fires once per cut segment. */
  async start(
    onLevel: (level: number) => void,
    onChunk: (chunk: MeetingChunk) => void,
    audioSource: MeetingAudioSource = 'mic'
  ): Promise<void> {
    if (this.running) return
    this.audioSource = audioSource
    this.stream = await this.acquireStream()
    this.onChunk = onChunk
    this.sessionStartedAt = Date.now()
    this.pausedAccumMs = 0
    this.paused = false
    const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
    this.mimeType = preferred.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
    this.cutter = new ChunkCutter(0)
    this.running = true
    this.beginSegment(0)
    this.monitorLevel(onLevel)
  }

  /**
   * Ends the in-flight segment and releases the mic/system stream(s), but keeps
   * the session timeline alive so resume() can continue it. Distinct from stop():
   * the session is not finalized and the cutter keeps its instance (just reset).
   */
  pause(): void {
    if (!this.running || this.paused) return
    this.paused = true
    this.pauseStartedAt = Date.now()
    this.releaseCapture()
    this.cutter?.reset(this.activeMs())
  }

  /**
   * Re-acquires the same audioSource picked at start() and starts a fresh
   * segment, continuing the same session timeline. Left in `paused` (with
   * `pausedAccumMs` untouched) if acquisition fails — e.g. another app is still
   * holding the mic right after pause() released it — so the caller can fall
   * back to the paused UI and let the user retry, instead of losing the session.
   */
  async resume(onLevel: (level: number) => void, onChunk: (chunk: MeetingChunk) => void): Promise<void> {
    if (!this.running || !this.paused) return
    const stream = await this.acquireStream()
    this.pausedAccumMs += Date.now() - this.pauseStartedAt
    this.paused = false
    this.stream = stream
    this.onChunk = onChunk
    this.beginSegment(this.activeMs())
    this.monitorLevel(onLevel)
  }

  /**
   * Switches the active audio source mid-recording without ending the session
   * — e.g. flip from "System audio only" to "Both" partway through a call.
   * Uses the same zero-gap "ping-pong" handoff as a natural silence-driven cut
   * (cutSegment): the new stream + MediaRecorder are stood up before the old
   * ones are torn down, so no audio is dropped at the switch boundary itself
   * (re-granting getUserMedia/getDisplayMedia for the new source can still
   * take a brief real moment, unlike a same-stream cut). On failure, every
   * field touched is restored to its pre-switch value so the still-running
   * old capture — and the next stop()/pause() cleanup — stay fully consistent;
   * the caller decides how to surface the error. No-ops if `newSource` already
   * matches the current source, or the recorder isn't running or is paused
   * (the picker's next resume() already re-applies whatever `audioSource` is
   * set to, so switching mid-pause isn't needed).
   */
  async switchAudioSource(
    newSource: MeetingAudioSource,
    onLevel: (level: number) => void,
    onChunk: (chunk: MeetingChunk) => void
  ): Promise<void> {
    if (!this.running || this.paused || newSource === this.audioSource) return
    const previousSource = this.audioSource
    const now = this.activeMs()
    const oldStream = this.stream
    const oldSourceStreams = this.sourceStreams
    const oldMixContext = this.mixContext
    const oldRecorder = this.active
    const oldAudioContext = this.audioContext
    const oldIntervalId = this.intervalId

    this.audioSource = newSource
    let newStream: MediaStream
    try {
      newStream = await this.acquireStream()
    } catch (err) {
      // Nothing below was touched yet — restore state exactly so the still-running
      // old capture (and stop()/pause() cleanup later) stay fully consistent.
      this.audioSource = previousSource
      this.sourceStreams = oldSourceStreams
      throw err
    }

    this.stream = newStream
    this.onChunk = onChunk
    this.beginSegment(now)

    if (oldIntervalId !== null) clearInterval(oldIntervalId)
    if (oldRecorder && oldRecorder.state !== 'inactive') oldRecorder.stop()
    oldStream?.getTracks().forEach((t) => t.stop())
    oldSourceStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
    void oldMixContext?.close()
    void oldAudioContext?.close()

    this.monitorLevel(onLevel)
  }

  /** Acquires whichever stream(s) `this.audioSource` calls for, always resetting `sourceStreams` first so a failed/retried acquisition never leaks a stale reference. */
  private async acquireStream(): Promise<MediaStream> {
    this.sourceStreams = []
    if (this.audioSource === 'system') return this.acquireSystemStream()
    if (this.audioSource === 'both') return this.acquireMixedStream()
    return this.acquireMicStream()
  }

  /**
   * getUserMedia with one short retry — right after pause() releases the mic, another
   * app that was waiting on it (or the OS audio session tearing down) can momentarily
   * hold onto the device, failing the very next acquisition even though the mic is
   * genuinely free an instant later. echoCancellation/autoGainControl/noiseSuppression
   * are the standard browser-side cleanup Chromium can do here, but a mic that
   * physically hears sound coming out of this same computer's speakers (rather than
   * headphones) can only be partially cancelled this way — true isolation from
   * computer audio needs headphones, so the speaker output never reaches the mic in
   * the first place (see the audio-source picker's hint text).
   */
  private async acquireMicStream(): Promise<MediaStream> {
    const constraints = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints)
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
      stream = await navigator.mediaDevices.getUserMedia(constraints)
    }
    this.sourceStreams.push(stream)
    return stream
  }

  /**
   * System/desktop ("what's playing on this computer") audio, via Chromium's
   * getDisplayMedia() loopback capture — no new npm dependency needed. The main
   * process's setDisplayMediaRequestHandler (index.ts) auto-grants this with no
   * interactive "choose what to share" dialog, since there's nothing to pick: we
   * always want the whole desktop's audio. getDisplayMedia forces a video track
   * along with the audio one — it's stopped immediately and never touched again,
   * only the audio track is kept. Loopback audio capture is currently reliable
   * on Windows only (Electron/Chromium limitation); on unsupported platforms the
   * resulting stream has no audio track, so this throws a clear error instead of
   * silently recording nothing.
   */
  private async acquireSystemStream(): Promise<MediaStream> {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    display.getVideoTracks().forEach((t) => t.stop())
    const audioOnly = new MediaStream(display.getAudioTracks())
    if (audioOnly.getAudioTracks().length === 0) {
      audioOnly.getTracks().forEach((t) => t.stop())
      throw new Error('System audio capture returned no audio track — loopback capture may not be supported on this OS.')
    }
    this.sourceStreams.push(audioOnly)
    return audioOnly
  }

  /**
   * Mixes mic + system audio into one combined stream via the Web Audio API, so
   * the rest of this class can still treat capture as a single MediaStream. If
   * system-audio acquisition fails after the mic was already granted, the mic
   * stream is released before the error propagates so a failed 'both' start
   * never leaves the mic indicator on.
   */
  private async acquireMixedStream(): Promise<MediaStream> {
    const mic = await this.acquireMicStream()
    try {
      const system = await this.acquireSystemStream()
      this.mixContext = new AudioContext()
      const dest = this.mixContext.createMediaStreamDestination()
      // acquireMicStream() turns on autoGainControl, which continuously boosts the
      // mic's own level — system loopback audio has no equivalent AGC, so without
      // rebalancing here the mic ends up dominating the mixed-down stream Whisper
      // actually transcribes and 'both' mode behaves just like mic-only. A fixed
      // gain boost on the system leg (tuned by ear, since loopback audio has no
      // comparable auto-leveling to match against) restores both sources to
      // comparable perceived loudness. Mic-only and system-only capture don't go
      // through this path at all, so neither is affected.
      const micGain = this.mixContext.createGain()
      micGain.gain.value = 1
      const systemGain = this.mixContext.createGain()
      systemGain.gain.value = 2.5
      this.mixContext.createMediaStreamSource(mic).connect(micGain).connect(dest)
      this.mixContext.createMediaStreamSource(system).connect(systemGain).connect(dest)
      return dest.stream
    } catch (err) {
      mic.getTracks().forEach((t) => t.stop())
      this.sourceStreams = this.sourceStreams.filter((s) => s !== mic)
      throw err
    }
  }

  /** Stops capture and flushes the final (possibly partial) chunk. */
  stop(): void {
    if (!this.running) return
    this.running = false
    this.paused = false
    this.releaseCapture()
    this.cutter = null
  }

  /** Stops the active MediaRecorder + level-monitor loop and releases every acquired stream (mic/system/mixed). Safe to call while already released (e.g. stop() right after pause()). */
  private releaseCapture(): void {
    if (this.intervalId !== null) clearInterval(this.intervalId)
    this.intervalId = null
    const rec = this.active
    this.active = null
    if (rec && rec.state !== 'inactive') rec.stop()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    // In 'both' mode this.stream is a synthetic mixed-down stream — stopping its
    // tracks doesn't release the underlying mic/system tracks feeding into it, so
    // those are stopped here too (a no-op double-stop in 'mic'/'system' mode,
    // where this.stream IS the one entry in sourceStreams).
    this.sourceStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
    this.sourceStreams = []
    void this.mixContext?.close()
    this.mixContext = null
    void this.audioContext?.close()
    this.audioContext = null
  }

  private beginSegment(startMs: number): void {
    if (!this.stream) return
    const startedAt = new Date().toISOString()
    const rec = new MediaRecorder(this.stream, this.mimeType ? { mimeType: this.mimeType } : {})
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType || this.mimeType || 'audio/webm' })
      const endMs = this.activeMs()
      this.onChunk?.({ blob, mimeType: blob.type, startMs, endMs, startedAt })
    }
    rec.start()
    this.active = rec
  }

  /** Zero-gap handoff: start the next segment before stopping the current one. */
  private cutSegment(now: number): void {
    if (!this.running) return
    const finishing = this.active
    this.beginSegment(now)
    if (finishing && finishing.state !== 'inactive') finishing.stop()
  }

  private monitorLevel(onLevel: (level: number) => void): void {
    if (!this.stream) return
    this.audioContext = new AudioContext()
    const source = this.audioContext.createMediaStreamSource(this.stream)
    const analyser = this.audioContext.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)

    const tick = (): void => {
      if (!this.running || !this.cutter) return
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128
        sum += v * v
      }
      const now = this.activeMs()
      const level = Math.min(1, Math.sqrt(sum / data.length) * 3)
      onLevel(level)
      if (this.cutter.update(level, now)) {
        this.cutter.reset(now)
        this.cutSegment(now)
      }
    }
    this.intervalId = setInterval(tick, LEVEL_TICK_MS)
  }
}
