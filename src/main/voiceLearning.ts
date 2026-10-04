import type { MeetingSession } from '@shared/types'

/**
 * Which names a session teaches speaker recognition, and from which segments: what the user
 * typed on a paragraph (a typed name, or a removed label, always wins), and otherwise who the
 * transcript says is speaking (the outline's speakers — a self-introduction). Never a name
 * that was itself recognised by voice (MeetingSegment.voiceName). Pure.
 */
export function namesToLearn(session: Pick<MeetingSession, 'segments' | 'speakerNames' | 'outline'>): Map<string, string[]> {
  const paragraphOf = new Map<string, string>()
  let paragraph = ''
  for (const segment of session.segments) {
    if (segment.isNewParagraph || !paragraph) paragraph = segment.id
    paragraphOf.set(segment.id, paragraph)
  }
  const byName = new Map<string, string[]>()
  const add = (name: string, segmentId: string): void => {
    byName.set(name, [...(byName.get(name) ?? []), segmentId])
  }
  const typed = session.speakerNames ?? {}
  for (const segment of session.segments) {
    const name = typed[paragraphOf.get(segment.id)!]
    if (name) add(name, segment.id)
  }
  const index = new Map(session.segments.map((s, i) => [s.id, i]))
  for (const speaker of session.outline?.speakers ?? []) {
    const from = index.get(speaker.startSegmentId)
    const to = index.get(speaker.endSegmentId)
    if (from === undefined || to === undefined) continue
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
      const segment = session.segments[i]
      if (typed[paragraphOf.get(segment.id)!] === undefined) add(speaker.name, segment.id)
    }
  }
  return byName
}
