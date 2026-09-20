import { CONTEXT_MAX_CHARS } from '@shared/constants'
import { normKey, words } from './lexiconLogic'

/**
 * Pure logic of "contexts": what the user has written in one place (one app's History, one Meeting
 * Space) decides which of their learned terms are worth priming the recognizer with there. A
 * Facebook-page project and a school project each get their own vocabulary first, without the user
 * sorting terms into folders — a term simply counts as relevant where it keeps showing up.
 *
 * It only ranks; it never adds or removes terms (see selectTerms), and it is read-only.
 */

/** One document as a normalized token string (" w1 w2 w3 "), so whole phrases can be counted with plain substring search. */
export function indexText(text: string): string {
  const tokens = words(text).map(normKey)
  return tokens.length > 0 ? ` ${tokens.join(' ')} ` : ''
}

/**
 * Joins documents (newest first) into one index, stopping at the size budget. Each document keeps
 * its own leading/trailing space, so a phrase never spans two documents.
 */
export function joinIndexes(indexes: readonly string[], maxChars = CONTEXT_MAX_CHARS): string {
  let size = 0
  const kept: string[] = []
  for (const ix of indexes) {
    if (ix === '') continue
    if (size + ix.length > maxChars && kept.length > 0) break
    kept.push(ix)
    size += ix.length
  }
  return kept.join('')
}

/** How many times the whole phrase occurs in the index (overlapping runs like "go go go" count each). */
export function countPhrase(index: string, term: string): number {
  const key = words(term).map(normKey).join(' ')
  if (!key || !index) return 0
  const needle = ` ${key} `
  let n = 0
  let from = 0
  for (;;) {
    const at = index.indexOf(needle, from)
    if (at < 0) return n
    n++
    from = at + 1
  }
}

/** A scoring function for terms over one context's text: higher = the user writes this term here more. */
export function relevanceOver(index: string): (term: string) => number {
  return (term) => countPhrase(index, term)
}
