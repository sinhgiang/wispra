import {
  SUGGEST_MAX_ITEMS,
  SUGGEST_MIN_TERM_COUNT,
  SUGGEST_MIN_TERM_SOURCES,
  SUGGEST_MIN_VARIANT_COUNT
} from '@shared/constants'
import type { LexiconEntry, Suggestion } from '@shared/types'
import { normKey, trimEdgePunct } from './lexiconLogic'

/**
 * Pure logic that mines the user's own History and Meeting text for lexicon candidates — no
 * Electron, no file access. Persistence of dismissals and the IPC glue live in suggestions.ts.
 *
 * Nothing found here is ever applied automatically: the app's own output contains its mistakes, so
 * a recurring spelling proves nothing by itself ("cloud" is a perfectly good word). Every candidate
 * is shown to the user with a piece of their own text and only becomes a lexicon entry when they
 * accept it. Two kinds are produced:
 *  - variant: a spelling that recurs and sounds like a term the user already keeps
 *  - term:    a name/brand that recurs and is missing from the user's word lists
 * Both are limited to Latin-script words without accents: that is where brand and technical names
 * live, and it keeps everyday Vietnamese words (where accents carry the meaning) out of the way.
 */

/** One dictation or one meeting. */
export interface SuggestDoc {
  id: string
  /** Text as the speech recogniser produced it — where mishearings live (one string per dictation / transcript segment). */
  asr: string[]
  /** Text as finally typed or shown — where correct spellings live. */
  final: string[]
}

export interface SuggestInput {
  docs: SuggestDoc[]
  /** The user's plain custom-vocabulary list (Dictate → Custom vocabulary). */
  vocabulary: string[]
  entries: LexiconEntry[]
  dismissed: ReadonlySet<string>
  limit?: number
}

// ── Tokens ───────────────────────────────────────────────────────────────────

interface Token {
  /** As written, punctuation included ("Code,"). */
  raw: string
  /** Without the punctuation around it ("Code"). */
  word: string
  sentenceStart: boolean
}

