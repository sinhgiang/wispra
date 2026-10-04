import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import type {
  AiQuotaNotice,
  ContentPlatform,
  MeetingAudioSource,
  MeetingChatMessage,
  MeetingContent,
  MeetingLanguageConfig,
  MeetingMindMap,
  MeetingOutline,
  MeetingSegment,
  MeetingSession,
  MeetingSessionSummary,
  MeetingSpace,
  MeetingState,
  MindMapProgress,
  OutlineProgress
} from '@shared/types'
import { LANGUAGES } from '@shared/constants'
import { captureHost, installCaptureHost } from './captureHost'
import { MindMapView } from './MindMapView'
import type { DailyLimitInfo, LiveOutlineStatus, MeetingSummaryStatus, MindMapJobStatus } from '@shared/types'
import { dailyLimitAdvice, dailyLimitText } from './dailyLimit'
import { AiQuotaMessage } from './AiQuotaMessage'
import { buildMindMapTree, formatElapsed, mindMapMarkdown, type MindMapTreeNode } from './mindMapData'
import { TranscriptColumns, type ActionsView } from './TranscriptColumns'
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

const ACTIONS_VIEW_STORAGE_KEY = 'wispra-transcript-actions-view'

/** Restores how the Transcript tab arranges action items (by topic, or one list). By topic unless the user chose the list. */
function loadActionsView(): ActionsView {
  try {
    return localStorage.getItem(ACTIONS_VIEW_STORAGE_KEY) === 'list' ? 'list' : 'topic'
  } catch {
    return 'topic'
  }
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

/**
 * Small folder glyph — used both for each space row in the sidebar (see the
 * Spaces section below "+ New session") and, smaller, next to a session's
 * space tag (see meeting-session-space-tag). Inherits text color via
 * currentColor so it themes automatically.
 */
function FolderIcon({ size = 14 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  )
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

/**
 * ChatGPT-style Q&A panel about a session's own transcript — shown at the bottom of
 * both the live-recording view and the past (stopped) session view. Works whether
 * the session is still recording or already stopped (askMeetingChat in
 * postprocess.ts reads whichever the session currently is). Purely presentational —
 * all state (messages, in-flight, error, which answer is highlighted) lives in
 * MeetingPanel so it can be shared correctly between the live/past variants.
 */
function MeetingChatPanel({
  messages,
  input,
  onInputChange,
  onSend,
  sending,
  error,
  highlightId,
  onSelectAnswer,
  compact = false
}: {
  /** Only the input row even when there are messages — used on the Mind map tab, where the map needs the room. */
  compact?: boolean
  messages: MeetingChatMessage[]
  input: string
  onInputChange: (value: string) => void
  onSend: () => void
  sending: boolean
  error: ReactNode
  highlightId: string | null
  onSelectAnswer: (message: MeetingChatMessage) => void
}): ReactElement {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }
  // Until something is asked, only the question box and Send: the transcript above gets the room.
  const inputOnly = compact || (messages.length === 0 && !sending)
  return (
    <div className={inputOnly ? 'meeting-chat-panel compact' : 'meeting-chat-panel'}>
      <div className="meeting-chat-messages">
        {messages.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'meeting-chat-bubble user' : 'meeting-chat-bubble assistant'}>
            <p>{m.text}</p>
            {m.role === 'assistant' && m.startSegmentId && m.endSegmentId && (
              <button
                type="button"
                className={
                  m.id === highlightId ? 'meeting-chat-highlight-btn active' : 'meeting-chat-highlight-btn'
                }
                onClick={() => onSelectAnswer(m)}
              >
                {m.id === highlightId ? 'Highlighted in transcript' : 'Show in transcript'}
              </button>
            )}
          </div>
        ))}
        {sending && (
          <div className="meeting-chat-bubble assistant meeting-chat-thinking" aria-label="Thinking…">
            <span className="meeting-chat-dot" />
            <span className="meeting-chat-dot" />
            <span className="meeting-chat-dot" />
          </div>
        )}
      </div>
      {typeof error === 'string' ? <div className="meeting-chat-error">{error}</div> : error}
      <div className="meeting-chat-input-row">
        <textarea
          className="meeting-chat-input"
          placeholder="Ask a question about this recording…"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <button type="button" className="meeting-chat-send-btn" onClick={onSend} disabled={sending || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  )
}

const LEVEL_BARS = 24

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
 * Turns an AI summary (plain text with blank-line-separated paragraphs,
 * "## Heading" section titles, and "- "/"1. " list lines, produced by the
 * MEETING_TITLE_PROMPT and CONTENT_PROMPTS.website in postprocess.ts) into
 * paragraph/heading/list JSX instead of one unbroken block.
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

/** One line saying where a session's mind map job is — the tooltip of its marks in the session list and on the tab. */
function mindMapJobLabel(job: MindMapJobStatus): string {
  if (job.state === 'done') return 'The mind map is ready'
  if (job.state === 'stopped' && job.reason === 'daily-limit') return "The mind map stopped at the AI provider's daily limit — open the Mind map tab for when it resets"
  if (job.state === 'stopped') {
    return job.total > 1 ? `The mind map is not finished (${job.done} of ${job.total} parts done) — open the Mind map tab to continue` : 'The mind map is not finished — open the Mind map tab to try again'
  }
  if (job.phase === 'merge') return 'Building the mind map — putting the parts together'
  return job.total > 1 ? `Building the mind map — ${job.done} of ${job.total} parts done` : 'Building the mind map'
}
/** How an AI call failed: Wispra Cloud's monthly AI allowance is used up ('quota'), or anything else ('error'). */
type FailureKind = 'error' | 'quota' | 'rate-limit' | 'daily-limit'

/** Value of the chat error state when the last question failed because the allowance is used up. */
const CHAT_ERROR_QUOTA = '\u0000ai-quota'

/** A Website / social request waiting for the AI provider's per-minute limit (HTTP 429). */
const WAITING_TEXT = "Waiting for the AI provider's per-minute limit, then trying again…"
/** …and giving up after a few minutes of that. Not a connection or key problem. */
const RATE_LIMITED_TEXT =
  "The AI provider's per-minute limit was still reached after waiting a few minutes — often because a mind map is being built with the same key. Try again in a minute."

/** Says that a backup model wrote what follows (the main model was at its daily limit). Nothing when the main model did. */
function BackupModelNote({ model }: { model: string | undefined }): ReactElement | null {
  if (!model) return null
  return <p className="meeting-backup-note">Written by the backup model {model} — the main model had reached its daily limit.</p>
}

/** How each social platform is named in the "Create …" button and the messages around it. */
const PLATFORM_NAMES: Record<Exclude<ContentPlatform, 'website'>, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  twitter: 'X'
}

/** What an empty Website or social tab shows: nothing is generated until this button is pressed. */
function CreateContentPrompt({ label, text, onCreate }: { label: string; text: string; onCreate: () => void }): ReactElement {
  return (
    <div className="meeting-create-prompt">
      <button type="button" className="meeting-create-btn" onClick={onCreate}>
        {label}
      </button>
      <div className="meeting-create-note">{text}</div>
    </div>
  )
}

type PastView = 'transcript' | 'summary' | 'mindmap' | ContentPlatform

const PAST_VIEW_TABS: Array<{ id: PastView; label: string }> = [
  { id: 'transcript', label: 'Transcript' },
  { id: 'summary', label: 'Summary' },
  { id: 'mindmap', label: 'Mind map' },
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
  /** "Both"-mode recordings: who the audio levels say was talking in this paragraph (see MeetingSegment.voice). A paragraph never mixes the two — a change of voice starts a new one. */
  voice?: 'me' | 'others'
  /** ids of every segment merged into this block — lets a chat answer's segment-id range (see MeetingChatMessage in shared/types.ts) resolve onto the paragraph block(s) it falls within, for transcript highlighting (see resolveHighlightBlockIds). */
  segmentIds: string[]
}

