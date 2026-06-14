import { useState } from 'react'
import type { Settings } from '@shared/types'

export function VocabularySection({ settings }: { settings: Settings }): React.JSX.Element {
  const [input, setInput] = useState('')

  const vocabulary = settings.vocabulary ?? []

  function addTerm(): void {
    const term = input.trim()
    if (!term || vocabulary.includes(term)) {
      setInput('')
      return
    }
    void window.api.setSettings({ vocabulary: [...vocabulary, term] })
    setInput('')
  }

  function removeTerm(term: string): void {
    void window.api.setSettings({ vocabulary: vocabulary.filter((t) => t !== term) })
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') addTerm()
  }

  return (
    <section>
      <h2>Custom vocabulary</h2>
      <p className="hint">
        Add proper nouns, names, or technical terms that AI cleanup should preserve exactly — e.g.
        &ldquo;Nguyễn Văn A&rdquo;, &ldquo;GPT-4o&rdquo;. Only applies when AI cleanup is on.
      </p>

      <div className="input-row" style={{ marginBottom: '10px' }}>
        <input
          type="text"
          value={input}
          placeholder="Add a word or phrase…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button onClick={addTerm} disabled={!input.trim()}>
          Add
        </button>
      </div>

      {vocabulary.length > 0 && (
        <ul className="vocab-list">
          {vocabulary.map((term) => (
            <li key={term} className="vocab-item">
              <span className="vocab-term">{term}</span>
              <button className="icon-btn danger" title="Remove" onClick={() => removeTerm(term)}>
                <RemoveIcon />
              </button>
            </li>
          ))}
        </ul>
      )}

      {vocabulary.length === 0 && (
        <p style={{ fontSize: '13px', color: 'var(--text-3)', marginTop: '4px' }}>
          No custom terms yet.
        </p>
      )}
    </section>
  )
}

function RemoveIcon(): React.JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <path d="M1 1L10 10M10 1L1 10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}
