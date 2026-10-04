import { useEffect, useState } from 'react'
import type { PendingDictation } from '@shared/types'

function formatLength(seconds: number): string {
  const s = Math.round(seconds)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m} min ${s % 60} s` : `${s} s`
}

/**
 * Dictations whose audio is saved but not yet text (see dictationAudio.ts) — the
 * transcription failed (connection, a provider's limit, the server) or Wispra was closed
 * first. Nothing said is lost: "Try again" transcribes the saved recording and puts the text
 * in History and on the clipboard; "Delete" removes the recording. Hidden when there is none.
 */
export function PendingDictations(): React.JSX.Element | null {
  const [items, setItems] = useState<PendingDictation[]>([])
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [notes, setNotes] = useState<Record<string, { text: string; ok: boolean }>>({})

  useEffect(() => {
    void window.api.getPendingDictations().then(setItems)
    return window.api.onPendingDictationsChanged(setItems)
  }, [])

  if (items.length === 0 && Object.keys(notes).length === 0) return null

  const retry = async (id: string): Promise<void> => {
    setBusy((b) => ({ ...b, [id]: true }))
    setNotes((n) => {
      const next = { ...n }
      delete next[id]
      return next
    })
    const result = await window.api.retryDictation(id)
    setBusy((b) => ({ ...b, [id]: false }))
    setNotes((n) => ({
      ...n,
      [id]: result.ok
        ? { text: 'Transcribed — the text is in History below and copied to the clipboard.', ok: true }
        : { text: result.error ?? 'Could not transcribe it.', ok: false }
    }))
  }

  const remove = (id: string): void => {
    if (!window.confirm('Delete this recording? What was said in it cannot be transcribed afterwards.')) return
    void window.api.deletePendingDictation(id)
  }

  const done = Object.entries(notes).filter(([id, note]) => note.ok && !items.some((p) => p.id === id))

  return (
    <section className="pending-dictations">
      {items.length > 0 && (
        <>
          <h2>Recordings not transcribed yet</h2>
          <p className="pending-hint">
            These dictations are saved on this computer but could not be turned into text. Nothing is lost: try again
            when the problem is solved.
          </p>
        </>
      )}
      {items.map((p) => (
        <div key={p.id} className="pending-item">
          <div className="pending-info">
            <span className="pending-when">
              {new Date(p.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ·{' '}
              {formatLength(p.seconds)}
            </span>
            <span className="pending-error">{notes[p.id] && !notes[p.id].ok ? notes[p.id].text : p.error}</span>
          </div>
          <div className="pending-actions">
            <button type="button" className="primary" onClick={() => void retry(p.id)} disabled={busy[p.id]}>
              {busy[p.id] ? 'Transcribing…' : 'Try again'}
            </button>
            <button type="button" onClick={() => remove(p.id)} disabled={busy[p.id]}>
              Delete
            </button>
          </div>
        </div>
      ))}
      {done.map(([id, note]) => (
        <p key={id} className="pending-done">
          {note.text}
        </p>
      ))}
    </section>
  )
}
