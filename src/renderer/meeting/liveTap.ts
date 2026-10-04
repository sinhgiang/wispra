// ── Live words: the audio of a meeting as it is spoken ───────────────────────
// For the grey words shown while someone speaks (liveWords.ts in the main process): the
// meeting's audio, turned into 16 kHz mono 16-bit PCM about four times a second, with the
// moments the recorder cuts a chunk. The chunks themselves still go to Groq as before;
// their text replaces the grey words when it arrives.

const OUTPUT_RATE = 16_000
/** Handed over about this often: short enough for words to show within a second. */
const SEND_EVERY_SAMPLES = OUTPUT_RATE / 4

const CAPTURE_WORKLET = `
class WispraLiveTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) this.port.postMessage(channel.slice(0))
    return true
  }
}
registerProcessor('wispra-live-tap', WispraLiveTap)
`

export interface LiveTapTarget {
  /** 16 kHz mono 16-bit PCM; `atMs` is where it ends on the recording's timeline. */
  onPcm: (pcm: ArrayBuffer, atMs: number) => void
  /** The recorder cut a chunk at `atMs`: what follows belongs to the next one. */
  onCut: (atMs: number) => void
}

/** Mean-of-inputs resampler (enough of a low-pass for speech), keeping its state across blocks. */
class Downsampler {
  private position = 0
  private acc = 0
  private n = 0
  constructor(private readonly ratio: number) {}

  push(input: Float32Array): Float32Array {
    const out: number[] = []
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i]
      this.n++
      if (++this.position >= this.ratio) {
        this.position -= this.ratio
        out.push(this.acc / this.n)
        this.acc = 0
        this.n = 0
      }
    }
    return Float32Array.from(out)
  }
}

/**
 * Taps `source` (in `ctx`) for live words. `now` gives the recording's active-timeline
 * position. Resolves a function that removes the tap.
 */
export async function attachLiveTap(ctx: AudioContext, source: AudioNode, target: LiveTapTarget, now: () => number): Promise<() => void> {
  const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'text/javascript' }))
  try {
    await ctx.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }
  const node = new AudioWorkletNode(ctx, 'wispra-live-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
  const down = new Downsampler(ctx.sampleRate / OUTPUT_RATE)
  let pending: Float32Array[] = []
  let count = 0
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const samples = down.push(e.data)
    if (samples.length === 0) return
    pending.push(samples)
    count += samples.length
    if (count < SEND_EVERY_SAMPLES) return
    const pcm = new Int16Array(count)
    let offset = 0
    for (const part of pending) {
      for (let i = 0; i < part.length; i++) {
        const s = Math.max(-1, Math.min(1, part[i]))
        pcm[offset++] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
    }
    pending = []
    count = 0
    target.onPcm(pcm.buffer, now())
  }
  source.connect(node)
  // Connected to the output (silently — it writes nothing) so the audio thread keeps running it.
  node.connect(ctx.destination)
  return () => {
    node.port.onmessage = null
    node.disconnect()
  }
}
