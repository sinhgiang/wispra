import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { Settings } from '@shared/types'

// Strip any persisted field that no longer exists in the schema.
function sanitize(raw: Record<string, unknown>): Partial<Settings> {
  const { _reserved: _, ...rest } = raw as Record<string, unknown> & { _reserved?: unknown }
  void _
  return rest as Partial<Settings>
}

/**
 * Plain-JSON settings store in userData. No runtime deps.
 * Settings are read once at startup and kept in memory; every set() persists.
 */
class SettingsStore {
  private settings: Settings = { ...DEFAULT_SETTINGS }
  private listeners = new Set<(settings: Settings) => void>()

  private get filePath(): string {
    return join(app.getPath('userData'), 'settings.json')
  }

  load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'))
      this.settings = { ...DEFAULT_SETTINGS, ...sanitize(raw) }
    } catch {
      // First run or corrupted file — fall back to defaults.
      this.settings = { ...DEFAULT_SETTINGS }
    }
  }

  get(): Settings {
    return { ...this.settings }
  }

  set(partial: Partial<Settings>): Settings {
    this.settings = { ...this.settings, ...partial }
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), 'utf8')
    } catch (err) {
      console.error('Failed to persist settings:', err)
    }
    for (const fn of this.listeners) fn(this.get())
    return this.get()
  }

  onChange(fn: (settings: Settings) => void): void {
    this.listeners.add(fn)
  }
}

export const store = new SettingsStore()
