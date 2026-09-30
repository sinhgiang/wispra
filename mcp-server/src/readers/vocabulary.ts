import { readFileSync } from 'fs'
import { join } from 'path'
import type { LexiconEntry } from '../types'

/**
 * Reads userData/learning/lexicon.json — the user's confirmed lexicon only. Deliberately does NOT
 * read autoVocab.ts's learned-terms output: those only bias the Whisper prompt and are not
 * confirmed vocabulary (see CLAUDE.md's lexicon vs. auto-vocab rule).
 */
export function readLexicon(userDataPath: string): LexiconEntry[] {
  try {
    const raw = JSON.parse(readFileSync(join(userDataPath, 'learning', 'lexicon.json'), 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}
