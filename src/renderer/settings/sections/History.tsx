import { useEffect, useState } from 'react'
import type { TranscriptEntry } from '@shared/types'

export function HistorySection(): React.JSX.Element {
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [copiedId, setCopiedId] = useState<string | null>(null)

  useEffect(() => {
    void window.api.getHistory().then(setEntries)
    window.api.onHistoryChanged(setEntries)
  }, [])

  function copy(entry: TranscriptEntry): void {
    window.api.copyText(entry.text)
    setCopiedId(entry.id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  return (
    <section>
      <div className="history-head">
        <h2>Recent Dictations</h2>
        {entries.length > 0 && (
          <button className="danger" onClick={() => void window.api.clearHistory()}>
            Clear all
          </button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="hint">Nothing yet — press the hotkey and start speaking.</p>
      ) : (
        <ul className="history">
          {entries.map((entry) => (
            <li key={entry.id}>
              <p>{entry.text}</p>
              <div className="meta">
                <span>{new Date(entry.createdAt).toLocaleString()}</span>
                <button onClick={() => copy(entry)}>
                  {copiedId === entry.id ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
