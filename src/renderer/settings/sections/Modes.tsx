import { useState } from 'react'
import { LANGUAGES } from '@shared/constants'
import type { Mode, Settings } from '@shared/types'

function genId(): string {
  return `mode_${Date.now().toString(36)}`
}

function CheckIcon(): React.JSX.Element {
  return (
    <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
      <path d="M1 4L3.8 7L9 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function EditIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M9.5 1.5L11.5 3.5L4.5 10.5H2.5V8.5L9.5 1.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M2 3.5H11M4.5 3.5V2.5C4.5 2 5 1.5 5.5 1.5H7.5C8 1.5 8.5 2 8.5 2.5V3.5M5.5 6V10M7.5 6V10M3 3.5L3.5 11C3.5 11.5 4 12 4.5 12H8.5C9 12 9.5 11.5 9.5 11L10 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M1 1L11 11M11 1L1 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function PlusIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M6 1V11M1 6H11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

interface ModeModalProps {
  mode: Mode
  isNew: boolean
  onSave: (m: Mode) => void
  onClose: () => void
}

function ModeModal({ mode, isNew, onSave, onClose }: ModeModalProps): React.JSX.Element {
  const [draft, setDraft] = useState<Mode>(mode)

  function update<K extends keyof Mode>(key: K, value: Mode[K]): void {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  const canSave = draft.name.trim().length > 0

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{isNew ? 'New mode' : 'Edit mode'}</span>
          <button className="icon-btn" onClick={onClose} title="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">Name</label>
            <input
              type="text"
              value={draft.name}
              placeholder="e.g. Meeting notes"
              onChange={(e) => update('name', e.target.value)}
              autoFocus
            />
          </div>

          <div className="form-group">
            <label className="form-label">Custom prompt</label>
            <textarea
              value={draft.prompt}
              placeholder="Describe how to process speech… (leave empty to use the default)"
              rows={4}
              onChange={(e) => update('prompt', e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Language pin</label>
            <select
              value={draft.language}
              onChange={(e) => update('language', e.target.value)}
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
          </div>

          <label className="toggle-row" style={{ paddingTop: 6, paddingBottom: 0, borderTop: 'none' }}>
            <input
              type="checkbox"
              checked={draft.removeFiller}
              onChange={(e) => update('removeFiller', e.target.checked)}
            />
            <div className="toggle-info">
              <span className="toggle-label">Remove filler words</span>
              <span className="toggle-desc">Strip "ừm", "uh", "like", "you know", etc.</span>
            </div>
            <div className="toggle-switch" />
          </label>
        </div>

        <div className="modal-footer">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!canSave} onClick={() => onSave(draft)}>
            {isNew ? 'Create' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// These modes activate automatically based on language detection or focused app.
// They are kept in settings.modes for the routing engine but hidden from manual selection.
const AUTO_ROUTING_IDS = ['vietnamese', 'zalo', 'email']

export function ModesSection({ settings }: { settings: Settings }): React.JSX.Element {
  const [modal, setModal] = useState<{ open: boolean; mode: Mode | null }>({
    open: false,
    mode: null
  })

  function openAdd(): void {
    setModal({
      open: true,
      mode: { id: genId(), name: '', prompt: '', language: 'auto', removeFiller: true }
    })
  }

  function openEdit(mode: Mode, e: React.MouseEvent): void {
    e.stopPropagation()
    setModal({ open: true, mode: { ...mode } })
  }

  function closeModal(): void {
    setModal({ open: false, mode: null })
  }

  function setActive(id: string): void {
    void window.api.setSettings({ activeMode: id })
  }

  function deleteMode(id: string, e: React.MouseEvent): void {
    e.stopPropagation()
    const modes = settings.modes.filter((m) => m.id !== id)
    const activeMode = settings.activeMode === id ? 'general' : settings.activeMode
    void window.api.setSettings({ modes, activeMode })
  }

  function saveMode(mode: Mode): void {
    const exists = settings.modes.some((m) => m.id === mode.id)
    const modes = exists
      ? settings.modes.map((m) => (m.id === mode.id ? mode : m))
      : [...settings.modes, mode]
    void window.api.setSettings({ modes })
    closeModal()
  }

  const isNew = modal.mode ? !settings.modes.some((m) => m.id === modal.mode!.id) : true

  return (
    <>
      <section>
        <h2>Modes</h2>
        <p className="hint">
          Select a mode to control how AI cleanup processes your speech. Modes only apply when AI
          cleanup is enabled.
        </p>

        <div className="mode-list">
          {settings.modes.filter((m) => !AUTO_ROUTING_IDS.includes(m.id)).map((mode) => {
            const active = settings.activeMode === mode.id
            return (
              <div
                key={mode.id}
                className={`mode-item${active ? ' active' : ''}`}
                onClick={() => setActive(mode.id)}
              >
                <div className="mode-check">
                  {active && <CheckIcon />}
                </div>
                <div className="mode-info">
                  <span className="mode-name">{mode.name}</span>
                  <span className="mode-desc">
                    {mode.prompt || 'Fix spelling & punctuation, remove filler words'}
                  </span>
                </div>
                {mode.language !== 'auto' && (
                  <span className="mode-tag">{mode.language.toUpperCase()}</span>
                )}
                <div className="mode-btns">
                  <button
                    className="icon-btn"
                    title="Edit"
                    onClick={(e) => openEdit(mode, e)}
                  >
                    <EditIcon />
                  </button>
                  {!mode.builtIn && (
                    <button
                      className="icon-btn danger"
                      title="Delete"
                      onClick={(e) => deleteMode(mode.id, e)}
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <button style={{ marginTop: '10px' }} onClick={openAdd}>
          <PlusIcon /> New mode
        </button>
      </section>

      {modal.open && modal.mode && (
        <ModeModal
          mode={modal.mode}
          isNew={isNew}
          onSave={saveMode}
          onClose={closeModal}
        />
      )}
    </>
  )
}