const SENTENCE_END = /[.!?…]["'”’)\]]*$/
const CLAUSE_BREAK = /[.,!?;:…]["'”’)\]]*$/

function tokenize(text: string): Token[] {
  const out: Token[] = []
  let start = true
  for (const raw of text.normalize('NFC').split(/\s+/)) {
    if (!raw) continue
    const word = trimEdgePunct(raw)
    if (/[\p{L}\p{N}]/u.test(word)) {
      out.push({ raw, word, sentenceStart: start })
      start = SENTENCE_END.test(raw)
    } else if (SENTENCE_END.test(raw)) {
      start = true // a bare "." or "…" still ends the sentence
    }
  }
  return out
}

/** Letters and digits only, lowercased: the form two spellings are compared in. Null unless plain unaccented Latin. */
function compareKey(text: string): string | null {
  const k = text.toLowerCase().replace(/['’._\-\s]/g, '')
  return /^[a-z0-9]+$/.test(k) ? k : null
}

// ── Sound-alike matching ─────────────────────────────────────────────────────

/** Terms shorter than this are too likely to have a real look-alike word to be worth matching. */
const MIN_TERM_LENGTH = 5
const MAX_GRAM_WORDS = 4
const MAX_RUN_WORDS = 3
const MAX_EXAMPLE_CHARS = 140

/** Optimal-string-alignment distance: insertions, deletions, substitutions and adjacent swaps. Anything over 3 is reported as 4. */
function editDistance(a: string, b: string): number {
  const n = a.length
  const m = b.length
  if (Math.abs(n - m) > 3) return 4
  let prev2: number[] = []
  let prev = Array.from({ length: m + 1 }, (_, j) => j)
  for (let i = 1; i <= n; i++) {
    const cur = [i]
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1)
      cur[j] = v
    }
    prev2 = prev
    prev = cur
  }
  return Math.min(prev[m], 4)
}

/** Consonants only ("claude" and "cloud" both give "cld"): speech-to-text mostly gets the vowels wrong, not the consonants. */
function skeleton(s: string): string {
  return s.replace(/[aeiou]/g, '')
}

/**
 * Could `cand` be how the recognizer wrote `term`? Both are compareKeys. Returns the edit distance
 * (0 = same letters, only spacing/hyphens differ) or null when they don't look alike.
 * A distance of 1 always counts; 2 or 3 additionally needs the consonants to line up, so
 * "Cloud" ≈ "Claude" and "Courser" ≈ "Cursor" but "Gitlab" ≉ "Github". One being the other plus a
 * few letters ("code" / "codex", "cursors") is an inflection, not a mishearing.
 */
function looksLike(cand: string, term: string): number | null {
  if (cand === term) return 0
  const len = term.length
  if (len < MIN_TERM_LENGTH) return null
  if (cand.startsWith(term) || term.startsWith(cand)) return null
  const d = editDistance(cand, term)
  if (d === 1) return 1
  if (d === 2 && len >= 6 && editDistance(skeleton(cand), skeleton(term)) <= (len >= 9 ? 1 : 0)) return 2
  if (d === 3 && len >= 13 && editDistance(skeleton(cand), skeleton(term)) <= 1) return 3
  return null
}

// ── What the user already has ────────────────────────────────────────────────

interface Target {
  term: string
  key: string
  cmp: string
  words: number
}

interface Known {
  /** Terms a mishearing can be matched to: the custom vocabulary and the enabled lexicon entries. */
  targets: Target[]
  /** Every spelling that is already accounted for — terms, wrong forms, vocabulary — as normKeys. */
  forms: Set<string>
}

function collectKnown(vocabulary: string[], entries: LexiconEntry[]): Known {
  const targets: Target[] = []
  const forms = new Set<string>()
  const addTarget = (term: string): void => {
    const key = normKey(term)
    if (!key) return
    forms.add(key)
    const cmp = compareKey(term)
    if (!cmp || cmp.length < MIN_TERM_LENGTH) return
    if (targets.some((t) => t.key === key)) return
    targets.push({ term, key, cmp, words: key.split(' ').length })
  }
  for (const v of vocabulary) addTarget(v)
  for (const e of entries) {
    for (const h of e.heardAs) {
      const k = normKey(h)
      if (k) forms.add(k)
    }
    // A switched-off entry is one the user doesn't want — never a target, but its spellings stay accounted for.
    if (e.enabled) addTarget(e.term)
    else forms.add(normKey(e.term))
  }
  return { targets, forms }
}

// ── Shared counting helpers ──────────────────────────────────────────────────

interface Counted {
  count: number
  /** Separate dictations/meetings it occurs in (docs are scanned one after another). */
  sources: number
  lastDoc: string
  surfaces: Map<string, number>
  /** Where to fetch the example from later: doc / text / first token. */
  ref: { d: number; t: number; i: number; n: number }
}

function counted(ref: Counted['ref']): Counted {
  return { count: 0, sources: 0, lastDoc: '', surfaces: new Map(), ref }
}

/** Counts one more occurrence of `key`; `make` builds its record the first time it is seen. */
function bump<T extends Counted>(map: Map<string, T>, key: string, surface: string, docId: string, make: () => T): void {
  let c = map.get(key)
  if (!c) {
    c = make()
    map.set(key, c)
  }
  c.count++
  if (c.lastDoc !== docId) {
    c.sources++
    c.lastDoc = docId
  }
  c.surfaces.set(surface, (c.surfaces.get(surface) ?? 0) + 1)
}

/** The spelling that occurs most often (ties: the first one seen). */
function commonSurface(c: Counted): string {
  let best = ''
  let bestN = 0
  for (const [s, n] of c.surfaces) {
    if (n > bestN) {
      best = s
      bestN = n
    }
  }
  return best
}

function snippet(tokens: Token[], i: number, n: number): string {
  const from = Math.max(0, i - 5)
  const to = Math.min(tokens.length, i + n + 5)
  const body = tokens
    .slice(from, to)
    .map((t) => t.raw)
    .join(' ')
  const text = `${from > 0 ? '… ' : ''}${body}${to < tokens.length ? ' …' : ''}`
  return text.length > MAX_EXAMPLE_CHARS ? `${text.slice(0, MAX_EXAMPLE_CHARS - 1)}…` : text
}

function exampleFor(texts: (d: number, t: number) => string, ref: Counted['ref']): string {
  return snippet(tokenize(texts(ref.d, ref.t)), ref.i, ref.n)
}

// ── Kind 1: near-miss spellings of known terms ───────────────────────────────

interface Gram extends Counted {
  cmp: string
}

interface VariantHit {
  key: string
  gram: Gram
  target: Target
  distance: number
}

function findVariants(docs: SuggestDoc[], known: Known): VariantHit[] {
  const { targets, forms } = known
  if (targets.length === 0) return []

  // Only word counts and lengths that some term could match are worth counting.
  const wantWords = new Set<number>()
  let minLen = Infinity
  let maxLen = 0
  for (const t of targets) {
    for (const n of [t.words - 1, t.words, t.words + 1]) if (n >= 1 && n <= MAX_GRAM_WORDS) wantWords.add(n)
    minLen = Math.min(minLen, t.cmp.length)
    maxLen = Math.max(maxLen, t.cmp.length)
  }

  const grams = new Map<string, Gram>()
  docs.forEach((doc, d) => {
    doc.asr.forEach((text, t) => {
      const tokens = tokenize(text)
      for (let i = 0; i < tokens.length; i++) {
        for (let n = 1; n <= MAX_GRAM_WORDS && i + n <= tokens.length; n++) {
          // A gram never reaches across a comma or the end of a sentence.
          if (n > 1 && CLAUSE_BREAK.test(tokens[i + n - 2].raw)) break
          if (!wantWords.has(n)) continue
          const surface = tokens
            .slice(i, i + n)
            .map((x) => x.word)
            .join(' ')
          const cmp = compareKey(surface)
          if (!cmp || cmp.length < minLen - 3 || cmp.length > maxLen + 3) continue
          const key = normKey(surface)
          if (forms.has(key)) continue
          bump(grams, key, surface, doc.id, () => ({ ...counted({ d, t, i, n }), cmp }))
        }
      }
    })
  })

  const hits: VariantHit[] = []
  for (const [key, g] of grams) {
    if (g.count < SUGGEST_MIN_VARIANT_COUNT) continue
    let best: { target: Target; distance: number } | null = null
    for (const target of targets) {
      if (Math.abs(g.ref.n - target.words) > 1) continue
      const distance = looksLike(g.cmp, target.cmp)
      if (distance === null) continue
      if (!best || distance < best.distance || (distance === best.distance && target.cmp.length > best.target.cmp.length)) {
        best = { target, distance }
      }
    }
    if (best) hits.push({ key, gram: g, target: best.target, distance: best.distance })
  }
  return hits
}

// ── Kind 2: names and brands that are not in any list yet ────────────────────

/** Capitalised words that carry no naming information. */
const NOT_A_NAME = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december', 'english', 'vietnamese', 'the', 'and', 'but', 'okay'
])

