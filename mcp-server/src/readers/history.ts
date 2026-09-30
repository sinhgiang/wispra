import { readFileSync } from 'fs'
import { join } from 'path'
import type { TranscriptEntry } from '../types'

/** Reads userData/history.json — newest-first array of TranscriptEntry, capped at 100 by the app. */
export function readHistory(userDataPath: string): TranscriptEntry[] {
  try {
    const raw = JSON.parse(readFileSync(join(userDataPath, 'history.json'), 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}
