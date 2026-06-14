import { useEffect, useState } from 'react'
import type { TranscriptEntry } from '@shared/types'

// ── Period ───────────────────────────────────────────────────
type Period = 'all' | 'today' | 'yesterday' | '3days' | 'week' | 'older'

const PERIOD_LABELS: Record<Period, string> = {
  all:       'All',
  today:     'Today',
  yesterday: 'Yesterday',
  '3days':   '3 days ago',
  week:      'This week',
  older:     'Older',
}

const ALL_PERIODS: Period[] = ['all', 'today', 'yesterday', '3days', 'week', 'older']

function dayMs(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function filterByPeriod(entries: TranscriptEntry[], period: Period): TranscriptEntry[] {
  if (period === 'all') return entries
  const todayMs = dayMs(new Date())
  const D       = 86_400_000
  return entries.filter((e) => {
    const d = dayMs(new Date(e.createdAt))
    switch (period) {
      case 'today':     return d === todayMs
      case 'yesterday': return d === todayMs - D
      case '3days':     return d >= todayMs - 3 * D && d < todayMs - D
      case 'week':      return d >= todayMs - 7 * D && d < todayMs - 3 * D
      case 'older':     return d < todayMs - 7 * D
    }
  })
}

// ── Tags ─────────────────────────────────────────────────────
const TOPIC_ICON: Record<string, string> = {
  Email: '📧', Meeting: '📅', Tasks: '✅', Notes: '📝', Message: '💬', General: '📌',
}

function getTag(entry: TranscriptEntry): string {
  return entry.topic ?? 'General'
}

function uniqueTagsByFreq(entries: TranscriptEntry[]): string[] {
  const counts: Record<string, number> = {}
  for (const e of entries) {
    const t = getTag(e)
    counts[t] = (counts[t] ?? 0) + 1
  }
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])
}

