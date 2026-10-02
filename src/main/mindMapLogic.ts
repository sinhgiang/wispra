import type {
  MeetingLanguageConfig,
  MeetingMindMap,
  MeetingSegment,
  MindMapBranchKind,
  MindMapNode
} from '@shared/types'

/**
 * Pure helpers behind the meeting mind map (mindMap.ts makes the AI calls): turning a
 * transcript into tagged lines and parts, and turning the model's JSON back into a
 * validated MeetingMindMap. Nothing here touches the network, Electron or the disk.
 */

/** One paragraph of the transcript as the model sees it: "[ref] (h:mm:ss) text". */
export interface TranscriptLine {
  /** 1-based reference number the model cites instead of the segments' long ids. */
  ref: number
  startMs: number
  firstSegmentId: string
  lastSegmentId: string
  text: string
}

/** A node while it is still addressed by line refs (inclusive range), before those are resolved to segment ids. */
export interface RefNode {
  label: string
  note?: string
  from?: number
  to?: number
  kind?: MindMapBranchKind
  owner?: string
  due?: string
  children: RefNode[]
}

export interface Outline {
  topics: RefNode[]
  decisions: RefNode[]
  actions: RefNode[]
  questions: RefNode[]
}

export interface BranchLabels {
  decisions: string
  actions: string
  questions: string
}

const LABEL_MAX_CHARS = 90
const NOTE_MAX_CHARS = 400
const MAX_TOPICS = 12
const MAX_POINTS = 8
const MAX_OUTCOMES = 20

/**
 * Names of the three fixed branches per language the user can pick. Used as-is for an
 * explicit language choice so they are never left in English by the model; for "auto"
 * (same language as the transcript) the model supplies them instead.
 */
const OUTCOME_LABELS: Record<string, BranchLabels> = {
  en: { decisions: 'Decisions', actions: 'Action items', questions: 'Open questions' },
  vi: { decisions: 'Quyết định', actions: 'Việc cần làm', questions: 'Câu hỏi còn mở' },
  zh: { decisions: '决定', actions: '行动项', questions: '待解决问题' },
  ja: { decisions: '決定事項', actions: 'アクションアイテム', questions: '未解決の質問' },
  ko: { decisions: '결정 사항', actions: '실행 항목', questions: '미해결 질문' },
  fr: { decisions: 'Décisions', actions: 'Actions à mener', questions: 'Questions ouvertes' },
  de: { decisions: 'Entscheidungen', actions: 'Aufgaben', questions: 'Offene Fragen' },
  es: { decisions: 'Decisiones', actions: 'Tareas pendientes', questions: 'Preguntas abiertas' },
  pt: { decisions: 'Decisões', actions: 'Ações a realizar', questions: 'Perguntas em aberto' },
  ru: { decisions: 'Решения', actions: 'Задачи', questions: 'Открытые вопросы' },
  th: { decisions: 'การตัดสินใจ', actions: 'สิ่งที่ต้องทำ', questions: 'คำถามที่ยังค้างอยู่' },
  id: { decisions: 'Keputusan', actions: 'Tindak lanjut', questions: 'Pertanyaan terbuka' },
  hi: { decisions: 'निर्णय', actions: 'कार्य बिंदु', questions: 'खुले प्रश्न' },
  ar: { decisions: 'القرارات', actions: 'بنود العمل', questions: 'أسئلة مفتوحة' }
}

/**
 * Which language a session's map is written in. A first build follows the "Website &
 * social posts" choice saved with the recording (languageConfig.website — the one the
 * Website and social tabs follow, never the spoken language). Regenerate may name the
 * language currently picked in that field instead, so an existing recording can be
 * re-mapped in another language. Anything that is not a known code means "auto".
 */
export function mindMapLanguage(
  languageConfig: MeetingLanguageConfig | undefined,
  options: { regenerate?: boolean; language?: string } | undefined,
  knownCodes: string[]
): string {
  const requested = options?.regenerate ? options.language : undefined
  const picked = requested ?? languageConfig?.website ?? 'auto'
  return knownCodes.includes(picked) ? picked : 'auto'
}

