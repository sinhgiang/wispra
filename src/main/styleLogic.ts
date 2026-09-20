import {
  STYLE_DROP_MIN_FIXES,
  STYLE_EXEMPLAR_MAX_CHARS,
  STYLE_EXEMPLARS_TOTAL_CHARS,
  STYLE_HABIT_MIN_FIXES,
  STYLE_HABIT_MIN_RATE,
  STYLE_MAX_EXEMPLARS,
  STYLE_MAX_FIXES_SCANNED,
  STYLE_MAX_HABITS,
  STYLE_NOTES_MAX_CHARS
} from '@shared/constants'
import type { StyleHabit, TranscriptEntry } from '@shared/types'
import { extractDeletions, normKey, words } from './lexiconLogic'

/**
 * Pure logic of the writing-style memory — no Electron, no file access.
 *
 * Where the style comes from: ONLY from dictations the user fixed by hand (History → Edit). Wispra's
 * own output says nothing about how the user writes (it would just echo the model's habits back),
 * so unfixed entries are never used. From the fixed ones it derives:
 *   - habits: things the user does to Wispra's text again and again (drops the final full stop,
 *     starts lowercase, cuts "kiểu như"), each only when it holds in most of the fixes where it
 *     could apply — and each can be switched off in the Learned tab;
 *   - examples: the few past fixes most like the text being cleaned right now (same words, same
 *     app, same mode), shown to the AI cleanup step as "this is what they wanted last time".
 */

/** One dictation the user corrected: what went in, what Wispra typed, what the user turned it into. */
export interface FixedPair {
  /** What the AI cleanup step received (the recognizer's raw text). */
  raw: string
  /** What Wispra typed. */
  before: string
  /** The user's own version. */
  after: string
  app?: string
  mode?: string
  createdAt: string
}

export type DetectedHabit = Omit<StyleHabit, 'enabled'>