/** ASCII, at least 3 characters, starts with a capital or has a capital inside ("iPhone"). */
function nameLike(word: string): boolean {
  if (word.length < 3 || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(word) || !/[A-Za-z]/.test(word)) return false
  if (NOT_A_NAME.has(word.toLowerCase())) return false
  return /^[A-Z]/.test(word) || /^[a-z]+[A-Z]/.test(word)
}

/** A capital letter that is not a plain-ASCII name ("Việt", "Định"): part of a name Wispra can't keep as a term. */
function otherCapitalised(token: Token | undefined): boolean {
  return !!token && /^\p{Lu}/u.test(token.word) && !nameLike(token.word)
}

interface TermHit {
  key: string
  run: Counted
}

function findTerms(docs: SuggestDoc[], known: Known, skip: ReadonlySet<string>): TermHit[] {
  const runs = new Map<string, Counted>()
  // How often each plain word is written in lower case: "build", "anh" — a word people use in
  // lower case as often as capitalised is an ordinary word, not a name.
  const lower = new Map<string, number>()
  docs.forEach((doc, d) => {
    doc.final.forEach((text, t) => {
      const tokens = tokenize(text)
      for (const tok of tokens) if (/^[a-z]{3,}$/.test(tok.word)) lower.set(tok.word, (lower.get(tok.word) ?? 0) + 1)
      let start = -1
      let ignored = false
      const flush = (end: number): void => {
        const len = end - start
        if (start >= 0 && !ignored && len >= 1 && len <= MAX_RUN_WORDS) {
          // "Nam" in "Việt Nam", "Trung" in "Trung Quốc": one half of a bigger name.
          const before = tokens[start - 1]
          const after = tokens[end]
          const joinedBefore = before && !CLAUSE_BREAK.test(before.raw) && otherCapitalised(before)
          const joinedAfter = after && !CLAUSE_BREAK.test(tokens[end - 1].raw) && otherCapitalised(after)
          if (joinedBefore || joinedAfter) {
            start = -1
            return
          }
          const surface = tokens
            .slice(start, end)
            .map((x) => x.word)
            .join(' ')
          bump(runs, normKey(surface), surface, doc.id, () => counted({ d, t, i: start, n: len }))
        }
        start = -1
      }
      for (let i = 0; i < tokens.length; i++) {
        if (start >= 0 && CLAUSE_BREAK.test(tokens[i - 1].raw)) flush(i)
        if (!nameLike(tokens[i].word)) {
          flush(i)
          continue
        }
        if (start < 0) {
          start = i
          // A capital at the start of a sentence proves nothing — nor does whatever capitalised word follows it.
          ignored = tokens[i].sentenceStart
        }
      }
      flush(tokens.length)
    })
  })

  const hits: TermHit[] = []
  for (const [key, run] of runs) {
    if (run.count < SUGGEST_MIN_TERM_COUNT || run.sources < SUGGEST_MIN_TERM_SOURCES) continue
    if (known.forms.has(key) || skip.has(key)) continue
    // A name has at least one word that is (almost) always capitalised; a run of ordinary words does not.
    const usedLower = Math.min(...key.split(' ').map((w) => lower.get(w) ?? 0))
    if (usedLower * 2 >= run.count) continue
    // Part of a term the user already has ("Claude" inside "Claude Code").
    if ([...known.forms].some((f) => ` ${f} `.includes(` ${key} `))) continue
    // A near-miss of a known term is a variant at best, never a new term.
    const cmp = compareKey(key)
    if (cmp && known.targets.some((t) => looksLike(cmp, t.cmp) !== null)) continue
    hits.push({ key, run })
  }
  return hits
}

