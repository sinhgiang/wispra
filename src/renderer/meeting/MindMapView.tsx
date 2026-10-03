import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import type { MeetingMindMap, MeetingSegment, MindMapJobStatus } from '@shared/types'
import { buildMindMapTree, formatElapsed, mindMapMarkdown, type MindMapTreeNode } from './mindMapData'
import { dailyLimitAdvice, dailyLimitText } from './dailyLimit'
import { createMindMap, mindMapNodeColor, type MindMapController, type MindMapLayoutNode } from './mindMapRenderer'

/** Levels shown when the map opens: the centre and the main branches only — the user opens the rest. */
const DEFAULT_LEVEL = 2
const LEVELS: Array<{ level: number; label: string; title: string }> = [
  { level: 2, label: '2', title: 'Centre and main branches' },
  { level: 3, label: '3', title: 'Main branches and their points' },
  { level: 9, label: 'All', title: 'Expand everything' }
]
/** Longest side of the exported PNG, in pixels. */
const PNG_MAX_SIDE = 8000

const DARK_QUERY = '(prefers-color-scheme: dark)'

function Icon({ d }: { d: string }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

function minutesLabel(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60000))
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`
}

function progressText(progress: MindMapJobStatus | null): string {
  const text = progressSentence(progress)
  return progress?.backupModel ? `${text} Using the backup model ${progress.backupModel} — the main model reached its daily limit.` : text
}

function progressSentence(progress: MindMapJobStatus | null): string {
  if (!progress || progress.total === 0) return 'Reading the transcript…'
  const waiting = progress.waitingUntil !== undefined && progress.waitingUntil > Date.now()
  if (progress.total === 1) return waiting ? "Waiting for the AI provider's per-minute limit…" : 'Building the map from the transcript…'
  if (progress.phase === 'merge') return waiting ? "All parts done — waiting for the AI provider's per-minute limit…" : 'All parts done — putting them together into one map…'
  const parts = `${progress.done} of ${progress.total} parts done`
  return waiting ? `${parts} — waiting for the AI provider's per-minute limit…` : `${parts} — outlining the next…`
}

function progressPercent(progress: MindMapJobStatus | null): number {
  if (!progress || progress.total <= 1) return 12
  // One extra step for the merge call that follows the parts.
  return Math.max(6, Math.round((progress.done / (progress.total + 1)) * 100))
}

/** What to tell the user about a job that stopped without a map, and what its button does. */
function stoppedText(job: MindMapJobStatus): { title: string; text: string; action: string } {
  const kept = job.total > 1 && job.done > 0
  const keptText = kept ? ` ${job.done} of ${job.total} parts are done and kept — it goes on from there.` : ''
  const action = kept ? 'Continue' : 'Try again'
  // A job stopped by 0.6.1 recorded the provider's "Failed to generate JSON" as a refusal.
  const reason = job.reason === 'refused' && /failed to generate json/i.test(job.detail ?? '') ? 'bad-answer' : job.reason
  switch (reason) {
    case 'daily-limit':
      return {
        title: "Stopped by the AI provider's daily limit",
        text: job.dailyLimit
          ? `${dailyLimitText(job.dailyLimit)}${keptText} ${dailyLimitAdvice(job.dailyLimit, action)}`
          : `The AI provider's daily limit is reached.${keptText} Wait until it resets, then press ${action}.`,
        action
      }
    case 'interrupted':
      return { title: 'The mind map was not finished', text: `Wispra was closed while it was being built.${keptText}`, action }
    case 'time-limit':
      return { title: 'Stopped — this was taking too long', text: `Building the map went past its time limit.${keptText}`, action }
    case 'rate-limit':
      return {
        title: "Stopped by the AI provider's per-minute limit",
        text: `Your AI key only allows a small amount per minute, and the provider kept asking to wait.${keptText} Give it a minute first.`,
        action
      }
    case 'timeout':
      return { title: 'The AI did not answer in time', text: `The AI provider took too long to answer.${keptText}`, action }
    case 'offline':
      return { title: 'Could not reach the AI', text: `Check your internet connection.${keptText}`, action }
    case 'no-key':
      return { title: 'No AI access', text: 'Add your API key, or sign in on the Account tab, then try again.', action }
    case 'quota':
      return { title: 'The mind map was not built', text: `This month's AI allowance is used up.${keptText}`, action }
    case 'bad-answer':
      return {
        title: 'The AI returned a result that could not be used',
        text: `Its answer for one part of the recording came back broken, several times in a row — this is not a problem with your API key or plan.${keptText}`,
        action
      }
    case 'refused': {
      // Only "not authorised" answers point at the key; anything else is shown as the provider put it.
      const keyProblem = /^HTTP 40[13]\b/.test(job.detail ?? '')
      return {
        title: 'The AI provider refused the request',
        text: `${keyProblem ? 'Check your API key or plan.' : 'It did not accept the request — see its message below.'}${keptText}`,
        action
      }
    }
    default:
      return { title: 'Could not build the mind map', text: `Check your connection/API key, then try again.${keptText}`, action }
  }
}

