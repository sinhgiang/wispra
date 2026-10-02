import type { MeetingLanguageConfig, MeetingOutline } from '@shared/types'
import { cleanText, formatClock, type TranscriptLine } from './mindMapLogic'

/**
 * Pure helpers behind the transcript outline (outline.ts makes the AI calls): turning
 * the model's JSON into validated topics, action items and speaker names, and joining
 * the outlines of a long recording's parts. Nothing here touches the network, Electron
 * or the disk. Topics, actions and speakers are addressed by transcript line refs (see
 * TranscriptLine in mindMapLogic.ts) until assembleOutline() resolves them to segment ids.
 */

/** A section of the transcript: paragraphs `from`..`to` (inclusive line refs). */
export interface RefTopic {
  title: string
  from: number
  to: number
}

/** A task stated in paragraph `at`. */
export interface RefAction {
  text: string
  owner?: string
  due?: string
  at: number
}

/** Paragraphs `from`..`to` are spoken by `name`, as the transcript itself says. */
export interface RefSpeaker {
  name: string
  from: number
  to: number
}

export interface RefOutline {
  topics: RefTopic[]
  actions: RefAction[]
  speakers: RefSpeaker[]
}

const TITLE_MAX_CHARS = 90
const ACTION_MAX_CHARS = 200
const PERSON_MAX_CHARS = 60
const MAX_TOPICS_PER_CALL = 16
const MAX_ACTIONS_PER_CALL = 30
const MAX_SPEAKERS_PER_CALL = 30

/**
 * Which language the topics and action items are written in: the session's "Summary"
 * language choice — like the summary they help re-read the recording, they are not
 * content to publish. Anything that is not a known code means "auto" (same as the transcript).
 */
export function outlineLanguage(languageConfig: MeetingLanguageConfig | undefined, knownCodes: string[]): string {
  const picked = languageConfig?.summary ?? 'auto'
  return knownCodes.includes(picked) ? picked : 'auto'
}

function refOf(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(/[[\]\s]/g, '')) : NaN
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {})
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/**
 * Reads the model's outline of one stretch of transcript (the whole recording, or one
 * part of it). A ref the model invented or took from outside `lines` drops that item —
 * never guesses a place for it. Topics come back contiguous and covering all of `lines`:
 * each runs from its own start to just before the next one, and the first is stretched
 * back to the first paragraph. Returns null when the answer has no usable topic.
 */
export function parseOutline(raw: unknown, lines: TranscriptLine[]): RefOutline | null {
  if (lines.length === 0) return null
  const data = asRecord(raw)
  const min = lines[0].ref
  const max = lines[lines.length - 1].ref

  const starts = new Map<number, string>()
  for (const entry of asList(data.topics)) {
    const item = asRecord(entry)
    const title = cleanText(item.title, TITLE_MAX_CHARS)
    const start = refOf(item.start, min, max)
    if (title && start !== undefined && !starts.has(start) && starts.size < MAX_TOPICS_PER_CALL) starts.set(start, title)
  }
  if (starts.size === 0) return null
  const ordered = [...starts.entries()].sort((a, b) => a[0] - b[0])
  const topics: RefTopic[] = ordered.map(([start, title], i) => ({
    title,
    from: i === 0 ? min : start,
    to: i + 1 < ordered.length ? ordered[i + 1][0] - 1 : max
  }))

  const actions: RefAction[] = []
  for (const entry of asList(data.actions)) {
    const item = asRecord(entry)
    const text = cleanText(item.text, ACTION_MAX_CHARS)
    const at = refOf(item.ref ?? item.start, min, max)
    if (!text || at === undefined || actions.length >= MAX_ACTIONS_PER_CALL) continue
    const action: RefAction = { text, at }
    const owner = cleanText(item.owner, PERSON_MAX_CHARS)
    if (owner) action.owner = owner
    const due = cleanText(item.due, PERSON_MAX_CHARS)
    if (due) action.due = due
    actions.push(action)
  }
  actions.sort((a, b) => a.at - b.at)

  const speakers: RefSpeaker[] = []
  for (const entry of asList(data.speakers)) {
    const item = asRecord(entry)
    const name = cleanText(item.name, PERSON_MAX_CHARS)
    const start = refOf(item.start, min, max)
    const end = refOf(item.end, min, max) ?? start
    if (!name || start === undefined || end === undefined || speakers.length >= MAX_SPEAKERS_PER_CALL) continue
    speakers.push({ name, from: Math.min(start, end), to: Math.max(start, end) })
  }

  return { topics, actions, speakers }
}