/** Shown while a session's own paragraphs are still loading (a stable reference, so nothing re-renders for it). */
const NO_BLOCKS: ParagraphBlock[] = []

/** Merges consecutive segments into paragraph blocks (isNewParagraph starts a new one), each labeled with the elapsed time and wall-clock time it started. */
function groupIntoParagraphs(segments: MeetingSegment[]): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = []
  for (const seg of segments) {
    const last = blocks[blocks.length - 1]
    if (seg.isNewParagraph || !last) {
      blocks.push({ id: seg.id, startedAt: seg.startedAt, startMs: seg.startMs, text: seg.text, segmentIds: [seg.id], voice: seg.voice })
    } else {
      last.text += ' ' + seg.text
      last.segmentIds.push(seg.id)
    }
  }
  return blocks
}

/** A stretch of the transcript picked on the Mind map tab ("Show in transcript"), highlighted the same way as a chat answer's range. */
interface MapHighlight {
  startSegmentId: string
  endSegmentId: string
  /** The node's label and colour, shown in the "From mind map" bar above the transcript. */
  label: string
  color: string
}

/**
 * Maps a startSegmentId/endSegmentId range — a chat answer's (see the AI chat panel
 * below and askMeetingChat in postprocess.ts) or a mind map node's (MapHighlight) —
 * onto the paragraph block(s) it spans, for transcript highlighting. Returns an empty
 * set — never throws — if there is no range, or if either id can't be found (e.g. the
 * transcript was truncated before the LLM call, or the model returned a
 * stale/hallucinated id).
 */
