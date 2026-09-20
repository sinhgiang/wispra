import { useEffect, useState } from 'react'
import type { LexiconEntry, Settings, Suggestion } from '@shared/types'
import { lexiconMode, type LexiconMode } from '@shared/lexiconMode'
import { StyleCard } from './StyleCard'
import { EvalCard } from './EvalCard'

const MODE_LABEL: Record<LexiconMode, string> = {
  replace:  'Always replace',
  hint:     'Hint only',
  spelling: 'Spelling',
  off:      'Off',
}

const MODE_TITLE: Record<LexiconMode, string> = {
  replace:  'Wispra swaps the wrong forms for this term automatically.',
  hint:     'Learned from one fix. The AI cleanup only applies it when the sentence clearly means this term. Fix it once more, or pin it, to always replace.',
  spelling: 'No wrong forms — Wispra just keeps this term spelled this way.',
  off:      'Switched off — ignored until you turn it back on.',
}

/** Splits a "heard as" field on commas / semicolons / line breaks into clean, non-empty variants. */
function splitVariants(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((v) => v.trim())
    .filter(Boolean)
}

/** The example text with the first occurrence of `needle` marked, so the user sees the word in their own sentence. */
function Highlighted({ text, needle }: { text: string; needle: string }): React.JSX.Element {
  const at = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1
  if (at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  )
}

