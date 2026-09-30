import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { MeetingSession, MeetingSessionSummary } from '../types'

function meetingsDir(userDataPath: string): string {
  return join(userDataPath, 'meetings')
}

/** Mirrors meetingSessions.ts's list() — newest first, skips unparseable files, no segment text loaded. */
export function listMeetingSummaries(userDataPath: string): MeetingSessionSummary[] {
  let files: string[] = []
  try {
    files = readdirSync(meetingsDir(userDataPath)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const summaries: MeetingSessionSummary[] = []
  for (const f of files) {
    try {
      const session = JSON.parse(readFileSync(join(meetingsDir(userDataPath), f), 'utf8')) as MeetingSession
      summaries.push({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        durationMs: session.durationMs,
        audioSource: session.audioSource,
        status: session.status,
        spaceId: session.spaceId
      })
    } catch {
      // Skip a corrupt/partial file rather than failing the whole list.
    }
  }
  summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return summaries
}

/** Reads one session's full file, including segments — mirrors meetingSessions.ts's get(). */
export function getMeeting(userDataPath: string, id: string): MeetingSession | null {
  try {
    return JSON.parse(readFileSync(join(meetingsDir(userDataPath), `${id}.json`), 'utf8')) as MeetingSession
  } catch {
    return null
  }
}

/** Reads every session's full file — used only by search, which needs segment text. */
export function listAllMeetings(userDataPath: string): MeetingSession[] {
  let files: string[] = []
  try {
    files = readdirSync(meetingsDir(userDataPath)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const sessions: MeetingSession[] = []
  for (const f of files) {
    try {
      sessions.push(JSON.parse(readFileSync(join(meetingsDir(userDataPath), f), 'utf8')) as MeetingSession)
    } catch {
      // Skip a corrupt/partial file rather than failing the whole search.
    }
  }
  sessions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return sessions
}
