import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { auth } from './auth'
import { history } from './history'
import { lexicon } from './lexicon'
import { meetingSessions } from './meetingSessions'
import { store } from './store'
import {
  SYNC_DEBOUNCE_MS,
  SYNC_MEETINGS_PER_REQUEST,
  SYNC_STARTUP_DELAY_MS,
  SYNC_TIMEOUT_MS,
  WISPRA_API_BASE
} from '@shared/constants'
import type { MeetingSession, SyncStatus } from '@shared/types'

interface SyncState {
  lastSyncedAt?: string
  lastError?: string
}

let syncing = false
let lastError: string | null = null
const listeners = new Set<(status: SyncStatus) => void>()

function stateFilePath(): string {
  return join(app.getPath('userData'), 'sync.json')
}

function loadState(): SyncState {
  try {
    return JSON.parse(readFileSync(stateFilePath(), 'utf8')) as SyncState
  } catch {
    return {}
  }
}

function saveState(state: SyncState): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(stateFilePath(), JSON.stringify(state, null, 2), 'utf8')
  } catch (err) {
    console.error('Failed to persist sync state:', err)
  }
}

// meetingSessions.ts keeps its on-disk directory private, so this scan reconstructs
// the same path independently — the same precedent mcp-server/src/readers/meetings.ts
// already set for a read-only external reader of this directory.
function meetingsDir(): string {
  return join(app.getPath('userData'), 'meetings')
}

/** Sessions whose file was modified after `sinceIso` (or all of them, on first sync). */
function changedMeetings(sinceIso: string | undefined): MeetingSession[] {
  const dir = meetingsDir()
  if (!existsSync(dir)) return []
  const sinceMs = sinceIso ? Date.parse(sinceIso) : 0
  const sessions: MeetingSession[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const filePath = join(dir, file)
    try {
      if (statSync(filePath).mtimeMs <= sinceMs) continue
      sessions.push(JSON.parse(readFileSync(filePath, 'utf8')) as MeetingSession)
    } catch (err) {
      console.error(`Failed to read meeting session ${file} for sync:`, err)
    }
  }
  return sessions
}

export function getStatus(): SyncStatus {
  const state = loadState()
  return {
    enabled: store.get().cloudSyncEnabled,
    syncing,
    lastSyncedAt: state.lastSyncedAt ?? null,
    lastError: lastError ?? state.lastError ?? null
  }
}

export function onStatusChange(fn: (status: SyncStatus) => void): void {
  listeners.add(fn)
}

function emitStatus(): void {
  const status = getStatus()
  for (const fn of listeners) fn(status)
}

async function postBatch(token: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${WISPRA_API_BASE}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SYNC_TIMEOUT_MS)
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Sync request failed (${res.status}): ${text.slice(0, 200)}`)
  }
}

/**
 * Best-effort push of History/Lexicon/Meetings to Supabase. Never throws — failures
 * are recorded in sync.json and surfaced via getStatus()/onStatusChange() instead.
 */
export async function pushSync(): Promise<void> {
  if (syncing) return
  if (!store.get().cloudSyncEnabled) return

  const token = await auth.getValidToken()
  if (!token) return

  syncing = true
  emitStatus()

  const state = loadState()
  try {
    const meetingRows = changedMeetings(state.lastSyncedAt).map((m) => ({
      id: m.id,
      title: m.title,
      summary: m.summary,
      createdAt: m.createdAt,
      durationMs: m.durationMs,
      status: m.status,
      segments: m.segments,
      content: m.content,
      languageConfig: m.languageConfig,
      spaceId: m.spaceId
    }))

    const historyRows = history.list().map((e) => ({
      id: e.id,
      text: e.text,
      rawText: e.rawText,
      createdAt: e.createdAt,
      app: e.app,
      topic: e.topic,
      language: e.language,
      durationSeconds: e.durationSeconds
    }))
    const lexiconRows = lexicon.list().map((e) => ({
      id: e.id,
      term: e.term,
      heardAs: e.heardAs,
      count: e.count,
      enabled: e.enabled,
      pinned: e.pinned,
      source: e.source,
      createdAt: e.createdAt,
      lastSeen: e.lastSeen
    }))

    // History/Lexicon always ride the first request (they're small, capped locally).
    // Meetings are chunked so a large backlog never exceeds the API route's body limit.
    const meetingChunks: (typeof meetingRows)[] = []
    for (let i = 0; i < meetingRows.length; i += SYNC_MEETINGS_PER_REQUEST) {
      meetingChunks.push(meetingRows.slice(i, i + SYNC_MEETINGS_PER_REQUEST))
    }
    if (meetingChunks.length === 0) meetingChunks.push([])

    await postBatch(token, { history: historyRows, lexicon: lexiconRows, meetings: meetingChunks[0] })
    for (let i = 1; i < meetingChunks.length; i++) {
      await postBatch(token, { meetings: meetingChunks[i] })
    }

    lastError = null
    saveState({ lastSyncedAt: new Date().toISOString() })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Cloud sync failed:', message)
    lastError = message
    saveState({ ...state, lastError: message })
  } finally {
    syncing = false
    emitStatus()
  }
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null

/** A dictation, lexicon, or meeting change happened — sync shortly after, once things go quiet. */
function scheduleSync(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void pushSync()
  }, SYNC_DEBOUNCE_MS)
  debounceTimer.unref()
}

/**
 * Wires auto-sync to actual data changes instead of a blind clock: a dictation added to
 * History, a Lexicon edit, or a Meeting update each (re)start a SYNC_DEBOUNCE_MS timer,
 * so a burst of activity collapses into one push shortly after it settles — an idle day
 * triggers nothing. The window is kept short (see SYNC_DEBOUNCE_MS) so content reaches
 * the cloud quickly enough for the remote MCP (Claude.ai etc.) to see it soon after dictation,
 * since that server can only ever read the synced copy, never the local machine. A one-time
 * sync SYNC_STARTUP_DELAY_MS after launch covers anything
 * left over from the last session (e.g. a change whose debounce never got to fire before
 * quit). pushSync() is the actual gate (no-ops unless cloudSyncEnabled is on and the user
 * is logged in), so all of this can wire up unconditionally. The manual "Sync now" button
 * (IPC.SYNC_NOW) calls pushSync() directly and runs independently of this.
 */
export function initAutoSync(): void {
  setTimeout(() => void pushSync(), SYNC_STARTUP_DELAY_MS).unref()
  history.onChange(() => scheduleSync())
  lexicon.onChange(() => scheduleSync())
  meetingSessions.onMeta(() => scheduleSync())
}
