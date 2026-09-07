import { app } from 'electron'
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type {
  MeetingAudioSource,
  MeetingContent,
  MeetingLanguageConfig,
  MeetingSegment,
  MeetingSession,
  MeetingSessionSummary
} from '@shared/types'

/** A gap this long (real wall-clock time, not active-timeline time) between two segments starts a new paragraph — covers pause/resume and any other real silence. */
const PARAGRAPH_GAP_MS = 2500
/** Otherwise, force a paragraph break once the current one gets this long, so long continuous speech stays readable. */
const PARAGRAPH_MAX_CHARS = 500

/**
 * Persists Meeting Mode sessions as one JSON file per session under
 * userData/meetings/ (mirrors the history.ts pattern). Also owns the
 * transcription-ordering queue: chunks are transcribed by Groq concurrently
 * in index.ts, but appended to segments[] strictly in recording order via
 * this class's serial queue, and owns the paragraph-break heuristic.
 */
class MeetingSessions {
  private current: MeetingSession | null = null
  private queue: Promise<void> = Promise.resolve()
  private listeners = new Set<(segment: MeetingSegment, sessionId: string) => void>()
  private metaListeners = new Set<(session: MeetingSession) => void>()

  private get dir(): string {
    const d = join(app.getPath('userData'), 'meetings')
    mkdirSync(d, { recursive: true })
    return d
  }

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  /** Starts a new session and persists it immediately (empty transcript) so it shows up in the sidebar right away. */
  start(audioSource: MeetingAudioSource, languageConfig?: MeetingLanguageConfig): MeetingSession {
    const now = new Date()
    const session: MeetingSession = {
      id: randomUUID(),
      title: defaultTitle(now),
      createdAt: now.toISOString(),
      durationMs: 0,
      audioSource,
      segments: [],
      status: 'recording',
      languageConfig
    }
    this.current = session
    this.queue = Promise.resolve()
    this.persist(session)
    return session
  }

  getCurrentId(): string | null {
    return this.current?.id ?? null
  }

  /** The session currently recording/paused, if any — used to read its languageConfig for each chunk's STT call. */
  getCurrent(): MeetingSession | null {
    return this.current
  }

  /**
   * Queues one chunk's transcription. `transcribeFn` runs immediately (chunks
   * transcribe concurrently for low latency), but the resulting segment is only
   * appended to the session once every earlier-queued chunk has been appended
   * first, so segments[] always stays in correct recording order.
   */
  enqueueChunk(
    chunk: { startMs: number; endMs: number; startedAt: string },
    transcribeFn: () => Promise<string | null>
  ): void {
    const session = this.current
    if (!session) return
    // Recorded duration tracks actual capture time, not transcribed content — update it
    // unconditionally so a stretch of failed/empty transcriptions (network hiccup, no
    // signed-in account, pure silence) never makes a genuinely long recording read as 0:00.
    session.durationMs = Math.max(session.durationMs, chunk.endMs)
    this.persist(session)
    // Kick off transcription now (don't wait for our turn in the queue) so a slow
    // earlier chunk doesn't delay this one from even starting.
    const resultPromise = transcribeFn().catch((err) => {
      console.error('[meeting] transcription failed:', err)
      return null
    })
    this.queue = this.queue.then(async () => {
      const text = await resultPromise
      if (!text || this.current !== session) return

      const prev = session.segments[session.segments.length - 1]
      let isNewParagraph = true
      if (prev) {
        const prevEndWallMs = Date.parse(prev.startedAt) + (prev.endMs - prev.startMs)
        const gapMs = Date.parse(chunk.startedAt) - prevEndWallMs
        isNewParagraph = gapMs >= PARAGRAPH_GAP_MS || charsSinceLastParagraph(session.segments) >= PARAGRAPH_MAX_CHARS
      }

      const segment: MeetingSegment = {
        id: randomUUID(),
        text,
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        startedAt: chunk.startedAt,
        isNewParagraph
      }
      session.segments.push(segment)
      this.persist(session)
      for (const fn of this.listeners) fn(segment, session.id)
    })
  }

  /**
   * Waits for all queued transcriptions to land, then marks the session
   * 'summarizing' (if it captured any speech — the caller, index.ts, follows up
   * with an AI title/summary generation pass and finishSummary()) or straight to
   * 'stopped' (nothing to summarize). Safe to call with no active session.
   */
  async stop(): Promise<MeetingSession | null> {
    const session = this.current
    if (!session) return null
    this.current = null
    await this.queue
    session.status = session.segments.length > 0 ? 'summarizing' : 'stopped'
    this.persist(session)
    for (const fn of this.metaListeners) fn(session)
    return session
  }

