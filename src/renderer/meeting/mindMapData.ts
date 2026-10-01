import type { MeetingMindMap, MeetingSegment, MindMapBranchKind, MindMapNode } from '@shared/types'

/**
 * Turns a session's stored MeetingMindMap into the tree the Mind map tab draws (see
 * mindMapRenderer.ts) and exports. Everything the map shows comes from the stored map
 * itself — already written in the map's language — or is language-neutral (times), so
 * the picture and its exports never mix in app-UI English.
 */
export interface MindMapTreeNode {
  label: string
  note?: string
  /** Small second line on the node: a time range, or who/when for an action item. */
  sub?: string
  kind?: MindMapBranchKind | 'root'
  /** Main branches only: colour (oklch hue) and which side of the centre it sits on. */
  hue?: number
  side?: 1 | -1
  owner?: string
  due?: string
  /** Transcript stretch the node is about — absent when the model gave no usable range. */
  startSegmentId?: string
  endSegmentId?: string
  startMs?: number
  endMs?: number
  children: MindMapTreeNode[]
}

const TOPIC_HUES = [262, 232, 205, 172, 300, 335, 248, 190, 318]
const OUTCOME_HUES: Record<Exclude<MindMapBranchKind, 'topic'>, number> = { decisions: 150, actions: 65, questions: 28 }

/** "mm:ss" (or "h:mm:ss" from one hour on) — same format as the transcript's paragraph times. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

export function buildMindMapTree(map: MeetingMindMap, segments: MeetingSegment[], durationMs: number): MindMapTreeNode {
  const byId = new Map(segments.map((s) => [s.id, s]))

  const convert = (node: MindMapNode, depth: number, branchKind: MindMapBranchKind): MindMapTreeNode => {
    const kind = depth === 1 ? (node.kind ?? 'topic') : branchKind
    const out: MindMapTreeNode = { label: node.label, children: node.children.map((c) => convert(c, depth + 1, kind)) }
    if (node.note) out.note = node.note
    if (depth === 1) out.kind = kind
    if (node.owner) out.owner = node.owner
    if (node.due) out.due = node.due
    const start = node.startSegmentId ? byId.get(node.startSegmentId) : undefined
    const end = node.endSegmentId ? byId.get(node.endSegmentId) : undefined
    if (start && end) {
      out.startSegmentId = start.id
      out.endSegmentId = end.id
      out.startMs = start.startMs
      out.endMs = Math.max(end.endMs, start.startMs)
    }
    if (depth === 1 && kind === 'topic' && out.startMs !== undefined && out.endMs !== undefined) {
      out.sub = `${formatElapsed(out.startMs)} – ${formatElapsed(out.endMs)}`
    } else if (kind === 'actions' && depth > 1) {
      const people = [node.owner, node.due].filter(Boolean).join(' · ')
      if (people) out.sub = people
    }
    return out
  }

  const branches = map.branches.map((b) => convert(b, 1, 'topic'))
  const topics = branches.filter((b) => b.kind === 'topic')
  const outcomes = branches.filter((b) => b.kind !== 'topic')
  topics.forEach((b, i) => {
    b.hue = TOPIC_HUES[i % TOPIC_HUES.length]
    // Topics read down the right side and outcomes sit on the left; with no outcomes
    // the second half of the topics moves left so the map stays balanced.
    b.side = outcomes.length === 0 && topics.length >= 4 && i >= Math.ceil(topics.length / 2) ? -1 : 1
  })
  for (const b of outcomes) {
    b.hue = OUTCOME_HUES[b.kind as Exclude<MindMapBranchKind, 'topic'>]
    b.side = -1
  }

  const root: MindMapTreeNode = { label: map.title, kind: 'root', children: [...topics, ...outcomes] }
  if (map.note) root.note = map.note
  if (durationMs > 0) {
    root.sub = formatElapsed(durationMs)
    root.startMs = 0
    root.endMs = durationMs
  }
  return root
}

/** The whole map as a nested Markdown list (every level, whatever is expanded on screen). */
export function mindMapMarkdown(tree: MindMapTreeNode, dateLabel: string): string {
  const meta = [dateLabel, tree.endMs ? formatElapsed(tree.endMs) : ''].filter(Boolean).join(' · ')
  const lines = [`# ${tree.label}`, '']
  if (meta) lines.push(`_${meta}_`, '')
  for (const branch of tree.children) {
    lines.push(branch.sub ? `## ${branch.label} (${branch.sub})` : `## ${branch.label}`)
    const walk = (nodes: MindMapTreeNode[], indent: number): void => {
      for (const node of nodes) {
        const people = [node.owner, node.due].filter(Boolean).join(', ')
        const box = branch.kind === 'actions' && indent === 0 ? '[ ] ' : ''
        const time = node.startMs !== undefined ? ` [${formatElapsed(node.startMs)}]` : ''
        lines.push(`${'  '.repeat(indent)}- ${box}${node.label}${people ? ` — ${people}` : ''}${time}`)
        walk(node.children, indent + 1)
      }
    }
    walk(branch.children, 0)
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}
