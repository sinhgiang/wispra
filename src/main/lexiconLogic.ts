import { randomUUID } from 'crypto'
import { LEXICON_REPLACE_MIN_COUNT, LLM_MAX_CORRECTION_HINTS, MAX_LEXICON_ENTRIES } from '@shared/constants'
import { lexiconMode } from '@shared/lexiconMode'
import type { LexiconEntry } from '@shared/types'

/**
 * Pure logic of the personal lexicon — no Electron, no file access — so it can be exercised with
 * plain strings. Persistence and settings live in lexicon.ts.
 *
 * How the lexicon learns without poisoning itself: the app's own output already contains its
 * mistakes ("Cloud Code"), so nothing is ever mined from History automatically. An entry only
 * appears when the user explicitly fixes a dictation (or types the entry in themselves), and a
 * correction learned from a single fix is only a HINT to the AI cleanup step until the user has
 * confirmed the same correction again (LEXICON_REPLACE_MIN_COUNT) or pinned it.
 */

/** A mishearing → correction pair pulled out of one user fix. */
export interface WordPair {
  heardAs: string
  term: string
}

/** A hint for the AI cleanup step: this wrong form is probably that term. */
export interface CorrectionHint {
  heardAs: string
  term: string
}

// ── Word-level diff ──────────────────────────────────────────────────────────

/** Sentence punctuation stripped from the edges of a word; kept inside ("gpt-4o") and on symbols ("C++"). */
const EDGE_PUNCT = /^[.,!?;:…"'“”‘’()[\]{}«»–—-]+|[.,!?;:…"'“”‘’()[\]{}«»–—-]+$/gu

/** A fix that changes many separate places, or a big share of the text, is a rewrite — nothing was "misheard". */
const MAX_HUNKS = 8
const MAX_CHANGED_RATIO = 0.4
/** Longest wrong/right phrase (in words / characters) worth remembering. */
const MAX_PHRASE_WORDS = 5
const MAX_PHRASE_CHARS = 60
/** Diff table size cap (words × words), so a huge pasted text can't stall the main process. */
const MAX_DIFF_CELLS = 4_000_000

const MAX_MANUAL_CHARS = 80
const MAX_MANUAL_VARIANTS = 10

/** A whitespace-separated chunk of text without the sentence punctuation around it. */
export function trimEdgePunct(chunk: string): string {
  return chunk.replace(EDGE_PUNCT, '')
}

/** The words of a text: whitespace-split, edge punctuation stripped, punctuation-only chunks dropped. */
export function words(text: string): string[] {
  return text
    .normalize('NFC')
    .split(/\s+/)
    .map(trimEdgePunct)
    .filter((w) => /[\p{L}\p{N}]/u.test(w))
}

export function wordCount(text: string): number {
  return words(text).length
}

interface Hunk {
  del: string[]
  ins: string[]
}

/** Lowercased, NFC, single-spaced — the identity of a word or phrase for matching purposes. */
export function normKey(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * LCS-based diff of two word lists, grouped into changed regions (consecutive deletions/insertions).
 * Words are aligned case-insensitively, so a sentence-initial capital never counts as an edit;
 * words that align but differ in case ("github" → "GitHub") come back separately as `recased`.
 */
function diffWords(a: string[], b: string[]): { hunks: Hunk[]; recased: Hunk[] } {
  const ka = a.map(normKey)
  const kb = b.map(normKey)
  const n = a.length
  const m = b.length
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        ka[i] === kb[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
    }
  }

  const hunks: Hunk[] = []
  const recased: Hunk[] = []
  let cur: Hunk | null = null
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && ka[i] === kb[j]) {
      if (cur) {
        hunks.push(cur)
        cur = null
      }
      if (a[i] !== b[j]) recased.push({ del: [a[i]], ins: [b[j]] })
      i++
      j++
      continue
    }
    if (!cur) cur = { del: [], ins: [] }
    if (j >= m || (i < n && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) cur.del.push(a[i++])
    else cur.ins.push(b[j++])
  }
  if (cur) hunks.push(cur)
  return { hunks, recased }
}

/** "hôm" → "Hôm" and the like: a capital at the start of a sentence, not a spelling the user cares about. "github" → "GitHub" is not (see diffWords). */
function isPlainCapitalization(heardAs: string, term: string): boolean {
  return normKey(heardAs) === normKey(term) && !/\p{Lu}/u.test(term.slice(1))
}

