import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type {
  ContentPlatform,
  MeetingAudioSource,
  MeetingContent,
  MeetingLanguageConfig,
  MeetingSegment,
  MeetingSession,
  MeetingSessionSummary,
  MeetingState
} from '@shared/types'
import { LANGUAGES } from '@shared/constants'
import { MeetingRecorder, type MeetingChunk } from './recorder'
import './meeting.css'

const LANG_CONFIG_STORAGE_KEY = 'wispra-meeting-lang-config'

const DEFAULT_LANG_CONFIG: MeetingLanguageConfig = {
  input: 'auto',
  transcript: 'auto',
  summary: 'auto',
  website: 'auto',
  facebook: 'auto',
  instagram: 'auto',
  linkedin: 'auto',
  twitter: 'auto'
}

// Same list as the Dictate tab's Language section, but "auto" reads differently here:
// for output fields it means "mirror the transcript's language", not "detect what I said".
const OUTPUT_LANGUAGES = LANGUAGES.map((l) => (l.code === 'auto' ? { ...l, label: 'Same as transcript' } : l))
// For the Transcript field itself, "auto" means "same as spoken" (plain transcription,
// no translation call) — "same as transcript" would be circular here.
const TRANSCRIPT_LANGUAGES = LANGUAGES.map((l) => (l.code === 'auto' ? { ...l, label: 'Same as spoken' } : l))

/** Restores the last language choices used (localStorage, per-device convenience only — not synced/persisted server-side). Falls back to all-"auto" on first use or a corrupt value. */
function loadLangConfig(): MeetingLanguageConfig {
  try {
    const raw = localStorage.getItem(LANG_CONFIG_STORAGE_KEY)
    const merged = raw ? { ...DEFAULT_LANG_CONFIG, ...(JSON.parse(raw) as Partial<MeetingLanguageConfig>) } : DEFAULT_LANG_CONFIG
    // Website/Facebook/Instagram/LinkedIn/X are now driven by one combined picker (see
    // the "content language" field below) — collapse any old per-platform differences
    // saved before that picker existed onto `website`'s value, so the single dropdown
    // shows one consistent choice instead of silently carrying stale, no-longer-editable
    // per-platform values.
    return { ...merged, facebook: merged.website, instagram: merged.website, linkedin: merged.website, twitter: merged.website }
  } catch {
    return DEFAULT_LANG_CONFIG
  }
}

/** Sets one language across all 5 generated-content platforms at once (Website/Facebook/Instagram/LinkedIn/X) — they're edited as a single field in the UI to cut down on picker clutter, per user request. */
function withContentLanguage(prev: MeetingLanguageConfig, value: string): MeetingLanguageConfig {
  return { ...prev, website: value, facebook: value, instagram: value, linkedin: value, twitter: value }
}

const AUDIO_SOURCE_STORAGE_KEY = 'wispra-meeting-audio-source'

const AUDIO_SOURCE_OPTIONS: Array<{ value: MeetingAudioSource; label: string; desc: string }> = [
  { value: 'mic', label: 'Microphone only', desc: 'Just your voice' },
  { value: 'system', label: 'System audio only', desc: "What's playing on this computer" },
  { value: 'both', label: 'Both', desc: 'Your voice + system audio' }
]

/** Compact labels for the in-session source switcher (next to the timer) — the full labels above are too long for a pill row. */
const SOURCE_SWITCHER_LABELS: Record<MeetingAudioSource, string> = {
  mic: 'Mic',
  system: 'System',
  both: 'Both'
}

/** Restores the last audio-source choice (localStorage, per-device convenience only). Falls back to 'mic' — the only mode that existed before this picker — on first use or a corrupt value. */
function loadAudioSource(): MeetingAudioSource {
  try {
    const raw = localStorage.getItem(AUDIO_SOURCE_STORAGE_KEY)
    if (raw === 'mic' || raw === 'system' || raw === 'both') return raw
    return 'mic'
  } catch {
    return 'mic'
  }
}

