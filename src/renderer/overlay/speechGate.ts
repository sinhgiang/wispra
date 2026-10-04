import { SPEECH_GATE_MIN_VOICED_MS, SPEECH_GATE_RMS } from '@shared/constants'

const WINDOW_MS = 20

/**
 * Pure check (no DOM) for "did anyone actually speak in this recording?", fed the samples
 * as they are recorded. Counts 20 ms windows above SPEECH_GATE_RMS across the whole
 * recording (not necessarily contiguous, so pauses between words never hurt) and requires
 * SPEECH_GATE_MIN_VOICED_MS in total — a single key click or mic pop is a couple of
 * windows at most and does not pass.
 *
 * Whisper never returns "nothing": handed silence it echoes its own `prompt` or invents
 * training-data phrases ("Kết thúc video", "Thanks for watching"). Text filters can only chase
 * those after the fact, so silent audio has to be stopped before it is ever transcribed.
 */
export class SpeechGate {
  private readonly windowSamples: number
  private readonly neededWindows: number
  private voiced = 0
  private sum = 0
  private count = 0

  constructor(sampleRate: number) {
    this.windowSamples = Math.max(1, Math.ceil((sampleRate * WINDOW_MS) / 1000))
    this.neededWindows = Math.ceil(SPEECH_GATE_MIN_VOICED_MS / WINDOW_MS)
  }

  get hasSpeech(): boolean {
    return this.voiced >= this.neededWindows
  }

  push(samples: Float32Array): void {
    if (this.hasSpeech) return
    for (let i = 0; i < samples.length; i++) {
      this.sum += samples[i] * samples[i]
      if (++this.count === this.windowSamples) {
        if (Math.sqrt(this.sum / this.count) > SPEECH_GATE_RMS) this.voiced++
        this.sum = 0
        this.count = 0
      }
    }
  }
}

/** Whole-recording form of the same check. */
export function hasEnoughSpeech(samples: Float32Array, sampleRate: number): boolean {
  const gate = new SpeechGate(sampleRate)
  gate.push(samples)
  return gate.hasSpeech
}

/**
 * Turns the audio context's samples (usually 48 kHz) into 16 kHz, one block at a time:
 * each output sample is the mean of the input samples it covers — enough of a low-pass
 * for speech recognition, and no state lost between blocks.
 */
export class Downsampler {
  private readonly ratio: number
  private position = 0
  private acc = 0
  private n = 0

  constructor(inputRate: number, outputRate: number) {
    this.ratio = inputRate / outputRate
  }

  push(input: Float32Array): Float32Array {
    const out: number[] = []
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i]
      this.n++
      this.position += 1
      if (this.position >= this.ratio) {
        this.position -= this.ratio
        out.push(this.acc / this.n)
        this.acc = 0
        this.n = 0
      }
    }
    return Float32Array.from(out)
  }
}

/** Float samples (-1..1) → 16-bit little-endian PCM bytes. */
export function toPcm16(samples: Float32Array): Uint8Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return new Uint8Array(out.buffer)
}