/**
 * What did the user change, phrased as "X was heard, they meant Y"? Only replacements count: a
 * pure insertion or deletion is a style edit (dropped filler, added word), not a misheard term.
 * A fix that rewrites a lot returns nothing.
 */
export function extractCorrections(before: string, after: string): WordPair[] {
  const a = words(before)
  const b = words(after)
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_DIFF_CELLS) return []

  const { hunks, recased } = diffWords(a, b)
  if (hunks.length > 1) {
    const changed = hunks.reduce((sum, h) => sum + Math.max(h.del.length, h.ins.length), 0)
    if (hunks.length > MAX_HUNKS || changed / Math.max(a.length, b.length) > MAX_CHANGED_RATIO) return []
  }

  const pairs: WordPair[] = []
  const seen = new Set<string>()
  for (const h of [...hunks, ...recased]) {
    if (h.del.length === 0 || h.ins.length === 0) continue
    if (h.del.length > MAX_PHRASE_WORDS || h.ins.length > MAX_PHRASE_WORDS) continue
    const heardAs = h.del.join(' ')
    const term = h.ins.join(' ')
    if (heardAs.length > MAX_PHRASE_CHARS || term.length > MAX_PHRASE_CHARS) continue
    if (isPlainCapitalization(heardAs, term)) continue
    const id = `${normKey(heardAs)}\u0000${normKey(term)}`
    if (seen.has(id)) continue
    seen.add(id)
    pairs.push({ heardAs, term })
  }
  return pairs
}

/** Longest run of deleted words that still counts as "a word the user cut" rather than a rewritten passage. */
const MAX_DELETED_WORDS = 2

/**
 * Words or short phrases the user simply cut out of a dictation (filler, hedging — "kiểu như",
 * "basically"), lowercased. Only clean deletions count: a hunk that also inserts something is a
 * replacement (see extractCorrections), and a fix that rewrites a lot returns nothing.
 */
export function extractDeletions(before: string, after: string): string[] {
  const a = words(before)
  const b = words(after)
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_DIFF_CELLS) return []

  const { hunks } = diffWords(a, b)
  if (hunks.length > 1) {
    const changed = hunks.reduce((sum, h) => sum + Math.max(h.del.length, h.ins.length), 0)
    if (hunks.length > MAX_HUNKS || changed / Math.max(a.length, b.length) > MAX_CHANGED_RATIO) return []
  }

  const out: string[] = []
  for (const h of hunks) {
    if (h.ins.length > 0 || h.del.length === 0 || h.del.length > MAX_DELETED_WORDS) continue
    const phrase = normKey(h.del.join(' '))
    if (!out.includes(phrase)) out.push(phrase)
  }
  return out
}

/**
 * How many words the user had to change to turn `before` into `after` (a replaced run counts as
 * the longer side; a plain sentence-initial capital does not count). Unlike extractCorrections
 * there is no rewrite guard — a full rewrite is exactly the kind of fix this measures. Null when
 * the texts are too long to compare cheaply.
 */
export function countWordEdits(before: string, after: string): number | null {
  const a = words(before)
  const b = words(after)
  if (a.length * b.length > MAX_DIFF_CELLS) return null
  const { hunks, recased } = diffWords(a, b)
  let edits = hunks.reduce((sum, h) => sum + Math.max(h.del.length, h.ins.length), 0)
  for (const r of recased) if (!isPlainCapitalization(r.del[0], r.ins[0])) edits += 1
  return edits
}

// ── Entry state helpers ──────────────────────────────────────────────────────

/** Applied as a plain text replacement before AI cleanup: typed in by the user, pinned, or confirmed more than once. */
export function replaces(e: LexiconEntry): boolean {
  return lexiconMode(e) === 'replace'
}

/** Learned from a single fix so far: only offered to the AI cleanup step, which judges from context. */
export function isHint(e: LexiconEntry): boolean {
  return lexiconMode(e) === 'hint'
}

/** Looks like a name/brand/technical term (capital letter, digit, plain-ASCII word) rather than an everyday Vietnamese word. */
function isTermLike(term: string): boolean {
  if (/[\p{Lu}\d]/u.test(term)) return true
  return /^[\x20-\x7e]+$/.test(term) && /[a-z]{3}/i.test(term)
}

function byPriority(a: LexiconEntry, b: LexiconEntry): number {
  return b.count - a.count || b.lastSeen.localeCompare(a.lastSeen)
}

function clone(entries: LexiconEntry[]): LexiconEntry[] {
  return entries.map((e) => ({ ...e, heardAs: [...e.heardAs] }))
}

