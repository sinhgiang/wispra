import { useMemo, useRef, useState, type ReactElement, type RefObject } from 'react'
import type { MeetingOutline, OutlineProgress } from '@shared/types'
import { formatElapsed } from './mindMapData'
import { dailyLimitAdvice, dailyLimitText } from './dailyLimit'

/** One paragraph of the transcript, as the Meeting tab groups segments (see groupIntoParagraphs in App.tsx). */
export interface TranscriptBlock {
  id: string
  startedAt: string
  startMs: number
  text: string
  segmentIds: string[]
  /** "Both"-mode recordings: who the audio levels say was talking (see MeetingSegment.voice). */
  voice?: 'me' | 'others'
}

/** How the action items column is arranged: next to the topic each belongs to, or as one list. */
export type ActionsView = 'topic' | 'list'

interface ActionItem {
  key: string
  text: string
  meta: string
  startMs: number
  startSegmentId: string
  endSegmentId: string
}

interface Section {
  key: string
  /** Undefined while there is no outline: the transcript is then one untitled section. */
  title?: string
  hue: number
  blocks: TranscriptBlock[]
  endMs: number
  actions: ActionItem[]
}

const TOPIC_HUES = [262, 205, 172, 300, 28, 232, 150, 335, 65]
const VOICE_LABEL: Record<'me' | 'others', string> = { me: 'You', others: 'Others' }

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** A stable colour per speaker name. */
function hueOf(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360
  return hash
}

/**
 * Lays the outline over the paragraphs: which paragraphs each topic covers, which
 * action items were said inside it, and what speaker label each paragraph shows.
 * Anything the outline points at that is not in the transcript (a stale id) is skipped.
 */
function buildSections(
  blocks: TranscriptBlock[],
  outline: MeetingOutline | undefined,
  speakerNames: Record<string, string>,
  durationMs: number
): { sections: Section[]; actions: ActionItem[]; speakerOf: Map<string, { label: string; named: boolean }> } {
  const blockIndexOf = new Map<string, number>()
  blocks.forEach((b, i) => b.segmentIds.forEach((id) => blockIndexOf.set(id, i)))
  const endOf = (index: number): number => (index + 1 < blocks.length ? blocks[index + 1].startMs : Math.max(durationMs, blocks[index]?.startMs ?? 0))

  // Topics → the paragraph each one starts at. Every paragraph belongs to the last topic that starts at or before it.
  const starts: Array<{ title: string; index: number }> = []
  for (const topic of outline?.topics ?? []) {
    const index = blockIndexOf.get(topic.startSegmentId)
    if (index !== undefined && !starts.some((s) => s.index === index)) starts.push({ title: topic.title, index })
  }
  starts.sort((a, b) => a.index - b.index)
  if (starts.length > 0) starts[0].index = 0

  const sections: Section[] =
    starts.length === 0
      ? [{ key: 'all', hue: TOPIC_HUES[0], blocks, endMs: durationMs, actions: [] }]
      : starts.map((start, i) => {
          const end = i + 1 < starts.length ? starts[i + 1].index : blocks.length
          return {
            key: `${i}-${blocks[start.index].id}`,
            title: start.title,
            hue: TOPIC_HUES[i % TOPIC_HUES.length],
            blocks: blocks.slice(start.index, end),
            endMs: endOf(end - 1),
            actions: []
          }
        })

  const actions: ActionItem[] = []
  ;(outline?.actions ?? []).forEach((action, i) => {
    const index = blockIndexOf.get(action.startSegmentId)
    if (index === undefined || starts.length === 0) return
    const item: ActionItem = {
      key: `a${i}`,
      text: action.text,
      meta: [action.owner, action.due].filter(Boolean).join(' · '),
      startMs: blocks[index].startMs,
      startSegmentId: action.startSegmentId,
      endSegmentId: action.endSegmentId
    }
    actions.push(item)
    let owner = 0
    for (let s = 0; s < starts.length; s++) if (starts[s].index <= index) owner = s
    sections[owner].actions.push(item)
  })
  actions.sort((a, b) => a.startMs - b.startMs)

  // Speaker label per paragraph: what the user typed, else the outline's name, else "You"/"Others".
  const speakerOf = new Map<string, { label: string; named: boolean }>()
  const aiName = new Map<number, string>()
  for (const speaker of outline?.speakers ?? []) {
    const from = blockIndexOf.get(speaker.startSegmentId)
    const to = blockIndexOf.get(speaker.endSegmentId)
    if (from === undefined || to === undefined) continue
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) aiName.set(i, speaker.name)
  }
  blocks.forEach((block, i) => {
    const typed = speakerNames[block.id]
    if (typed !== undefined) {
      if (typed) speakerOf.set(block.id, { label: typed, named: true })
      return
    }
    const name = aiName.get(i)
    if (name) speakerOf.set(block.id, { label: name, named: true })
    else if (block.voice) speakerOf.set(block.id, { label: VOICE_LABEL[block.voice], named: false })
  })
  return { sections, actions, speakerOf }
}