function LangField({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: Array<{ code: string; label: string }>
  onChange: (value: string) => void
}): ReactElement {
  return (
    <label className="meeting-lang-field">
      <span className="meeting-lang-field-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.code} value={o.code}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

const LEVEL_BARS = 24

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** Wall-clock "HH:MM" label for a segment's ISO startedAt, in the user's own locale/24h-vs-12h preference. */
function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** "Sep 2, 9:53 PM" label for a session's createdAt — shown secondary to the (now AI-generated) title. */
function formatSessionDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${date}, ${time}`
}

/**
 * Splits inline "**bold**" runs out of AI-generated text into real <strong>
 * elements. The content prompts in postprocess.ts ask for "plain text, not
 * markdown", but models trained on markdown still slip "**bold**" emphasis in
 * regardless of instructions — rendering it properly is far more reliable than
 * trying to prompt it away entirely, so literal asterisks never reach the screen.
 */
function renderInlineBold(text: string, keyPrefix: string): Array<string | ReactElement> {
  return text.split(/\*\*([\s\S]+?)\*\*/g).map((part, i) => (i % 2 === 1 ? <strong key={`${keyPrefix}-${i}`}>{part}</strong> : part))
}

/**
 * Turns an AI summary (plain text with blank-line-separated paragraphs and
 * "- "/"1. " list lines, produced by the MEETING_TITLE_PROMPT in
 * postprocess.ts) into paragraph/list JSX instead of one unbroken block.
 * Also understands "## Heading" lines (used by the website article body from
 * CONTENT_PROMPTS.website in postprocess.ts) — the plain Summary prompt never
 * produces those, so this is a pure addition, no regression for that tab.
 */
function renderSummaryBlocks(summary: string): ReactElement[] {
  const blocks: ReactElement[] = []
  let listItems: string[] = []

  const flushList = (): void => {
    if (listItems.length === 0) return
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="meeting-summary-list">
        {listItems.map((item, i) => (
          <li key={i}>{renderInlineBold(item, `li-${i}`)}</li>
        ))}
      </ul>
    )
    listItems = []
  }

  for (const rawLine of summary.split('\n')) {
    const line = rawLine.trim()
    if (!line) {
      flushList()
      continue
    }
    const headingMatch = /^##\s+(.*)/.exec(line)
    const bulletMatch = /^[-•*]\s+(.*)/.exec(line) ?? /^\d+[.)]\s+(.*)/.exec(line)
    if (headingMatch) {
      flushList()
      blocks.push(
        <h4 key={`h-${blocks.length}`} className="meeting-summary-heading">
          {renderInlineBold(headingMatch[1], `h-${blocks.length}`)}
        </h4>
      )
    } else if (bulletMatch) {
      listItems.push(bulletMatch[1])
    } else {
      flushList()
      blocks.push(<p key={`p-${blocks.length}`}>{renderInlineBold(line, `p-${blocks.length}`)}</p>)
    }
  }
  flushList()
  return blocks
}

type PastView = 'transcript' | 'summary' | ContentPlatform

const PAST_VIEW_TABS: Array<{ id: PastView; label: string }> = [
  { id: 'transcript', label: 'Transcript' },
  { id: 'summary', label: 'Summary' },
  { id: 'website', label: 'Website' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'twitter', label: 'X' }
]

interface ParagraphBlock {
  id: string
  startedAt: string
  /** Milliseconds along the session's active (non-paused) timeline — lets the user match a paragraph back to a position in a source recording/video. */
  startMs: number
  text: string
}

/** Merges consecutive segments into paragraph blocks (isNewParagraph starts a new one), each labeled with the elapsed time and wall-clock time it started. */
function groupIntoParagraphs(segments: MeetingSegment[]): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = []
  for (const seg of segments) {
    const last = blocks[blocks.length - 1]
    if (seg.isNewParagraph || !last) {
      blocks.push({ id: seg.id, startedAt: seg.startedAt, startMs: seg.startMs, text: seg.text })
    } else {
      last.text += ' ' + seg.text
    }
  }
  return blocks
}

/**
 * Meeting Mode tab, embedded in the main Settings window (not a separate window —
 * same app the user already has open, just another tab next to Settings/Transcribe/
 * History/Account). Step 3: real near-real-time Groq transcription per chunk,
 * Pause/Resume, wall-clock paragraph timestamps, and a sidebar of persisted sessions.
 */
export function MeetingPanel(): React.JSX.Element {
  const [meetingState, setMeetingState] = useState<MeetingState>('idle')
  const [level, setLevel] = useState(0)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [sessions, setSessions] = useState<MeetingSessionSummary[]>([])
  /** id of the session currently recording/paused/just-stopped, shown by default. null = idle "start a new session" screen. */
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [liveSegments, setLiveSegments] = useState<MeetingSegment[]>([])
  /** id of a past (already-stopped) session the user clicked in the sidebar, read-only. null = showing the current session instead. */
  const [viewingPastId, setViewingPastId] = useState<string | null>(null)
  const [pastSegments, setPastSegments] = useState<MeetingSegment[]>([])
  const [pastTitle, setPastTitle] = useState('')
  const [pastCreatedAt, setPastCreatedAt] = useState('')
  /** Drives the "Generating title…" vs "Recording ended" note while AI title/summary generation is in flight. */
  const [pastStatus, setPastStatus] = useState<MeetingSession['status']>('stopped')
  const [pastSummary, setPastSummary] = useState('')
  /** True while a manual "Try again" summary regeneration is in flight for the session being viewed — the Summary tab has no automatic reopen-to-retry like the content tabs since it never auto-fires again after the initial post-Stop attempt. */
  const [summaryGenerating, setSummaryGenerating] = useState(false)
  /** Which view the past-session panel is showing: raw transcript, AI summary, or one of the on-demand-generated platform tabs. */
  const [pastView, setPastView] = useState<PastView>('transcript')
  /** On-demand-generated ready-to-post content for the session being viewed, cached on the session itself once generated (see setContent in meetingSessions.ts). */
  const [pastContent, setPastContent] = useState<MeetingContent | undefined>(undefined)
  /** Which platform tabs are currently waiting on a generateMeetingContent() call — per-platform (not a single value) so switching between several not-yet-generated tabs in quick succession tracks each one's own in-flight state correctly instead of only the most recently opened tab. */
  const [generatingPlatforms, setGeneratingPlatforms] = useState<Partial<Record<ContentPlatform, boolean>>>({})
  /** Which of the 3 generated variants is shown for each social platform. */
  const [variantIndex, setVariantIndex] = useState<Record<'facebook' | 'instagram' | 'linkedin' | 'twitter', number>>({
    facebook: 0,
    instagram: 0,
    linkedin: 0,
    twitter: 0
  })
  /** Set when resume() fails to re-acquire the mic — shown inline so the user can retry Resume without losing the session. */
  const [resumeError, setResumeError] = useState<string | null>(null)
  /** id of the sidebar row whose title is currently being edited inline, if any. */
  const [renamingId, setRenamingId] = useState<string | null>(null)
  /** The open kebab menu's session id + its screen position (computed from the kebab button's rect so the menu is never clipped by the sidebar's own scroll container). */
  const [menuPos, setMenuPos] = useState<{ id: string; top: number; right: number } | null>(null)
  /** Language choices for the next recording, picked on the idle "Start recording" screen. Persisted across sessions (see loadLangConfig) so the user's usual picks stick. */
  const [langConfig, setLangConfig] = useState<MeetingLanguageConfig>(loadLangConfig)
  /** Audio-source choice for the next recording (mic / system / both), picked on the same idle screen. Persisted the same way as langConfig. */
  const [audioSource, setAudioSourceState] = useState<MeetingAudioSource>(loadAudioSource)
  // Mirrors audioSource for the onMeetingCaptureStart handler below, which is registered
  // once at mount (see initializedRef) and would otherwise only ever see its initial
  // value through a stale closure — same reason currentSessionIdRef exists.
  const audioSourceRef = useRef<MeetingAudioSource>(audioSource)
  const setAudioSource = useCallback((value: MeetingAudioSource) => {
    audioSourceRef.current = value
    setAudioSourceState(value)
  }, [])
  /** True while a live switchAudioSource() call is in flight — disables the in-session source switcher so a second click can't race the first. */
  const [switchingAudioSource, setSwitchingAudioSource] = useState(false)
  /** Set when a mid-recording source switch fails (e.g. system-audio permission hiccup) — shown inline, same spot as resumeError. */
  const [audioSourceSwitchError, setAudioSourceSwitchError] = useState<string | null>(null)
  // Set right before sending MEETING_DISCARD so the onMeetingCaptureStop handler below
  // (registered once at mount) knows this particular stop-capture event is a discard —
  // whose session was just deleted server-side — rather than a normal Stop, and should
  // return to the idle screen instead of opening a past view for a session that no
  // longer exists.
  const discardingRef = useRef(false)
  /** Set by onMeetingAutoStopped to the id of the session being recorded when the silence safety net fired, so onMeetingCaptureStop's transition to the past view knows to show autoStopNotice for that specific session (and not leak it onto some other session viewed later). */
  const autoStoppedSessionIdRef = useRef<string | null>(null)
  /** Shown in the just-ended session's past view when the silence safety net (not the user) stopped the recording — cleared on starting a new recording or opening a different session. */
  const [autoStopNotice, setAutoStopNotice] = useState<string | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(LANG_CONFIG_STORAGE_KEY, JSON.stringify(langConfig))
    } catch {
      // Best-effort — a full/blocked localStorage just means the picks reset next launch.
    }
  }, [langConfig])

  useEffect(() => {
    try {
      localStorage.setItem(AUDIO_SOURCE_STORAGE_KEY, audioSource)
    } catch {
      // Best-effort — a full/blocked localStorage just means the pick resets next launch.
    }
  }, [audioSource])

  const recorderRef = useRef<MeetingRecorder>(new MeetingRecorder())
  const startedAtRef = useRef(0)
  const initializedRef = useRef(false)
  const transcriptRef = useRef<HTMLDivElement>(null)
  // Set right before a rename input is dismissed via Escape, so the blur that
  // unmounting it triggers is treated as a cancel instead of a commit.
  const skipRenameBlurRef = useRef(false)
  // Mirrors currentSessionId for handlers registered once at mount (below), which would
  // otherwise only ever see its initial (null) value through a stale closure.
  const currentSessionIdRef = useRef<string | null>(null)
  // Same reason, for viewingPastId — read by the onMeetingSessionUpdated handler below.
  const viewingPastIdRef = useRef<string | null>(null)

  const setCurrentSession = useCallback((id: string | null) => {
    currentSessionIdRef.current = id
    setCurrentSessionId(id)
  }, [])

  const setViewingPast = useCallback((id: string | null) => {
    viewingPastIdRef.current = id
    setViewingPastId(id)
  }, [])

  const refreshSessions = useCallback(async () => {
    setSessions(await window.api.getMeetingSessions())
  }, [])

  const handleChunk = useCallback((chunk: MeetingChunk) => {
    void chunk.blob.arrayBuffer().then((buffer) => {
      window.api.meetingChunkCaptured(buffer, {
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        startedAt: chunk.startedAt,
        mimeType: chunk.mimeType
      })
    })
  }, [])

  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    window.api.onMeetingStateChanged(setMeetingState)
    window.api.onMeetingCaptureStart(() => {
      startedAtRef.current = Date.now()
      setLiveSegments([])
      setViewingPast(null)
      setResumeError(null)
      autoStoppedSessionIdRef.current = null
      setAutoStopNotice(null)
      recorderRef.current.start(setLevel, handleChunk, audioSourceRef.current).catch((err: unknown) => {
        recorderRef.current.stop()
        const sourceLabel =
          audioSourceRef.current === 'system'
            ? 'system audio'
            : audioSourceRef.current === 'both'
              ? 'microphone/system audio'
              : 'microphone'
        const detail = err instanceof Error ? err.message : 'access denied or unavailable'
        window.api.meetingCaptureFailed(`Could not start capture (${sourceLabel}): ${detail}`)
      })
      void window.api.getMeetingSessions().then((list) => {
        setSessions(list)
        const active = list.find((s) => s.status === 'recording')
        if (active) setCurrentSession(active.id)
      })
    })
    window.api.onMeetingCapturePause(() => {
      recorderRef.current.pause()
      setLevel(0)
    })
    window.api.onMeetingCaptureResume(() => {
      setResumeError(null)
      recorderRef.current.resume(setLevel, handleChunk).catch(() => {
        // Don't end the whole session over a resume hiccup (e.g. another app briefly
        // holding the mic) — fall back to paused, which the recorder is already
        // internally consistent with, and let the user retry Resume.
        setResumeError('Could not resume — the microphone may be in use by another app. Try Resume again.')
        window.api.meetingPause()
      })
    })
    // Arrives right before onMeetingCaptureStop when the silence safety net (not the
    // user) ended the recording — just records which session that was; the actual
    // notice is shown once we know (below) that the stop wasn't a discard.
    window.api.onMeetingAutoStopped(() => {
      autoStoppedSessionIdRef.current = currentSessionIdRef.current
    })
    window.api.onMeetingCaptureStop(() => {
      recorderRef.current.stop()
      setLevel(0)
      setResumeError(null)
      setAudioSourceSwitchError(null)
      const wasDiscarding = discardingRef.current
      discardingRef.current = false
      const autoStoppedId = autoStoppedSessionIdRef.current
      autoStoppedSessionIdRef.current = null
      if (wasDiscarding) {
        // The session's file was just deleted server-side — go back to the idle
        // screen rather than opening a past view for a session that no longer exists.
        setCurrentSession(null)
        setViewingPast(null)
        setLiveSegments([])
        setAutoStopNotice(null)
      } else {
        // Show the just-finished session in the read-only past view instead of leaving
        // the main panel stuck on the now-fully-disabled live-session controls.
        const stoppedId = currentSessionIdRef.current
        if (stoppedId) {
          setViewingPast(stoppedId)
          setCurrentSession(null)
          setAutoStopNotice(
            autoStoppedId === stoppedId
              ? 'Automatically stopped after 5 minutes with no speech detected.'
              : null
          )
        }
      }
      void refreshSessions()
    })
    window.api.onMeetingSegmentReady((segment) => {
      setLiveSegments((prev) => [...prev, segment])
    })
    window.api.onMeetingSessionUpdated((session) => {
      // Keep the sidebar list's title/status in sync (e.g. the AI title lands a few
      // seconds after Stop, once the LLM call finishes).
      setSessions((prev) =>
        prev.map((s) =>
          s.id === session.id
            ? {
                id: session.id,
                title: session.title,
                createdAt: session.createdAt,
                durationMs: session.durationMs,
                audioSource: session.audioSource,
                status: session.status
              }
            : s
        )
      )
      // If this is the session currently open in the read-only past view, update it live too.
      if (viewingPastIdRef.current === session.id) {
        setPastTitle(session.title)
        setPastCreatedAt(session.createdAt)
        setPastStatus(session.status)
        setPastSummary(session.summary ?? '')
        setPastContent(session.content)
      }
    })

    // Hydrate on mount: a fresh mount (first open, or re-opening this tab after
    // switching away mid-meeting) otherwise has no idea a recording is already
    // in progress until the next state change broadcasts.
    void (async () => {
      const [state, list] = await Promise.all([window.api.getMeetingState(), window.api.getMeetingSessions()])
      setMeetingState(state)
      setSessions(list)
      if (state === 'recording' || state === 'paused') {
        const active = list.find((s) => s.status === 'recording')
        if (active) {
          setCurrentSession(active.id)
          const full = await window.api.getMeetingSession(active.id)
          if (full) {
            setLiveSegments(full.segments)
            startedAtRef.current = Date.parse(full.createdAt)
          }
        }
      }
    })()
  }, [handleChunk, refreshSessions])

  // Live elapsed timer while recording — reads the recorder's pause-aware active
  // timeline so it freezes exactly while paused and never jumps on resume.
  useEffect(() => {
    if (meetingState !== 'recording') return
    const tick = (): void => {
      const active = recorderRef.current.getActiveMs()
      setElapsedMs(active > 0 ? active : Date.now() - startedAtRef.current)
    }
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [meetingState])

  // Fetch a past session's transcript when the sidebar selection changes.
  useEffect(() => {
    if (viewingPastId === null) return
    let cancelled = false
    setPastView('transcript')
    setGeneratingPlatforms({})
    setSummaryGenerating(false)
    setVariantIndex({ facebook: 0, instagram: 0, linkedin: 0, twitter: 0 })
    void window.api.getMeetingSession(viewingPastId).then((full) => {
      if (cancelled || !full) return
      setPastSegments(full.segments)
      setPastTitle(full.title)
      setPastCreatedAt(full.createdAt)
      setPastStatus(full.status)
      setPastSummary(full.summary ?? '')
      setPastContent(full.content)
    })
    return () => {
      cancelled = true
    }
  }, [viewingPastId])

  // Generate a platform's content the first time its tab is opened, then cache
  // it in pastContent (also persisted server-side by the IPC handler) so
  // re-opening the tab later doesn't call the LLM again.
  useEffect(() => {
    if (viewingPastId === null) return
    if (pastView === 'transcript' || pastView === 'summary') return
    const platform = pastView
    if (pastContent?.[platform]) return
    if (generatingPlatforms[platform]) return
    const id = viewingPastId
    setGeneratingPlatforms((prev) => ({ ...prev, [platform]: true }))
    void window.api.generateMeetingContent(id, platform).then((result) => {
      setGeneratingPlatforms((prev) => ({ ...prev, [platform]: false }))
      if (!result || viewingPastIdRef.current !== id) return
      setPastContent((prev) => {
        if (result.platform === 'website') {
          return { ...prev, website: { title: result.title, metaDescription: result.metaDescription, body: result.body } }
        }
        if (result.platform === 'facebook') return { ...prev, facebook: result.posts }
        if (result.platform === 'instagram') return { ...prev, instagram: result.posts }
        if (result.platform === 'linkedin') return { ...prev, linkedin: result.posts }
        return { ...prev, twitter: result.posts }
      })
    })
  }, [pastView, viewingPastId, pastContent, generatingPlatforms])

  // Keep the transcript scrolled to the latest paragraph as it streams in.
  useEffect(() => {
    if (viewingPastId !== null) return
    const el = transcriptRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [liveSegments, viewingPastId])

  const isRecording = meetingState === 'recording'
  const isPaused = meetingState === 'paused'
  const showingSession = viewingPastId !== null || currentSessionId !== null

  const startNewSession = (): void => {
    setViewingPast(null)
    setCurrentSession(null)
    setLiveSegments([])
    setAutoStopNotice(null)
  }

  const copyTranscript = (blocks: ParagraphBlock[]): void => {
    window.api.copyText(
      blocks.map((b) => `[${formatElapsed(b.startMs)} · ${formatClock(b.startedAt)}] ${b.text}`).join('\n\n')
    )
  }

  const copySummary = (): void => {
    window.api.copyText(pastSummary)
  }

  // Manual retry for a session whose title/summary generation failed (e.g. offline,
  // rate-limited, or a proxy hiccup right after Stop) — the Summary tab otherwise has
  // no way to try again. On success the main process broadcasts MEETING_SESSION_UPDATED,
  // which the onMeetingSessionUpdated handler above already applies to pastSummary/
  // pastTitle, so there's nothing else to update here on success or failure.
  const retrySummary = (): void => {
    if (viewingPastId === null || summaryGenerating) return
    setSummaryGenerating(true)
    void window.api.generateMeetingSummary(viewingPastId).then(() => {
      setSummaryGenerating(false)
    })
  }

  const copyCurrentPastView = (): void => {
    if (pastView === 'transcript') return copyTranscript(pastBlocks)
    if (pastView === 'summary') return copySummary()
    if (pastView === 'website') {
      if (pastContent?.website) {
        const { title, metaDescription, body } = pastContent.website
        window.api.copyText(metaDescription ? `${title}\n\n${metaDescription}\n\n${body}` : `${title}\n\n${body}`)
      }
      return
    }
    const posts = pastContent?.[pastView]
    if (posts) window.api.copyText(posts[variantIndex[pastView]] ?? '')
  }

  const copyLabel: Record<PastView, string> = {
    transcript: 'Copy transcript',
    summary: 'Copy summary',
    website: 'Copy article',
    facebook: 'Copy post',
    instagram: 'Copy caption',
    linkedin: 'Copy post',
    twitter: 'Copy post'
  }

  const copyDisabled =
    pastView === 'transcript'
      ? false
      : pastView === 'summary'
        ? !pastSummary
        : pastView === 'website'
          ? !pastContent?.website
          : !pastContent?.[pastView]

  const startRename = (id: string): void => {
    setMenuPos(null)
    setRenamingId(id)
  }

  const commitRename = (id: string, rawTitle: string): void => {
    setRenamingId(null)
    const title = rawTitle.trim()
    const existing = sessions.find((s) => s.id === id)
    if (!title || !existing || existing.title === title) return
    void window.api.renameMeetingSession(id, title)
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)))
    if (viewingPastIdRef.current === id) setPastTitle(title)
  }

  const handleDelete = (id: string, title: string): void => {
    setMenuPos(null)
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return
    void window.api.deleteMeetingSession(id).then(() => {
      setSessions((prev) => prev.filter((s) => s.id !== id))
      if (viewingPastIdRef.current === id) setViewingPast(null)
    })
  }

  // Live audio-source switcher (near the timer) — lets the user flip mic/system/both
  // mid-recording instead of only once on the idle "Start recording" screen.
  const handleSwitchAudioSource = (newSource: MeetingAudioSource): void => {
    if (newSource === audioSource || switchingAudioSource || !isRecording) return
    setSwitchingAudioSource(true)
    setAudioSourceSwitchError(null)
    recorderRef.current
      .switchAudioSource(newSource, setLevel, handleChunk)
      .then(() => {
        setAudioSource(newSource)
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : 'access denied or unavailable'
        setAudioSourceSwitchError(`Could not switch source: ${detail}`)
      })
      .finally(() => {
        setSwitchingAudioSource(false)
      })
  }

  // "Discard" button, between Pause and Stop — cancels the in-progress session
  // without saving it, in one click, instead of Stop (which saves) + sidebar Delete.
  const handleDiscard = (): void => {
    if (!isRecording && !isPaused) return
    if (!window.confirm("Discard this recording? What's been captured so far will not be saved.")) return
    discardingRef.current = true
    window.api.meetingDiscard()
  }

  const liveBlocks = groupIntoParagraphs(liveSegments)
  const pastBlocks = groupIntoParagraphs(pastSegments)

  return (
    <div className="meeting">
      <div className="meeting-layout">
        <aside className="meeting-sidebar">
          <button
            className="meeting-new-btn"
            onClick={startNewSession}
            disabled={isRecording || isPaused || (viewingPastId === null && currentSessionId === null)}
          >
            + New session
          </button>
          {sessions.length === 0 ? (
            <div className="meeting-sidebar-empty">No sessions yet</div>
          ) : (
            <div className="meeting-session-list" onScroll={() => setMenuPos(null)}>
              {sessions.map((s) => {
                const isActiveRow = s.status === 'recording' ? viewingPastId === null : viewingPastId === s.id
                const isRenamingThis = renamingId === s.id
                return (
                  <div key={s.id} className={isActiveRow ? 'meeting-session-row active' : 'meeting-session-row'}>
                    <div
                      className="meeting-session-row-main"
                      onClick={() => {
                        // Only this session's own auto-stop banner belongs on its past
                        // view — clear it here so browsing to a different one doesn't
                        // carry it along.
                        setAutoStopNotice(null)
                        setViewingPast(s.status === 'recording' ? null : s.id)
                      }}
                    >
                      {isRenamingThis ? (
                        <input
                          className="meeting-session-rename-input"
                          autoFocus
                          maxLength={200}
                          defaultValue={s.title}
                          onClick={(e) => e.stopPropagation()}
                          onFocus={(e) => e.currentTarget.select()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') e.currentTarget.blur()
                            else if (e.key === 'Escape') {
                              skipRenameBlurRef.current = true
                              setRenamingId(null)
                            }
                          }}
                          onBlur={(e) => {
                            if (skipRenameBlurRef.current) {
                              skipRenameBlurRef.current = false
                              return
                            }
                            commitRename(s.id, e.currentTarget.value)
                          }}
                        />
                      ) : (
                        <span className="meeting-session-title">{s.title}</span>
                      )}
                      <span className="meeting-session-meta">
                        {s.status === 'recording' && <span className="meeting-session-dot" />}
                        {s.status === 'summarizing' ? 'Summarizing…' : formatElapsed(s.durationMs)}
                      </span>
                    </div>
                    {s.status === 'stopped' && (
                      <div className="meeting-session-kebab-wrap">
                        <button
                          className={menuPos?.id === s.id ? 'meeting-session-kebab open' : 'meeting-session-kebab'}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (menuPos?.id === s.id) {
                              setMenuPos(null)
                              return
                            }
                            const rect = e.currentTarget.getBoundingClientRect()
                            setMenuPos({ id: s.id, top: rect.bottom + 4, right: window.innerWidth - rect.right })
                          }}
                          aria-label="Session options"
                        >
                          ⋯
                        </button>
                        {menuPos?.id === s.id && (
                          <>
                            <div className="meeting-session-menu-backdrop" onClick={() => setMenuPos(null)} />
                            <div
                              className="meeting-session-menu"
                              style={{ top: menuPos.top, right: menuPos.right }}
                            >
                              <button onClick={() => startRename(s.id)}>Rename</button>
                              <button className="danger" onClick={() => handleDelete(s.id, s.title)}>
                                Delete
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </aside>
        <div className={showingSession ? 'meeting-main has-session' : 'meeting-main'}>
          {meetingState === 'error' && viewingPastId === null && (
            <div className="meeting-error">Could not access the microphone. Check permissions and try again.</div>
          )}

          {viewingPastId !== null ? (
            <div className="meeting-session-view">
              <div className="meeting-session-header">
                <div className="meeting-session-heading">
                  <h2>{pastTitle}</h2>
                  <div className="meeting-session-date">{formatSessionDate(pastCreatedAt)}</div>
                </div>
              </div>
              <div className="meeting-view-toggle-row">
                <div className="meeting-view-toggle">
                  {PAST_VIEW_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      className={pastView === tab.id ? 'meeting-view-btn active' : 'meeting-view-btn'}
                      onClick={() => setPastView(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <button className="meeting-copy-btn" onClick={copyCurrentPastView} disabled={copyDisabled}>
                  {copyLabel[pastView]}
                </button>
              </div>
              <div className="meeting-ended-note">
                {pastStatus === 'summarizing' ? 'Recording ended — writing a title…' : 'Recording ended'}
              </div>
              {autoStopNotice && <div className="meeting-resume-error">{autoStopNotice}</div>}
              {pastView === 'transcript' ? (
                <div className="meeting-transcript">
                  {pastBlocks.length === 0 ? (
                    <div className="meeting-transcript-empty">No speech was transcribed in this session.</div>
                  ) : (
                    pastBlocks.map((b) => (
                      <div key={b.id} className="meeting-paragraph">
                        <span className="meeting-paragraph-time">
                          <span className="meeting-paragraph-elapsed">{formatElapsed(b.startMs)}</span>
                          <span className="meeting-paragraph-clock">{formatClock(b.startedAt)}</span>
                        </span>
                        <p>{b.text}</p>
                      </div>
                    ))
                  )}
                </div>
              ) : pastView === 'summary' ? (
                <div className="meeting-summary-view">
                  {pastSummary ? (
                    renderSummaryBlocks(pastSummary)
                  ) : (
                    <div className="meeting-transcript-empty">
                      <div>
                        {pastStatus === 'summarizing' || summaryGenerating
                          ? 'Summarizing…'
                          : 'No summary available for this session.'}
                      </div>
                      {pastStatus !== 'summarizing' && (
                        <button className="meeting-retry-btn" onClick={retrySummary} disabled={summaryGenerating}>
                          {summaryGenerating ? 'Generating…' : 'Try again'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ) : pastView === 'website' ? (
                <div className="meeting-summary-view">
                  {pastContent?.website ? (
                    <>
                      <p className="meeting-content-seo-title">
                        <strong>SEO title ({pastContent.website.title.length} chars):</strong> {pastContent.website.title}
                      </p>
                      {pastContent.website.metaDescription && (
                        <p className="meeting-content-seo-title">
                          <strong>Meta description ({pastContent.website.metaDescription.length} chars):</strong>{' '}
                          {pastContent.website.metaDescription}
                        </p>
                      )}
                      {renderSummaryBlocks(pastContent.website.body)}
                    </>
                  ) : (
                    <div className="meeting-transcript-empty">
                      {generatingPlatforms.website
                        ? 'Writing a blog post…'
                        : 'Could not generate a blog post — check your connection/API key, then reopen this tab to retry.'}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {pastContent?.[pastView] ? (
                    <div className="meeting-variant-tabs">
                      {pastContent[pastView]!.map((_, i) => (
                        <button
                          key={i}
                          className={variantIndex[pastView] === i ? 'meeting-variant-tab active' : 'meeting-variant-tab'}
                          onClick={() => setVariantIndex((prev) => ({ ...prev, [pastView]: i }))}
                        >
                          Version {i + 1}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="meeting-summary-view">
                    {pastContent?.[pastView] ? (
                      <p className="meeting-post-text">
                        {renderInlineBold(pastContent[pastView]![variantIndex[pastView]], 'post')}
                      </p>
                    ) : (
                      <div className="meeting-transcript-empty">
                        {generatingPlatforms[pastView]
                          ? `Writing ${pastView} posts…`
                          : 'Could not generate posts — check your connection/API key, then reopen this tab to retry.'}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : currentSessionId !== null ? (
            <div className="meeting-session-view">
              <div className="meeting-session-header">
                <div className="meeting-timer">{formatElapsed(elapsedMs)}</div>
                <div className="meeting-source-switcher" role="group" aria-label="Audio source">
                  {AUDIO_SOURCE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={
                        opt.value === audioSource ? 'meeting-source-switcher-btn active' : 'meeting-source-switcher-btn'
                      }
                      onClick={() => handleSwitchAudioSource(opt.value)}
                      disabled={!isRecording || switchingAudioSource}
                      title={opt.label}
                    >
                      {SOURCE_SWITCHER_LABELS[opt.value]}
                    </button>
                  ))}
                </div>
                <button className="meeting-copy-btn" onClick={() => copyTranscript(liveBlocks)} disabled={liveBlocks.length === 0}>
                  Copy transcript
                </button>
              </div>
              <div className="meeting-waveform" aria-hidden="true">
                {Array.from({ length: LEVEL_BARS }).map((_, i) => (
                  <span
                    key={i}
                    className="meeting-waveform-bar"
                    style={{ transform: `scaleY(${isRecording ? Math.max(0.08, Math.min(1, level * 3)) : 0.08})` }}
                  />
                ))}
              </div>
              {resumeError && <div className="meeting-resume-error">{resumeError}</div>}
              {audioSourceSwitchError && <div className="meeting-resume-error">{audioSourceSwitchError}</div>}
              <div className="meeting-btn-row">
                {isPaused ? (
                  <button className="meeting-btn meeting-btn-resume" onClick={() => window.api.meetingResume()}>
                    Resume
                  </button>
                ) : (
                  <button className="meeting-btn meeting-btn-pause" onClick={() => window.api.meetingPause()} disabled={!isRecording}>
                    Pause
                  </button>
                )}
                <button className="meeting-btn meeting-btn-discard" onClick={handleDiscard} disabled={!isRecording && !isPaused}>
                  Discard
                </button>
                <button className="meeting-btn meeting-btn-stop" onClick={() => window.api.meetingStop()} disabled={!isRecording && !isPaused}>
                  Stop
                </button>
              </div>
              <div className="meeting-transcript" ref={transcriptRef}>
                {liveBlocks.length === 0 ? (
                  <div className="meeting-transcript-empty">
                    {isPaused ? 'Paused — press Resume to keep going.' : 'Listening… transcribed text will appear here as you speak.'}
                  </div>
                ) : (
                  liveBlocks.map((b) => (
                    <div key={b.id} className="meeting-paragraph">
                      <span className="meeting-paragraph-time">
                        <span className="meeting-paragraph-elapsed">{formatElapsed(b.startMs)}</span>
                        <span className="meeting-paragraph-clock">{formatClock(b.startedAt)}</span>
                      </span>
                      <p>{b.text}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="meeting-timer">00:00</div>
              <div className="meeting-waveform" aria-hidden="true">
                {Array.from({ length: LEVEL_BARS }).map((_, i) => (
                  <span key={i} className="meeting-waveform-bar" style={{ transform: 'scaleY(0.08)' }} />
                ))}
              </div>
              <div className="meeting-audio-source-panel">
                <div className="meeting-audio-source-title">Audio source</div>
                <div className="meeting-audio-source-hint">
                  Pick what to capture — matters most on a call, so your own conversation in the room isn't mixed into
                  it. You can change this while recording too. Tip: headphones keep computer audio out of
                  Microphone-only recordings — a mic can only partly filter out sound coming from this computer's own
                  speakers.
                </div>
                <div className="meeting-audio-source-options">
                  {AUDIO_SOURCE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`meeting-audio-source-option${audioSource === opt.value ? ' active' : ''}`}
                      onClick={() => setAudioSource(opt.value)}
                    >
                      <span className="meeting-audio-source-option-label">{opt.label}</span>
                      <span className="meeting-audio-source-option-desc">{opt.desc}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="meeting-lang-panel">
                <div className="meeting-lang-title">Languages</div>
                <div className="meeting-lang-hint">
                  Pick these before recording — applies to this session's transcript and every generated tab.
                </div>
                <div className="meeting-lang-grid">
                  <LangField
                    label="Spoken (input)"
                    value={langConfig.input}
                    options={LANGUAGES}
                    onChange={(value) => setLangConfig((prev) => ({ ...prev, input: value }))}
                  />
                  <LangField
                    label="Transcript"
                    value={langConfig.transcript}
                    options={TRANSCRIPT_LANGUAGES}
                    onChange={(value) => setLangConfig((prev) => ({ ...prev, transcript: value }))}
                  />
                  <LangField
                    label="Summary"
                    value={langConfig.summary}
                    options={OUTPUT_LANGUAGES}
                    onChange={(value) => setLangConfig((prev) => ({ ...prev, summary: value }))}
                  />
                  <LangField
                    label="Website & social posts"
                    value={langConfig.website}
                    options={OUTPUT_LANGUAGES}
                    onChange={(value) => setLangConfig((prev) => withContentLanguage(prev, value))}
                  />
                </div>
              </div>
              <button className="meeting-btn meeting-btn-start" onClick={() => window.api.meetingStart(langConfig, audioSource)}>
                Start recording
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
