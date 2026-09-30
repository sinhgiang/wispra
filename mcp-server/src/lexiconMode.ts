import type { LexiconEntry } from './types'

/**
 * Local port of ../../src/shared/lexiconMode.ts — same logic, kept in sync by hand (see types.ts's
 * note on why this package can't import across into src/shared).
 */

const LEXICON_REPLACE_MIN_COUNT = 2

export type LexiconMode = 'replace' | 'hint' | 'spelling' | 'off'

export function lexiconMode(e: LexiconEntry): LexiconMode {
  if (!e.enabled) return 'off'
  if (e.heardAs.length === 0) return 'spelling'
  return e.source === 'manual' || e.pinned || e.count >= LEXICON_REPLACE_MIN_COUNT ? 'replace' : 'hint'
}