function progressText(progress: OutlineProgress | null): string {
  if (!progress || progress.total <= 1) return 'Finding topics and action items…'
  if (progress.phase === 'merge') return 'Finding topics and action items… joining the parts'
  return `Finding topics and action items… part ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`
}

/**
 * The Transcript tab of a finished session as four columns: time and speaker, topic,
 * transcript, action items. Topics, action items and speaker names come from the
 * session's outline (AI-made once, see outline.ts); without one the transcript shows
 * as before, in two columns. Narrower windows fold: first the topic becomes a heading
 * row (and by-topic action items sit under it), then the one-list action panel slides
 * over instead of taking a column. Clicking an action item asks the parent to highlight
 * its paragraph; the parent's highlight (also used by chat and the mind map) comes back
 * through `highlighted`.
 */
export function TranscriptColumns({
  blocks,
  loading,
  outline,
  speakerNames,
  durationMs,
  highlighted,
  activeActionKey,
  actionsView,
  generating,
  progress,
  failed,
  canCreate,
  onCreate,
  scrollRef,
  onActionsViewChange,
  onAction,
  onRetry,
  onRegenerate,
  onRenameSpeaker
}: {
  blocks: TranscriptBlock[]
  /** The session's paragraphs are not here yet (just opened) — show nothing rather than "no speech". */
  loading: boolean
  outline: MeetingOutline | undefined
  speakerNames: Record<string, string>
  durationMs: number
  /** Ids of the paragraphs to highlight. */
  highlighted: Set<string>
  activeActionKey: string | null
  actionsView: ActionsView
  generating: boolean
  progress: OutlineProgress | null
  /** The last attempt to build the outline failed (there may still be an earlier outline to show). */
  failed: boolean
  /** An older recording without topics yet: nothing is made by itself, a "Create" button is offered instead. */
  canCreate: boolean
  onCreate: () => void
  scrollRef: RefObject<HTMLDivElement | null>
  onActionsViewChange: (view: ActionsView) => void
  onAction: (action: { key: string; startSegmentId: string; endSegmentId: string }) => void
  onRetry: () => void
  onRegenerate: () => void
  /** `ids` are the paragraphs to (re)name; an empty name removes the label. */
  onRenameSpeaker: (ids: string[], name: string) => void
}): ReactElement {
  const { sections, actions, speakerOf } = useMemo(
    () => buildSections(blocks, outline, speakerNames, durationMs),
    [blocks, outline, speakerNames, durationMs]
  )
  /** Paragraph whose speaker label is being edited. */
  const [editingId, setEditingId] = useState<string | null>(null)
  /** Narrow windows, one-list view: whether the slide-over action panel is open. */
  const [panelOpen, setPanelOpen] = useState(false)
  // Set right before the name input is dismissed with Escape, so the blur that follows is a cancel, not a commit.
  const skipBlurRef = useRef(false)
  const hasOutline = !!outline
  const byTopic = actionsView === 'topic'

  // Renaming a label renames that speaker everywhere it shows; a paragraph without one is named on its own.
  const commitSpeaker = (blockId: string, raw: string): void => {
    setEditingId(null)
    const name = raw.trim()
    const current = speakerOf.get(blockId)?.label ?? ''
    if (name === current) return
    const ids = current ? blocks.filter((b) => speakerOf.get(b.id)?.label === current).map((b) => b.id) : [blockId]
    onRenameSpeaker(ids, name)
  }

  const startEditing = (blockId: string): void => {
    skipBlurRef.current = false
    setEditingId(blockId)
  }

  const speakerCell = (block: TranscriptBlock): ReactElement => {
    if (editingId === block.id) {
      return (
        <input
          className="txc-speaker-input"
          autoFocus
          maxLength={60}
          defaultValue={speakerOf.get(block.id)?.label ?? ''}
          placeholder="Speaker name"
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              // Commit here rather than through blur(): the blur that follows the input's removal must not commit twice.
              skipBlurRef.current = true
              commitSpeaker(block.id, e.currentTarget.value)
            }
            else if (e.key === 'Escape') {
              skipBlurRef.current = true
              setEditingId(null)
            }
          }}
          onBlur={(e) => {
            if (skipBlurRef.current) {
              skipBlurRef.current = false
              return
            }
            commitSpeaker(block.id, e.currentTarget.value)
          }}
        />
      )
    }
    const speaker = speakerOf.get(block.id)
    if (!speaker) {
      return (
        <button type="button" className="txc-speaker txc-speaker-add" title="Name the speaker of this paragraph" onClick={() => startEditing(block.id)}>
          + name
        </button>
      )
    }
    return (
      <button
        type="button"
        className={speaker.named ? 'txc-speaker' : 'txc-speaker txc-speaker-voice'}
        style={speaker.named ? ({ '--hue': hueOf(speaker.label) } as React.CSSProperties) : undefined}
        title="Click to rename this speaker"
        onClick={() => startEditing(block.id)}
      >
        <i />
        <span>{speaker.label}</span>
      </button>
    )
  }

  const actionButton = (action: ActionItem): ReactElement => (
    <button
      key={action.key}
      type="button"
      className={action.key === activeActionKey ? 'txc-act active' : 'txc-act'}
      title={`Jump to ${formatElapsed(action.startMs)} in the transcript`}
      onClick={() => {
        setPanelOpen(false)
        onAction(action)
      }}
    >
      <span className="txc-act-time">{formatElapsed(action.startMs)}</span>
      <span className="txc-act-body">
        <span className="txc-act-text">{action.text}</span>
        {action.meta && <span className="txc-act-meta">{action.meta}</span>}
      </span>
    </button>
  )

  // "Action items 8 · [By topic | List] · rebuild" — shown in the column header (by topic) or the panel header (list).
  const actionsHeader = (
    <span className="txc-actions-head">
      <span className="txc-actions-label">
        Action items <span className="txc-count">{actions.length}</span>
      </span>
      <span className="txc-view-switch" role="group" aria-label="Action items layout">
        <button
          type="button"
          className={byTopic ? 'active' : ''}
          title="Show each action item next to its topic"
          onClick={() => onActionsViewChange('topic')}
        >
          By topic
        </button>
        <button
          type="button"
          className={byTopic ? '' : 'active'}
          title="Show all action items as one list"
          onClick={() => onActionsViewChange('list')}
        >
          List
        </button>
      </span>
      <button type="button" className="txc-icon-btn" title="Build the topics and action items again" aria-label="Rebuild topics and action items" onClick={onRegenerate} disabled={generating}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" />
        </svg>
      </button>
    </span>
  )

  const className = [
    'txc',
    hasOutline ? (byTopic ? 'txc--by-topic' : 'txc--list') : 'txc--plain',
    panelOpen ? 'txc--panel-open' : ''
  ].join(' ')

  return (
    <div className={className}>
      <div className="txc-scroll" ref={scrollRef}>
        <div className="txc-cols txc-head">
          <span className="txc-col-time">Time · speaker</span>
          <span className="txc-col-topic">Topic</span>
          <span className="txc-col-text">
            <span>Transcript</span>
            {/* Folded layouts have no action column to carry these controls. */}
            {hasOutline && byTopic && <span className="txc-head-folded">{actionsHeader}</span>}
            {hasOutline && !byTopic && (
              <button type="button" className="txc-panel-toggle" onClick={() => setPanelOpen((open) => !open)}>
                Action items <span className="txc-count">{actions.length}</span>
              </button>
            )}
          </span>
          {hasOutline && byTopic && <span className="txc-col-actions">{actionsHeader}</span>}
        </div>

        {(generating || (failed && !generating)) && (
          <div className={generating ? 'txc-status' : 'txc-status txc-status-failed'} role="status">
            {generating ? (
              <>
                <span className="txc-spinner" aria-hidden="true" />
                {progressText(progress)}
              </>
            ) : (
              <>
                <span>
                  {progress?.dailyLimit
                    ? `${dailyLimitText(progress.dailyLimit)} ${dailyLimitAdvice(progress.dailyLimit, 'Try again')}`
                    : hasOutline
                      ? 'Could not rebuild the topics and action items — the previous ones are kept.'
                      : 'Could not find topics and action items — check your connection/API key, then try again.'}
                </span>
                <button type="button" className="meeting-retry-btn" onClick={onRetry}>
                  Try again
                </button>
              </>
            )}
          </div>
        )}

        {canCreate && !hasOutline && !generating && !failed && blocks.length > 0 && (
          <div className="txc-status txc-create" role="status">
            <span>Topics and action items have not been made for this recording yet.</span>
            <button type="button" className="meeting-create-btn" onClick={onCreate}>
              Create topics and action items
            </button>
          </div>
        )}
        {loading ? null : blocks.length === 0 ? (
          <div className="meeting-transcript-empty">No speech was transcribed in this session.</div>
        ) : (
          sections.map((section) => (
            <div key={section.key} className="txc-cols txc-sec" style={{ '--hue': section.hue } as React.CSSProperties}>
              {section.title !== undefined && (
                <div className="txc-topic" style={{ gridRow: `1 / span ${section.blocks.length}` }}>
                  <div className="txc-topic-inner">
                    <h3>{section.title}</h3>
                    <span className="txc-range">
                      {formatElapsed(section.blocks[0].startMs)} – {formatElapsed(section.endMs)}
                    </span>
                  </div>
                </div>
              )}
              {hasOutline && byTopic && (
                // Empty on purpose when the topic has no action item: nothing is made up to fill it.
                <div className={section.actions.length ? 'txc-sec-actions' : 'txc-sec-actions empty'} style={{ gridRow: `1 / span ${section.blocks.length}` }}>
                  <div className="txc-sec-actions-inner">{section.actions.map(actionButton)}</div>
                </div>
              )}
              {section.blocks.map((block, i) => {
                const hl = highlighted.has(block.id)
                return [
                  <div key={`${block.id}-time`} className={hl ? 'txc-time txc-hl' : 'txc-time'} style={{ gridRow: i + 1 }}>
                    <span className="txc-elapsed">{formatElapsed(block.startMs)}</span>
                    <span className="txc-clock">{formatClock(block.startedAt)}</span>
                    {speakerCell(block)}
                  </div>,
                  <p key={`${block.id}-text`} data-block-id={block.id} className={hl ? 'txc-text txc-hl' : 'txc-text'} style={{ gridRow: i + 1 }}>
                    {block.text}
                  </p>
                ]
              })}
            </div>
          ))
        )}
      </div>

      {hasOutline && !byTopic && (
        <aside className="txc-panel" aria-label="Action items">
          <div className="txc-head txc-panel-head">
            {actionsHeader}
            <button type="button" className="txc-icon-btn txc-panel-close" aria-label="Close action items" onClick={() => setPanelOpen(false)}>
              ✕
            </button>
          </div>
          <div className="txc-panel-list">
            {actions.length === 0 ? <div className="txc-panel-empty">No action items were found in this recording.</div> : actions.map(actionButton)}
          </div>
        </aside>
      )}
    </div>
  )
}
