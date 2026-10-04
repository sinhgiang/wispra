import { Downsampler, SpeechGate, toPcm16 } from './speechGate'

export interface RecordingResult {
  durationSeconds: number
  /** False when the recording is (near-)silent — the main process then does NOT send it to the STT provider. */
  hasSpeech: boolean
}

/** Speech recognition's sample rate; what the main process stores (see dictationAudio.ts). */
const OUTPUT_RATE = 16_000
/** PCM is handed to the main process about this often, so it is on disk while recording. */
const SEND_EVERY_SAMPLES = OUTPUT_RATE
/** After the mic stops, the last blocks still in flight from the audio thread are awaited this long. */
const DRAIN_MS = 150

/** Runs on the audio thread: hands each block of microphone samples to the page. */
const CAPTURE_WORKLET = `
class WispraCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) this.port.postMessage(channel.slice(0))
    return true
  }
}
registerProcessor('wispra-capture', WispraCapture)
`

/**
 * Microphone capture for the overlay. One recording at a time.
 *
 * The audio is not kept here: it is turned into 16 kHz mono 16-bit PCM as it comes in and
 * sent to the main process about once a second, which writes it to a file (dictationAudio.ts).
 * So a dictation can run for as long as the user likes, memory stays flat, and what was
 * said is on disk before anything is sent to a speech-to-text service. The mic and the
 * AudioContext are released the moment recording stops.
 */
export class Recorder {
  private stream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private worklet: AudioWorkletNode | null = null
  private downsampler: Downsampler | null = null
  private gate: SpeechGate | null = null
  private pending: Float32Array[] = []
  private pendingSamples = 0
  private totalSamples = 0
  private rafId = 0
  private stopping = false
  private onPcm: ((pcm: ArrayBuffer) => void) | null = null

  get isActive(): boolean {
    return this.audioContext !== null
  }

  /** Starts capturing; `onLevel` receives 0..1 mic levels for the UI, `onPcm` the recorded audio. */
  async start(onLevel: (level: number) => void, onPcm: (pcm: ArrayBuffer) => void): Promise<void> {
    if (this.isActive) return
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    })
    const ctx = new AudioContext()
    this.audioContext = ctx
    this.onPcm = onPcm
    this.downsampler = new Downsampler(ctx.sampleRate, OUTPUT_RATE)
    this.gate = new SpeechGate(OUTPUT_RATE)
    this.pending = []
    this.pendingSamples = 0
    this.totalSamples = 0

    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'text/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const source = ctx.createMediaStreamSource(this.stream)
    const worklet = new AudioWorkletNode(ctx, 'wispra-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
    worklet.port.onmessage = (e: MessageEvent<Float32Array>) => this.take(e.data)
    source.connect(worklet)
    // Connected to the output (silently — it writes nothing) so the audio thread keeps running it.
    worklet.connect(ctx.destination)
    this.worklet = worklet
    this.monitorLevel(source, onLevel)
  }

  private take(block: Float32Array): void {
    if (!this.downsampler || !this.gate) return
    const samples = this.downsampler.push(block)
    if (samples.length === 0) return
    this.gate.push(samples)
    this.pending.push(samples)
    this.pendingSamples += samples.length
    this.totalSamples += samples.length
    if (this.pendingSamples >= SEND_EVERY_SAMPLES) this.flush()
  }

  private flush(): void {
    if (this.pendingSamples === 0 || !this.onPcm) return
    const all = new Float32Array(this.pendingSamples)
    let offset = 0
    for (const part of this.pending) {
      all.set(part, offset)
      offset += part.length
    }
    this.pending = []
    this.pendingSamples = 0
    const pcm = toPcm16(all)
    this.onPcm(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer)
  }

  /** Stops the mic, sends the last of the audio, and says how long it was and whether anyone spoke. */
  async stop(): Promise<RecordingResult | null> {
    if (!this.isActive || this.stopping) return null
    this.stopping = true
    this.stream?.getTracks().forEach((t) => t.stop())
    await new Promise((resolve) => setTimeout(resolve, DRAIN_MS))
    this.flush()
    const result = { durationSeconds: Math.round(this.totalSamples / OUTPUT_RATE), hasSpeech: this.gate?.hasSpeech ?? false }
    this.cleanup()
    return result
  }

  /** Aborts without delivering anything more (e.g. on failure). */
  abort(): void {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.cleanup()
  }

  private monitorLevel(source: MediaStreamAudioSourceNode, onLevel: (level: number) => void): void {
    if (!this.audioContext) return
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
    if (this.worklet) this.worklet.port.onmessage = null
    this.worklet?.disconnect()
    this.worklet = null
    // Release the mic immediately — no lingering mic indicator.
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    void this.audioContext?.close()
    this.audioContext = null
    this.downsampler = null
    this.gate = null
    this.pending = []
    this.pendingSamples = 0
    this.onPcm = null
    this.stopping = false
  }
}