/** Merges consecutive segments into paragraphs (same rule as the transcript view) and numbers them. */
export function buildTranscriptLines(segments: MeetingSegment[]): TranscriptLine[] {
  const lines: TranscriptLine[] = []
  for (const seg of segments) {
    const text = seg.text.trim()
    if (!text) continue
    const last = lines[lines.length - 1]
    if (seg.isNewParagraph || !last) {
      lines.push({ ref: lines.length + 1, startMs: seg.startMs, firstSegmentId: seg.id, lastSegmentId: seg.id, text })
    } else {
      last.text += ' ' + text
      last.lastSegmentId = seg.id
    }
  }
  return lines
}

export function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

export function formatLine(line: TranscriptLine): string {
  return `[${line.ref}] (${formatClock(line.startMs)}) ${line.text}`
}

export function linesLength(lines: TranscriptLine[]): number {
  return lines.reduce((sum, l) => sum + formatLine(l).length + 1, 0)
}

/**
 * Cuts the transcript into consecutive parts of roughly equal size, each about
 * `partChars` long — or longer, when that would take more than `maxParts` parts.
 * Whole paragraphs only, so every ref stays intact.
 */
export function splitIntoParts(lines: TranscriptLine[], partChars: number, maxParts: number): TranscriptLine[][] {
  const total = linesLength(lines)
  const count = Math.max(1, Math.min(maxParts, Math.ceil(total / partChars)))
  const target = total / count
  const parts: TranscriptLine[][] = []
  let current: TranscriptLine[] = []
  let used = 0
  for (const line of lines) {
    current.push(line)
    used += formatLine(line).length + 1
    if (used >= target && parts.length < count - 1) {
      parts.push(current)
      current = []
      used = 0
    }
  }
  if (current.length > 0) parts.push(current)
  return parts
}

function cleanText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  // Models slip markdown emphasis, list markers and double-escaped newlines into JSON
  // strings despite instructions.
  const text = value
    .replace(/\\[nrt]/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/^\s*(?:[-•*]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > maxChars ? text.slice(0, maxChars - 1).trimEnd() + '…' : text
}

function refOf(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(/[[\]\s]/g, '')) : NaN
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined
}

/**
 * One item of the model's JSON as a RefNode, or null when it has no usable label. A ref
 * the model invented, copied wrong, or took from outside [min, max] just leaves the
 * node without a range — never a wrong one.
 */
function parseItem(raw: unknown, min: number, max: number, depthLeft: number, people: boolean): RefNode | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const label = cleanText(item.label, LABEL_MAX_CHARS)
  if (!label) return null
  const node: RefNode = { label, children: [] }
  const note = cleanText(item.note, NOTE_MAX_CHARS)
  if (note) node.note = note
  const start = refOf(item.start, min, max)
  const end = refOf(item.end, min, max)
  const from = start ?? end
  const to = end ?? start
  if (from !== undefined && to !== undefined) {
    node.from = Math.min(from, to)
    node.to = Math.max(from, to)
  }
  if (people) {
    const owner = cleanText(item.owner, 60)
    if (owner) node.owner = owner
    const due = cleanText(item.due, 60)
    if (due) node.due = due
  }
  if (depthLeft > 0) node.children = parseList(item.points, min, max, depthLeft - 1, MAX_POINTS)
  return node
}

/** `people` keeps each item's owner/due — action items only. */
function parseList(raw: unknown, min: number, max: number, depthLeft: number, limit: number, people = false): RefNode[] {
  if (!Array.isArray(raw)) return []
  const nodes: RefNode[] = []
  for (const entry of raw) {
    const node = parseItem(entry, min, max, depthLeft, people)
    if (node) nodes.push(node)
    if (nodes.length >= limit) break
  }
  return nodes
}

/**
 * Reads the model's outline of one stretch of transcript (the whole recording, or one
 * part of it). `pointDepth` is how many levels of points a topic may carry.
 */
