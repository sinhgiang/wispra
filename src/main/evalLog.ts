import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { EvalReport } from '@shared/types'
import {
  addDictation,
  addFix,
  buildReport,
  dayOf,
  fixDelta,
  sanitizeRecords,
  type EvalRecord,
  type FixFacts
} from './evalLogic'

/**
 * Keeps the counts behind "is learning helping?" in userData/learning/eval.json. Counts only — no
 * dictated text ever lands in this file. All the arithmetic lives in evalLogic.ts; this is
 * persistence, and it never throws into the dictation flow (a failed write just loses a count).
 */
class EvalLog {
  private records: EvalRecord[] = []
  /** When the statistics were last reset: fixes to older dictations aren't counted afterwards. */
  private since = ''

  private get dir(): string {
    return join(app.getPath('userData'), 'learning')
  }

  private get filePath(): string {
    return join(this.dir, 'eval.json')
  }

  load(): void {
    let text: string
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch {
      return // first run: no file yet
    }
    try {
      const raw = JSON.parse(text) as { since?: unknown; records?: unknown }
      this.records = sanitizeRecords(raw?.records)
      this.since = typeof raw?.since === 'string' ? raw.since : ''
    } catch (err) {
      // Keep the unreadable file for the user to look at instead of overwriting it.
      console.error('Eval file is corrupt, starting empty:', err)
      try {
        renameSync(this.filePath, join(this.dir, 'eval.corrupt.json'))
      } catch {
        /* best effort */
      }
      this.records = []
      this.since = ''
    }
  }

  /** A dictation was typed. Call before it lands in History, so the History change event already sees it. */
  recordDictation(words: number, learning: boolean, when = new Date()): void {
    const day = dayOf(when)
    if (!day) return
    this.commit(addDictation(this.records, day, learning, words))
  }

  /** The user fixed a History entry. */
  recordFix(fix: FixFacts): void {
    if (fix.createdAt < this.since) return
    const day = dayOf(fix.createdAt)
    const delta = fixDelta(fix)
    if (!day || !delta || fix.learning === undefined) return
    this.commit(addFix(this.records, day, fix.learning, delta))
  }

  report(now = new Date()): EvalReport {
    return buildReport(this.records, dayOf(now))
  }

  /** Forgets the statistics. Only ever called from the user's own "Reset" click. */
  reset(): void {
    this.since = new Date().toISOString()
    this.commit([])
  }

  private commit(next: EvalRecord[]): void {
    if (next === this.records) return // nothing changed, nothing to write
    this.records = next
    try {
      mkdirSync(this.dir, { recursive: true })
      // Write-then-rename so a crash mid-write can't leave a half-written file behind.
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, JSON.stringify({ since: this.since, records: this.records }, null, 2), 'utf8')
      renameSync(tmp, this.filePath)
    } catch (err) {
      console.error('Failed to persist eval statistics:', err)
    }
  }
}

export const evalLog = new EvalLog()
