import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DailyLimitInfo, MeetingMindMap, MeetingSession, MindMapJobStatus, MindMapStopReason } from '@shared/types'
import { runMindMap, type MindMapLimits } from './mindMap'
import { mindMapLanguage, type Outline } from './mindMapLogic'
import type { ChatTarget } from './postprocess'

// ── Mind map jobs ────────────────────────────────────────────────────────────
// Building a session's mind map is a background job of the main process: it goes on
// whatever the Settings window shows (another tab, another session, Dictate, minimised,
// closed to the tray) and the renderer only watches its status. One job per session.
//
// While a job runs, every part it finishes is written to a small checkpoint file next to
// the app's other data (mind-map-jobs/<session id>.json). A job that stops part-way —
// provider limit, time limit, no network, the app being closed — leaves that file
// behind, so starting the job again only does the parts that are missing. The file is
// removed when the map is saved on the session.

interface Checkpoint {
  version: 1
  sessionId: string
  /** Language the parts are written in (see mindMapLanguage). */
  language: string
  /** runMindMap's signature of the transcript split the parts belong to. */
  signature: string
  total: number
  /** Outline of each finished part, by part index. */
  parts: Array<Outline | null>
  startedAt: string
  updatedAt: string
  /** "running" on disk at startup means the app was closed mid-run. */
  state: 'running' | 'stopped'
  reason?: MindMapStopReason
  detail?: string
  dailyLimit?: DailyLimitInfo
}

export interface MindMapJobsDeps {
  /** Folder the checkpoint files live in. */
  dir: string
  getSession: (id: string) => MeetingSession | undefined
  /** The chat endpoint to use right now, or null when there is no key / the user is signed out. */
  resolveTarget: () => Promise<ChatTarget | null>
  saveMindMap: (id: string, mindMap: MeetingMindMap) => void
  /** Called on every change of a job's status. */
  notify: (status: MindMapJobStatus) => void
  /** Language codes the user can pick. */
  languages: string[]
  /** True if Wispra Cloud said "monthly AI allowance used up" at or after this time (ms) — see aiQuota.ts. */
  quotaExceededSince?: (since: number) => boolean
  /** True while something that must not be slowed down is using the AI (a dictation being processed). */
  busy?: () => boolean
  limits?: Partial<MindMapLimits>
}

export interface MindMapJobs {
  /** Starts (or joins) the session's job; resolves the map, or null when the job stopped. */
  start: (id: string, options?: { regenerate?: boolean; language?: string }) => Promise<MeetingMindMap | null>
  /** Every job that is running, stopped part-way, or finished but not yet acknowledged. */
  statuses: () => MindMapJobStatus[]
  /** The user has seen the finished map. */
  acknowledge: (id: string) => void
  /** The session was deleted. */
  forget: (id: string) => void
  /** Reads the checkpoints left by an earlier run of the app; call once at startup. */
  restore: () => void
}

