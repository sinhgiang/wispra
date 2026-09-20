import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { StyleProfile } from '@shared/types'
import { history } from './history'
import { store } from './store'
import { cleanNotes, detectHabits, fixedPairs, renderStyleBlock, selectExemplars, usableAsExample } from './styleLogic'

/** Habit switches remembered at most (the list only ever holds ids the user turned off). */
const MAX_OFF = 200

/**
 * The user's writing style, as shown in the Learned tab and passed to the AI cleanup step.
 *
 * Nothing here is stored about the text itself: habits and examples are recomputed from History
 * (the user's own fixes, see styleLogic.ts) each time. The one file written is
 * userData/learning/style.json — the user's own notes and which detected habits they switched off.
 */
class Style {
  private notes = ''
  /** Habit ids the user switched off (a habit that is gone and comes back keeps its switch). */
  private off: string[] = []

  private get dir(): string {
    return join(app.getPath('userData'), 'learning')
  }

  private get filePath(): string {
    return join(this.dir, 'style.json')
  }

  load(): void {
    let text: string
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch {
      return // first run: no file yet
    }
    try {
      const raw = JSON.parse(text)
      this.notes = typeof raw?.notes === 'string' ? cleanNotes(raw.notes) : ''
      this.off = Array.isArray(raw?.off) ? raw.off.filter((x: unknown): x is string => typeof x === 'string') : []
    } catch (err) {
      // The notes are the user's own writing — keep an unreadable file for them to recover, don't overwrite it.
      console.error('Style file is corrupt, starting empty:', err)
      try {
        renameSync(this.filePath, join(this.dir, 'style.corrupt.json'))
      } catch {
        /* best effort */
      }
      this.notes = ''
      this.off = []
    }
  }

  profile(): StyleProfile {
    const pairs = fixedPairs(history.list())
    return {
      notes: this.notes,
      habits: detectHabits(pairs).map((h) => ({ ...h, enabled: !this.off.includes(h.id) })),
      exampleCount: pairs.filter(usableAsExample).length
    }
  }

  setNotes(notes: string): StyleProfile {
    this.notes = cleanNotes(typeof notes === 'string' ? notes : '')
    this.persist()
    return this.profile()
  }

  setHabitEnabled(id: string, enabled: boolean): StyleProfile {
    if (typeof id === 'string' && id) {
      const rest = this.off.filter((x) => x !== id)
      this.off = (enabled ? rest : [...rest, id]).slice(-MAX_OFF)
      this.persist()
    }
    return this.profile()
  }

  /** Clears the notes and switches every habit back on. The learned examples live in History and are not touched. */
  reset(): StyleProfile {
    this.notes = ''
    this.off = []
    this.persist()
    return this.profile()
  }

  /**
   * The style section for one AI cleanup call: the user's notes, their enabled habits, and the past
   * fixes most like `text`. Empty when learning is off or there is nothing to say yet.
   */
  blockFor(text: string, ctx: { app?: string; mode?: string }): string {
    if (!store.get().learningEnabled) return ''
    const pairs = fixedPairs(history.list())
    const habits = detectHabits(pairs).filter((h) => !this.off.includes(h.id))
    return renderStyleBlock({ notes: this.notes, habits, exemplars: selectExemplars(pairs, text, ctx) })
  }

  private persist(): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, JSON.stringify({ notes: this.notes, off: this.off }), 'utf8')
      renameSync(tmp, this.filePath)
    } catch (err) {
      console.error('Failed to persist style settings:', err)
    }
  }
}

export const style = new Style()
