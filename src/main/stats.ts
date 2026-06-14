import type { TranscriptEntry, UsageStats } from '@shared/types'

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

export function computeStats(entries: TranscriptEntry[]): UsageStats {
  const now = Date.now()
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000

  let totalMinutes = 0
  let totalWords = 0
  let thisWeekDictations = 0
  let thisWeekMinutes = 0

  const daySet = new Set<string>()
  const dayCount: Record<string, number> = {}

  for (const e of entries) {
    const dur = e.durationSeconds ?? 0
    totalMinutes += dur / 60
    totalWords += wordCount(e.text)

    const ts = new Date(e.createdAt).getTime()
    if (ts >= weekAgo) {
      thisWeekDictations++
      thisWeekMinutes += dur / 60
    }

    const day = e.createdAt.slice(0, 10)
    daySet.add(day)

    const dow = new Date(e.createdAt).toLocaleDateString('en', { weekday: 'long' })
    dayCount[dow] = (dayCount[dow] ?? 0) + 1
  }

  // Streak: consecutive days ending today (or yesterday)
  let streak = 0
  const today = new Date()
  for (let i = 0; i < 366; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    if (daySet.has(key)) {
      streak++
    } else if (i > 0) {
      break
    }
  }

  const mostActiveDay =
    Object.entries(dayCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—'

  return {
    totalDictations: entries.length,
    totalMinutes: Math.round(totalMinutes * 10) / 10,
    totalWords,
    thisWeekDictations,
    thisWeekMinutes: Math.round(thisWeekMinutes * 10) / 10,
    streak,
    mostActiveDay
  }
}

export function formatHistoryAsTxt(entries: TranscriptEntry[]): string {
  return entries
    .map((e) => `[${new Date(e.createdAt).toLocaleString()}]\n${e.text}`)
    .join('\n\n---\n\n')
}

export function formatHistoryAsMd(entries: TranscriptEntry[]): string {
  const byDay: Record<string, TranscriptEntry[]> = {}
  for (const e of entries) {
    const day = e.createdAt.slice(0, 10)
    ;(byDay[day] ??= []).push(e)
  }
  return Object.entries(byDay)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, list]) => {
      const items = list.map((e) => `- ${e.text}`).join('\n')
      return `## ${day}\n\n${items}`
    })
    .join('\n\n')
}

export function formatHistoryAsCsv(entries: TranscriptEntry[]): string {
  const header = 'id,createdAt,language,durationSeconds,text'
  const rows = entries.map((e) => {
    const text = `"${e.text.replace(/"/g, '""')}"`
    return [e.id, e.createdAt, e.language ?? '', e.durationSeconds ?? '', text].join(',')
  })
  return [header, ...rows].join('\n')
}
