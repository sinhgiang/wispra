import { EVAL_MAX_RECORDS, EVAL_WEEKS_SHOWN } from '@shared/constants'
import type { EvalReport, EvalTotals } from '@shared/types'
import { countWordEdits } from './lexiconLogic'

/**
 * Pure logic of the "is learning helping?" statistics. Only counts are kept — never any text — as
 * one record per (day, learning on/off): how many dictations and words were typed, and how many of
 * them the user later fixed by hand (History → Edit) and by how many words.
 *
 * It is deliberately narrow: it measures fixes the user actually made, so it says nothing about
 * dictations they didn't bother to correct or about punctuation-only fixes (words are compared).
 */

export interface EvalRecord {
  /** Local calendar day of the dictation, YYYY-MM-DD. */
  day: string
  /** Whether "Learn from my corrections" was on when it was dictated. */
  learning: boolean
  dictations: number
  words: number
  /** Dictations with at least one word fixed. */
  edited: number
  /** Words changed by fixes. */
  edits: number
}

/** What one History fix says about a dictation. */
export interface FixFacts {
  /** What Wispra first typed. */
  original: string
  /** The text before this fix / after it (the user may fix the same entry several times). */
  before: string
  after: string
  /** When the dictation was made (the fix counts towards that day). */
  createdAt: string
  /** Unset on entries dictated before learning was tracked — those are left out. */
  learning?: boolean
}

export interface FixDelta {
  edited: number
  edits: number
}

// ── Calendar helpers (local time, plain arithmetic on the calendar — no 24h-day assumptions) ──

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function fromParts(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function toDate(day: string): Date | null {
  const m = DAY_RE.exec(day)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return fromParts(d) === day ? d : null // rejects 2025-02-31 and friends
}

/** The local calendar day of a timestamp, or '' when it isn't a valid date. */
export function dayOf(when: string | Date): string {
  const d = typeof when === 'string' ? new Date(when) : when
  return Number.isNaN(d.getTime()) ? '' : fromParts(d)
}

export function addDays(day: string, n: number): string {
  const d = toDate(day)
  if (!d) return ''
  d.setDate(d.getDate() + n)
  return fromParts(d)
}

/** The Monday of the week that contains `day`. */
export function weekStart(day: string): string {
  const d = toDate(day)
  if (!d) return ''
  return addDays(day, -((d.getDay() + 6) % 7))
}

export function isDay(day: unknown): day is string {
  return typeof day === 'string' && toDate(day) !== null
}

// ── Recording ────────────────────────────────────────────────────────────────

function find(records: EvalRecord[], day: string, learning: boolean): number {
  return records.findIndex((r) => r.day === day && r.learning === learning)
}

/** Oldest days go first once there are too many records. */
function capped(records: EvalRecord[]): EvalRecord[] {
  if (records.length <= EVAL_MAX_RECORDS) return records
  return [...records].sort((a, b) => a.day.localeCompare(b.day)).slice(-EVAL_MAX_RECORDS)
}

/** One more dictation of `words` words. */
export function addDictation(records: EvalRecord[], day: string, learning: boolean, words: number): EvalRecord[] {
  if (!isDay(day) || words < 0) return records
  const at = find(records, day, learning)
  if (at < 0) return capped([...records, { day, learning, dictations: 1, words, edited: 0, edits: 0 }])
  const r = records[at]
  const next = { ...r, dictations: r.dictations + 1, words: r.words + words }
  return records.map((x, i) => (i === at ? next : x))
}

/**
 * What one fix changes. Null when it can't be measured: the entry predates tracking, or the texts
 * are too long to compare. Both sides are measured against the text Wispra first typed, so fixing
 * the same entry twice moves the count by the difference, and undoing a fix takes it back.
 */
export function fixDelta(fix: FixFacts): FixDelta | null {
  if (fix.learning === undefined) return null
  const prev = fix.before === fix.original ? 0 : countWordEdits(fix.original, fix.before)
  const next = fix.after === fix.original ? 0 : countWordEdits(fix.original, fix.after)
  if (prev === null || next === null) return null
  return { edited: (next > 0 ? 1 : 0) - (prev > 0 ? 1 : 0), edits: next - prev }
}

/**
 * Applies a fix to its dictation's day. A fix whose dictation was never counted (statistics were
 * reset since, or the day fell off the end of the log) is left out rather than counted alone.
 */
export function addFix(records: EvalRecord[], day: string, learning: boolean, delta: FixDelta): EvalRecord[] {
  const at = find(records, day, learning)
  if (at < 0) return records
  const r = records[at]
  const next = {
    ...r,
    edited: Math.min(r.dictations, Math.max(0, r.edited + delta.edited)),
    edits: Math.max(0, r.edits + delta.edits)
  }
  return records.map((x, i) => (i === at ? next : x))
}

// ── Reporting ────────────────────────────────────────────────────────────────

/** Word edits per 100 dictated words, one decimal; null while nothing was dictated. */
export function rateOf(edits: number, words: number): number | null {
  return words > 0 ? Math.round((edits / words) * 1000) / 10 : null
}

export function totalsOf(records: readonly EvalRecord[]): EvalTotals {
  let dictations = 0
  let words = 0
  let edited = 0
  let edits = 0
  for (const r of records) {
    dictations += r.dictations
    words += r.words
    edited += r.edited
    edits += r.edits
  }
  return { dictations, words, edited, edits, rate: rateOf(edits, words) }
}

/**
 * The last `weeksShown` weeks (Monday start, oldest first, empty weeks included so a gap shows as a
 * gap) and the learning on/off split over the same window — so the numbers on screen add up.
 */
export function buildReport(records: readonly EvalRecord[], today: string, weeksShown = EVAL_WEEKS_SHOWN): EvalReport {
  const thisWeek = weekStart(today)
  const starts: string[] = []
  for (let i = weeksShown - 1; i >= 0; i--) starts.push(addDays(thisWeek, -7 * i))

  const shown = new Set(starts)
  const inWindow = records.filter((r) => shown.has(weekStart(r.day)))
  return {
    weeks: starts.map((start) => ({ start, ...totalsOf(inWindow.filter((r) => weekStart(r.day) === start)) })),
    on: totalsOf(inWindow.filter((r) => r.learning)),
    off: totalsOf(inWindow.filter((r) => !r.learning)),
    all: totalsOf(inWindow)
  }
}

/** Keeps only well-formed records from a saved file, so a hand-edited or old file can't crash the app. */
export function sanitizeRecords(raw: unknown): EvalRecord[] {
  if (!Array.isArray(raw)) return []
  const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0)
  const out: EvalRecord[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Partial<EvalRecord>
    if (!isDay(r.day) || typeof r.learning !== 'boolean') continue
    const dictations = count(r.dictations)
    const at = find(out, r.day, r.learning)
    const rec = { day: r.day, learning: r.learning, dictations, words: count(r.words), edited: Math.min(dictations, count(r.edited)), edits: count(r.edits) }
    if (at < 0) out.push(rec)
    else out[at] = totalsMerge(out[at], rec)
  }
  return capped(out)
}

function totalsMerge(a: EvalRecord, b: EvalRecord): EvalRecord {
  const dictations = a.dictations + b.dictations
  return { ...a, dictations, words: a.words + b.words, edited: Math.min(dictations, a.edited + b.edited), edits: a.edits + b.edits }
}