// ── Putting it together ──────────────────────────────────────────────────────

export function computeSuggestions(input: SuggestInput): Suggestion[] {
  const limit = input.limit ?? SUGGEST_MAX_ITEMS
  const known = collectKnown(input.vocabulary, input.entries)
  const asrText = (d: number, t: number): string => input.docs[d].asr[t]
  const finalText = (d: number, t: number): string => input.docs[d].final[t]

  const variantHits = findVariants(input.docs, known)
  const variantKeys = new Set(variantHits.map((h) => h.key))
  const termHits = findTerms(input.docs, known, variantKeys)

  const variants: Suggestion[] = variantHits.map((h) => ({
    id: `variant:${h.target.key}:${h.key}`,
    kind: 'variant',
    term: h.target.term,
    heardAs: commonSurface(h.gram),
    count: h.gram.count,
    sources: h.gram.sources,
    example: exampleFor(asrText, h.gram.ref)
  }))
  const terms: Suggestion[] = termHits.map((h) => ({
    id: `term:${h.key}`,
    kind: 'term',
    term: commonSurface(h.run),
    count: h.run.count,
    sources: h.run.sources,
    example: exampleFor(finalText, h.run.ref)
  }))

  const byStrength = (a: Suggestion, b: Suggestion): number => b.sources - a.sources || b.count - a.count || a.id.localeCompare(b.id)
  // Mishearings first: they are live mistakes; a new name is only a nice-to-have.
  return [...variants.sort(byStrength), ...terms.sort(byStrength)].filter((s) => !input.dismissed.has(s.id)).slice(0, limit)
}
