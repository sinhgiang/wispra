import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta'])

function acceleratorFrom(e: React.KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  const mods: string[] = []
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl')
  if (e.shiftKey) mods.push('Shift')
  if (e.altKey) mods.push('Alt')
  if (mods.length === 0) return null

  let key = e.key
  if (key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toUpperCase()
  else if (key.startsWith('Arrow')) key = key.slice(5)
  return [...mods, key].join('+')
}

function renderAccelerator(hotkey: string): React.JSX.Element[] {
  return hotkey
    .replace('CommandOrControl', 'Ctrl')
    .split('+')
    .map((part, i) => <kbd key={i}>{part}</kbd>)
}

export function HotkeySection({ settings }: { settings: Settings }): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)
  const [display, setDisplay] = useState(settings.hotkey)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setDisplay(settings.hotkey), [settings.hotkey])

  async function onKeyDown(e: React.KeyboardEvent): Promise<void> {
    if (!capturing) return
    e.preventDefault()
    const accelerator = acceleratorFrom(e)
    if (!accelerator) return
    setCapturing(false)
    const result = await window.api.applyHotkey(accelerator)
    if (result.ok) {
      setDisplay(accelerator)
      setError(null)
    } else {
      setError(result.error ?? 'Could not set the hotkey.')
    }
  }

  return (
    <section>
      <h2>Dictation Hotkey</h2>
      <p className="hint">Press anywhere to start or stop dictation.</p>
      <div className="input-row">
        {capturing ? (
          <input
            type="text"
            readOnly
            autoFocus
            className="capturing"
            value="Press a key combination…"
            onKeyDown={(e) => void onKeyDown(e)}
            onBlur={() => setCapturing(false)}
          />
        ) : (
          <div className="kbd-display">
            {renderAccelerator(display)}
          </div>
        )}
        <button onClick={() => { setCapturing(!capturing); setError(null) }}>
          {capturing ? 'Cancel' : 'Change'}
        </button>
      </div>
      {error && <p className="status err">{error}</p>}
    </section>
  )
}
