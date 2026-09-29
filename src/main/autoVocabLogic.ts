import {
  AUTO_AMBIGUITY_RATIO,
  AUTO_MAX_TERMS,
  AUTO_MIN_FIX_COUNT,
  AUTO_MIN_FIX_SOURCES
} from '@shared/constants'
import type { AutoTerm, LexiconEntry } from '@shared/types'
import { extractCorrections, normKey } from './lexiconLogic'
import {
  bump,
  canonicalSpelling,
  collectKnown,
  commonSurface,
  compareKey,
  counted,
  findTerms,
  looksLike,
  nameLike,
  type Counted,
  type SuggestDoc
} from './suggestLogic'

/**
 * Pure logic of the vocabulary Wispra learns by itself from the user's History and finished
 * meetings — no Electron, no file access. Persistence, caching and IPC live in autoVocab.ts.
 *
 * This is the one place the app learns without being told, so it is deliberately gentle. What it
 * finds is only ever handed to the speech recogniser as a spelling to prefer; it is never used to
 * rewrite text (that stays with the user's own corrections, see lexiconLogic.ts), and it is never
 * given to the AI cleanup as "keep this exactly" — an entrenched mistake would then also stop the
 * AI from fixing it. Two signals, both from the user's own text:
 *  - seen:  a name/brand/acronym that keeps turning up in what the user dictates
 *  - fixed: the AI cleanup keeps turning one spelling into another look-alike one
 *           ("Cloud" → "Claude"): the cleanup step knows more than the recogniser did
 *
 * The risk is that History holds the recogniser's own output, so a recurring WRONG spelling looks
 * exactly like a recurring right one. Four guards: a spelling the AI keeps correcting is never
 * learned as-is; a look-alike of a well-known name ("Cloud" for "Claude", see wellKnownNames.ts) is
 * never learned; two look-alike spellings that are about equally common cancel each other out
 * instead of one being picked; and whatever is learned is listed for the user to keep or remove.
 */

export interface AutoVocabInput {
  docs: SuggestDoc[]
  /** The user's plain custom-vocabulary list (Dictate → Custom vocabulary). */
  vocabulary: string[]
  entries: LexiconEntry[]
  /** Ids ("term:<key>") the user removed or ignored — never learned again. */
  dismissed: ReadonlySet<string>
  limit?: number
}

interface Fixed extends Counted {
  /** The wrong spellings that were changed into this term, most frequent first wins for display. */
  heard: Map<string, number>
}

/** Every word is ASCII, at least 3 characters, and capitalised (or has a capital inside): a name, brand or acronym. */
function termLike(term: string): boolean {
  const parts = term.trim().split(/\s+/)
  return parts.length > 0 && parts.every(nameLike)
}

function mostCommon(counts: Map<string, number>): string {
  let best = ''
  let bestN = 0
  for (const [s, n] of counts) {
    if (n > bestN) {
      best = s
      bestN = n
    }
  }
  return best
}

/**
 * Spellings that were changed into a term-like look-alike between the recogniser's output and the
 * final text. The look-alike requirement is what separates "Cloud" → "Claude" (a spelling fix)
 * from a rewritten sentence.
 */
function findFixed(docs: SuggestDoc[], knownForms: ReadonlySet<string>): Map<string, Fixed> {
  const fixed = new Map<string, Fixed>()
  for (const doc of docs) {
    doc.asr.forEach((asr, i) => {
      const final = doc.final[i]
      if (final === undefined || asr === final) return
      for (const pair of extractCorrections(asr, final)) {
        if (!termLike(pair.term)) continue
        const termKey = normKey(pair.term)
        if (knownForms.has(termKey)) continue
        const heard = compareKey(pair.heardAs)
        const term = compareKey(pair.term)
        if (!heard || !term || looksLike(heard, term) === null) continue
        bump(fixed, termKey, pair.term, doc.id, () => ({ ...counted({ d: 0, t: 0, i: 0, n: 0 }), heard: new Map() }))
        const entry = fixed.get(termKey)!
        entry.heard.set(pair.heardAs, (entry.heard.get(pair.heardAs) ?? 0) + 1)
      }
    })
  }
  for (const [key, f] of fixed) {
    if (f.count < AUTO_MIN_FIX_COUNT || f.sources < AUTO_MIN_FIX_SOURCES) fixed.delete(key)
  }
  return fixed
}

/** Two candidates that look like the same word spelled differently. */
function alike(a: string, b: string): boolean {
  const ca = compareKey(a)
  const cb = compareKey(b)
  if (!ca || !cb || ca === cb) return false
  return looksLike(ca, cb) !== null || looksLike(cb, ca) !== null
}

export function computeAutoTerms(input: AutoVocabInput): AutoTerm[] {
  const limit = input.limit ?? AUTO_MAX_TERMS
  const known = collectKnown(input.vocabulary, input.entries)

  const fixed = findFixed(input.docs, known.forms)
  // A spelling the AI keeps correcting is a mistake, not vocabulary — even though it recurs.
  const corrected = new Set<string>()
  for (const [termKey, f] of fixed) {
    for (const h of f.heard.keys()) {
      const k = normKey(h)
      if (k !== termKey) corrected.add(k)
    }
  }
  const seen = findTerms(input.docs, known, corrected)

  const candidates: AutoTerm[] = []
  for (const [key, f] of fixed) {
    candidates.push({
      id: `term:${key}`,
      term: canonicalSpelling(commonSurface(f)),
      count: f.count,
      sources: f.sources,
      via: 'fixed',
      heardAs: mostCommon(f.heard)
    })
  }
  const fixedKeys = new Set(fixed.keys())
  for (const hit of seen) {
    if (fixedKeys.has(hit.key)) continue
    const term = canonicalSpelling(commonSurface(hit.run))
    // Looks like something the AI corrects towards: at best a variant of that term, never vocabulary itself.
    if ([...fixed.values()].some((f) => alike(term, commonSurface(f)))) continue
    candidates.push({ id: `term:${hit.key}`, term, count: hit.run.count, sources: hit.run.sources, via: 'seen' })
  }

  // Two spellings of one word that are about equally common: which one is right is not knowable
  // from the text alone, so learn neither and leave the choice to the user.
  const ambiguous = new Set<string>()
  const seenOnes = candidates.filter((c) => c.via === 'seen')
  for (let i = 0; i < seenOnes.length; i++) {
    for (let j = i + 1; j < seenOnes.length; j++) {
      const a = seenOnes[i]
      const b = seenOnes[j]
      if (!alike(a.term, b.term)) continue
      if (a.count >= b.count * AUTO_AMBIGUITY_RATIO) ambiguous.add(b.id)
      else if (b.count >= a.count * AUTO_AMBIGUITY_RATIO) ambiguous.add(a.id)
      else {
        ambiguous.add(a.id)
        ambiguous.add(b.id)
      }
    }
  }

  return candidates
    .filter((c) => !ambiguous.has(c.id) && !input.dismissed.has(c.id))
    .sort((a, b) => b.sources - a.sources || b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, limit)
}
