import { AUTO_REFRESH_DELAY_MS, AUTO_SESSION_LIST_MAX_AGE_MS } from '@shared/constants'
import type { AutoTerm, Settings } from '@shared/types'
import { computeAutoTerms } from './autoVocabLogic'
import { lexicon } from './lexicon'
import { store } from './store'
import { suggestions } from './suggestions'

/**
 * Vocabulary Wispra learns by itself from the user's own History and finished Meetings, so the
 * recogniser gets their names and jargon right without the user having to fix anything first.
 * What is found (autoVocabLogic.ts) is only appended to the speech-recogniser prompt — see
 * Lexicon.sttTerms — never turned into a lexicon entry, a text replacement or an AI-cleanup rule.
 * The user sees the list in the Learned tab and can keep a term (making it one of their own words)
 * or remove it.
 *
 * Read-only towards the user's data. The one thing written is the shared list of hidden ids
 * (suggestions.hide), so a removed term stays removed. Nothing is computed while learning or
 * "Learn my vocabulary from History" is switched off.
 */
class AutoVocab {
  private cache: AutoTerm[] | null = null
  /** The settings the cache was computed from; a change to any of them means a new result. */
  private signature = ''
  private timer: NodeJS.Timeout | null = null
  /** A meeting was finished or deleted since the last computation, so the list of meetings must be re-read. */
  private rescanMeetings = false

  /** Terms for the recogniser prompt, strongest first. Never throws: dictation must not depend on this. */
  terms(): string[] {
    try {
      return this.list().map((t) => t.term)
    } catch (err) {
      console.error('Auto vocabulary failed:', err)
      return []
    }
  }

  /** What was learned, strongest first; empty while switched off. `fresh` re-reads the finished meetings too. */
  list(fresh = false): AutoTerm[] {
    const settings = store.get()
    const signature = signatureOf(settings)
    if (signature !== this.signature) {
      this.signature = signature
      this.cache = null
    }
    if (!settings.learningEnabled || !settings.autoLearnVocabulary) return []
    if (fresh) this.cache = null
    if (this.cache) return this.cache
    const maxAgeMs = fresh || this.rescanMeetings ? 0 : AUTO_SESSION_LIST_MAX_AGE_MS
    this.rescanMeetings = false
    this.cache = computeAutoTerms({
      docs: suggestions.docs(maxAgeMs),
      vocabulary: settings.vocabulary,
      entries: lexicon.list(),
      dismissed: suggestions.dismissedIds()
    })
    return this.cache
  }

  /** Makes the term one of the user's own words (spelling only — it never rewrites anything). Returns the refreshed list. */
  keep(id: string): AutoTerm[] {
    const found = this.list().find((t) => t.id === id)
    if (found) lexicon.add(found.term, [])
    return this.list(true)
  }

  /** Never learn the term again. Returns the refreshed list. */
  remove(id: string): AutoTerm[] {
    suggestions.hide(id)
    return this.list(true)
  }

  /**
   * What the result depends on changed (a dictation was added, the lexicon was edited, …): forget
   * it and recompute a moment later, in the background, so the next dictation finds it ready.
   * `meetingsChanged`: a meeting was finished or deleted, so re-read them rather than trusting the
   * recently listed set.
   */
  invalidate(meetingsChanged = false): void {
    this.cache = null
    if (meetingsChanged) this.rescanMeetings = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.terms()
    }, AUTO_REFRESH_DELAY_MS)
    this.timer.unref()
  }

  /** Settings hook: only the settings this depends on matter, not every saved change. */
  onSettingsChanged(settings: Settings): void {
    if (signatureOf(settings) !== this.signature) this.invalidate()
  }
}

function signatureOf(s: Settings): string {
  return `${s.learningEnabled}|${s.autoLearnVocabulary}|${s.vocabulary.join('\n')}`
}

export const autoVocab = new AutoVocab()
