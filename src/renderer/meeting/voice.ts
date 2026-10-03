import { MEETING_VOICE_DOMINANCE } from '@shared/constants'

/**
 * "You / others" for online calls, with no AI and no voice recognition: in "Both" mode
 * the recorder has the microphone and the computer's audio as two separate sources
 * before it mixes them, so a chunk in which one of them carried nearly all the sound
 * was spoken by the user (microphone) or by the other side of the call (computer
 * audio). Pure functions — recorder.ts feeds them.
 *
 * It only works when the two do not bleed into each other: with headphones, or with
 * echo cancellation doing its job. In a room where everyone shares one microphone
 * there is nothing to tell apart, which is why an unclear chunk gets no label at all.
 */

/** Root-mean-square level (0..1) of one analyser time-domain frame (unsigned bytes centred on 128). */
export function rmsOf(frame: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    const v = (frame[i] - 128) / 128
    sum += v * v
  }
  return Math.sqrt(sum / Math.max(1, frame.length))
}

/** Energy below this over a whole chunk is silence on both sides — nothing to label. */
const MIN_ENERGY = 1e-4

/**
 * Who a chunk belongs to, from the energy each source accumulated over it: the side
 * with at least MEETING_VOICE_DOMINANCE times the other's energy, or undefined when
 * neither clearly dominates (both talking, speakers leaking into the mic, or silence).
 */
export function voiceOf(micEnergy: number, systemEnergy: number): 'me' | 'others' | undefined {
  if (!(micEnergy > MIN_ENERGY) && !(systemEnergy > MIN_ENERGY)) return undefined
  if (micEnergy >= systemEnergy * MEETING_VOICE_DOMINANCE) return 'me'
  if (systemEnergy >= micEnergy * MEETING_VOICE_DOMINANCE) return 'others'
  return undefined
}