/** Longest a new AI call is held back for a dictation in progress. */
const BUSY_WAIT_MS = 20_000
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function createMindMapJobs(deps: MindMapJobsDeps): MindMapJobs {
  const running = new Map<string, Promise<MeetingMindMap | null>>()
  const status = new Map<string, MindMapJobStatus>()

  const fileOf = (id: string): string => join(deps.dir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)

  function readCheckpoint(id: string): Checkpoint | null {
    try {
      const parsed = JSON.parse(readFileSync(fileOf(id), 'utf8')) as Checkpoint
      if (parsed?.version !== 1 || parsed.sessionId !== id || !Array.isArray(parsed.parts)) return null
      return parsed
    } catch {
      return null
    }
  }

  function writeCheckpoint(checkpoint: Checkpoint): void {
    try {
      mkdirSync(deps.dir, { recursive: true })
      const file = fileOf(checkpoint.sessionId)
      // Write-then-rename, so a crash mid-write never leaves half a file.
      writeFileSync(`${file}.tmp`, JSON.stringify({ ...checkpoint, updatedAt: new Date().toISOString() }))
      renameSync(`${file}.tmp`, file)
    } catch (err) {
      console.error('[meeting] could not save mind map progress:', err)
    }
  }

  function removeCheckpoint(id: string): void {
    try {
      if (existsSync(fileOf(id))) unlinkSync(fileOf(id))
    } catch (err) {
      console.error('[meeting] could not remove mind map progress:', err)
    }
  }

  function setStatus(next: MindMapJobStatus): void {
    status.set(next.sessionId, next)
    deps.notify(next)
  }

  const gate = async (): Promise<void> => {
    const until = Date.now() + BUSY_WAIT_MS
    while (deps.busy?.() && Date.now() < until) await sleep(200)
  }

  async function run(id: string, session: MeetingSession, options?: { regenerate?: boolean; language?: string }): Promise<MeetingMindMap | null> {
    const requested = mindMapLanguage(session.languageConfig, options, deps.languages)
    const saved = readCheckpoint(id)
    // Regenerate starts over — unless it is the retry of a Regenerate in the same language that stopped part-way.
    const previous = saved && (!options?.regenerate || saved.language === requested) ? saved : null
    // Continuing keeps the language the kept parts were written in.
    const language = previous?.language ?? requested
    const began = Date.now()
    const startedAt = new Date(began).toISOString()
    const checkpoint: Checkpoint = {
      version: 1,
      sessionId: id,
      language,
      signature: previous?.signature ?? '',
      total: previous?.total ?? 0,
      parts: previous?.parts ?? [],
      startedAt,
      updatedAt: startedAt,
      state: 'running'
    }
    let current: MindMapJobStatus = {
      sessionId: id,
      state: 'running',
      phase: 'outline',
      done: checkpoint.parts.filter(Boolean).length,
      total: checkpoint.total,
      startedAt
    }
    setStatus(current)
    const stop = (reason: MindMapStopReason, detail?: string, dailyLimit?: DailyLimitInfo): null => {
      checkpoint.state = 'stopped'
      checkpoint.reason = reason
      checkpoint.detail = detail
      checkpoint.dailyLimit = dailyLimit
      writeCheckpoint(checkpoint)
      const { waitingUntil: _waitingUntil, dailyLimit: _earlier, ...rest } = current
      setStatus({ ...rest, state: 'stopped', reason, detail, ...(dailyLimit ? { dailyLimit } : {}) })
      return null
    }

    try {
      const target = await deps.resolveTarget()
      if (!target) return stop('no-key')
      const result = await runMindMap(session.segments, target, language, {
        resume: previous ? { signature: previous.signature, parts: previous.parts } : undefined,
        limits: deps.limits,
        gate,
        onPlan: (signature, total) => {
          // A transcript or language that changed since the kept parts were made: they do not apply.
          if (checkpoint.signature !== signature) checkpoint.parts = []
          checkpoint.signature = signature
          checkpoint.total = total
          writeCheckpoint(checkpoint)
        },
        onPartDone: (index, outline) => {
          checkpoint.parts[index] = outline
          writeCheckpoint(checkpoint)
        },
        onProgress: (progress) => {
          current = { sessionId: id, state: 'running', startedAt, ...progress }
          setStatus(current)
        }
      })
      if (!result.map) {
        // The allowance ran out on the way: say that, rather than "the provider refused".
        if (deps.quotaExceededSince?.(began)) return stop('quota')
        return stop(result.failure.reason, result.failure.detail, result.failure.daily)
      }
      deps.saveMindMap(id, result.map)
      removeCheckpoint(id)
      const { waitingUntil: _waitingUntil, ...rest } = current
      setStatus({ ...rest, state: 'done', done: rest.total })
      return result.map
    } catch (err) {
      console.error('[meeting] mind map generation failed:', err)
      return stop('failed', String((err as Error)?.message ?? err).slice(0, 240))
    }
  }

  return {
    start(id, options) {
      const inFlight = running.get(id)
      if (inFlight) return inFlight
      const session = deps.getSession(id)
      if (!session || session.status === 'recording') return Promise.resolve(null)
      if (session.mindMap && !options?.regenerate) return Promise.resolve(session.mindMap)
      const job = run(id, session, options).finally(() => running.delete(id))
      running.set(id, job)
      return job
    },

    statuses: () => [...status.values()],

    acknowledge(id) {
      if (status.get(id)?.state === 'done') status.delete(id)
    },

    forget(id) {
      status.delete(id)
      removeCheckpoint(id)
    },

    restore() {
      let files: string[] = []
      try {
        files = existsSync(deps.dir) ? readdirSync(deps.dir).filter((f) => f.endsWith('.json')) : []
      } catch {
        return
      }
      for (const file of files) {
        const id = file.slice(0, -'.json'.length)
        const checkpoint = readCheckpoint(id)
        const session = checkpoint && deps.getSession(id)
        // Left over from a deleted session, or from a run whose map made it onto the session after all.
        if (!checkpoint || !session || session.mindMap) {
          try {
            unlinkSync(join(deps.dir, file))
          } catch {
            /* nothing to clean up */
          }
          continue
        }
        status.set(id, {
          sessionId: id,
          state: 'stopped',
          // Still marked "running": the app was closed (or crashed) while the job ran.
          reason: checkpoint.state === 'running' ? 'interrupted' : (checkpoint.reason ?? 'failed'),
          detail: checkpoint.state === 'running' ? undefined : checkpoint.detail,
          ...(checkpoint.state !== 'running' && checkpoint.dailyLimit ? { dailyLimit: checkpoint.dailyLimit } : {}),
          phase: 'outline',
          done: checkpoint.parts.filter(Boolean).length,
          total: checkpoint.total,
          startedAt: checkpoint.startedAt
        })
      }
    }
  }
}
