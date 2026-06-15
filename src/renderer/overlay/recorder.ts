/**
 * Microphone capture for the overlay. One recording at a time;
 * the mic and AudioContext are released the moment recording stops.
 */
export class Recorder {
  private mediaRecorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private chunks: Blob[] = []
  private startedAt = 0
  private rafId = 0
  private mimeType = ''
  private stopping = false

  get isActive(): boolean {
    return this.mediaRecorder !== null
  }

  /** Starts capturing; `onLevel` receives 0..1 mic levels for the UI. */
  async start(onLevel: (level: number) => void): Promise<void> {
    if (this.isActive) return
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    })
    this.chunks = []
    this.startedAt = Date.now()
    const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
    this.mimeType = preferred.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
    this.mediaRecorder = new MediaRecorder(this.stream, this.mimeType ? { mimeType: this.mimeType } : {})
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }
    this.mediaRecorder.start(250)
    this.monitorLevel(onLevel)
  }

  /** Stops and resolves with WAV audio (universally accepted by STT APIs). */
  stop(): Promise<{ audio: ArrayBuffer; durationSeconds: number; mimeType: string } | null> {
    const recorder = this.mediaRecorder
    if (!recorder || this.stopping) return Promise.resolve(null)
    this.stopping = true
    const durationSeconds = Math.round((Date.now() - this.startedAt) / 1000)
    const mimeType = recorder.mimeType || this.mimeType || 'audio/webm'

    return new Promise((resolve) => {
      recorder.onstop = async () => {
        const blob = new Blob(this.chunks, { type: mimeType })
        this.cleanup()
        try {
          const wav = await encodeWav(blob)
          resolve({ audio: wav, durationSeconds, mimeType: 'audio/wav' })
        } catch {
          // Fallback: send raw webm if WAV conversion fails
          resolve({ audio: await blob.arrayBuffer(), durationSeconds, mimeType })
        }
      }
      recorder.stop()
    })
  }

  /** Aborts without delivering audio (e.g. on failure). */
  abort(): void {
    try {
      this.mediaRecorder?.stop()
    } catch {
      // already stopped
    }
    this.cleanup()
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
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128
        sum += v * v
      }
      onLevel(Math.min(1, Math.sqrt(sum / data.length) * 3))
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private cleanup(): void {
    cancelAnimationFrame(this.rafId)
    this.mediaRecorder = null
    this.stopping = false
    this.chunks = []
    // Release the mic immediately — no lingering mic indicator.
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    void this.audioContext?.close()
    this.audioContext = null
  }
}

const WAV_SAMPLE_RATE = 16_000 // Whisper's native rate — keeps file size small

// RMS below this level is considered silence (0–1 scale after normalising from Int16)
const SILENCE_RMS = 0.01
// Keep 300 ms of audio after the last detected speech to avoid cutting off final words
const SILENCE_PAD_SAMPLES = Math.ceil(WAV_SAMPLE_RATE * 0.3)

/**
 * Removes trailing silence from PCM data before it is sent to Whisper.
 * Without this, Whisper hallucinates text during silent portions at the end of recordings.
 */
function trimTrailingSilence(samples: Float32Array, sampleRate: number): Float32Array {
  const windowSamples = Math.ceil(sampleRate * 0.02) // 20 ms analysis window
  let lastSpeechEnd = samples.length

  for (let i = samples.length - windowSamples; i >= 0; i -= windowSamples) {
    let sum = 0
    const end = Math.min(i + windowSamples, samples.length)
    for (let j = i; j < end; j++) sum += samples[j] * samples[j]
    const rms = Math.sqrt(sum / (end - i))
    if (rms > SILENCE_RMS) {
      lastSpeechEnd = Math.min(i + windowSamples + SILENCE_PAD_SAMPLES, samples.length)
      break
    }
  }

  // Safety: never trim more than 90% of audio (e.g. very quiet recording)
  const minLength = Math.ceil(samples.length * 0.1)
  return samples.slice(0, Math.max(lastSpeechEnd, minLength))
}

/** Decode any MediaRecorder blob → 16kHz mono 16-bit WAV (no library needed). */
async function encodeWav(blob: Blob): Promise<ArrayBuffer> {
  // Decode the compressed blob into raw PCM
  const decodeCtx = new AudioContext()
  const decoded = await decodeCtx.decodeAudioData(await blob.arrayBuffer())
  void decodeCtx.close()

  // Resample to 16kHz mono using OfflineAudioContext (browser built-in, no library)
  const frameCount = Math.ceil(decoded.duration * WAV_SAMPLE_RATE)
  const offlineCtx = new OfflineAudioContext(1, frameCount, WAV_SAMPLE_RATE)
  const src = offlineCtx.createBufferSource()
  src.buffer = decoded
  src.connect(offlineCtx.destination)
  src.start()
  const resampled = await offlineCtx.startRendering()

  const channelData = trimTrailingSilence(resampled.getChannelData(0), WAV_SAMPLE_RATE)

  // Float32 → Int16 PCM
  const pcm = new Int16Array(channelData.length)
  for (let i = 0; i < channelData.length; i++) {
    const s = Math.max(-1, Math.min(1, channelData[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }

  // Build WAV container
  const dataBytes = pcm.length * 2
  const wav = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(wav)
  const w = (off: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); w(8, 'WAVE')
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true)
  v.setUint16(22, 1, true); v.setUint32(24, WAV_SAMPLE_RATE, true)
  v.setUint32(28, WAV_SAMPLE_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  w(36, 'data'); v.setUint32(40, dataBytes, true)
  new Int16Array(wav, 44).set(pcm)
  return wav
}
