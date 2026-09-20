import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { LLM_PROMPT_MAX_TERMS, STT_PROMPT_MAX_TERMS } from '@shared/constants'
import type { LearnedPair, LexiconEntry } from '@shared/types'
import { store } from './store'
import {
  addManualEntry,
  applyReplacements,
  extractCorrections,
  learnPair,
  normKey,
  selectHints,
  selectTerms,
  type CorrectionHint
} from './lexiconLogic'

/** The user-editable fields of an entry. Wrong forms can only be removed, never added, so a patch can't create conflicts. */
export type LexiconPatch = Partial<Pick<LexiconEntry, 'enabled' | 'pinned' | 'heardAs'>>

/**
 * The user's personal lexicon: terms Wispra should spell their way, learned from their own fixes
 * (History → Edit) or typed in by hand. Persisted as JSON in userData/learning/. The learning and
 * replacement rules live in lexiconLogic.ts; this file is persistence + the settings on/off switch.
 *
 * `learningEnabled` off means Wispra neither learns nor applies anything (the list itself is kept),
 * so the effect of the feature can be compared with and without it.
 */
class Lexicon {
  private entries: LexiconEntry[] = []
  private listeners = new Set<(entries: LexiconEntry[]) => void>()

  private get dir(): string {
    return join(app.getPath('userData'), 'learning')
  }

  private get filePath(): string {
    return join(this.dir, 'lexicon.json')
  }

  load(): void {
    let text: string
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch {
      this.entries = [] // first run: no file yet
      return
    }
    try {
      const raw = JSON.parse(text)
      this.entries = Array.isArray(raw) ? raw.map(sanitize).filter((e): e is LexiconEntry => e !== null) : []
    } catch (err) {
      // Never overwrite a file we couldn't parse — keep it for the user to recover.
      console.error('Lexicon file is corrupt, starting empty:', err)
      try {
        renameSync(this.filePath, join(this.dir, 'lexicon.corrupt.json'))
      } catch {
        /* best effort */
      }
      this.entries = []
    }
  }

  private get on(): boolean {
    return store.get().learningEnabled
  }

  list(): LexiconEntry[] {
    return this.entries.map((e) => ({ ...e, heardAs: [...e.heardAs] }))
  }

  // ── Learning ───────────────────────────────────────────────────────────────

  /** Learns from one user fix (before = what Wispra typed, after = what the user made of it). Returns the pairs that were learned. */
  learnFromFix(before: string, after: string): LearnedPair[] {
    if (!this.on) return []
    const now = new Date().toISOString()
    const learned: LearnedPair[] = []
    let list = this.entries
    for (const pair of extractCorrections(before, after)) {
      const res = learnPair(list, pair, now)
      list = res.entries
      // An undone substitution changes the list but isn't something "learned".
      if (res.entry) learned.push(pair)
    }
    if (list !== this.entries) this.commit(list)
    return learned
  }

  add(term: string, heardAs: string[]): LexiconEntry | null {
    const res = addManualEntry(this.entries, term, heardAs, new Date().toISOString())
    if (!res) return null
    this.commit(res.entries)
    return res.entry
  }

  update(id: string, patch: LexiconPatch): boolean {
    const target = this.entries.find((e) => e.id === id)
    if (!target) return false
    const next: LexiconEntry = { ...target, heardAs: [...target.heardAs] }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    if (typeof patch.pinned === 'boolean') next.pinned = patch.pinned
    if (Array.isArray(patch.heardAs)) {
      const keep = new Set(patch.heardAs.map((h) => normKey(String(h))))
      next.heardAs = next.heardAs.filter((h) => keep.has(normKey(h)))
    }
    this.commit(this.entries.map((e) => (e.id === id ? next : e)))
    return true
  }

  remove(id: string): boolean {
    if (!this.entries.some((e) => e.id === id)) return false
    this.commit(this.entries.filter((e) => e.id !== id))
    return true
  }

  /** Forgets everything Wispra learned. Only ever called from the user's own "Reset" click. */
  reset(): void {
    this.commit([])
  }

  // ── Using what was learned (all no-ops while learning is switched off) ─────

  /**
   * Terms for the Whisper prompt: the user's custom vocabulary plus the most useful learned terms,
   * capped. `relevance` (contexts.ts) prefers the terms this app / meeting space actually uses.
   */
  sttTerms(manual: string[], relevance?: (term: string) => number): string[] {
    return this.on ? selectTerms(manual, this.entries, STT_PROMPT_MAX_TERMS, relevance) : manual.slice(0, STT_PROMPT_MAX_TERMS)
  }

  /** Terms for the AI-cleanup prompt (wider than the Whisper prompt). */
  llmTerms(manual: string[], relevance?: (term: string) => number): string[] {
    return this.on ? selectTerms(manual, this.entries, LLM_PROMPT_MAX_TERMS, relevance) : manual
  }

  /** Deterministic fixes for wrong forms the user has confirmed. */
  applyReplacements(text: string): string {
    return this.on ? applyReplacements(text, this.entries) : text
  }

  /** Not-yet-confirmed mishearings that occur in `text`, for the AI-cleanup step to judge by context. */
  hintsFor(text: string): CorrectionHint[] {
    return this.on ? selectHints(text, this.entries) : []
  }

  onChange(fn: (entries: LexiconEntry[]) => void): void {
    this.listeners.add(fn)
  }

  private commit(next: LexiconEntry[]): void {
    this.entries = next
    try {
      mkdirSync(this.dir, { recursive: true })
      // Write-then-rename so a crash mid-write can't leave a half-written lexicon behind.
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, JSON.stringify(this.entries, null, 2), 'utf8')
      renameSync(tmp, this.filePath)
    } catch (err) {
      console.error('Failed to persist lexicon:', err)
    }
    for (const fn of this.listeners) fn(this.list())
  }
}

/** Drops anything in the file that isn't a well-formed entry, so a hand-edited or old file can't crash the app. */
function sanitize(raw: unknown): LexiconEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Partial<LexiconEntry>
  if (typeof e.id !== 'string' || typeof e.term !== 'string' || !e.term.trim()) return null
  const now = new Date().toISOString()
  return {
    id: e.id,
    term: e.term,
    heardAs: Array.isArray(e.heardAs) ? e.heardAs.filter((h): h is string => typeof h === 'string' && h.trim() !== '') : [],
    count: typeof e.count === 'number' && e.count > 0 ? Math.floor(e.count) : 1,
    enabled: e.enabled !== false,
    pinned: e.pinned === true,
    source: e.source === 'manual' ? 'manual' : 'correction',
    createdAt: typeof e.createdAt === 'string' ? e.createdAt : now,
    lastSeen: typeof e.lastSeen === 'string' ? e.lastSeen : now
  }
}

export const lexicon = new Lexicon()