function resolveHighlightBlockIds(
  blocks: ParagraphBlock[],
  message: { startSegmentId?: string; endSegmentId?: string } | null | undefined
): Set<string> {
  if (!message?.startSegmentId || !message.endSegmentId) return new Set()
  const startIdx = blocks.findIndex((b) => b.segmentIds.includes(message.startSegmentId!))
  const endIdx = blocks.findIndex((b) => b.segmentIds.includes(message.endSegmentId!))
  if (startIdx === -1 || endIdx === -1) return new Set()
  const [from, to] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
  return new Set(blocks.slice(from, to + 1).map((b) => b.id))
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
  /** Topics named so far in the recording in progress (see liveOutline.ts), with the part still open. */
  const [liveOutline, setLiveOutline] = useState<MeetingOutline | undefined>(undefined)
  /** Speaker names typed for the recording in progress, by paragraph id. */
  const [liveSpeakerNames, setLiveSpeakerNames] = useState<Record<string, string>>({})
  /** Whether a finished part is being named right now, or naming stopped (daily limit, failures). */
  const [liveOutlineStatus, setLiveOutlineStatus] = useState<LiveOutlineStatus | null>(null)
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
  /** The viewed session's summary request and the provider's limits: waiting (per minute), gave up, or stopped at the daily limit. */
  const [summaryStatus, setSummaryStatus] = useState<MeetingSummaryStatus | null>(null)
  /** Which view the past-session panel is showing: raw transcript, AI summary, or one of the on-demand-generated platform tabs. */
  const [pastView, setPastView] = useState<PastView>('transcript')
  /** On-demand-generated ready-to-post content for the session being viewed, cached on the session itself once generated (see setContent in meetingSessions.ts). */
  const [pastContent, setPastContent] = useState<MeetingContent | undefined>(undefined)
  /** Which backup model wrote the viewed session's summary / posts, when the main model was at its daily limit. */
  const [pastBackupModels, setPastBackupModels] = useState<MeetingSession['backupModels']>(undefined)
  /** Topics, action items and speaker names of the session being viewed (see MeetingOutline) — what the Transcript tab's columns are built from. */
  const [pastOutline, setPastOutline] = useState<MeetingOutline | undefined>(undefined)
  const [outlineGenerating, setOutlineGenerating] = useState(false)
  const [outlineProgress, setOutlineProgress] = useState<OutlineProgress | null>(null)
  /** The last outline generation for the session being viewed failed — stops the effect below from retrying by itself; "Try again" clears it. */
  const [outlineFailed, setOutlineFailed] = useState(false)
  /** Speaker names the user typed for the session being viewed, by paragraph id. */
  const [pastSpeakerNames, setPastSpeakerNames] = useState<Record<string, string>>({})
  /** Action item clicked in the Transcript tab: its paragraph is highlighted. Never set together with the chat's or the mind map's highlight. */
  const [actionHighlight, setActionHighlight] = useState<{ key: string; startSegmentId: string; endSegmentId: string } | null>(null)
  /** Action items next to their topic, or as one list — remembered across sessions (see loadActionsView). */
  const [actionsView, setActionsView] = useState<ActionsView>(loadActionsView)
  /** id of the past session whose data (segments, summary, mind map…) is currently loaded — lags viewingPastId by one getMeetingSession() round trip, during which the state above still belongs to the previously viewed session. */
  const [pastLoadedId, setPastLoadedId] = useState<string | null>(null)
  /** Mind map of the session being viewed, cached on the session once generated (see setMindMap in meetingSessions.ts). */
  const [pastMindMap, setPastMindMap] = useState<MeetingMindMap | undefined>(undefined)
  /** True once the Mind map tab has been opened for the session being viewed — its view then stays mounted (hidden) behind the other tabs so the map keeps its open branches and zoom. */
  const [mindMapOpened, setMindMapOpened] = useState(false)
  /**
   * Mind map jobs by session id: running, stopped part-way, or finished but not yet
   * looked at. The jobs run in the main process (mindMapJobs.ts) whatever this page
   * shows — this only mirrors them, so leaving the tab, the session or the page never
   * stops or restarts one. A stopped job also keeps the open-tab effect from retrying in
   * a loop; "Continue"/"Try again"/Regenerate start it again.
   */
  const [mindMapJobs, setMindMapJobs] = useState<Record<string, MindMapJobStatus>>({})
  /** False until the jobs were fetched after mount — before that the open-tab effect cannot know whether one is already running. */
  const [mindMapJobsLoaded, setMindMapJobsLoaded] = useState(false)
  /** Transcript stretch picked with "Show in transcript" on the Mind map tab. Never set together with chatHighlightId — whichever was chosen last wins. */
  const [mapHighlight, setMapHighlight] = useState<MapHighlight | null>(null)
  /** Which platform tabs are currently waiting on a generateMeetingContent() call — per-platform (not a single value) so switching between several not-yet-generated tabs in quick succession tracks each one's own in-flight state correctly instead of only the most recently opened tab. */
  const [generatingPlatforms, setGeneratingPlatforms] = useState<Partial<Record<ContentPlatform, boolean>>>({})
  /** Which platform tabs' last generateMeetingContent() call failed for the session being viewed. A failed tab is not generated again by itself — the effect below would otherwise call the LLM in a loop for as long as the tab stays open — only when the user presses "Try again" (retryContent). */
  const [failedPlatforms, setFailedPlatforms] = useState<Partial<Record<ContentPlatform, FailureKind>>>({})
  /** Platform tabs of the viewed session whose request is waiting for the provider's per-minute limit: when it goes again (ms). */
  const [contentWaiting, setContentWaiting] = useState<Partial<Record<ContentPlatform, number>>>({})
  /** "sessionId/platform" of requests that gave up because of the provider's per-minute limit — read when their answer arrives. */
  const contentRateLimitedRef = useRef(new Set<string>())
  /** "sessionId/platform" of requests stopped at the provider's daily limit, with its numbers — read when their answer arrives. */
  const contentDailyRef = useRef(new Map<string, DailyLimitInfo>())
  /** The daily limit behind a platform tab's failure, when that was the reason. */
  const [contentDaily, setContentDaily] = useState<Partial<Record<ContentPlatform, DailyLimitInfo>>>({})
  /**
   * Wispra Cloud's "this month's AI allowance is used up" notice (see AiQuotaNotice),
   * pushed by the main process the moment the server says so. A failure that follows
   * such a notice is shown as that (reset date, what to do) instead of the generic
   * "check your connection" text. Null for users on their own key — it never applies.
   */
  const [aiQuota, setAiQuota] = useState<AiQuotaNotice | null>(null)
  // Read by the async handlers below right when a call fails, before React re-renders.
  const aiQuotaRef = useRef<AiQuotaNotice | null>(null)
  /** Pro checkout link for the notice's "upgrade" option — fetched once a notice arrives. */
  const [subscribeUrl, setSubscribeUrl] = useState<string | null>(null)
  // Why a call that started at `startedAt` failed: the allowance notice arrives from the
  // main process before the failed call's own answer does, so a notice at least as new
  // as the call means "allowance used up"; anything else is an ordinary failure.
  const failureKind = (startedAt: number): FailureKind =>
    aiQuotaRef.current !== null && aiQuotaRef.current.seenAt >= startedAt ? 'quota' : 'error'
  const quotaMessage = aiQuota ? <AiQuotaMessage notice={aiQuota} subscribeUrl={subscribeUrl} /> : null  /** Which of the 3 generated variants is shown for each social platform. */
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
  /** User-created spaces for organizing sessions (e.g. one per class) — see the space tabs row above the session list. */
  const [spaces, setSpaces] = useState<MeetingSpace[]>([])
  /** Which space tab is selected — filters the session list below, and (if not null) is where the next new recording gets filed. null = "All". */
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null)
  /** True while the inline "new space" name input is showing (the "+" tab). */
  const [creatingSpace, setCreatingSpace] = useState(false)
  /** id of the space tab currently being renamed inline, if any. */
  const [renamingSpaceId, setRenamingSpaceId] = useState<string | null>(null)
  /** The open space-tab kebab menu's space id + screen position — same pattern as menuPos above, kept separate so opening one never closes the other by accident. */
  const [spaceMenuPos, setSpaceMenuPos] = useState<{ id: string; top: number; right: number } | null>(null)
  // Same Escape-vs-blur trick as skipRenameBlurRef, for the space rename input.
  const skipSpaceRenameBlurRef = useRef(false)
  /** Language choices for the next recording, picked on the idle "Start recording" screen. Persisted across sessions (see loadLangConfig) so the user's usual picks stick. */
  const [langConfig, setLangConfig] = useState<MeetingLanguageConfig>(loadLangConfig)
  /** Audio-source choice for the next recording (mic / system / both), picked on the same idle screen. Persisted the same way as langConfig. */
  const [audioSource, setAudioSourceState] = useState<MeetingAudioSource>(loadAudioSource)
  // The window's recorder (captureHost.ts) records from whatever was picked last.
  const setAudioSource = useCallback((value: MeetingAudioSource) => {
    captureHost.setAudioSource(value)
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

  // --- in-session AI chat (see MeetingChatMessage in shared/types.ts, askMeetingChat
  // in postprocess.ts) — separate message arrays for the live session and whichever
  // past session is being viewed, so switching between them never mixes histories.
  // Input/sending/error/highlight are shared since only one of the two chat panels is
  // ever visible at a time (see isPastChat below).
  const [liveChat, setLiveChat] = useState<MeetingChatMessage[]>([])
  const [pastChat, setPastChat] = useState<MeetingChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  // The chat's error line: the allowance message when that is why the last question failed.
  const chatErrorView: ReactNode =
    chatError === CHAT_ERROR_QUOTA
      ? (quotaMessage ?? "This month's AI allowance is used up. Try again after it resets.")
      : chatError
  /** id of the assistant chat message currently driving the transcript highlight, if any — set automatically when a fresh answer names a range, or by clicking "Show in transcript" on any past answer. */
  const [chatHighlightId, setChatHighlightId] = useState<string | null>(null)

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

  const startedAtRef = useRef(0)
  const transcriptRef = useRef<HTMLDivElement>(null)
  // Same purpose as transcriptRef, for the read-only past-session transcript — used
  // only to scroll a chat-highlighted paragraph into view (see the chatHighlightId
  // effect below), never auto-scrolled to the bottom like the live one.
  const pastTranscriptRef = useRef<HTMLDivElement>(null)
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

  // The IPC listeners of this panel. They are removed when the panel unmounts (another
  // tab is shown): the recording itself goes on in the window's recorder (captureHost.ts)
  // whatever this panel shows, and a panel that left its listeners behind made every
  // later Start run once per earlier visit to the tab.
  useEffect(() => {
    installCaptureHost()
    captureHost.setAudioSource(audioSource)
    const off: Array<() => void> = []
    off.push(captureHost.onLevel(setLevel))
    off.push(captureHost.onResumeError(setResumeError))
    off.push(window.api.onMeetingStateChanged(setMeetingState))
    off.push(window.api.onMeetingCaptureStart(() => {
      startedAtRef.current = Date.now()
      setLiveSegments([])
      setLiveOutline(undefined)
      setLiveSpeakerNames({})
      setLiveOutlineStatus(null)
      setActionHighlight(null)
      setLiveChat([])
      setChatInput('')
      setChatError(null)
      setChatHighlightId(null)
      setViewingPast(null)
      setResumeError(null)
      autoStoppedSessionIdRef.current = null
      setAutoStopNotice(null)
      void window.api.getMeetingSessions().then((list) => {
        setSessions(list)
        const active = list.find((s) => s.status === 'recording')
        if (active) setCurrentSession(active.id)
      })
    }))
    off.push(window.api.onMeetingCaptureResume(() => setResumeError(null)))
    // Arrives right before onMeetingCaptureStop when the silence safety net (not the
    // user) ended the recording — just records which session that was; the actual
    // notice is shown once we know (below) that the stop wasn't a discard.
    off.push(window.api.onMeetingAutoStopped(() => {
      autoStoppedSessionIdRef.current = currentSessionIdRef.current
    }))
    off.push(window.api.onMeetingCaptureStop(() => {
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
        setLiveChat([])
        setChatInput('')
        setChatError(null)
        setChatHighlightId(null)
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
    }))
    off.push(window.api.onMeetingSegmentReady((segment) => {
      setLiveSegments((prev) => [...prev, segment])
    }))
    off.push(window.api.onMeetingSessionUpdated((session) => {
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
                status: session.status,
                spaceId: session.spaceId
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
        setPastBackupModels(session.backupModels)
        setPastChat(session.chat ?? [])
        // Same map, new object (this broadcast fires for every session change, e.g. a
        // chat answer): keep the old reference so the drawn map is not rebuilt.
        setPastMindMap((prev) => (prev?.generatedAt === session.mindMap?.generatedAt ? prev : session.mindMap))
        setPastOutline((prev) => (prev?.generatedAt === session.outline?.generatedAt ? prev : session.outline))
        setPastSpeakerNames(session.speakerNames ?? {})
      }
      // Same, for the live session's own chat — e.g. an answer that just finished
      // while the mic is still recording. This is the single source of truth for
      // liveChat; sendActiveChatMessage below only manages an optimistic bubble
      // in between sending a question and this broadcast arriving.
      if (currentSessionIdRef.current === session.id) {
        setLiveChat(session.chat ?? [])
        setLiveOutline((prev) => (prev?.generatedAt === session.outline?.generatedAt ? prev : session.outline))
        setLiveSpeakerNames(session.speakerNames ?? {})
      }
    }))
    off.push(window.api.onMeetingLiveOutlineStatus((status) => {
      if (currentSessionIdRef.current === status.sessionId) setLiveOutlineStatus(status)
    }))
    off.push(window.api.onMeetingOutlineProgress((progress) => {
      if (viewingPastIdRef.current === progress.sessionId) setOutlineProgress(progress)
    }))
    off.push(window.api.onMeetingMindMapProgress((progress) => {
      setMindMapJobs((prev) => ({ ...prev, [progress.sessionId]: progress }))
    }))
    off.push(window.api.onMeetingSummaryStatus((status) => {
      if (viewingPastIdRef.current === status.sessionId) setSummaryStatus(status)
    }))
    off.push(window.api.onMeetingContentStatus((status) => {
      const key = `${status.sessionId}/${status.platform}`
      if (status.rateLimited) contentRateLimitedRef.current.add(key)
      if (status.dailyLimit) contentDailyRef.current.set(key, status.dailyLimit)
      if (viewingPastIdRef.current !== status.sessionId) return
      setContentWaiting((prev) => ({ ...prev, [status.platform]: status.waitingUntil }))
    }))
    // Jobs that were already running (or stopped, or finished unseen) before this page mounted.
    void window.api.getMeetingMindMapJobs().then((jobs) => {
      setMindMapJobs((prev) => ({ ...Object.fromEntries((jobs ?? []).map((job) => [job.sessionId, job])), ...prev }))
      setMindMapJobsLoaded(true)
    })
    const applyAiQuota = (notice: AiQuotaNotice | null): void => {
      aiQuotaRef.current = notice
      setAiQuota(notice)
      if (notice) void window.api.getAccountInfo().then((info) => setSubscribeUrl(info?.subscribeUrl ?? null))
    }
    off.push(window.api.onAiQuotaChanged(applyAiQuota))
    void window.api.getAiQuota().then(applyAiQuota)

    // Hydrate on mount: a fresh mount (first open, or re-opening this tab after
    // switching away mid-meeting) otherwise has no idea a recording is already
    // in progress until the next state change broadcasts.
    void (async () => {
      const [state, list, spaceList] = await Promise.all([
        window.api.getMeetingState(),
        window.api.getMeetingSessions(),
        window.api.getMeetingSpaces()
      ])
      setMeetingState(state)
      setSessions(list)
      setSpaces(spaceList)
      if (state === 'recording' || state === 'paused') {
        const active = list.find((s) => s.status === 'recording')
        if (active) {
          setCurrentSession(active.id)
          const full = await window.api.getMeetingSession(active.id)
          if (full) {
            setLiveSegments(full.segments)
            setLiveChat(full.chat ?? [])
            setLiveOutline(full.outline)
            setLiveSpeakerNames(full.speakerNames ?? {})
            void window.api.getMeetingLiveOutlineStatus().then((status) => {
              if (status?.sessionId === active.id) setLiveOutlineStatus(status)
            })
            startedAtRef.current = Date.parse(full.createdAt)
          }
        }
      }
    })()
    return () => {
      for (const unsubscribe of off) unsubscribe()
    }
    // Registered once per mount; the handlers read changing values through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSessions])

  // Live elapsed timer while recording — reads the recorder's pause-aware active
  // timeline so it freezes exactly while paused and never jumps on resume.
  useEffect(() => {
    if (meetingState !== 'recording') return
    const tick = (): void => {
      const active = captureHost.getActiveMs()
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
    setFailedPlatforms({})
    setContentWaiting({})
    setSummaryStatus(null)
    setSummaryGenerating(false)
    setVariantIndex({ facebook: 0, instagram: 0, linkedin: 0, twitter: 0 })
    setChatInput('')
    setChatError(null)
    setChatHighlightId(null)
    setMapHighlight(null)
    setMindMapOpened(false)
    setActionHighlight(null)
    setOutlineGenerating(false)
    setOutlineProgress(null)
    setOutlineFailed(false)
    const id = viewingPastId
    void window.api.getMeetingSession(id).then((full) => {
      if (cancelled || !full) return
      setPastSegments(full.segments)
      setPastTitle(full.title)
      setPastCreatedAt(full.createdAt)
      setPastStatus(full.status)
      setPastSummary(full.summary ?? '')
      setPastContent(full.content)
      setPastBackupModels(full.backupModels)
      setPastChat(full.chat ?? [])
      setPastMindMap(full.mindMap)
      setPastOutline(full.outline)
      setPastSpeakerNames(full.speakerNames ?? {})
      setPastLoadedId(id)
      // A summary made right after Stop may have hit the provider's limit before this tab was open.
      void window.api.getMeetingSummaryStatus(id).then((status) => {
        if (!cancelled && viewingPastIdRef.current === id) setSummaryStatus(status ?? null)
      })
    })
    return () => {
      cancelled = true
    }
  }, [viewingPastId])

  // Asks the main process for the viewed session's transcript outline — the cached one,
  // the one being built right after Stop (the call joins it), a first build for an
  // older session, or (regenerate) a rebuild. On success the outline also arrives via
  // onMeetingSessionUpdated; both paths keep one reference.
  /** When this install first ran a version that limits automatic AI to new recordings (Settings.autoAiSince); null until read. */
  const [autoAiSince, setAutoAiSince] = useState<string | null>(null)
  useEffect(() => {
    void window.api.getSettings().then((settings) => setAutoAiSince(settings?.autoAiSince ?? ''))
  }, [])
  /** Whether a recording made at `createdAt` may get AI work started by itself. Unknown → no. */
  const autoAiFor = useCallback(
    (createdAt: string): boolean => {
      if (!autoAiSince) return false
      const since = Date.parse(autoAiSince)
      const made = Date.parse(createdAt)
      return Number.isFinite(since) && Number.isFinite(made) && made >= since
    },
    [autoAiSince]
  )

  const requestOutline = useCallback((regenerate: boolean): void => {
    const id = viewingPastIdRef.current
    if (id === null) return
    setOutlineGenerating(true)
    setOutlineFailed(false)
    setOutlineProgress(null)
    void window.api.generateMeetingOutline(id, regenerate ? { regenerate: true } : undefined).then((result) => {
      if (viewingPastIdRef.current !== id) return
      setOutlineGenerating(false)
      if (result) setPastOutline((prev) => (prev?.generatedAt === result.generatedAt ? prev : result))
      else setOutlineFailed(true)
    })
  }, [])

  // The Transcript tab's topics and action items: a recording made since this version
  // was first started gets them right after Stop — and, if that did not happen (the app
  // was closed, or it failed), on first open. An older recording gets them only when the
  // user presses "Create topics and action items": many old recordings would otherwise
  // spend the AI provider's daily allowance just by being looked at.
  // One attempt per opening — a failure is remembered (outlineFailed) and only "Try
  // again" makes another call.
  useEffect(() => {
    if (viewingPastId === null || pastView !== 'transcript') return
    if (pastLoadedId !== viewingPastId) return
    if ((pastOutline && !pastOutline.openFromSegmentId) || outlineGenerating || outlineFailed || pastSegments.length === 0) return
    if (!autoAiFor(pastCreatedAt)) return
    requestOutline(false)
  }, [pastView, viewingPastId, pastLoadedId, pastOutline, outlineGenerating, outlineFailed, pastSegments, pastCreatedAt, autoAiFor, requestOutline])

  // A chat answer or a mind map node was picked to be shown in the transcript: that
  // highlight replaces the clicked action item's (toggleActionHighlight does the reverse).
  useEffect(() => {
    if (chatHighlightId || mapHighlight) setActionHighlight(null)
  }, [chatHighlightId, mapHighlight])

  useEffect(() => {
    try {
      localStorage.setItem(ACTIONS_VIEW_STORAGE_KEY, actionsView)
    } catch {
      // Best-effort — a full/blocked localStorage just means the choice resets next launch.
    }
  }, [actionsView])

  // Asks the main process for the viewed session's mind map — the cached one, a first
  // build, the rest of a build that stopped part-way, or (regenerate) a rebuild. The
  // build is a background job there: its progress and its end arrive as job statuses
  // (mindMapJobs), for whichever session, whether or not this page is still showing it.
  // A rebuild is written in the language currently
  // picked under "Website & social posts", so changing that field and pressing
  // Regenerate re-maps an existing recording in the new language; a first build uses
  // the choice saved with the recording, like the Website and social tabs. On success
  // the map also arrives via onMeetingSessionUpdated; both paths keep one reference.
  const requestMindMap = useCallback(
    (regenerate: boolean): void => {
      const id = viewingPastIdRef.current
      if (id === null) return
      // Shown at once; the job's own status replaces it a moment later.
      setMindMapJobs((prev) => ({
        ...prev,
        [id]: { sessionId: id, state: 'running', phase: 'outline', done: prev[id]?.done ?? 0, total: prev[id]?.total ?? 0, startedAt: new Date().toISOString() }
      }))
      const startedAt = Date.now()
      void window.api
        .generateMeetingMindMap(id, regenerate ? { regenerate: true, language: langConfig.website } : undefined)
        .then((result) => {
          if (result) {
            if (viewingPastIdRef.current === id) setPastMindMap((prev) => (prev?.generatedAt === result.generatedAt ? prev : result))
            // Normally the job has already said "done"; never leave the placeholder above spinning.
            setMindMapJobs((prev) => {
              if (prev[id]?.state !== 'running') return prev
              const { [id]: _finished, ...rest } = prev
              return rest
            })
            return
          }
          // The job says why it stopped; this only covers a request that never became a job.
          setMindMapJobs((prev) => (prev[id]?.state === 'running' ? { ...prev, [id]: { ...prev[id], state: 'stopped', reason: failureKind(startedAt) === 'quota' ? 'quota' : 'failed' } } : prev))
        })
    },
    [langConfig.website]
  )

  // Opening the Mind map tab only shows what is there — a saved map, a job that is
  // running or stopped part-way, or a "Create mind map" button. Nothing is sent to the AI
  // until the user presses that button (a long recording's map takes many AI calls).
  useEffect(() => {
    if (viewingPastId === null || pastView !== 'mindmap') return
    setMindMapOpened(true)
  }, [pastView, viewingPastId])

  // The finished map is on screen: its "ready" mark has done its job.
  useEffect(() => {
    if (viewingPastId === null || pastView !== 'mindmap' || mindMapJobs[viewingPastId]?.state !== 'done') return
    const id = viewingPastId
    void window.api.ackMeetingMindMap(id)
    setMindMapJobs((prev) => {
      const { [id]: _seen, ...rest } = prev
      return rest
    })
  }, [pastView, viewingPastId, mindMapJobs])

  // Generates a platform's content when the user presses its "Create …" button (or "Try
  // again" after a failure) — never because a tab was opened. The result is cached in
  // pastContent (also persisted by the IPC handler), so the tab shows it from then on.
  // One call per press: a failure is remembered in failedPlatforms until the next press.
  const createContent = (platform: ContentPlatform): void => {
    const id = viewingPastIdRef.current
    if (id === null || pastContent?.[platform] || generatingPlatforms[platform]) return
    contentRateLimitedRef.current.delete(`${id}/${platform}`)
    setFailedPlatforms((prev) => ({ ...prev, [platform]: undefined }))
    setGeneratingPlatforms((prev) => ({ ...prev, [platform]: true }))
    const startedAt = Date.now()
    void window.api.generateMeetingContent(id, platform).then((result) => {
      // A different session is on screen by now: its own state was reset when it
      // opened, and this late answer must not touch it.
      if (viewingPastIdRef.current !== id) return
      setGeneratingPlatforms((prev) => ({ ...prev, [platform]: false }))
      setContentWaiting((prev) => ({ ...prev, [platform]: undefined }))
      if (!result) {
        // The main process says "rate limited" before this answer arrives (see onMeetingContentStatus).
        const rateLimited = contentRateLimitedRef.current.delete(`${id}/${platform}`)
        const daily = contentDailyRef.current.get(`${id}/${platform}`)
        contentDailyRef.current.delete(`${id}/${platform}`)
        setContentDaily((prev) => ({ ...prev, [platform]: daily }))
        setFailedPlatforms((prev) => ({ ...prev, [platform]: daily ? 'daily-limit' : rateLimited ? 'rate-limit' : failureKind(startedAt) }))
        return
      }
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
  }

  // Keep the transcript scrolled to the latest paragraph as it streams in.
  useEffect(() => {
    if (viewingPastId !== null) return
    const el = transcriptRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [liveSegments, viewingPastId])

  // Scroll a chat-highlighted paragraph into view when the highlight is set (a fresh
  // answer with a range, or clicking "Show in transcript" on a past one) — see
  // resolveHighlightBlockIds and the meeting-paragraph-highlighted class below. In
  // the live view this can lose to the auto-scroll-to-latest effect above once new
  // speech arrives, which is the right tradeoff — staying caught up with a live
  // recording takes priority over a one-off lookup.
  // A mind map node's stretch (mapHighlight) can run over many paragraphs, so it is
  // scrolled to its start rather than centred on its first paragraph.
  useEffect(() => {
    if (!chatHighlightId && !mapHighlight && !actionHighlight) return
    // Right after switching sessions the paragraphs on hand are still the previous
    // session's; scrolling to a highlight among them would leave the new one scrolled.
    if (viewingPastId !== null && pastLoadedId !== viewingPastId) return
    const container = viewingPastId !== null ? pastTranscriptRef.current : transcriptRef.current
    const target = container?.querySelector<HTMLElement>('.meeting-paragraph-highlighted, .txc-text.txc-hl')
    target?.scrollIntoView({ behavior: 'smooth', block: mapHighlight || actionHighlight ? 'start' : 'center' })
  }, [chatHighlightId, mapHighlight, actionHighlight, viewingPastId, pastLoadedId, pastView])

  const isRecording = meetingState === 'recording'
  const isPaused = meetingState === 'paused'
  const showingSession = viewingPastId !== null || currentSessionId !== null
  // The viewed session's mind map — undefined while pastMindMap still belongs to the
  // session viewed before (see pastLoadedId).
  const viewedMindMap = pastLoadedId === viewingPastId ? pastMindMap : undefined
  const viewedOutline = pastLoadedId === viewingPastId ? pastOutline : undefined
  const viewedMapJob = viewingPastId !== null ? mindMapJobs[viewingPastId] : undefined
  const pastDurationMs = sessions.find((s) => s.id === viewingPastId)?.durationMs ?? 0
  const contentLanguageLabel =
    langConfig.website === 'auto'
      ? "the transcript's language"
      : (LANGUAGES.find((l) => l.code === langConfig.website)?.label ?? langConfig.website)

  const startNewSession = (): void => {
    setViewingPast(null)
    setCurrentSession(null)
    setLiveSegments([])
    setLiveChat([])
    setChatInput('')
    setChatError(null)
    setChatHighlightId(null)
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
    setSummaryStatus(null)
    setSummaryGenerating(true)
    void window.api.generateMeetingSummary(viewingPastId).then(() => {
      setSummaryGenerating(false)
    })
  }

  const copyCurrentPastView = (): void => {
    if (pastView === 'transcript') return copyTranscript(pastBlocks)
    if (pastView === 'summary') return copySummary()
    if (pastView === 'mindmap') {
      if (viewedMindMap) {
        const tree = buildMindMapTree(viewedMindMap, pastSegments, pastDurationMs)
        window.api.copyText(mindMapMarkdown(tree, formatSessionDate(pastCreatedAt)))
      }
      return
    }
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
    mindmap: 'Copy outline',
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
        : pastView === 'mindmap'
          ? !viewedMindMap
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

  // Sidebar kebab menu → "Move to space" — files (or, with spaceId null, unfiles) a
  // stopped session. Doesn't move the currently-open past view off screen — only the
  // sidebar's own filtered list (via selectedSpaceId) can do that.
  const handleMoveToSpace = (sessionId: string, spaceId: string | null): void => {
    setMenuPos(null)
    void window.api.moveMeetingSessionToSpace(sessionId, spaceId)
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, spaceId: spaceId ?? undefined } : s)))
  }

  // "+" tab → inline name input, committed on Enter/blur, cancelled on Escape/empty.
  const commitCreateSpace = (rawName: string): void => {
    setCreatingSpace(false)
    const name = rawName.trim()
    if (!name) return
    void window.api.createMeetingSpace(name).then((space) => {
      if (!space) return
      setSpaces((prev) => [...prev, space])
      setSelectedSpaceId(space.id)
    })
  }

  const startSpaceRename = (id: string): void => {
    setSpaceMenuPos(null)
    setRenamingSpaceId(id)
  }

  const commitSpaceRename = (id: string, rawName: string): void => {
    setRenamingSpaceId(null)
    const name = rawName.trim()
    const existing = spaces.find((s) => s.id === id)
    if (!name || !existing || existing.name === name) return
    void window.api.renameMeetingSpace(id, name)
    setSpaces((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)))
  }

  // Never deletes the sessions filed under the space — they fall back to "All"
  // server-side too (see meetingSessions.clearSpace, called by the IPC handler).
  const handleDeleteSpace = (id: string, name: string): void => {
    setSpaceMenuPos(null)
    if (!window.confirm(`Delete space "${name}"? Its sessions are kept and move back to "All".`)) return
    void window.api.deleteMeetingSpace(id).then(() => {
      setSpaces((prev) => prev.filter((s) => s.id !== id))
      if (selectedSpaceId === id) setSelectedSpaceId(null)
      setSessions((prev) => prev.map((s) => (s.spaceId === id ? { ...s, spaceId: undefined } : s)))
    })
  }

  // Live audio-source switcher (near the timer) — lets the user flip mic/system/both
  // mid-recording instead of only once on the idle "Start recording" screen.
  const handleSwitchAudioSource = (newSource: MeetingAudioSource): void => {
    if (newSource === audioSource || switchingAudioSource || !isRecording) return
    setSwitchingAudioSource(true)
    setAudioSourceSwitchError(null)
    captureHost
      .switchAudioSource(newSource)
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

  // --- in-session AI chat wiring (see MeetingChatMessage in shared/types.ts) ---
  // Only one of the live/past chat panels is ever visible at a time, so a single set
  // of handlers routes to whichever is active based on which view is open.
  const isPastChat = viewingPastId !== null
  const activeChatSessionId = isPastChat ? viewingPastId : currentSessionId
  const setActiveChatMessages = isPastChat ? setPastChat : setLiveChat
  const liveHighlightedBlockIds = resolveHighlightBlockIds(liveBlocks, actionHighlight ?? liveChat.find((m) => m.id === chatHighlightId))
  const pastHighlightedBlockIds = resolveHighlightBlockIds(
    pastBlocks,
    actionHighlight ?? mapHighlight ?? pastChat.find((m) => m.id === chatHighlightId)
  )

  // Sends the pending question: appends an optimistic user bubble immediately, then
  // waits for the authoritative answer. The real messages (both the question and the
  // answer) arrive moments later via the onMeetingSessionUpdated broadcast and fully
  // replace liveChat/pastChat (see that handler above) — so on success this function
  // does nothing to the message list itself, only clears input/highlights a range. On
  // failure it rolls back the optimistic bubble it added.
  const sendActiveChatMessage = (): void => {
    const sessionId = activeChatSessionId
    const question = chatInput.trim()
    if (!sessionId || !question || chatSending) return
    const optimisticId = `pending-${crypto.randomUUID()}`
    setActiveChatMessages((prev) => [
      ...prev,
      { id: optimisticId, role: 'user', text: question, createdAt: new Date().toISOString() }
    ])
    setChatInput('')
    setChatSending(true)
    setChatError(null)
    const startedAt = Date.now()
    // On the Mind map tab the chat is only its input row (see `compact`), so the
    // conversation continues on the Transcript tab where the answer can be read.
    if (isPastChat && pastView === 'mindmap') setPastView('transcript')
    void window.api.sendMeetingChatMessage(sessionId, question).then((result) => {
      setChatSending(false)
      if (!result) {
        setActiveChatMessages((prev) => prev.filter((m) => m.id !== optimisticId))
        // Nothing was saved, so the question goes back into the box to be sent again
        // later (unless the user has already started typing something else).
        setChatInput((current) => current || question)
        setChatError(
          failureKind(startedAt) === 'quota'
            ? CHAT_ERROR_QUOTA
            : 'Could not get an answer — check your connection/API key, then try again.'
        )
        return
      }
      if (result.startSegmentId && result.endSegmentId) {
        setMapHighlight(null)
        setChatHighlightId(result.id)
        if (isPastChat) setPastView('transcript')
      }
    })
  }

  // Toggles the transcript highlight for a past answer's range (clicking it again
  // clears the highlight), switching to the Transcript tab so the highlight is visible.
  const selectChatAnswer = (message: MeetingChatMessage): void => {
    if (!message.startSegmentId || !message.endSegmentId) return
    setMapHighlight(null)
    setChatHighlightId((prev) => (prev === message.id ? null : message.id))
    if (isPastChat) setPastView('transcript')
  }

  // Mind map tab → "Show in transcript": jumps to the Transcript tab with the node's
  // stretch highlighted, reusing the chat answers' highlight (see MapHighlight).
  const showMapNodeInTranscript = (node: MindMapTreeNode, color: string): void => {
    if (!node.startSegmentId || !node.endSegmentId) return
    setChatHighlightId(null)
    setMapHighlight({ startSegmentId: node.startSegmentId, endSegmentId: node.endSegmentId, label: node.label, color })
    setPastView('transcript')
  }

  // Transcript tab → click on an action item: highlights the paragraph it was said in
  // (the scroll effect above brings it into view); clicking the same one again clears it.
  const toggleActionHighlight = (action: { key: string; startSegmentId: string; endSegmentId: string }): void => {
    setChatHighlightId(null)
    setMapHighlight(null)
    setActionHighlight((prev) => (prev?.key === action.key ? null : action))
  }

  // Transcript tab → speaker label edited. Shown at once; the main process stores it on
  // the session and echoes it back through onMeetingSessionUpdated.
  const renameSpeaker = (ids: string[], name: string): void => {
    if (viewingPastId === null || ids.length === 0) return
    const patch = Object.fromEntries(ids.map((id) => [id, name]))
    setPastSpeakerNames((prev) => ({ ...prev, ...patch }))
    void window.api.setMeetingSpeakerNames(viewingPastId, patch)
  }

  // Same, in the table of the recording in progress.
  const renameLiveSpeaker = (ids: string[], name: string): void => {
    if (currentSessionId === null || ids.length === 0) return
    const patch = Object.fromEntries(ids.map((id) => [id, name]))
    setLiveSpeakerNames((prev) => ({ ...prev, ...patch }))
    void window.api.setMeetingSpeakerNames(currentSessionId, patch)
  }

  // "All" (selectedSpaceId === null) shows every session, including unfiled ones and
  // ones whose space was since deleted — filtering only ever narrows, never hides.
  const visibleSessions = selectedSpaceId === null ? sessions : sessions.filter((s) => s.spaceId === selectedSpaceId)

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
          <div className="meeting-spaces-section">
            <button
              className={selectedSpaceId === null ? 'meeting-space-row all-sessions active' : 'meeting-space-row all-sessions'}
              onClick={() => setSelectedSpaceId(null)}
            >
              All sessions
            </button>
            <div className="meeting-spaces-header">
              <span className="meeting-spaces-label">Spaces</span>
              <button className="meeting-spaces-add-btn" onClick={() => setCreatingSpace(true)} aria-label="New space" title="New space">
                +
              </button>
            </div>
            <div className="meeting-spaces-list">
              {spaces.map((sp) => {
                const isRenamingThis = renamingSpaceId === sp.id
                return (
                  <div key={sp.id} className="meeting-space-row-wrap">
                    {isRenamingThis ? (
                      <input
                        className="meeting-space-rename-input"
                        autoFocus
                        maxLength={100}
                        defaultValue={sp.name}
                        onFocus={(e) => e.currentTarget.select()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur()
                          else if (e.key === 'Escape') {
                            skipSpaceRenameBlurRef.current = true
                            setRenamingSpaceId(null)
                          }
                        }}
                        onBlur={(e) => {
                          if (skipSpaceRenameBlurRef.current) {
                            skipSpaceRenameBlurRef.current = false
                            return
                          }
                          commitSpaceRename(sp.id, e.currentTarget.value)
                        }}
                      />
                    ) : (
                      <>
                        <button
                          className={selectedSpaceId === sp.id ? 'meeting-space-row active' : 'meeting-space-row'}
                          onClick={() => setSelectedSpaceId(sp.id)}
                        >
                          <FolderIcon />
                          <span className="meeting-space-row-name">{sp.name}</span>
                        </button>
                        <button
                          className={spaceMenuPos?.id === sp.id ? 'meeting-space-row-kebab open' : 'meeting-space-row-kebab'}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (spaceMenuPos?.id === sp.id) {
                              setSpaceMenuPos(null)
                              return
                            }
                            const rect = e.currentTarget.getBoundingClientRect()
                            setSpaceMenuPos({ id: sp.id, top: rect.bottom + 4, right: window.innerWidth - rect.right })
                          }}
                          aria-label={`"${sp.name}" space options`}
                        >
                          ⋯
                        </button>
                        {spaceMenuPos?.id === sp.id && (
                          <>
                            <div className="meeting-session-menu-backdrop" onClick={() => setSpaceMenuPos(null)} />
                            <div className="meeting-session-menu" style={{ top: spaceMenuPos.top, right: spaceMenuPos.right }}>
                              <button onClick={() => startSpaceRename(sp.id)}>Rename</button>
                              <button className="danger" onClick={() => handleDeleteSpace(sp.id, sp.name)}>
                                Delete
                              </button>
                            </div>
                          </>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
              {creatingSpace && (
                <input
                  className="meeting-space-rename-input"
                  autoFocus
                  maxLength={100}
                  placeholder="Space name"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    else if (e.key === 'Escape') {
                      skipSpaceRenameBlurRef.current = true
                      setCreatingSpace(false)
                    }
                  }}
                  onBlur={(e) => {
                    if (skipSpaceRenameBlurRef.current) {
                      skipSpaceRenameBlurRef.current = false
                      return
                    }
                    commitCreateSpace(e.currentTarget.value)
                  }}
                />
              )}
            </div>
          </div>
          {visibleSessions.length === 0 ? (
            <div className="meeting-sidebar-empty">
              {sessions.length === 0 ? 'No sessions yet' : 'No sessions in this space yet'}
            </div>
          ) : (
            <div className="meeting-session-list" onScroll={() => setMenuPos(null)}>
              {visibleSessions.map((s) => {
                const isActiveRow = s.status === 'recording' ? viewingPastId === null : viewingPastId === s.id
                const isRenamingThis = renamingId === s.id
                // Resolves to undefined both when unfiled and when the space was deleted
                // (deleting a space only clears spaceId elsewhere, but guard anyway).
                const sessionSpace = s.spaceId ? spaces.find((sp) => sp.id === s.spaceId) : undefined
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
                      {mindMapJobs[s.id] && (
                        <span className={`meeting-session-map-tag ${mindMapJobs[s.id].state}`} title={mindMapJobLabel(mindMapJobs[s.id])}>
                          <span className={`meeting-map-dot ${mindMapJobs[s.id].state}`} />
                          {mindMapJobs[s.id].state === 'running'
                            ? mindMapJobs[s.id].total > 1
                              ? `Mind map ${mindMapJobs[s.id].done}/${mindMapJobs[s.id].total}`
                              : 'Mind map…'
                            : mindMapJobs[s.id].state === 'done'
                              ? 'Mind map ready'
                              : 'Mind map not finished'}
                        </span>
                      )}
                      {sessionSpace && (
                        <span className="meeting-session-space-tag" title={`In space: ${sessionSpace.name}`}>
                          <FolderIcon size={10} />
                          <span className="meeting-session-space-tag-name">{sessionSpace.name}</span>
                        </span>
                      )}
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
                              {spaces.length > 0 && (
                                <>
                                  <div className="meeting-session-menu-label">Move to space</div>
                                  {spaces.map((sp) => (
                                    <button key={sp.id} onClick={() => handleMoveToSpace(s.id, sp.id)}>
                                      {s.spaceId === sp.id ? '✓ ' : ''}
                                      {sp.name}
                                    </button>
                                  ))}
                                  {s.spaceId && (
                                    <button onClick={() => handleMoveToSpace(s.id, null)}>Remove from space</button>
                                  )}
                                </>
                              )}
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
            <div
              className={
                pastView === 'mindmap'
                  ? 'meeting-session-view meeting-session-view--map'
                  : pastView === 'transcript'
                    ? 'meeting-session-view meeting-session-view--wide'
                    : 'meeting-session-view'
              }
            >
              <div className="meeting-session-header">
                <div className="meeting-session-heading">
                  <h2>{pastTitle}</h2>
                  <div className="meeting-session-date">{formatSessionDate(pastCreatedAt)}</div>
                </div>
                {/* Sits beside the title rather than in the tab row below: with eight view
                    tabs the row has no room for it at the default window width. */}
                <button className="meeting-copy-btn" onClick={copyCurrentPastView} disabled={copyDisabled}>
                  {copyLabel[pastView]}
                </button>
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
                      {tab.id === 'mindmap' && viewedMapJob && (
                        <span className={`meeting-map-dot ${viewedMapJob.state}`} title={mindMapJobLabel(viewedMapJob)} />
                      )}
                    </button>
                  ))}
                </div>
              </div>
              {pastView !== 'mindmap' && (
                <div className="meeting-ended-note">
                  {pastStatus === 'summarizing' ? 'Recording ended — writing a title…' : 'Recording ended'}
                </div>
              )}
              {autoStopNotice && <div className="meeting-resume-error">{autoStopNotice}</div>}
              {pastView === 'transcript' && mapHighlight && (
                <div className="meeting-from-map">
                  <span className="meeting-from-map-dot" style={{ background: mapHighlight.color }} />
                  <span className="meeting-from-map-label">
                    From mind map: <b>{mapHighlight.label}</b>
                  </span>
                  <button type="button" className="meeting-from-map-back" onClick={() => setPastView('mindmap')}>
                    ← Back to mind map
                  </button>
                  <button
                    type="button"
                    className="meeting-from-map-clear"
                    aria-label="Clear highlight"
                    onClick={() => setMapHighlight(null)}
                  >
                    ✕
                  </button>
                </div>
              )}
              {/* Mounted on first open and then kept (hidden) behind the other tabs, so the
                  map keeps its open branches and zoom across a "Show in transcript" round trip. */}
              {mindMapOpened && (
                <div className="meeting-mindmap-view" style={pastView === 'mindmap' ? undefined : { display: 'none' }}>
                  <MindMapView
                    key={viewingPastId}
                    map={viewedMindMap}
                    segments={pastSegments}
                    durationMs={pastDurationMs}
                    dateLabel={formatSessionDate(pastCreatedAt)}
                    active={pastView === 'mindmap'}
                    generating={viewedMapJob?.state === 'running'}
                    progress={viewedMapJob ?? null}
                    stopped={viewedMapJob?.state === 'stopped' ? viewedMapJob : null}
                    quotaMessage={quotaMessage}
                    regenerateTitle={`Build the map again, written in ${contentLanguageLabel} — the "Website & social posts" language on the New session screen`}
                    canCreate={mindMapJobsLoaded}
                    onCreate={() => requestMindMap(false)}
                    onRetry={() => requestMindMap(false)}
                    onRegenerate={() => requestMindMap(true)}
                    onShowInTranscript={showMapNodeInTranscript}
                  />
                </div>
              )}
              {pastView === 'mindmap' ? null : pastView === 'transcript' ? (
                <TranscriptColumns
                  // A fresh view per session, so one session's scroll position, open name editor or open
                  // action panel never carries over to the next.
                  key={viewingPastId}
                  loading={pastLoadedId !== viewingPastId}
                  blocks={pastLoadedId === viewingPastId ? pastBlocks : NO_BLOCKS}
                  outline={viewedOutline}
                  speakerNames={pastSpeakerNames}
                  durationMs={pastDurationMs}
                  highlighted={pastHighlightedBlockIds}
                  activeActionKey={actionHighlight?.key ?? null}
                  actionsView={actionsView}
                  generating={outlineGenerating}
                  progress={outlineProgress}
                  failed={outlineFailed}
                  canCreate={autoAiSince !== null && !autoAiFor(pastCreatedAt)}
                  onCreate={() => requestOutline(false)}
                  scrollRef={pastTranscriptRef}
                  onActionsViewChange={setActionsView}
                  onAction={toggleActionHighlight}
                  onRetry={() => requestOutline(false)}
                  onRegenerate={() => requestOutline(true)}
                  onRenameSpeaker={renameSpeaker}
                />
              ) : pastView === 'summary' ? (
                <div className="meeting-summary-view">
                  {pastSummary ? (
                    <>
                      <BackupModelNote model={pastBackupModels?.summary} />
                      {renderSummaryBlocks(pastSummary)}
                    </>
                  ) : (
                    <div className="meeting-transcript-empty">
                      <div>
                        {pastStatus === 'summarizing' || summaryGenerating
                          ? summaryStatus?.waitingUntil && summaryStatus.waitingUntil > Date.now()
                            ? WAITING_TEXT
                            : 'Summarizing…'
                          : summaryStatus?.dailyLimit
                            ? `${dailyLimitText(summaryStatus.dailyLimit)} ${dailyLimitAdvice(summaryStatus.dailyLimit, 'Try again')}`
                            : summaryStatus?.rateLimited
                              ? RATE_LIMITED_TEXT
                              : 'No summary available for this session.'}
                      </div>
                      {/* The allowance ran out (now, or when the recording ended): say why there is no summary. */}
                      {pastStatus !== 'summarizing' && !summaryGenerating && quotaMessage}
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
                      <BackupModelNote model={pastBackupModels?.website} />
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
                      {failedPlatforms.website ? (
                        <>
                          {failedPlatforms.website === 'quota' && quotaMessage ? (
                            quotaMessage
                          ) : failedPlatforms.website === 'daily-limit' && contentDaily.website ? (
                            <div>{`${dailyLimitText(contentDaily.website)} ${dailyLimitAdvice(contentDaily.website, 'Try again')}`}</div>
                          ) : failedPlatforms.website === 'rate-limit' ? (
                            <div>{RATE_LIMITED_TEXT}</div>
                          ) : (
                            <div>Could not generate a blog post — check your connection/API key, then try again.</div>
                          )}
                          <button className="meeting-retry-btn" onClick={() => createContent('website')}>
                            Try again
                          </button>
                        </>
                      ) : generatingPlatforms.website ? (
                        contentWaiting.website ? WAITING_TEXT : 'Writing a blog post…'
                      ) : (
                        <CreateContentPrompt
                          label="Create website content"
                          text="A blog post written from this recording: SEO title, meta description and article."
                          onCreate={() => createContent('website')}
                        />
                      )}
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
                      <>
                        <BackupModelNote model={pastBackupModels?.[pastView]} />
                        <p className="meeting-post-text">
                          {renderInlineBold(pastContent[pastView]![variantIndex[pastView]], 'post')}
                        </p>
                      </>
                    ) : (
                      <div className="meeting-transcript-empty">
                        {failedPlatforms[pastView] ? (
                          <>
                            {failedPlatforms[pastView] === 'quota' && quotaMessage ? (
                              quotaMessage
                            ) : failedPlatforms[pastView] === 'daily-limit' && contentDaily[pastView] ? (
                              <div>{`${dailyLimitText(contentDaily[pastView]!)} ${dailyLimitAdvice(contentDaily[pastView]!, 'Try again')}`}</div>
                            ) : failedPlatforms[pastView] === 'rate-limit' ? (
                              <div>{RATE_LIMITED_TEXT}</div>
                            ) : (
                              <div>Could not generate posts — check your connection/API key, then try again.</div>
                            )}
                            <button className="meeting-retry-btn" onClick={() => createContent(pastView)}>
                              Try again
                            </button>
                          </>
                        ) : generatingPlatforms[pastView] ? (
                          contentWaiting[pastView] ? WAITING_TEXT : `Writing ${PLATFORM_NAMES[pastView]} posts…`
                        ) : (
                          <CreateContentPrompt
                            label={`Create ${PLATFORM_NAMES[pastView]} post`}
                            text={`Three versions of a ${PLATFORM_NAMES[pastView]} post written from this recording.`}
                            onCreate={() => createContent(pastView)}
                          />
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
              <MeetingChatPanel
                compact={pastView === 'mindmap'}
                messages={pastChat}
                input={chatInput}
                onInputChange={setChatInput}
                onSend={sendActiveChatMessage}
                sending={chatSending && isPastChat}
                error={isPastChat ? chatErrorView : null}
                highlightId={chatHighlightId}
                onSelectAnswer={selectChatAnswer}
              />
            </div>
          ) : currentSessionId !== null ? (
            <div className="meeting-session-view meeting-session-view--wide">
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
              {/* The four columns from the first second: the transcript runs into the middle
                  column, and each part gets its topic and action items once it is finished. */}
              <TranscriptColumns
                key={currentSessionId}
                live
                liveStatus={liveOutlineStatus}
                loading={false}
                blocks={liveBlocks}
                outline={liveOutline}
                speakerNames={liveSpeakerNames}
                durationMs={elapsedMs}
                highlighted={liveHighlightedBlockIds}
                activeActionKey={actionHighlight?.key ?? null}
                actionsView={actionsView}
                generating={false}
                progress={null}
                failed={false}
                canCreate={false}
                onCreate={() => undefined}
                scrollRef={transcriptRef}
                onActionsViewChange={setActionsView}
                onAction={toggleActionHighlight}
                onRetry={() => undefined}
                onRegenerate={() => undefined}
                onRenameSpeaker={renameLiveSpeaker}
                emptyText={isPaused ? 'Paused — press Resume to keep going.' : 'Listening… transcribed text will appear here as you speak.'}
              />
              <MeetingChatPanel
                messages={liveChat}
                input={chatInput}
                onInputChange={setChatInput}
                onSend={sendActiveChatMessage}
                sending={chatSending && !isPastChat}
                error={!isPastChat ? chatErrorView : null}
                highlightId={chatHighlightId}
                onSelectAnswer={selectChatAnswer}
              />
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
              {selectedSpaceId !== null && (
                <div className="meeting-space-hint">
                  Will be saved to <strong>{spaces.find((sp) => sp.id === selectedSpaceId)?.name}</strong>
                </div>
              )}
              <button
                className="meeting-btn meeting-btn-start"
                onClick={() => window.api.meetingStart(langConfig, audioSource, selectedSpaceId ?? undefined)}
              >
                Start recording
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
