/**
 * Local copies of the type shapes this server reads off disk. Mirrors the relevant slices of
 * ../../src/shared/types.ts — this package is self-contained (no cross-package imports, since a
 * published npm package can't reach outside itself at runtime), so keep these in sync by hand if
 * the app's shapes change.
 */

export interface TranscriptEntry {
  id: string
  text: string
  createdAt: string
  language?: string
  durationSeconds?: number
  topic?: string
  rawText?: string
  app?: string
  originalText?: string
  mode?: string
  learning?: boolean
}

export type MeetingAudioSource = 'mic' | 'system' | 'both'

export interface MeetingSegment {
  id: string
  text: string
  startMs: number
  endMs: number
  startedAt: string
  isNewParagraph: boolean
  topicLabel?: string
}

export interface MeetingSession {
  id: string
  title: string
  summary?: string
  createdAt: string
  durationMs: number
  audioSource: MeetingAudioSource
  segments: MeetingSegment[]
  status: 'recording' | 'summarizing' | 'stopped'
  spaceId?: string
}

export interface MeetingSessionSummary {
  id: string
  title: string
  createdAt: string
  durationMs: number
  audioSource: MeetingAudioSource
  status: 'recording' | 'summarizing' | 'stopped'
  spaceId?: string
}

export interface LexiconEntry {
  id: string
  term: string
  heardAs: string[]
  count: number
  enabled: boolean
  pinned: boolean
  source: 'manual' | 'correction'
  createdAt: string
  lastSeen: string
}

export interface UsageStats {
  totalDictations: number
  totalMinutes: number
  totalWords: number
  thisWeekDictations: number
  thisWeekMinutes: number
  streak: number
  mostActiveDay: string
}
