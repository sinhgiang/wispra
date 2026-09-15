import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { MeetingSpace } from '@shared/types'

/**
 * Persists Meeting Mode "spaces" — user-created groupings sessions can be filed
 * under (e.g. one per class) — as a single JSON array under userData/, mirroring
 * store.ts's pattern (settings.json). Unlike meetingSessions.ts, spaces are few
 * and small, so one file for the whole list is simpler than one file each.
 */
class MeetingSpaces {
  private spaces: MeetingSpace[] = []
  private loaded = false

  private get filePath(): string {
    return join(app.getPath('userData'), 'meeting-spaces.json')
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (Array.isArray(raw)) this.spaces = raw as MeetingSpace[]
    } catch {
      // First run or corrupted file — start with an empty list.
      this.spaces = []
    }
  }

  list(): MeetingSpace[] {
    this.ensureLoaded()
    return [...this.spaces]
  }

  create(name: string): MeetingSpace {
    this.ensureLoaded()
    const space: MeetingSpace = { id: randomUUID(), name, createdAt: new Date().toISOString() }
    this.spaces.push(space)
    this.persist()
    return space
  }

  /** No-ops if the space was already deleted. */
  rename(id: string, name: string): void {
    this.ensureLoaded()
    const space = this.spaces.find((s) => s.id === id)
    if (!space) return
    space.name = name
    this.persist()
  }

  /** No-ops if already gone. Does NOT touch any session's spaceId — see clearSpace() in meetingSessions.ts, called separately by the IPC handler so sessions fall back to unfiled instead of pointing at a space that no longer exists. */
  delete(id: string): void {
    this.ensureLoaded()
    this.spaces = this.spaces.filter((s) => s.id !== id)
    this.persist()
  }

  private persist(): void {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.spaces, null, 2), 'utf8')
    } catch (err) {
      console.error('[meeting] failed to persist spaces:', err)
    }
  }
}

export const meetingSpaces = new MeetingSpaces()