// ── Timestamp ─────────────────────────────────────────────────
function formatTime(createdAt: string, period: Period): string {
  const d    = new Date(createdAt)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (period === 'today' || period === 'yesterday') return time
  if (period === 'all') {
    const todayMs = dayMs(new Date())
    const day     = dayMs(d)
    if (day === todayMs)             return `Today, ${time}`
    if (day === todayMs - 86_400_000) return `Yesterday, ${time}`
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time
}

// ── Summary state ─────────────────────────────────────────────
interface SummaryState { loading: boolean; text?: string; error?: string }

// ── Component ─────────────────────────────────────────────────
export function HistorySection(): React.JSX.Element {
  const [entries,   setEntries]   = useState<TranscriptEntry[]>([])
  const [period,    setPeriod]    = useState<Period>('all')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [summaries, setSummaries] = useState<Record<string, SummaryState>>({})
  const [copiedId,  setCopiedId]  = useState<string | null>(null)

  useEffect(() => {
    void window.api.getHistory().then(setEntries)
    window.api.onHistoryChanged(setEntries)
  }, [])

  function changePeriod(p: Period): void {
    setPeriod(p)
    setActiveTag(null)
    setSummaries({})
  }

  function toggleTag(tag: string): void {
    setActiveTag((prev) => (prev === tag ? null : tag))
    setSummaries({})
  }

  function copy(entry: TranscriptEntry): void {
    window.api.copyText(entry.text)
    setCopiedId(entry.id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  async function summarize(key: string, texts: string[]): Promise<void> {
    setSummaries((s) => ({ ...s, [key]: { loading: true } }))
    const result = await window.api.summarizeTopic(texts)
    setSummaries((s) => ({
      ...s,
      [key]: result.ok
        ? { loading: false, text: result.summary }
        : { loading: false, error: result.error ?? 'Summary failed.' },
    }))
  }

  // Derived data
  const periodEntries = filterByPeriod(entries, period)
  const tags          = uniqueTagsByFreq(periodEntries)
  const filtered      = activeTag
    ? periodEntries.filter((e) => getTag(e) === activeTag)
    : periodEntries

  const periodCounts  = Object.fromEntries(
    ALL_PERIODS.map((p) => [p, filterByPeriod(entries, p).length])
  ) as Record<Period, number>

  const sumKey = `${period}::${activeTag ?? 'all'}`
  const sum    = summaries[sumKey]

  return (
    <section>
      {/* Header */}
      <div className="history-head">
        <h2>Recent Dictations</h2>
        {entries.length > 0 && (
          <button className="danger" onClick={() => void window.api.clearHistory()}>
            Clear all
          </button>
        )}
      </div>

      {entries.length === 0 ? (
        <div className="history-empty">
          <p>Nothing yet — press the hotkey and start speaking.</p>
        </div>
      ) : (
        <>
          {/* Period tabs */}
          <div className="period-tabs">
            {ALL_PERIODS.map((p) => {
              const count = periodCounts[p]
              if (p !== 'all' && count === 0) return null
              return (
                <button
                  key={p}
                  className={`period-tab${period === p ? ' active' : ''}`}
                  onClick={() => changePeriod(p)}
                >
                  {PERIOD_LABELS[p]}
                  <span className="period-count">{count}</span>
                </button>
              )
            })}
          </div>

          {/* Hashtag filter pills */}
          {tags.length > 1 && (
            <div className="tag-filters">
              {tags.map((tag) => {
                const count = periodEntries.filter((e) => getTag(e) === tag).length
                return (
                  <button
                    key={tag}
                    className={`tag-pill${activeTag === tag ? ' active' : ''}`}
                    onClick={() => toggleTag(tag)}
                  >
                    {TOPIC_ICON[tag] ?? '📌'} #{tag}
                    <span className="tag-pill-count">{count}</span>
                  </button>
                )
              })}
              {activeTag && (
                <button className="tag-clear" onClick={() => setActiveTag(null)} title="Clear filter">
                  ✕ Clear
                </button>
              )}
            </div>
          )}

          {/* Flat entry list */}
          <ul className="history">
            {filtered.map((entry) => {
              const tag = getTag(entry)
              return (
                <li key={entry.id}>
                  <p>{entry.text}</p>
                  <div className="meta">
                    <button
                      className={`entry-tag-btn${activeTag === tag ? ' active' : ''}`}
                      onClick={() => toggleTag(tag)}
                      title={`Filter by #${tag}`}
                    >
                      {TOPIC_ICON[tag] ?? '📌'} #{tag}
                    </button>
                    <span className="meta-time">{formatTime(entry.createdAt, period)}</span>
                    <button
                      className={`copy-btn${copiedId === entry.id ? ' copied' : ''}`}
                      onClick={() => copy(entry)}
                    >
                      {copiedId === entry.id ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>

          {/* AI Summary bar */}
          {filtered.length >= 2 && (
            <div className="summary-bar">
              <span className="summary-bar-label">
                {filtered.length} entries{activeTag ? ` · #${activeTag}` : ''}
              </span>
              {!sum && (
                <button
                  className="summary-btn"
                  onClick={() => void summarize(sumKey, filtered.map((e) => e.text))}
                >
                  ✨ Summarize with AI
                </button>
              )}
            </div>
          )}

          {sum?.loading && (
            <div className="summary-loading">
              <span className="spinner-inline" /> Summarizing…
            </div>
          )}
          {sum?.text && (
            <div className="summary-box">
              <div className="summary-header">
                <span>✨ AI Summary</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="copy-btn" onClick={() => window.api.copyText(sum.text!)}>
                    Copy
                  </button>
                  <button
                    className="copy-btn"
                    onClick={() =>
                      setSummaries((s) => { const n = { ...s }; delete n[sumKey]; return n })
                    }
                  >
                    ✕
                  </button>
                </div>
              </div>
              <p className="summary-text">{sum.text}</p>
            </div>
          )}
          {sum?.error && <div className="summary-error">{sum.error}</div>}
        </>
      )}
    </section>
  )
}
