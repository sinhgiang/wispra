import { useEffect, useState } from 'react'
import type { UsageStats } from '@shared/types'

export function StatisticsSection(): React.JSX.Element {
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<string | null>(null)

  useEffect(() => {
    void window.api.getStats().then(setStats)
    // Refresh whenever a new dictation is added.
    window.api.onHistoryChanged(() => {
      void window.api.getStats().then(setStats)
    })
  }, [])

  async function doExport(format: 'txt' | 'md' | 'csv'): Promise<void> {
    setExporting(true)
    setExportMsg(null)
    const result = await window.api.exportHistory(format)
    setExporting(false)
    setExportMsg(result.ok ? 'Exported successfully!' : (result.error ?? 'Export failed.'))
    setTimeout(() => setExportMsg(null), 3000)
  }

  if (!stats) return <section><p className="hint">Loading…</p></section>

  // Time saved = words ÷ average typing speed (40 WPM)
  const typingMinutes = Math.round(stats.totalWords / 40)
  const savedHours = Math.floor(typingMinutes / 60)
  const savedMins = typingMinutes % 60
  const savedText = savedHours > 0
    ? savedMins > 0 ? `${savedHours} hr ${savedMins} min` : `${savedHours} hr`
    : `${savedMins} min`

  return (
    <section>
      {/* Hero — time saved banner */}
      <div className="savings-hero">
        <div className="savings-left">
          <span className="savings-eyebrow">⚡ Time saved typing</span>
          <span className="savings-amount">{savedText}</span>
          <span className="savings-sub">
            {stats.totalWords.toLocaleString()} words transcribed · vs. typing at 40 WPM
          </span>
        </div>
        <div className="savings-right">
          <span className="savings-big-num">{stats.totalDictations.toLocaleString()}</span>
          <span className="savings-big-label">dictations</span>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-value">{stats.totalDictations.toLocaleString()}</span>
          <span className="stat-label">Total dictations</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{stats.totalMinutes.toLocaleString()}</span>
          <span className="stat-label">Minutes recorded</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{stats.totalWords.toLocaleString()}</span>
          <span className="stat-label">Words transcribed</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{stats.thisWeekDictations}</span>
          <span className="stat-label">This week</span>
        </div>
        <div className="stat-card accent">
          <span className="stat-value">{stats.streak}</span>
          <span className="stat-label">Day streak 🔥</span>
        </div>
        <div className="stat-card">
          <span className="stat-value" style={{ fontSize: '16px' }}>{stats.mostActiveDay}</span>
          <span className="stat-label">Most active day</span>
        </div>
      </div>

      {/* Export */}
      <div className="stats-export">
        <span className="stats-export-label">Export history as:</span>
        <button className="btn-secondary" disabled={exporting} onClick={() => void doExport('txt')}>TXT</button>
        <button className="btn-secondary" disabled={exporting} onClick={() => void doExport('md')}>Markdown</button>
        <button className="btn-secondary" disabled={exporting} onClick={() => void doExport('csv')}>CSV</button>
        {exportMsg && <span className="stats-export-msg">{exportMsg}</span>}
      </div>
    </section>
  )
}