  /**
   * Applies an AI-generated title/summary once generation finishes, and always
   * moves the session out of 'summarizing' — pass an empty patch on generation
   * failure (offline, no key, etc.) to just fall back to the existing default
   * date/time title. No-ops if the session was deleted while generation was in flight.
   */
  finishSummary(id: string, patch: { title?: string; summary?: string }): void {
    const session = this.get(id)
    if (!session) return
    if (patch.title) session.title = patch.title
    if (patch.summary) session.summary = patch.summary
    session.status = 'stopped'
    this.persist(session)
    for (const fn of this.metaListeners) fn(session)
  }

  /**
   * Cancels the current in-progress session without finalizing/summarizing it —
   * backs the recording screen's "Discard" button, for when the user decides
   * mid-recording that this take isn't worth keeping. Deletes its JSON file
   * (already being written incrementally as segments arrive — see
   * enqueueChunk/persist) and clears `current` immediately, so any
   * transcription chunk still in flight silently no-ops via the
   * `this.current !== session` check in enqueueChunk instead of resurrecting
   * the file after we've deleted it. Safe to call with no active session.
   */
  discard(): void {
    const session = this.current
    if (!session) return
    this.current = null
    this.delete(session.id)
  }

  onSegment(fn: (segment: MeetingSegment, sessionId: string) => void): void {
    this.listeners.add(fn)
  }

  /** Notified whenever a session's status/title/summary changes (stop() and finishSummary()). */
  onMeta(fn: (session: MeetingSession) => void): void {
    this.metaListeners.add(fn)
  }

  /** Sidebar listing — newest first, without loading every session's full transcript. */
  list(): MeetingSessionSummary[] {
    let files: string[] = []
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }
    const summaries: MeetingSessionSummary[] = []
    for (const f of files) {
      try {
        const session = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as MeetingSession
        summaries.push({
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          durationMs: session.durationMs,
          audioSource: session.audioSource,
          status: session.status
        })
      } catch {
        // Skip a corrupt/partial file rather than failing the whole list.
      }
    }
    summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return summaries
  }

  get(id: string): MeetingSession | null {
    if (this.current?.id === id) return this.current
    try {
      return JSON.parse(readFileSync(this.filePath(id), 'utf8')) as MeetingSession
    } catch {
      return null
    }
  }

  delete(id: string): void {
    try {
      unlinkSync(this.filePath(id))
    } catch {
      // Already gone.
    }
    if (this.current?.id === id) this.current = null
  }

  /**
   * User-triggered rename (sidebar kebab menu). Only applies to a 'stopped'
   * session — the renderer only offers rename once a session has reached that
   * state, so a rename never races finishSummary()'s own title write (which
   * would otherwise clobber it once AI title generation lands mid-edit).
   * No-ops if the session was deleted in the meantime.
   */
  rename(id: string, title: string): void {
    const session = this.get(id)
    if (!session || session.status !== 'stopped') return
    session.title = title
    this.persist(session)
    for (const fn of this.metaListeners) fn(session)
  }

  /**
   * Saves one platform's on-demand-generated ready-to-post content (see
   * generateMeetingContent in postprocess.ts) onto a session and notifies
   * listeners, so re-opening that platform's tab later shows the cached
   * result instead of calling the LLM again. No-ops if the session was
   * deleted in the meantime.
   */
  setContent(id: string, patch: Partial<MeetingContent>): void {
    const session = this.get(id)
    if (!session) return
    session.content = { ...session.content, ...patch }
    this.persist(session)
    for (const fn of this.metaListeners) fn(session)
  }

  private persist(session: MeetingSession): void {
    try {
      writeFileSync(this.filePath(session.id), JSON.stringify(session, null, 2), 'utf8')
    } catch (err) {
      console.error('[meeting] failed to persist session:', err)
    }
  }
}

function charsSinceLastParagraph(segments: MeetingSegment[]): number {
  let chars = 0
  for (let i = segments.length - 1; i >= 0; i--) {
    chars += segments[i].text.length
    if (segments[i].isNewParagraph) break
  }
  return chars
}

function defaultTitle(d: Date): string {
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `Meeting — ${date}, ${time}`
}

export const meetingSessions = new MeetingSessions()