/** The user's fixed dictations, newest first. Entries they never fixed (or fixed back to the original) are not included. */
export function fixedPairs(entries: readonly TranscriptEntry[]): FixedPair[] {
  const pairs: FixedPair[] = []
  for (const e of entries) {
    const before = e.originalText?.trim()
    const after = e.text.trim()
    if (!before || !after || before === after) continue
    pairs.push({ raw: (e.rawText ?? before).trim(), before, after, app: e.app, mode: e.mode, createdAt: e.createdAt })
  }
  return pairs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

// ── Habits ───────────────────────────────────────────────────────────────────

interface Feature {
  id: string
  /** The instruction given to the AI cleanup step. */
  text: string
  /** Could this habit have shown up in this fix at all? */
  applicable(p: FixedPair): boolean
  /** Did the user do it in this fix? */
  applied(p: FixedPair): boolean
}

const commas = (s: string): number => (s.match(/[,，]/g) ?? []).length
const endsSentence = (s: string): boolean => /[.!?…]["'”’)\]]?$/u.test(s)

const FEATURES: Feature[] = [
  {
    id: 'no-final-stop',
    text: 'Do not end the text with a full stop.',
    applicable: (p) => /\.$/.test(p.before),
    applied: (p) => !/\.$/.test(p.after)
  },
  {
    id: 'final-stop',
    text: 'Always end the text with a full stop (or ? / ! where it fits).',
    applicable: (p) => !endsSentence(p.before),
    applied: (p) => endsSentence(p.after)
  },
  {
    id: 'lower-start',
    text: 'Start the text with a lowercase letter (keep capitals on names and acronyms).',
    applicable: (p) => /^\p{Lu}\p{Ll}/u.test(p.before),
    applied: (p) => /^\p{Ll}/u.test(p.after)
  },
  {
    id: 'upper-start',
    text: 'Always start the text with a capital letter.',
    applicable: (p) => /^\p{Ll}/u.test(p.before),
    applied: (p) => /^\p{Lu}/u.test(p.after)
  },
  {
    id: 'fewer-commas',
    text: 'Use fewer commas — only where a reader would really pause.',
    applicable: (p) => commas(p.before) >= 2,
    applied: (p) => commas(p.after) < commas(p.before)
  },
  {
    id: 'more-commas',
    text: 'Put commas between clauses.',
    applicable: (p) => words(p.before).length >= 12,
    applied: (p) => commas(p.after) > commas(p.before)
  }
]

/** Habits that ask for opposite things: if both look true (different kinds of fixes), only the stronger one is kept. */
const CONFLICTS: Array<[string, string]> = [
  ['no-final-stop', 'final-stop'],
  ['lower-start', 'upper-start'],
  ['fewer-commas', 'more-commas']
]

interface Candidate extends DetectedHabit {
  rate: number
  total: number
}

/** "Wispra wrote it with a capital, I made it lowercase" needs the same words in the same order, whole words only. */
function containsPhrase(text: string, phrase: string): boolean {
  const haystack = ` ${words(text).map(normKey).join(' ')} `
  return haystack.includes(` ${phrase} `)
}

/**
 * Habits the user's fixes agree on. Needs STYLE_HABIT_MIN_FIXES fixes where the habit could apply,
 * holding in at least STYLE_HABIT_MIN_RATE of them — a single odd fix never makes a rule.
 */
export function detectHabits(pairs: readonly FixedPair[]): DetectedHabit[] {
  const scanned = pairs.slice(0, STYLE_MAX_FIXES_SCANNED)
  const found: Candidate[] = []

  for (const f of FEATURES) {
    const relevant = scanned.filter((p) => f.applicable(p))
    if (relevant.length < STYLE_HABIT_MIN_FIXES) continue
    const applied = relevant.filter((p) => f.applied(p)).length
    const rate = applied / relevant.length
    if (rate < STYLE_HABIT_MIN_RATE) continue
    found.push({
      id: f.id,
      text: f.text,
      evidence: `You did this in ${applied} of ${relevant.length} fixes`,
      rate,
      total: relevant.length
    })
  }

  const deleted = new Map<string, number>()
  for (const p of scanned) {
    for (const phrase of extractDeletions(p.before, p.after)) deleted.set(phrase, (deleted.get(phrase) ?? 0) + 1)
  }
  for (const [phrase, times] of deleted) {
    if (times < STYLE_DROP_MIN_FIXES) continue
    const present = scanned.filter((p) => containsPhrase(p.before, phrase)).length
    const rate = times / Math.max(present, times)
    if (rate < STYLE_HABIT_MIN_RATE) continue
    found.push({
      id: `drop:${phrase}`,
      text: `Cut “${phrase}” — the user deletes it from their dictations.`,
      evidence: `You deleted it in ${times} of ${present} fixes where it appeared`,
      rate,
      total: present
    })
  }

  const stronger = (a: Candidate, b: Candidate): number => b.rate - a.rate || b.total - a.total || a.id.localeCompare(b.id)
  const dropped = new Set<string>()
  for (const [x, y] of CONFLICTS) {
    const a = found.find((c) => c.id === x)
    const b = found.find((c) => c.id === y)
    if (a && b) dropped.add(stronger(a, b) <= 0 ? y : x)
  }
  return found
    .filter((c) => !dropped.has(c.id))
    .sort(stronger)
    .slice(0, STYLE_MAX_HABITS)
    .map(({ id, text, evidence }) => ({ id, text, evidence }))
}

// ── Examples ─────────────────────────────────────────────────────────────────

function tokenSet(text: string): Set<string> {
  return new Set(words(text).map(normKey))
}

/** Sørensen–Dice overlap of two word sets, 0..1. */
function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let common = 0
  for (const t of a) if (b.has(t)) common++
  return (2 * common) / (a.size + b.size)
}

/** Weights of the context signals on top of word overlap (0..1). Small on purpose — overlap decides, context breaks ties. */
const APP_BOOST = 0.25
const MODE_BOOST = 0.1
const RECENCY_BOOST = 0.05
/** Two examples this alike teach the same thing — only the better one is kept. */
const DUPLICATE_OVERLAP = 0.8

/** Short enough to be worth its tokens as a prompt example. */
export function usableAsExample(p: Pick<FixedPair, 'raw' | 'after'>): boolean {
  return p.raw.length <= STYLE_EXEMPLAR_MAX_CHARS && p.after.length <= STYLE_EXEMPLAR_MAX_CHARS
}

/**
 * The past fixes most worth showing while cleaning `text`: similar wording first, then the same
 * app and mode, then the newest. Long examples, near-duplicates and anything past the total size
 * budget are skipped. `pairs` must be newest first (see fixedPairs).
 */
export function selectExemplars(
  pairs: readonly FixedPair[],
  text: string,
  ctx: { app?: string; mode?: string },
  max = STYLE_MAX_EXEMPLARS
): FixedPair[] {
  const target = tokenSet(text)
  const scored = pairs
    .map((p, i) => {
      const tokens = tokenSet(p.raw)
      const score =
        dice(target, tokens) +
        (ctx.app && p.app === ctx.app ? APP_BOOST : 0) +
        (ctx.mode && p.mode === ctx.mode ? MODE_BOOST : 0) +
        RECENCY_BOOST * (1 - i / pairs.length)
      return { p, tokens, score }
    })
    .filter(({ p }) => usableAsExample(p))
    .sort((a, b) => b.score - a.score)

  const chosen: Array<{ p: FixedPair; tokens: Set<string> }> = []
  let size = 0
  for (const c of scored) {
    if (chosen.length >= max) break
    const cost = c.p.raw.length + c.p.after.length
    if (size + cost > STYLE_EXEMPLARS_TOTAL_CHARS) continue
    if (chosen.some((o) => dice(o.tokens, c.tokens) >= DUPLICATE_OVERLAP)) continue
    chosen.push(c)
    size += cost
  }
  return chosen.map((c) => c.p)
}

// ── The prompt block ─────────────────────────────────────────────────────────

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The user's own style notes, made safe for the prompt: one line, bounded. */
export function cleanNotes(notes: string): string {
  return oneLine(notes.normalize('NFC')).slice(0, STYLE_NOTES_MAX_CHARS).trim()
}

/**
 * The text spliced into the AI cleanup system prompt (before its critical rules). Empty when there
 * is nothing to say; otherwise ends with a blank line so it can be concatenated as-is.
 */
export function renderStyleBlock(input: {
  notes: string
  habits: readonly Pick<StyleHabit, 'text'>[]
  exemplars: readonly Pick<FixedPair, 'raw' | 'after'>[]
}): string {
  const notes = cleanNotes(input.notes)
  const parts: string[] = []

  if (notes || input.habits.length > 0) {
    const lines = ['The user has personal writing conventions — follow them:']
    if (notes) lines.push(`- In their own words: ${notes}`)
    for (const h of input.habits) lines.push(`- ${h.text}`)
    parts.push(lines.join('\n'))
  }

  if (input.exemplars.length > 0) {
    const lines = ['Earlier dictations this user corrected by hand (Raw = what was said, Final = what they wanted):']
    for (const e of input.exemplars) {
      lines.push(`Raw: “${oneLine(e.raw)}”`, `Final: “${oneLine(e.after)}”`)
    }
    lines.push('Imitate their conventions; never reuse the content of these examples.')
    parts.push(lines.join('\n'))
  }

  return parts.length > 0 ? `${parts.join('\n\n')}\n\n` : ''
}