/** Drops the least valuable unpinned entries when the lexicon outgrows its cap. */
function cap(entries: LexiconEntry[]): LexiconEntry[] {
  if (entries.length <= MAX_LEXICON_ENTRIES) return entries
  const removable = entries.filter((e) => !e.pinned).sort((a, b) => a.count - b.count || a.lastSeen.localeCompare(b.lastSeen))
  const drop = new Set(removable.slice(0, entries.length - MAX_LEXICON_ENTRIES).map((e) => e.id))
  return entries.filter((e) => !drop.has(e.id))
}

/** Newest claim wins: no entry other than `keep` may still list `heardAs` as a wrong form. Correction entries left with nothing to map are dropped. */
function releaseHeardAs(entries: LexiconEntry[], heardAs: string, keep: LexiconEntry | null): LexiconEntry[] {
  const k = normKey(heardAs)
  return entries
    .map((e) => (e === keep ? e : { ...e, heardAs: e.heardAs.filter((h) => normKey(h) !== k) }))
    .filter((e) => e === keep || e.heardAs.length > 0 || e.source === 'manual' || e.pinned)
}

// ── Learning ─────────────────────────────────────────────────────────────────

export interface LearnResult {
  entries: LexiconEntry[]
  /** The entry that was created or reinforced; null when the pair only undid an earlier substitution. */
  entry: LexiconEntry | null
}

/** Records one confirmed correction. Never mutates the list it is given. */
export function learnPair(current: LexiconEntry[], pair: WordPair, now: string): LearnResult {
  const heardKey = normKey(pair.heardAs)
  const termKey = normKey(pair.term)
  let list = clone(current)

  // The user changed one of OUR substitutions back to the original wording: that entry misfired.
  // Forget that wrong form instead of learning the reverse mapping.
  const misfired = list.find((e) => normKey(e.term) === heardKey && e.heardAs.some((h) => normKey(h) === termKey))
  if (misfired) {
    misfired.heardAs = misfired.heardAs.filter((h) => normKey(h) !== termKey)
    misfired.lastSeen = now
    list = list.filter((e) => e !== misfired || e.heardAs.length > 0 || e.source === 'manual' || e.pinned)
    return { entries: list, entry: null }
  }

  const existing = list.find((e) => normKey(e.term) === termKey) ?? null
  list = releaseHeardAs(list, pair.heardAs, existing)

  if (existing) {
    if (!existing.heardAs.some((h) => normKey(h) === heardKey)) existing.heardAs.push(pair.heardAs)
    existing.term = pair.term
    existing.count += 1
    existing.lastSeen = now
    return { entries: list, entry: existing }
  }

  const entry: LexiconEntry = {
    id: randomUUID(),
    term: pair.term,
    heardAs: [pair.heardAs],
    count: 1,
    enabled: true,
    pinned: false,
    source: 'correction',
    createdAt: now,
    lastSeen: now
  }
  list.push(entry)
  return { entries: cap(list), entry }
}

/** Trims, de-duplicates and bounds a list of wrong forms typed in by the user; drops any that equal the term itself. */
function cleanVariants(termKey: string, heardAs: string[]): string[] {
  const variants: string[] = []
  for (const h of heardAs) {
    const v = h.normalize('NFC').replace(/\s+/g, ' ').trim()
    if (!v || v.length > MAX_MANUAL_CHARS || normKey(v) === termKey) continue
    if (variants.some((x) => normKey(x) === normKey(v))) continue
    variants.push(v)
  }
  return variants.slice(0, MAX_MANUAL_VARIANTS)
}

/** Adds a term typed in by the user, optionally with the wrong forms it tends to be heard as. Null when the term is empty/too long. */
export function addManualEntry(
  current: LexiconEntry[],
  term: string,
  heardAs: string[],
  now: string
): LearnResult | null {
  const cleanTerm = term.normalize('NFC').replace(/\s+/g, ' ').trim()
  if (!cleanTerm || cleanTerm.length > MAX_MANUAL_CHARS) return null
  const termKey = normKey(cleanTerm)
  const variants = cleanVariants(termKey, heardAs)

  let list = clone(current)
  const existing = list.find((e) => normKey(e.term) === termKey) ?? null
  for (const v of variants) list = releaseHeardAs(list, v, existing)

  if (existing) {
    for (const v of variants) if (!existing.heardAs.some((h) => normKey(h) === normKey(v))) existing.heardAs.push(v)
    existing.term = cleanTerm
    existing.count += 1
    existing.lastSeen = now
    // Typed in by the user = explicitly wanted, whatever the entry started as.
    existing.source = 'manual'
    return { entries: list, entry: existing }
  }

  const entry: LexiconEntry = {
    id: randomUUID(),
    term: cleanTerm,
    heardAs: variants,
    count: 1,
    enabled: true,
    pinned: false,
    source: 'manual',
    createdAt: now,
    lastSeen: now
  }
  list.push(entry)
  return { entries: cap(list), entry }
}

