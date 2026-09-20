import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { SUGGEST_MAX_DISMISSED, SUGGEST_MAX_SESSIONS } from '@shared/constants'
import type { Suggestion } from '@shared/types'
import { history } from './history'
import { lexicon } from './lexicon'
import { meetingSessions } from './meetingSessions'
import { store } from './store'
import { computeSuggestions, type SuggestDoc } from './suggestLogic'

/**
 * Suggestions for the Learned tab: recurring mishearings and new names found in the user's own
 * History and finished Meetings (the mining itself is suggestLogic.ts). This file only gathers the
 * text, remembers which suggestions the user waved away, and turns an accepted one into a lexicon
 * entry.
 *
 * Read-only towards the user's data: History and meeting sessions are only ever read. The one file
 * written is userData/learning/dismissed.json (ids of suggestions the user chose to hide).
 */
class Suggestions {
  /** Ids in the order they were dismissed (oldest first), so the cap forgets the oldest. */
  private dismissed: string[] = []
  /** A finished meeting's transcript never changes, so it is read from disk once. */
  private meetingDocs = new Map<string, SuggestDoc | null>()

  private get dir(): string {
    return join(app.getPath('userData'), 'learning')
  }

  private get filePath(): string {
    return join(this.dir, 'dismissed.json')
  }

  load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'))
      this.dismissed = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
    } catch {
      this.dismissed = [] // first run, or unreadable: nothing is hidden
    }
  }

  /** Current suggestions, best first. Empty while learning is switched off. */
  list(): Suggestion[] {
    const settings = store.get()
    if (!settings.learningEnabled) return []
    return computeSuggestions({
      docs: [...this.historyDocs(), ...this.sessionDocs()],
      vocabulary: settings.vocabulary,
      entries: lexicon.list(),
      dismissed: new Set(this.dismissed)
    })
  }

  /** Adds a suggestion to the lexicon and hides it. Returns the refreshed list. */
  accept(id: string): Suggestion[] {
    const found = this.list().find((s) => s.id === id)
    // Not offered any more (already handled, or the data changed): nothing to add.
    if (found) {
      lexicon.add(found.term, found.heardAs ? [found.heardAs] : [])
      this.remember(id)
    }
    return this.list()
  }

  /** Never offer this suggestion again. Returns the refreshed list. */
  dismiss(id: string): Suggestion[] {
    this.remember(id)
    return this.list()
  }

  /** Forgets every dismissal — called when the user clears the whole lexicon, so "start over" means it. */
  resetDismissed(): void {
    this.dismissed = []
    this.persist()
  }

  private remember(id: string): void {
    if (typeof id !== 'string' || !id || this.dismissed.includes(id)) return
    this.dismissed = [...this.dismissed, id].slice(-SUGGEST_MAX_DISMISSED)
    this.persist()
  }

  private historyDocs(): SuggestDoc[] {
    return history.list().map((e) => ({
      id: `h:${e.id}`,
      // The recogniser's own output is where mishearings show; on older entries the best stand-in is what was first typed.
      asr: [e.rawText ?? e.originalText ?? e.text],
      final: [e.text]
    }))
  }

  private sessionDocs(): SuggestDoc[] {
    const docs: SuggestDoc[] = []
    const stopped = meetingSessions
      .list()
      .filter((s) => s.status === 'stopped')
      .slice(0, SUGGEST_MAX_SESSIONS)
    const live = new Set(stopped.map((s) => s.id))
    for (const id of this.meetingDocs.keys()) if (!live.has(id)) this.meetingDocs.delete(id)
    for (const { id } of stopped) {
      if (!this.meetingDocs.has(id)) {
        const session = meetingSessions.get(id)
        const texts = session ? session.segments.map((seg) => seg.text).filter((t) => t.trim() !== '') : []
        this.meetingDocs.set(id, texts.length > 0 ? { id: `m:${id}`, asr: texts, final: texts } : null)
      }
      const doc = this.meetingDocs.get(id)
      if (doc) docs.push(doc)
    }
    return docs
  }

  private persist(): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, JSON.stringify(this.dismissed), 'utf8')
      renameSync(tmp, this.filePath)
    } catch (err) {
      console.error('Failed to persist dismissed suggestions:', err)
    }
  }
}

export const suggestions = new Suggestions()