export function parseOutline(raw: unknown, lines: TranscriptLine[], pointDepth: number): Outline {
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const min = lines[0]?.ref ?? 1
  const max = lines[lines.length - 1]?.ref ?? 0
  const topics = parseList(data.topics, min, max, pointDepth, MAX_TOPICS)
  for (const topic of topics) {
    topic.kind = 'topic'
    settleRanges(topic)
  }
  return {
    topics,
    decisions: parseList(data.decisions, min, max, 0, MAX_OUTCOMES),
    actions: parseList(data.actions, min, max, 0, MAX_OUTCOMES, true),
    questions: parseList(data.questions, min, max, 0, MAX_OUTCOMES)
  }
}

/** A node without a range takes the span of its children; a child without one takes its parent's. */
function settleRanges(node: RefNode): void {
  for (const child of node.children) settleRanges(child)
  if (node.from === undefined) spanChildren(node)
  pushRangeDown(node)
}

function spanChildren(node: RefNode): void {
  const ranged = node.children.filter((c) => c.from !== undefined && c.to !== undefined)
  if (ranged.length === 0) return
  node.from = Math.min(...ranged.map((c) => c.from!))
  node.to = Math.max(...ranged.map((c) => c.to!))
}

function pushRangeDown(node: RefNode): void {
  for (const child of node.children) {
    if (child.from === undefined && node.from !== undefined) {
      child.from = node.from
      child.to = node.to
    }
    pushRangeDown(child)
  }
}

/** The text the merge call reads: every part's topics and outcomes as short numbered lines. */
export function describeForMerge(outline: Outline, lines: TranscriptLine[]): string {
  const byRef = new Map(lines.map((l) => [l.ref, l]))
  const when = (n: RefNode): string => {
    const from = n.from !== undefined ? byRef.get(n.from) : undefined
    const to = n.to !== undefined ? byRef.get(n.to) : undefined
    return from && to ? ` (${formatClock(from.startMs)}–${formatClock(to.startMs)})` : ''
  }
  const list = (prefix: string, nodes: RefNode[], withTime: boolean): string =>
    nodes.length === 0
      ? '(none)'
      : nodes
          .map((n, i) => {
            const people = [n.owner && `owner: ${n.owner}`, n.due && `due: ${n.due}`].filter(Boolean).join(', ')
            return `${prefix}${i + 1}${withTime ? when(n) : ''} ${n.label}${n.note ? ` — ${n.note}` : ''}${people ? ` (${people})` : ''}`
          })
          .join('\n')
  return [
    `TOPICS:\n${list('T', outline.topics, true)}`,
    `DECISIONS:\n${list('D', outline.decisions, false)}`,
    `ACTIONS:\n${list('A', outline.actions, false)}`,
    `QUESTIONS:\n${list('Q', outline.questions, false)}`
  ].join('\n\n')
}

function indexList(raw: unknown, count: number): number[] | null {
  if (!Array.isArray(raw)) return null
  const seen = new Set<number>()
  for (const value of raw) {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(/^[A-Za-z]\s*/, '')) : NaN
    if (Number.isInteger(n) && n >= 1 && n <= count) seen.add(n - 1)
  }
  return [...seen].sort((a, b) => a - b)
}

/**
 * Applies the merge call's grouping: the part-by-part topics become the children of
 * 5-9 main branches. Tolerates a sloppy answer — a topic the model listed twice stays
 * in the first branch that named it, and one it forgot joins the branch of the topic
 * before it — so no part of the recording drops out of the map. Returns null only when
 * the answer has no usable branch at all.
 */
