import { globalShortcut } from 'electron'
import type { HotkeyResult } from '@shared/types'

let current: string | null = null

/**
 * (Re)registers the global dictation hotkey.
 * Registration can fail silently in Electron when another app owns the
 * combination, so we verify with isRegistered and report the failure.
 */
export function registerHotkey(accelerator: string, onTrigger: () => void): HotkeyResult {
  if (current) {
    globalShortcut.unregister(current)
    current = null
  }
  try {
    const ok = globalShortcut.register(accelerator, onTrigger)
    if (!ok || !globalShortcut.isRegistered(accelerator)) {
      return {
        ok: false,
        error: `"${accelerator}" could not be registered — it may be taken by another app. Pick a different hotkey.`
      }
    }
    current = accelerator
    return { ok: true }
  } catch {
    return { ok: false, error: `"${accelerator}" is not a valid hotkey.` }
  }
}

export function unregisterAll(): void {
  globalShortcut.unregisterAll()
  current = null
}

export function isHotkeyRegistered(): boolean {
  return current !== null && globalShortcut.isRegistered(current)
}
