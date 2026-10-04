import { LIVE_OUTLINE_FORCE_CHARS, LIVE_OUTLINE_MAX_FAILURES, LIVE_OUTLINE_MIN_CHARS, LIVE_OUTLINE_STEP_CHARS } from '@shared/constants'
import type { DailyLimitInfo, LiveOutlineStatus, MeetingOutline, MeetingSession } from '@shared/types'
import { createRouter } from './mindMap'
import { buildTranscriptLines, linesLength } from './mindMapLogic'
import { outlineOpenPart } from './outline'
import { applyLiveAnswer, liveCallDue, openLines } from './outlineLogic'
import type { ChatTarget } from './postprocess'

// ── Topics of a recording in progress ────────────────────────────────────────
// While a meeting records, the Transcript table names its topics as they finish instead
// of waiting for Stop. After each new segment, the part of the transcript that has no
// topic yet (the "open part") is looked at; once it is long enough — and grown by a
// step since the AI last read it — it is sent to the AI, and only the topics followed by
// another one are kept, with their action items and speaker names (outlineLogic.ts,
// applyLiveAnswer). The last topic may still be going on, so it waits for a later call,
// or for Stop, when finalising the outline names whatever is left (generateSessionOutline
// in index.ts). One call at a time per recording.
//
// Limits are kept as everywhere else: a per-minute limit is waited out by the call
// itself; a daily limit moves the recording to the backup routes, and when none is left
// nothing more is sent while it records — the rest is named after Stop or "Try again".

export interface LiveOutlineLimits {
  /** The open part is sent once it is this long… */
  min: number
  /** …and again each time it has grown by this much. */
  step: number
  /** An open part this long is named as it stands, even without a change of subject. */
  force: number
  /** Failed calls in a row after which nothing more is sent while the recording runs. */
  maxFailures: number
}

export interface LiveOutlinerDeps {
  getSession: (id: string) => MeetingSession | null
  /** The chat endpoint to use, or null without a key / signed out. */
  resolveTarget: () => Promise<ChatTarget | null>
  resolveBackups: () => ChatTarget[]
  /** The language the topics are written in (the session's "Summary" choice, see outlineLanguage). */
  language: (session: MeetingSession) => string
  saveOutline: (id: string, outline: MeetingOutline) => void
  notify: (status: LiveOutlineStatus) => void
  limits?: Partial<LiveOutlineLimits>
}

export interface LiveOutliner {
  /** A segment was added to the recording `id`. */
  onSegment: (id: string) => void
  /**
   * The recording `id` ends (Stop or Discard): nothing new is sent. Resolves once a call
   * still in flight is over, with the outline it produced — not saved, because the
   * session is being written by Stop at that moment; the caller saves it afterwards.
   */
  end: (id: string) => Promise<MeetingOutline | undefined>
  /** What the Transcript table of the recording `id` should say about naming, or null. */
  status: (id: string) => LiveOutlineStatus | null
}

interface Run {
  router: ReturnType<typeof createRouter> | null
  /** First segment of the open part the AI last read, and how long that part was then. */
  openFrom: string | undefined
  readChars: number
  inFlight: Promise<void> | null
  failures: number
  /** Nothing more is sent for this recording (daily limit with no backup left, repeated failures, no key). */
  stopped: boolean
  ended: boolean
  /** An outline that arrived after end(). */
  late?: MeetingOutline
  status: LiveOutlineStatus
}

export function createLiveOutliner(deps: LiveOutlinerDeps): LiveOutliner {
  const limits: LiveOutlineLimits = {
    min: LIVE_OUTLINE_MIN_CHARS,
    step: LIVE_OUTLINE_STEP_CHARS,
    force: LIVE_OUTLINE_FORCE_CHARS,
    maxFailures: LIVE_OUTLINE_MAX_FAILURES,
    ...deps.limits
  }
  const runs = new Map<string, Run>()
  /** Recordings that ended: a segment that still arrives for one starts nothing. */
  const ended = new Set<string>()

  const runOf = (id: string): Run => {
    let run = runs.get(id)
    if (!run) {
      run = { router: null, openFrom: undefined, readChars: 0, inFlight: null, failures: 0, stopped: false, ended: false, status: { sessionId: id, working: false } }
      runs.set(id, run)
    }
    return run
  }

  const setStatus = (run: Run, patch: Partial<LiveOutlineStatus>): void => {
    run.status = { ...run.status, ...patch }
    deps.notify(run.status)
  }

  /** Sends the open part while it is due; returns when it is not (or the run stopped / ended). */
  async function work(id: string, run: Run): Promise<void> {
    for (;;) {
      if (run.stopped || run.ended) return
      const session = deps.getSession(id)
      if (!session || session.status !== 'recording') return
      const open = openLines(buildTranscriptLines(session.segments), session.outline)
      if (open.length === 0) return
      if (open[0].firstSegmentId !== run.openFrom) {
        run.openFrom = open[0].firstSegmentId
        run.readChars = 0
      }
      const chars = linesLength(open)
      if (!liveCallDue(chars, run.readChars, limits)) return

      if (!run.router) {
        const target = await deps.resolveTarget()
        if (!target) {
          // No key or signed out: say nothing here — after Stop the Transcript tab says what is wrong.
          run.stopped = true
          return
        }
        run.router = createRouter(target, deps.resolveBackups(), (route) => setStatus(run, { backupModel: route.label }))
      }

      setStatus(run, { working: true })
      let daily: DailyLimitInfo | undefined
      const language = deps.language(session)
      const previousTitle = session.outline?.topics[session.outline.topics.length - 1]?.title
      const raw = await outlineOpenPart(open, previousTitle, run.router, language, {
        onFailure: (failure) => {
          if (failure.daily) daily = failure.daily
        }
      })
      run.readChars = chars
      const result = raw ? applyLiveAnswer(raw, open, session.outline, language, new Date().toISOString(), chars >= limits.force) : null
      if (result && result !== 'unchanged') {
        const backupModel = run.router.usedBackup()
        const outline = backupModel ? { ...result, backupModel } : result
        if (run.ended) {
          run.late = outline
        } else {
          deps.saveOutline(id, outline)
          // The new open part was read in this call too: wait for it to grow by a step.
          run.openFrom = outline.openFromSegmentId
          run.readChars = linesLength(openLines(buildTranscriptLines(session.segments), outline))
        }
      }
      if (raw && result) run.failures = 0
      else if (daily) {
        run.stopped = true
        setStatus(run, { working: false, dailyLimit: daily })
        return
      } else if (++run.failures >= limits.maxFailures) {
        run.stopped = true
        setStatus(run, { working: false, failed: true })
        return
      }
      setStatus(run, { working: false })
    }
  }

  return {
    onSegment(id) {
      if (ended.has(id)) return
      const run = runOf(id)
      if (run.inFlight || run.stopped || run.ended) return
      run.inFlight = work(id, run)
        .catch((err) => console.error('[meeting] naming topics while recording failed:', err))
        .finally(() => {
          run.inFlight = null
        })
    },

    async end(id) {
      ended.add(id)
      const run = runs.get(id)
      if (!run) return undefined
      run.ended = true
      await run.inFlight
      runs.delete(id)
      return run.late
    },

    status: (id) => runs.get(id)?.status ?? null
  }
}
