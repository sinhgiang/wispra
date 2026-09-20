import { SPEECH_GATE_MIN_VOICED_MS, SPEECH_GATE_RMS } from '@shared/constants'

const WINDOW_MS = 20

/**
 * Pure check (no DOM) for "did anyone actually speak in this recording?", run on the decoded
 * PCM before anything is sent to the STT provider. Counts 20 ms windows above SPEECH_GATE_RMS
 * across the whole recording (not necessarily contiguous, so pauses between words never hurt)
 * and requires SPEECH_GATE_MIN_VOICED_MS in total — a single key click or mic pop is a couple
 * of windows at most and does not pass.
 *
 * Whisper never returns "nothing": handed silence it echoes its own `prompt` or invents
 * training-data phrases ("Kết thúc video", "Thanks for watching"). Text filters can only chase
 * those after the fact, so silent audio has to be stopped before it is ever transcribed.
 */
export function hasEnoughSpeech(samples: Float32Array, sampleRate: number): boolean {
  const windowSamples = Math.max(1, Math.ceil((sampleRate * WINDOW_MS) / 1000))
  const neededWindows = Math.ceil(SPEECH_GATE_MIN_VOICED_MS / WINDOW_MS)
  let voiced = 0

  for (let start = 0; start < samples.length; start += windowSamples) {
    const end = Math.min(start + windowSamples, samples.length)
    let sum = 0
    for (let i = start; i < end; i++) sum += samples[i] * samples[i]
    if (Math.sqrt(sum / (end - start)) > SPEECH_GATE_RMS && ++voiced >= neededWindows) return true
  }
  return false
}
