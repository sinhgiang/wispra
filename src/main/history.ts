import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { MAX_HISTORY_ENTRIES } from '@shared/constants'
import type { TranscriptEntry } from '@shared/types'

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

  add(text: string, language?: string, durationSeconds?: number, topic?: string): void {
    this.entries.unshift({
      id: randomUUID(),
      text,
      createdAt: new Date().toISOString(),
      language,
      durationSeconds,
      topic
    })
    this.entries = this.entries.slice(0, MAX_HISTORY_ENTRIES)
    this.persist()
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
