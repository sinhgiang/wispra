import { useEffect, useRef, useState } from 'react'
import type { StyleProfile } from '@shared/types'
import { STYLE_HABIT_MIN_FIXES, STYLE_NOTES_MAX_CHARS } from '@shared/constants'

/**
 * "Your writing style" (Learned tab): the user's own notes plus the habits Wispra noticed in the
 * dictations they fixed by hand. Everything here is editable, and nothing is applied that the user
 * can't see — the habits and the notes are exactly what the AI cleanup step is told.
 */
export function StyleCard({ aiCleanup }: { aiCleanup: boolean }): React.JSX.Element {
  const [profile, setProfile] = useState<StyleProfile | null>(null)
  const [draft, setDraft] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const draftRef = useRef('')
  const savedRef = useRef('')

  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      window.api
        .getStyle()
        .then((p) => {
          if (!alive) return
          setProfile(p)
          // Don't overwrite what the user is typing; only adopt the saved notes while there is no unsaved edit.
          if (draftRef.current === savedRef.current) {
            draftRef.current = p.notes
            setDraft(p.notes)
          }
          savedRef.current = p.notes
        })
        .catch(() => {
          /* optional card — keep whatever is shown */
        })
    }
    refresh()
    // Habits and examples come from History, so a new dictation or fix can change them.
    const off = window.api.onHistoryChanged(refresh)
    return () => {
      alive = false
      off()
      // Leaving the tab with an unsaved edit still saves it.
      if (draftRef.current !== savedRef.current) void window.api.setStyleNotes(draftRef.current)
    }
  }, [])

  useEffect(() => {
    if (!confirmReset) return
    const t = setTimeout(() => setConfirmReset(false), 4000)
    return () => clearTimeout(t)
  }, [confirmReset])

  function saveNotes(): void {
    if (draftRef.current === savedRef.current) return
    const text = draftRef.current
    savedRef.current = text
    window.api
      .setStyleNotes(text)
      .then((p) => {
        setProfile(p)
        savedRef.current = p.notes
        // The saved form is tidied (one line); show it once the user has left the field.
        draftRef.current = p.notes
        setDraft(p.notes)
      })
      .catch(() => {
        savedRef.current = '' // not saved: try again on the next blur
      })
  }

  function toggleHabit(id: string, enabled: boolean): void {
    void window.api.setStyleHabit(id, enabled).then(setProfile)
  }

  function reset(): void {
    if (!confirmReset) {
      setConfirmReset(true)
      return
    }
    setConfirmReset(false)
    void window.api.resetStyle().then((p) => {
      setProfile(p)
      savedRef.current = p.notes
      draftRef.current = p.notes
      setDraft(p.notes)
    })
  }

  const habits = profile?.habits ?? []
  const resettable = !!profile && (profile.notes !== '' || habits.some((h) => !h.enabled))

  return (
    <>
      <div className="learned-head">
        <h3 className="learned-sub">Your writing style</h3>
        {resettable && (
          <button className={`danger${confirmReset ? ' armed' : ''}`} onClick={reset}>
            {confirmReset ? 'Click again to reset' : 'Reset style'}
          </button>
        )}
      </div>
      <p className="hint learned-note">
        {aiCleanup
          ? 'Passed to the AI cleanup with every dictation, so the text comes out the way you write.'
          : 'Used by the AI cleanup — turn it on in Dictate to apply your style.'}
      </p>

      <div className="style-notes">
        <textarea
          rows={2}
          value={draft}
          maxLength={STYLE_NOTES_MAX_CHARS}
          placeholder="In your own words — e.g. short sentences, casual tone, never use exclamation marks"
          onChange={(e) => {
            draftRef.current = e.target.value
            setDraft(e.target.value)
          }}
          onBlur={saveNotes}
        />
        <span className="style-count">
          {draft.length}/{STYLE_NOTES_MAX_CHARS}
        </span>
      </div>

      <h3 className="learned-sub">
        Habits Wispra noticed <span className="learned-count">{habits.length}</span>
      </h3>
      {habits.length === 0 ? (
        <p className="learned-empty">
          None yet. Wispra looks for a change you keep making — after at least {STYLE_HABIT_MIN_FIXES} fixes
          in History (Edit) that show the same pattern.
        </p>
      ) : (
        <div className="style-habits">
          {habits.map((h) => (
            <label key={h.id} className="toggle-row">
              <input type="checkbox" checked={h.enabled} onChange={(e) => toggleHabit(h.id, e.target.checked)} />
              <div className="toggle-info">
                <span className="toggle-label">{h.text}</span>
                <span className="toggle-desc">{h.evidence}</span>
              </div>
              <div className="toggle-switch" />
            </label>
          ))}
        </div>
      )}

      <p className="hint learned-note">
        {profile && profile.exampleCount > 0
          ? `${profile.exampleCount} of your fixed dictations can be shown to the AI as examples — only the few closest to what you dictate, each time. They are sent to your AI cleanup provider together with the dictation.`
          : 'Once you have fixed a few dictations in History, the closest ones are shown to the AI as examples of how you write.'}
      </p>
    </>
  )
}
