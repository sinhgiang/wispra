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
  /** The finished meetings, as of `at` — listing them parses every session file, so callers that ask often may reuse it. */
  private stopped: { at: number; ids: string[] } | null = null
  /** Terms Wispra learned from History by itself (autoVocab.ts) — already used, so not suggested again. Injected, so this file doesn't depend on it. */
  private autoTerms: () => string[] = () => []

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

  setAutoTerms(provider: () => string[]): void {
    this.autoTerms = provider
  }

  /**
   * Current suggestions, best first. Empty while learning is switched off. A term Wispra already
   * learned by itself counts as known: it is not offered as a new term, and a recurring spelling
   * that sounds like it is offered as a variant of it.
   */
  list(): Suggestion[] {
    const settings = store.get()
    if (!settings.learningEnabled) return []
    return computeSuggestions({
      docs: this.docs(),
      vocabulary: [...settings.vocabulary, ...this.autoTerms()],
      entries: lexicon.list(),
      dismissed: new Set(this.dismissed)
    })
  }

  /**
   * Everything the user has written that learning may read: dictations and finished meetings.
   * `maxAgeMs` lets a caller that asks often reuse the list of finished meetings instead of
   * re-reading them all; a meeting stopped in the meantime shows up once it is that old.
   */
  docs(maxAgeMs = 0): SuggestDoc[] {
    return [...this.historyDocs(), ...this.sessionDocs(maxAgeMs)]
  }

  dismissedIds(): ReadonlySet<string> {
    return new Set(this.dismissed)
  }

  /** Never offer or learn `id` again (the user removed it). */
  hide(id: string): void {
    this.remember(id)
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

  private sessionDocs(maxAgeMs: number): SuggestDoc[] {
    const docs: SuggestDoc[] = []
    if (!this.stopped || Date.now() - this.stopped.at >= maxAgeMs) {
      const ids = meetingSessions
        .list()
        .filter((s) => s.status === 'stopped')
        .slice(0, SUGGEST_MAX_SESSIONS)
        .map((s) => s.id)
      this.stopped = { at: Date.now(), ids }
      const live = new Set(ids)
      for (const id of this.meetingDocs.keys()) if (!live.has(id)) this.meetingDocs.delete(id)
    }
    for (const id of this.stopped.ids) {
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