/**
 * The Mind map tab of a finished session: the map itself (drawn by mindMapRenderer.ts),
 * its toolbar, the node detail card and the generating/failed states. View-only —
 * nodes cannot be edited. Stays mounted while another tab is shown (`active` false) so
 * coming back from "Show in transcript" finds the map as it was left.
 */
export function MindMapView({
  map,
  segments,
  durationMs,
  dateLabel,
  active,
  generating,
  progress,
  stopped,
  quotaMessage,
  regenerateTitle,
  canCreate,
  onCreate,
  onRetry,
  onRegenerate,
  onShowInTranscript
}: {
  map: MeetingMindMap | undefined
  segments: MeetingSegment[]
  durationMs: number
  /** The session's date, for the Markdown outline's header line. */
  dateLabel: string
  active: boolean
  generating: boolean
  /** The session's job while it runs — it runs in the main process, so this can be a job started before this view existed. */
  progress: MindMapJobStatus | null
  /** The job stopped without a map (there may still be an earlier map to show). */
  stopped: MindMapJobStatus | null
  /** What to show when it stopped because Wispra Cloud's monthly AI allowance is used up. */
  quotaMessage: ReactNode
  regenerateTitle: string
  /** False until it is known whether this session already has a job — until then no "Create" button is offered. */
  canCreate: boolean
  /** Starts building the map: opening the tab never does. */
  onCreate: () => void
  onRetry: () => void
  onRegenerate: () => void
  onShowInTranscript: (node: MindMapTreeNode, color: string) => void
}): ReactElement {
  const canvasRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLElement>(null)
  const zoomLabelRef = useRef<HTMLButtonElement>(null)
  const controllerRef = useRef<MindMapController | null>(null)
  const introducedRef = useRef(false)
  const activeRef = useRef(active)
  activeRef.current = active

  const [dark, setDark] = useState(() => window.matchMedia(DARK_QUERY).matches)
  const [selected, setSelected] = useState<MindMapLayoutNode | null>(null)
  /** Which "Levels" preset the map currently matches; null once a branch was opened or closed by hand. */
  const [level, setLevel] = useState<number | null>(DEFAULT_LEVEL)
  /** Bumped when a branch is toggled, so the card's Expand/Collapse label re-reads the controller. */
  const [, setToggleCount] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [hintHidden, setHintHidden] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const tree = useMemo(() => (map ? buildMindMapTree(map, segments, durationMs) : null), [map, segments, durationMs])

  const showToast = useCallback((text: string) => setToast(text), [])
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 2400)
    return () => clearTimeout(id)
  }, [toast])

  // A failed Regenerate leaves the earlier map on screen, so it has to say so.
  useEffect(() => {
    if (!stopped || !map) return
    setToast(
      stopped.reason === 'quota'
        ? "This month's AI allowance is used up — the previous mind map is kept"
        : 'Could not rebuild the mind map — the previous one is kept'
    )
  }, [stopped, map])

  // While the run waits for the provider's limit, redraw when the wait is over.
  const [, setWaitTick] = useState(0)
  useEffect(() => {
    const until = generating ? progress?.waitingUntil : undefined
    if (until === undefined || until <= Date.now()) return
    const id = setTimeout(() => setWaitTick((n) => n + 1), until - Date.now() + 50)
    return () => clearTimeout(id)
  }, [generating, progress?.waitingUntil])

  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY)
    const onChange = (): void => {
      setDark(query.matches)
      controllerRef.current?.setDark(query.matches)
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  // (Re)build the drawing whenever the map itself changes (first generation, Regenerate).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!tree || !canvas) return
    const controller = createMindMap(canvas, {
      tree,
      dark: window.matchMedia(DARK_QUERY).matches,
      onSelect: setSelected,
      onViewChange: (k) => {
        if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(k * 100)}%`
      },
      onManualToggle: () => {
        setLevel(null)
        setToggleCount((n) => n + 1)
      }
    })
    controllerRef.current = controller
    introducedRef.current = false
    setSelected(null)
    setLevel(DEFAULT_LEVEL)
    // The intro fits the map to the canvas, so it has to wait until the tab is visible.
    if (activeRef.current) {
      controller.intro(DEFAULT_LEVEL)
      introducedRef.current = true
    }
    return () => {
      controller.destroy()
      controllerRef.current = null
    }
  }, [tree])

  useEffect(() => {
    if (!active) {
      setFullscreen(false)
      setMenuOpen(false)
      return
    }
    if (controllerRef.current && !introducedRef.current) {
      controllerRef.current.intro(DEFAULT_LEVEL)
      introducedRef.current = true
    }
  }, [active])

  // Keep the selected node clear of the detail card.
  useEffect(() => {
    const controller = controllerRef.current
    if (!controller) return
    if (!selected) {
      controller.setInsetRight(0)
      return
    }
    controller.setInsetRight((cardRef.current?.offsetWidth ?? 0) + 12)
    controller.ensureVisible(selected.id)
  }, [selected])

  // Full screen = the map fills the whole app window (not the OS screen).
  const firstFullscreenRender = useRef(true)
  useEffect(() => {
    if (firstFullscreenRender.current) {
      firstFullscreenRender.current = false
      return
    }
    const id = requestAnimationFrame(() => controllerRef.current?.fit())
    return () => cancelAnimationFrame(id)
  }, [fullscreen])

  useEffect(() => {
    if (!active) return
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.tagName === 'SELECT')) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const controller = controllerRef.current
      if (e.key === 'Escape') {
        if (menuOpen) setMenuOpen(false)
        else if (selected) controller?.select(null)
        else setFullscreen(false)
      } else if (!controller) return
      else if (e.key === '+' || e.key === '=') controller.zoomBy(1.25)
      else if (e.key === '-') controller.zoomBy(1 / 1.25)
      else if (e.key === '0') controller.resetZoom()
      else if (e.key === 'f' || e.key === 'F') controller.fit()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [active, menuOpen, selected])

  useEffect(() => {
    if (!menuOpen) return
    const close = (): void => setMenuOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuOpen])

  const pickLevel = (next: number): void => {
    controllerRef.current?.setLevel(next)
    setLevel(next)
  }

  const copyOutline = (): void => {
    if (!tree) return
    window.api.copyText(mindMapMarkdown(tree, dateLabel))
    showToast('Markdown outline copied to the clipboard')
  }

  const exportPng = (): void => {
    const controller = controllerRef.current
    if (!controller || !map) return
    const { svg, width, height } = controller.exportSvg(48)
    const scale = Math.min(2, PNG_MAX_SIDE / Math.max(width, height))
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(width * scale)
      canvas.height = Math.round(height * scale)
      canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
      canvas.toBlob((blob) => {
        if (!blob) return showToast('Could not render the PNG')
        void blob
          .arrayBuffer()
          .then((bytes) => window.api.saveMindMapPng(bytes, `${map.title} - mind map`))
          .then((result) => {
            if (result.ok) showToast(`PNG saved (${canvas.width} × ${canvas.height})`)
            else if (result.error !== 'Cancelled.') showToast(`Could not save the PNG: ${result.error ?? 'unknown error'}`)
          })
      }, 'image/png')
    }
    img.onerror = () => showToast('Could not render the PNG')
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  }

  const node = selected?.data
  const color = selected ? mindMapNodeColor(selected, dark) : undefined
  const crumb = !selected
    ? ''
    : selected.depth === 0
      ? 'Recording'
      : selected.depth === 1
        ? node?.kind === 'topic'
          ? 'Topic'
          : 'Outcome'
        : (() => {
            const path: string[] = []
            for (let p = selected.parent; p && p.depth > 0; p = p.parent) path.unshift(p.data.label)
            return path.join('  ›  ')
          })()
  const chips: string[] = []
  if (selected && node && node.startMs !== undefined && node.endMs !== undefined) {
    const single = selected.children.length === 0 && selected.depth > 1
    chips.push(single ? formatElapsed(node.startMs) : `${formatElapsed(node.startMs)} – ${formatElapsed(node.endMs)}`)
    if (!single && node.endMs > node.startMs) chips.push(minutesLabel(node.endMs - node.startMs))
  }
  if (node?.owner) chips.push(`Owner: ${node.owner}`)
  if (node?.due) chips.push(`Due: ${node.due}`)
  if (selected && selected.children.length > 0) {
    chips.push(`${selected.children.length} ${selected.children.length === 1 ? 'point' : 'points'}`)
  }
  const canToggle = !!selected && selected.depth > 0 && selected.children.length > 0
  const canShow = !!selected && selected.depth > 0 && !!node?.startSegmentId && !!node.endSegmentId

  return (
    <div className={fullscreen ? 'mm-panel mm-full' : 'mm-panel'}>
      <div
        className="mm-canvas"
        ref={canvasRef}
        onPointerDown={() => setHintHidden(true)}
        onWheel={() => setHintHidden(true)}
      />

      {map && (
        <>
          <div className="mm-float tl" role="group" aria-label="Levels shown">
            <span className="mm-float-label">Levels</span>
            {LEVELS.map((l) => (
              <button
                key={l.level}
                type="button"
                className={level === l.level ? 'mm-btn active' : 'mm-btn'}
                title={l.title}
                onClick={() => pickLevel(l.level)}
              >
                {l.label}
              </button>
            ))}
          </div>

          <div className="mm-float tr">
            <button type="button" className="mm-btn" title={regenerateTitle} onClick={onRegenerate} disabled={generating}>
              <Icon d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" />
              <span className="mm-btn-text">Regenerate</span>
            </button>
            <span className="mm-sep" />
            <div className="mm-menu-wrap">
              <button
                type="button"
                className="mm-btn"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title="Export"
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen((open) => !open)
                }}
              >
                <Icon d="M12 3v12M7 10l5 5 5-5M5 21h14" />
                <span className="mm-btn-text">Export</span>
              </button>
              {menuOpen && (
                <div className="mm-menu" role="menu">
                  <button type="button" role="menuitem" onClick={exportPng}>
                    Download PNG
                    <small>The map as shown, at 2× resolution</small>
                  </button>
                  <button type="button" role="menuitem" onClick={copyOutline}>
                    Copy Markdown outline
                    <small>The full map as a nested list</small>
                  </button>
                </div>
              )}
            </div>
            <span className="mm-sep" />
            <button
              type="button"
              className="mm-btn"
              title={fullscreen ? 'Exit full screen (Esc)' : 'Full screen (Esc to exit)'}
              aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
              onClick={() => setFullscreen((on) => !on)}
            >
              <Icon d={fullscreen ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'} />
            </button>
          </div>

          <div className="mm-float br" role="group" aria-label="Zoom">
            <button type="button" className="mm-btn" title="Zoom out (−)" aria-label="Zoom out" onClick={() => controllerRef.current?.zoomBy(1 / 1.25)}>
              −
            </button>
            <button
              type="button"
              className="mm-btn mm-zoom-label"
              ref={zoomLabelRef}
              title="Reset to 100% (0)"
              onClick={() => controllerRef.current?.resetZoom()}
            >
              100%
            </button>
            <button type="button" className="mm-btn" title="Zoom in (+)" aria-label="Zoom in" onClick={() => controllerRef.current?.zoomBy(1.25)}>
              +
            </button>
            <span className="mm-sep" />
            <button type="button" className="mm-btn" title="Fit to screen (F)" onClick={() => controllerRef.current?.fit()}>
              <Icon d="M6 6h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2ZM9 12h6" />
              <span className="mm-btn-text">Fit</span>
            </button>
          </div>

          {map.backupModel && (
            <div className="mm-backup-note" title="The main model reached its daily limit while this map was being built">
              Partly written by the backup model {map.backupModel}
            </div>
          )}

          <div className={hintHidden ? 'mm-hint hide' : 'mm-hint'}>
            Click a numbered circle to open a branch · click a node for details · scroll to zoom · drag to move
          </div>
        </>
      )}

      <aside className={selected ? 'mm-card show' : 'mm-card'} ref={cardRef} aria-live="polite">
        {selected && node && (
          <>
            <div className="mm-card-top">
              <span className="mm-card-dot" style={{ background: color }} />
              <span className="mm-card-crumb" style={{ color }}>
                {crumb}
              </span>
              <button type="button" className="mm-btn mm-card-close" aria-label="Close" onClick={() => controllerRef.current?.select(null)}>
                ✕
              </button>
            </div>
            <h3>{node.label}</h3>
            {chips.length > 0 && (
              <div className="mm-chips">
                {chips.map((chip) => (
                  <span key={chip} className="mm-chip">
                    {chip}
                  </span>
                ))}
              </div>
            )}
            {node.note && <p className="mm-card-note">{node.note}</p>}
            {(canShow || canToggle) && (
              <div className="mm-card-actions">
                {canShow && (
                  <button type="button" className="mm-primary" onClick={() => onShowInTranscript(node, color ?? '')}>
                    <Icon d="M4 6h16M4 12h10M4 18h13" />
                    Show in transcript
                  </button>
                )}
                {canToggle && (
                  <button type="button" className="mm-secondary" onClick={() => controllerRef.current?.toggle(selected.id)}>
                    {controllerRef.current?.isExpanded(selected.id) ? 'Collapse' : 'Expand'}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </aside>

      {generating ? (
        <div className="mm-overlay">
          <svg className="mm-gen-art" viewBox="0 0 132 72" aria-hidden="true">
            <path d="M66 36C84 36 84 12 104 12" />
            <path d="M66 36C84 36 84 36 104 36" />
            <path d="M66 36C84 36 84 60 104 60" />
            <path d="M66 36C48 36 48 12 28 12" />
            <path d="M66 36C48 36 48 36 28 36" />
            <path d="M66 36C48 36 48 60 28 60" />
            <circle cx="66" cy="36" r="6" />
          </svg>
          <div className="mm-overlay-title">Building the mind map</div>
          <div className="mm-overlay-step">{progressText(progress)}</div>
          <div className="mm-gen-bar">
            <i style={{ width: `${progressPercent(progress)}%` }} />
          </div>
          <div className="mm-overlay-foot">
            This keeps running in the background — you can leave this tab, open another recording or dictate. The map is saved
            with the recording when it is done.
          </div>
        </div>
      ) : !map ? (
        <div className="mm-overlay">
          {segments.length === 0 ? (
            <div className="mm-overlay-step">No speech was transcribed in this session.</div>
          ) : stopped?.reason === 'quota' && quotaMessage ? (
            <>
              <div className="mm-overlay-title">The mind map was not built</div>
              {quotaMessage}
              {stopped.total > 1 && (
                // A long recording is outlined part by part; the allowance ran out on the way.
                <div className="mm-overlay-step">
                  It stopped after {stopped.done} of {stopped.total} parts. They are kept — it goes on from there.
                </div>
              )}
              <button type="button" className="meeting-retry-btn" onClick={onRetry}>
                {stopped.total > 1 && stopped.done > 0 ? 'Continue' : 'Try again'}
              </button>
            </>
          ) : stopped ? (
            <>
              <div className="mm-overlay-title">{stoppedText(stopped).title}</div>
              <div className="mm-overlay-step">{stoppedText(stopped).text}</div>
              {stopped.detail && <div className="mm-overlay-detail">{stopped.detail}</div>}
              <button type="button" className="meeting-retry-btn" onClick={onRetry}>
                {stoppedText(stopped).action}
              </button>
            </>
          ) : canCreate ? (
            <>
              <button type="button" className="meeting-create-btn" onClick={onCreate}>
                Create mind map
              </button>
              <div className="mm-overlay-step">
                The whole recording as a map of its topics, decisions, action items and open questions. It is built in the
                background and saved with the recording.
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {toast && <div className="mm-toast">{toast}</div>}
    </div>
  )
}