// ── Using the lexicon ────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Regex source for a phrase: its words in order, separated by any whitespace. */
function phrasePattern(phrase: string): string {
  return phrase.normalize('NFC').trim().split(/\s+/).map(escapeRegex).join('\\s+')
}

const NOT_AFTER_WORD = '(?<![\\p{L}\\p{N}])'
const NOT_BEFORE_WORD = '(?![\\p{L}\\p{N}])'

/**
 * Replaces every known wrong form with the user's spelling, in one pass (so one replacement's
 * output can never be re-replaced by another rule). Whole words only, case-insensitive; a term
 * that is all lowercase keeps the capital the recognizer gave the word it replaces.
 */
export function applyReplacements(text: string, entries: LexiconEntry[]): string {
  const rules = new Map<string, string>()
  for (const e of [...entries].sort(byPriority)) {
    if (!replaces(e)) continue
    for (const h of e.heardAs) {
      const k = normKey(h)
      if (k && !rules.has(k)) rules.set(k, e.term)
    }
  }
  if (rules.size === 0) return text

  // Longest phrase first, so "cloud code" wins over "cloud".
  const alternatives = [...rules.keys()].sort((x, y) => y.length - x.length).map(phrasePattern)
  const re = new RegExp(`${NOT_AFTER_WORD}(?:${alternatives.join('|')})${NOT_BEFORE_WORD}`, 'giu')
  const source = text.normalize('NFC')
  return source.replace(re, (matched: string) => {
    const term = rules.get(normKey(matched))
    if (term === undefined) return matched
    if (/^\p{Lu}/u.test(matched) && /^\p{Ll}/u.test(term) && !/\p{Lu}/u.test(term)) {
      return term[0].toUpperCase() + term.slice(1)
    }
    return term
  })
}

/** Hint-only entries whose wrong form actually occurs in `text` — the only ones worth spending prompt tokens on. */
export function selectHints(text: string, entries: LexiconEntry[], limit = LLM_MAX_CORRECTION_HINTS): CorrectionHint[] {
  const source = text.normalize('NFC')
  const hints: CorrectionHint[] = []
  for (const e of entries.filter(isHint).sort(byPriority)) {
    const found = e.heardAs.find((h) => new RegExp(`${NOT_AFTER_WORD}${phrasePattern(h)}${NOT_BEFORE_WORD}`, 'iu').test(source))
    if (found === undefined) continue
    hints.push({ heardAs: found, term: e.term })
    if (hints.length >= limit) break
  }
  return hints
}

/**
 * The terms worth priming the speech recognizer with, best first: pinned entries, then the user's
 * own vocabulary list, then the rest by how often they were confirmed. Everyday-looking terms
 * learned from a single fix stay out — a short prompt is a better prompt.
 *
 * `relevance` scores a term for the current context (how often it shows up in what the user wrote
 * in this app / meeting space). It only matters when there are more candidates than `limit`: then
 * the unpinned terms that belong to this context beat equally-confirmed ones that do not. It is
 * not called at all when everything fits.
 */
export function selectTerms(
  manual: string[],
  entries: LexiconEntry[],
  limit: number,
  relevance?: (term: string) => number
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (term: string): void => {
    const k = normKey(term)
    if (!k || seen.has(k)) return
    seen.add(k)
    out.push(term)
  }

  const usable = entries.filter((e) => e.enabled)
  for (const e of usable.filter((x) => x.pinned).sort(byPriority)) push(e.term)
  for (const t of manual) push(t)
  const rest = usable.filter(
    (x) => !x.pinned && (x.source === 'manual' || x.count >= LEXICON_REPLACE_MIN_COUNT || isTermLike(x.term))
  )
  rest.sort(byPriority)
  if (relevance && out.length + rest.length > limit) {
    const score = new Map(rest.map((e) => [e.id, relevance(e.term)]))
    rest.sort((x, y) => (score.get(y.id) ?? 0) - (score.get(x.id) ?? 0) || byPriority(x, y))
  }
  for (const e of rest) push(e.term)
  return out.slice(0, limit)
}