export function groupTopics(raw: unknown, topics: RefNode[]): RefNode[] | null {
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  if (!Array.isArray(data.branches)) return null
  const owner = new Array<number>(topics.length).fill(-1)
  const drafts: Array<{ label: string; note: string }> = []
  for (const entry of data.branches) {
    if (!entry || typeof entry !== 'object') continue
    const branch = entry as Record<string, unknown>
    const label = cleanText(branch.label, LABEL_MAX_CHARS)
    const members = (indexList(branch.topics, topics.length) ?? []).filter((i) => owner[i] === -1)
    if (!label || members.length === 0) continue
    for (const i of members) owner[i] = drafts.length
    drafts.push({ label, note: cleanText(branch.note, NOTE_MAX_CHARS) })
  }
  if (drafts.length === 0) return null
  for (let i = 0; i < topics.length; i++) {
    if (owner[i] !== -1) continue
    const next = owner.find((o, j) => j > i && o !== -1)
    owner[i] = i > 0 ? owner[i - 1] : (next ?? 0)
  }
  const branches: RefNode[] = []
  drafts.forEach((draft, d) => {
    const members = topics.filter((_, i) => owner[i] === d)
    if (members.length === 0) return
    if (members.length === 1) {
      // A topic that stands on its own is the branch itself, not a branch with one child.
      branches.push(members[0])
      return
    }
    const node: RefNode = { label: draft.label, kind: 'topic', children: members.map(({ kind: _kind, ...rest }) => rest) }
    if (draft.note) node.note = draft.note
    spanChildren(node)
    branches.push(node)
  })
  branches.sort((a, b) => (a.from ?? Infinity) - (b.from ?? Infinity))
  return branches
}

/** The outcome items the merge call chose to keep (it drops repeats and settled questions); all of them when it gave no usable list. */
export function keepListed(raw: unknown, items: RefNode[]): RefNode[] {
  const kept = indexList(raw, items.length)
  return kept ? kept.map((i) => items[i]) : items
}

export function resolveBranchLabels(language: string, raw: unknown): BranchLabels {
  const fixed = OUTCOME_LABELS[language]
  if (fixed) return fixed
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    decisions: cleanText(data.decisions, 40) || OUTCOME_LABELS.en.decisions,
    actions: cleanText(data.actions, 40) || OUTCOME_LABELS.en.actions,
    questions: cleanText(data.questions, 40) || OUTCOME_LABELS.en.questions
  }
}

export function cleanTitle(value: unknown): string {
  return cleanText(value, LABEL_MAX_CHARS)
}

export function cleanNote(value: unknown): string {
  return cleanText(value, NOTE_MAX_CHARS)
}

/** Puts the finished map together: topic branches in time order, then the outcome branches that have items. */
export function assembleMindMap(input: {
  title: string
  note: string
  branches: RefNode[]
  decisions: RefNode[]
  actions: RefNode[]
  questions: RefNode[]
  labels: BranchLabels
  lines: TranscriptLine[]
  language: string
  generatedAt: string
}): MeetingMindMap {
  const byRef = new Map(input.lines.map((l) => [l.ref, l]))
  const toNode = (ref: RefNode): MindMapNode => {
    const node: MindMapNode = { label: ref.label, children: ref.children.map(toNode) }
    if (ref.note) node.note = ref.note
    if (ref.kind) node.kind = ref.kind
    if (ref.owner) node.owner = ref.owner
    if (ref.due) node.due = ref.due
    const from = ref.from !== undefined ? byRef.get(ref.from) : undefined
    const to = ref.to !== undefined ? byRef.get(ref.to) : undefined
    if (from && to) {
      node.startSegmentId = from.firstSegmentId
      node.endSegmentId = to.lastSegmentId
    }
    return node
  }
  const outcome = (kind: MindMapBranchKind, label: string, items: RefNode[]): RefNode[] => {
    if (items.length === 0) return []
    const branch: RefNode = { label, kind, children: items }
    spanChildren(branch)
    return [branch]
  }
  const map: MeetingMindMap = {
    title: input.title,
    branches: [
      ...input.branches,
      ...outcome('decisions', input.labels.decisions, input.decisions),
      ...outcome('actions', input.labels.actions, input.actions),
      ...outcome('questions', input.labels.questions, input.questions)
    ].map(toNode),
    language: input.language,
    generatedAt: input.generatedAt
  }
  if (input.note) map.note = input.note
  return map
}
