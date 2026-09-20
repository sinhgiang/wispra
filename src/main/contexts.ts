import { SUGGEST_MAX_SESSIONS } from '@shared/constants'
import { indexText, joinIndexes, relevanceOver } from './contextLogic'
import { history } from './history'
import { meetingSessions } from './meetingSessions'

/**
 * A space's text is re-read at most this often. Listing sessions parses every session file, and a
 * long meeting asks for terms every ~20 seconds; a meeting finished a minute ago barely changes
 * which terms matter in the space.
 */
const SPACE_CACHE_MS = 5 * 60_000

/**
 * Which learned terms matter where. A context is the app Wispra is typing into (its History) or the
 * Meeting Space a meeting is filed under (its finished meetings). Read-only: it only reads History
 * and meeting sessions, and keeps nothing on disk.
 */
class Contexts {
  /** A finished meeting's transcript never changes, so it is normalized once. */
  private sessionIndex = new Map<string, string>()
  private spaceCache = new Map<string, { at: number; parts: string[] }>()

  /**
   * Scores a term by how much the user has written it in this context, or undefined when there is no
   * context to go by. The text is only read when the scorer is first used — selectTerms never calls
   * it when every term fits in the prompt anyway.
   */
  relevance(ctx: { app?: string; spaceId?: string }): ((term: string) => number) | undefined {
    if (!ctx.app && !ctx.spaceId) return undefined
    let score: ((term: string) => number) | null = null
    return (term) => {
      score ??= relevanceOver(this.indexFor(ctx))
      return score(term)
    }
  }

  private indexFor(ctx: { app?: string; spaceId?: string }): string {
    const parts: string[] = []
    if (ctx.app) {
      for (const e of history.list()) if (e.app === ctx.app) parts.push(indexText(e.text))
    }
    if (ctx.spaceId) parts.push(...this.spaceIndexes(ctx.spaceId))
    return joinIndexes(parts)
  }

  private spaceIndexes(spaceId: string): string[] {
    const cached = this.spaceCache.get(spaceId)
    if (cached && Date.now() - cached.at < SPACE_CACHE_MS) return cached.parts

    const all = meetingSessions.list()
    const known = new Set(all.map((s) => s.id))
    for (const id of this.sessionIndex.keys()) if (!known.has(id)) this.sessionIndex.delete(id)

    const parts: string[] = []
    const inSpace = all.filter((s) => s.spaceId === spaceId && s.status === 'stopped').slice(0, SUGGEST_MAX_SESSIONS)
    for (const { id } of inSpace) {
      if (!this.sessionIndex.has(id)) {
        const session = meetingSessions.get(id)
        this.sessionIndex.set(id, session ? indexText(session.segments.map((seg) => seg.text).join(' ')) : '')
      }
      parts.push(this.sessionIndex.get(id) ?? '')
    }
    this.spaceCache.set(spaceId, { at: Date.now(), parts })
    return parts
  }
}

export const contexts = new Contexts()
