import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { MAX_HISTORY_ENTRIES } from '@shared/constants'
import type { TranscriptEntry } from '@shared/types'

/** Everything about a dictation besides its text. All optional: templates and older callers know less. */
export interface HistoryMeta {
  language?: string
  durationSeconds?: number
  topic?: string
  /** Speech-to-text output before any learned replacement or AI cleanup. */
  rawText?: string
  /** Process name of the app the text went into. */
  app?: string
  /** Id of the mode whose cleanup prompt ran. */
  mode?: string
  /** Whether "Learn from my corrections" was on. */
  learning?: boolean
}

/** What a History fix changed — enough for the lexicon (before/after) and the statistics (original, when, learning). */
export interface FixChange {
  before: string
  after: string
  /** What Wispra first typed (stays the same across repeated fixes). */
  original: string
  createdAt: string
  learning?: boolean
}

/** Recent transcripts, newest first, persisted as JSON in userData. */
class History {
  private entries: TranscriptEntry[] = []
  private listeners = new Set<(entries: TranscriptEntry[]) => void>()

  private get filePath(): string {
    return join(app.getPath('userData'), 'history.json')
  }

  load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'))
      this.entries = Array.isArray(raw) ? raw : []
    } catch {
      this.entries = []
    }
  }

  list(): TranscriptEntry[] {
    return [...this.entries]
  }

  add(text: string, meta: HistoryMeta = {}): void {
    this.entries.unshift({
      id: randomUUID(),
      text,
      createdAt: new Date().toISOString(),
      ...meta
    })
    this.entries = this.entries.slice(0, MAX_HISTORY_ENTRIES)
    this.persist()
  }

  /**
   * The user corrected an entry's text. Keeps the first version Wispra produced in `originalText`
   * (so repeated edits still compare against what was actually typed) and returns before/after,
   * or null when the entry is gone or the text didn't change.
   */
  fix(id: string, text: string): FixChange | null {
    const entry = this.entries.find((e) => e.id === id)
    const after = text.trim()
    if (!entry || !after || after === entry.text) return null
    const before = entry.text
    entry.originalText ??= before
    entry.text = after
    this.persist()
    return { before, after, original: entry.originalText, createdAt: entry.createdAt, learning: entry.learning }
  }

  clear(): void {
    this.entries = []
    this.persist()
  }

  onChange(fn: (entries: TranscriptEntry[]) => void): void {
    this.listeners.add(fn)
  }

  private persist(): void {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), 'utf8')
    } catch (err) {
      console.error('Failed to persist history:', err)
    }
    for (const fn of this.listeners) fn(this.list())
  }
}

export const history = new History()