/** The text the merge call reads: every part's topics and actions as short numbered lines. */
export function describeForMerge(outline: RefOutline, lines: TranscriptLine[]): string {
  const byRef = new Map(lines.map((l) => [l.ref, l]))
  const clock = (ref: number): string => formatClock(byRef.get(ref)?.startMs ?? 0)
  const topics = outline.topics.map((t, i) => `T${i + 1} (${clock(t.from)}–${clock(t.to)}) ${t.title}`).join('\n')
  const actions =
    outline.actions.length === 0
      ? '(none)'
      : outline.actions
          .map((a, i) => {
            const people = [a.owner && `owner: ${a.owner}`, a.due && `due: ${a.due}`].filter(Boolean).join(', ')
            return `A${i + 1} (${clock(a.at)}) ${a.text}${people ? ` (${people})` : ''}`
          })
          .join('\n')
  return `TOPICS:\n${topics}\n\nACTIONS:\n${actions}`
}

function indexOf(value: unknown, count: number): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(/^[A-Za-z]\s*/, '')) : NaN
  return Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : undefined
}

/**
 * Applies the merge call's answer to the part-by-part outline: runs of consecutive
 * topics the model says are one subject become one topic, and action items it marks as
 * repeats are dropped. Tolerant by design — a run that is malformed or overlaps an
 * earlier one is ignored and its topics stay as they were, and an unusable answer
 * leaves the outline untouched — so a sloppy merge can never lose part of the recording.
 */
export function applyMerge(raw: unknown, outline: RefOutline): RefOutline {
  const data = asRecord(raw)
  const count = outline.topics.length
  const runs: Array<{ from: number; to: number; title: string }> = []
  const taken = new Array<boolean>(count).fill(false)
  for (const entry of asList(data.topics)) {
    const item = asRecord(entry)
    const from = indexOf(item.from, count)
    const to = indexOf(item.to ?? item.from, count)
    if (from === undefined || to === undefined || to < from) continue
    if (taken.slice(from, to + 1).some(Boolean)) continue
    for (let i = from; i <= to; i++) taken[i] = true
    runs.push({ from, to, title: cleanText(item.title, TITLE_MAX_CHARS) })
  }
  for (let i = 0; i < count; i++) if (!taken[i]) runs.push({ from: i, to: i, title: '' })
  runs.sort((a, b) => a.from - b.from)
  const topics = runs.map((run) => ({
    title: run.title || outline.topics[run.from].title,
    from: outline.topics[run.from].from,
    to: outline.topics[run.to].to
  }))

  let actions = outline.actions
  if (Array.isArray(data.actions)) {
    const keep = new Set<number>()
    for (const value of data.actions) {
      const i = indexOf(value, outline.actions.length)
      if (i !== undefined) keep.add(i)
    }
    // An answer that keeps nothing while tasks exist is far more likely a slip than a verdict.
    if (keep.size > 0) actions = outline.actions.filter((_, i) => keep.has(i))
  }
  return { topics, actions, speakers: outline.speakers }
}

/** Resolves line refs to segment ids and puts the finished outline together. */
export function assembleOutline(outline: RefOutline, lines: TranscriptLine[], language: string, generatedAt: string): MeetingOutline {
  const byRef = new Map(lines.map((l) => [l.ref, l]))
  const first = (ref: number): string => byRef.get(ref)!.firstSegmentId
  const last = (ref: number): string => byRef.get(ref)!.lastSegmentId
  return {
    topics: outline.topics.map((t) => ({ title: t.title, startSegmentId: first(t.from), endSegmentId: last(t.to) })),
    actions: outline.actions.map((a) => {
      const action: MeetingOutline['actions'][number] = { text: a.text, startSegmentId: first(a.at), endSegmentId: last(a.at) }
      if (a.owner) action.owner = a.owner
      if (a.due) action.due = a.due
      return action
    }),
    speakers: outline.speakers.map((s) => ({ name: s.name, startSegmentId: first(s.from), endSegmentId: last(s.to) })),
    language,
    generatedAt
  }
}
