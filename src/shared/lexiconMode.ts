import { LEXICON_REPLACE_MIN_COUNT } from './constants'
import type { LexiconEntry } from './types'

/**
 * How Wispra uses one lexicon entry. Shared so the Learned tab shows exactly the behaviour the
 * main process applies:
 *  - replace:  wrong forms are swapped for the term automatically (typed in by the user, pinned,
 *              or the same correction confirmed LEXICON_REPLACE_MIN_COUNT times)
 *  - hint:     learned from a single fix so far — only offered to the AI cleanup step
 *  - spelling: no wrong forms, just a term to keep spelled this way
 *  - off:      switched off by the user
 */
export type LexiconMode = 'replace' | 'hint' | 'spelling' | 'off'

export function lexiconMode(e: LexiconEntry): LexiconMode {
  if (!e.enabled) return 'off'
  if (e.heardAs.length === 0) return 'spelling'
  return e.source === 'manual' || e.pinned || e.count >= LEXICON_REPLACE_MIN_COUNT ? 'replace' : 'hint'
}
