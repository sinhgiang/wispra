import { useState } from 'react'
import type { Settings, Template } from '@shared/types'

function genId(): string {
  return Math.random().toString(36).slice(2, 10)
}

interface TemplateFormState {
  keyword: string
  expansion: string
}

export function TemplatesSection({ settings }: { settings: Settings }): React.JSX.Element {
  const [form, setForm] = useState<TemplateFormState>({ keyword: '', expansion: '' })
  const [editId, setEditId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const templates = settings.templates ?? []

  function save(): void {
    const keyword = form.keyword.trim()
    const expansion = form.expansion.trim()
    if (!keyword) { setError('Keyword is required.'); return }
    if (!expansion) { setError('Expansion text is required.'); return }

    // Duplicate check (excluding the one being edited)
    const dup = templates.find(
      (t) => t.keyword.toLowerCase() === keyword.toLowerCase() && t.id !== editId
    )
    if (dup) { setError('A template with this keyword already exists.'); return }

    let updated: Template[]
    if (editId) {
      updated = templates.map((t) => t.id === editId ? { ...t, keyword, expansion } : t)
    } else {
      updated = [...templates, { id: genId(), keyword, expansion }]
    }
    void window.api.setSettings({ templates: updated })
    setForm({ keyword: '', expansion: '' })
    setEditId(null)
    setError(null)
  }

  function startEdit(t: Template): void {
    setEditId(t.id)
    setForm({ keyword: t.keyword, expansion: t.expansion })
    setError(null)
  }

  function cancelEdit(): void {
    setEditId(null)
    setForm({ keyword: '', expansion: '' })
    setError(null)
  }

  function remove(id: string): void {
    void window.api.setSettings({ templates: templates.filter((t) => t.id !== id) })
    if (editId === id) cancelEdit()
  }

  const isEditing = editId !== null

  return (
    <section>
      <h2>Voice Templates</h2>
      <p className="hint">
        Say the <strong>keyword</strong> exactly to expand it into the full text.
        Supports <code>[date]</code> and <code>[time]</code> variables.
      </p>

      {/* Add / Edit form */}
      <div className="tpl-form">
        <div className="tpl-form-row">
          <div className="form-group" style={{ flex: '1' }}>
            <label className="form-label">Keyword (say this)</label>
            <input
              type="text"
              className="tpl-input"
              placeholder='e.g. "my address"'
              value={form.keyword}
              onChange={(e) => { setForm((f) => ({ ...f, keyword: e.target.value })); setError(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') save() }}
            />
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Expansion (what gets typed)</label>
          <textarea
            className="tpl-textarea"
            placeholder='e.g. "Best regards, John Smith — Senior Engineer"'
            value={form.expansion}
            rows={3}
            onChange={(e) => { setForm((f) => ({ ...f, expansion: e.target.value })); setError(null) }}
          />
        </div>
        {error && <p className="tpl-error">{error}</p>}
        <div className="tpl-form-actions">
          <button className="btn-primary" onClick={save}>
            {isEditing ? 'Save changes' : 'Add template'}
          </button>
          {isEditing && (
            <button className="btn-secondary" onClick={cancelEdit}>Cancel</button>
          )}
        </div>
      </div>

      {/* Template list */}
      {templates.length > 0 && (
        <ul className="tpl-list">
          {templates.map((t) => (
            <li key={t.id} className="tpl-item">
              <div className="tpl-item-body">
                <span className="tpl-keyword">"{t.keyword}"</span>
                <span className="tpl-arrow">→</span>
                <span className="tpl-expansion">
                  {t.expansion.length > 80 ? t.expansion.slice(0, 77) + '…' : t.expansion}
                </span>
              </div>
              <div className="tpl-item-actions">
                <button className="icon-btn" title="Edit" onClick={() => startEdit(t)}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M11.5 1.5a1.5 1.5 0 0 1 2.121 2.121L5 12.243l-2.5.5.5-2.5L11.5 1.5z"/>
                  </svg>
                </button>
                <button className="icon-btn danger" title="Delete" onClick={() => remove(t.id)}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M6 2h4a1 1 0 0 0-2 0H6a1 1 0 0 0-2 0H2v1h12V2h-2a1 1 0 0 0-2 0zM3 5l1 9h8l1-9H3z"/>
                  </svg>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {templates.length === 0 && (
        <p className="tpl-empty">
          No templates yet. Add one above — say the keyword to instantly expand it.
        </p>
      )}
    </section>
  )
}