function SuggestionCard({
  suggestion,
  busy,
  onAccept,
  onDismiss
}: {
  suggestion: Suggestion
  busy: boolean
  onAccept: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const isVariant = suggestion.kind === 'variant' && !!suggestion.heardAs
  const places = suggestion.sources === 1 ? '1 place' : `${suggestion.sources} places`
  return (
    <li className="suggest-item">
      <div className="suggest-main">
        <div className="suggest-title">
          {isVariant ? (
            <>
              Wispra wrote <b className="suggest-wrong">{suggestion.heardAs}</b> — did you mean{' '}
              <b>{suggestion.term}</b>?
            </>
          ) : (
            <>
              <b>{suggestion.term}</b> comes up a lot — keep it spelled this way?
            </>
          )}
        </div>
        <div className="suggest-meta">
          Seen {suggestion.count}× in {places}
          {isVariant ? ` · would be replaced with “${suggestion.term}”` : ' · added as a spelling to keep'}
        </div>
        {suggestion.example && (
          <div className="suggest-example">
            <Highlighted text={suggestion.example} needle={isVariant ? suggestion.heardAs! : suggestion.term} />
          </div>
        )}
      </div>
      <div className="suggest-actions">
        <button className="primary" disabled={busy} onClick={onAccept}>
          {isVariant ? 'Yes, replace it' : 'Add'}
        </button>
        <button className="copy-btn" disabled={busy} onClick={onDismiss}>
          {isVariant ? 'No' : 'Ignore'}
        </button>
      </div>
    </li>
  )
}

export function LearnedSection({ settings }: { settings: Settings }): React.JSX.Element {
  const [entries, setEntries] = useState<LexiconEntry[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [term, setTerm] = useState('')
  const [heardAs, setHeardAs] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const learning = settings.learningEnabled ?? true

  useEffect(() => {
    let alive = true
    const refreshSuggestions = (): void => {
      window.api
        .getSuggestions()
        .then((list) => {
          if (alive) setSuggestions(list)
        })
        .catch(() => {
          /* suggestions are optional — keep whatever is shown */
        })
    }
    void window.api.getLexicon().then((list) => {
      if (alive) setEntries(list)
    })
    refreshSuggestions()
    // A new lexicon entry (or a History fix) changes what is worth suggesting.
    const offLexicon = window.api.onLexiconChanged((list) => {
      setEntries(list)
      refreshSuggestions()
    })
    const offHistory = window.api.onHistoryChanged(refreshSuggestions)
    return () => {
      alive = false
      offLexicon()
      offHistory()
    }
  }, [learning])

  async function resolveSuggestion(id: string, act: (id: string) => Promise<Suggestion[]>): Promise<void> {
    setBusyId(id)
    try {
      setSuggestions(await act(id))
    } catch {
      /* the list refreshes on the next change; nothing to show */
    } finally {
      setBusyId(null)
    }
  }

  // The two-click Reset arms itself for a few seconds, then disarms.
  useEffect(() => {
    if (!confirmReset) return
    const t = setTimeout(() => setConfirmReset(false), 4000)
    return () => clearTimeout(t)
  }, [confirmReset])

  async function addEntry(): Promise<void> {
    const cleaned = term.trim()
    if (!cleaned) return
    setAddError(null)
    try {
      const ok = await window.api.addLexiconEntry(cleaned, splitVariants(heardAs))
      if (!ok) {
        setAddError('Could not add that term.')
        return
      }
      setTerm('')
      setHeardAs('')
    } catch {
      setAddError('Could not add that term.')
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') void addEntry()
  }

  function removeForm(entry: LexiconEntry, form: string): void {
    void window.api.updateLexiconEntry(entry.id, { heardAs: entry.heardAs.filter((h) => h !== form) })
  }

  function resetAll(): void {
    if (!confirmReset) {
      setConfirmReset(true)
      return
    }
    setConfirmReset(false)
    void window.api.resetLexicon()
  }

  return (
    <section>
      <h2>Learned</h2>
      <p className="hint">
        Wispra learns your spelling from the fixes you make in History (click <b>Edit</b> on a dictation).
        Fix a misheard word once and Wispra passes it to the AI cleanup; fix it again and it is replaced
        automatically. Nothing is learned unless you correct it yourself.
      </p>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={learning}
          onChange={(e) => void window.api.setSettings({ learningEnabled: e.target.checked })}
        />
        <div className="toggle-info">
          <span className="toggle-label">Learn from my corrections</span>
          <span className="toggle-desc">
            When off, Wispra neither learns new words nor applies the list below. Your list is kept.
          </span>
        </div>
        <div className="toggle-switch" />
      </label>

      {learning && suggestions.length > 0 && (
        <>
          <h3 className="learned-sub">
            Suggestions <span className="learned-count">{suggestions.length}</span>
          </h3>
          <p className="hint learned-note">
            Found by reading your History and meetings. Nothing changes until you press a button.
          </p>
          <ul className="suggest-list">
            {suggestions.map((s) => (
              <SuggestionCard
                key={s.id}
                suggestion={s}
                busy={busyId === s.id}
                onAccept={() => void resolveSuggestion(s.id, window.api.acceptSuggestion)}
                onDismiss={() => void resolveSuggestion(s.id, window.api.dismissSuggestion)}
              />
            ))}
          </ul>
        </>
      )}

      <h3 className="learned-sub">Add a term</h3>
      <div className="learned-add">
        <input
          type="text"
          value={term}
          placeholder="Correct spelling — e.g. Claude Code"
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <input
          type="text"
          value={heardAs}
          placeholder="Often misheard as (optional, comma-separated) — e.g. Cloud Code, Clod Code"
          onChange={(e) => setHeardAs(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button className="primary" onClick={() => void addEntry()} disabled={!term.trim()}>
          Add
        </button>
      </div>
      {addError && <p className="learned-error">{addError}</p>}
      <p className="hint learned-note">
        Terms you add here replace the misheard forms right away. The plain word list under
        Dictate → Custom vocabulary keeps working too.
      </p>

      <div className="learned-head">
        <h3 className="learned-sub">
          Your words <span className="learned-count">{entries.length}</span>
        </h3>
        {entries.length > 0 && (
          <button className={`danger${confirmReset ? ' armed' : ''}`} onClick={resetAll}>
            {confirmReset ? 'Click again to clear' : 'Clear all'}
          </button>
        )}
      </div>

      {entries.length === 0 ? (
        <p className="learned-empty">
          Nothing learned yet. Dictate something, then open History and fix a word Wispra got wrong.
        </p>
      ) : (
        <ul className={`learned-list${learning ? '' : ' learned-list--paused'}`}>
          {entries.map((entry) => {
            const mode = lexiconMode(entry)
            return (
              <li key={entry.id} className={`learned-item${entry.enabled ? '' : ' is-off'}`}>
                <div className="learned-main">
                  <div className="learned-top">
                    <span className="learned-term">{entry.term}</span>
                    <span className={`mode-badge mode-${mode}`} title={MODE_TITLE[mode]}>
                      {MODE_LABEL[mode]}
                    </span>
                    {entry.pinned && <span className="learned-pin" title="Pinned">📌</span>}
                  </div>

                  {entry.heardAs.length > 0 && (
                    <div className="learned-forms">
                      <span className="learned-forms-label">heard as</span>
                      {entry.heardAs.map((form) => (
                        <span key={form} className="form-chip">
                          {form}
                          <button
                            className="chip-x"
                            title={`Stop replacing “${form}”`}
                            onClick={() => removeForm(entry, form)}
                          >
                            <svg width="9" height="9" viewBox="0 0 11 11" fill="none">
                              <path d="M1 1L10 10M10 1L1 10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                            </svg>
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="learned-meta">
                    {entry.source === 'manual' ? 'Added by you' : `Fixed ${entry.count}×`}
                  </div>
                </div>

                <div className="learned-actions">
                  <button
                    className={`copy-btn${entry.pinned ? ' copied' : ''}`}
                    title="Pinned terms are always used and never pruned"
                    onClick={() => void window.api.updateLexiconEntry(entry.id, { pinned: !entry.pinned })}
                  >
                    {entry.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button
                    className="copy-btn"
                    onClick={() => void window.api.updateLexiconEntry(entry.id, { enabled: !entry.enabled })}
                  >
                    {entry.enabled ? 'Turn off' : 'Turn on'}
                  </button>
                  <button
                    className="icon-btn danger"
                    title="Delete"
                    onClick={() => void window.api.deleteLexiconEntry(entry.id)}
                  >
                    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                      <path d="M1 1L10 10M10 1L1 10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {learning && <StyleCard aiCleanup={settings.aiPostProcess} />}

      <EvalCard />
    </section>
  )
}
