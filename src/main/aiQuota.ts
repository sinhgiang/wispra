import type { AiQuotaNotice } from '@shared/types'

/**
 * Wispra Cloud's monthly allowance for AI text features (dictation cleanup, meeting
 * summary, content tabs, chat, mind map — everything that goes through the proxy's
 * /api/chat/completions). When it is used up the server answers HTTP 402 with
 * `code: "ai_quota_exceeded"`; this module recognises that answer on every chat call
 * (see `fetch` below, used by postprocess.ts and mindMap.ts) and remembers it so the
 * app can explain what happened instead of showing a generic failure.
 *
 * Users with their own Groq/OpenAI key or a local server never get that answer, so
 * nothing here applies to them. No Electron imports: index.ts wires the broadcast and
 * the dictation notification.
 */

/** Machine-readable code the server sends with HTTP 402. Never match on the error sentence. */
const QUOTA_EXCEEDED_CODE = 'ai_quota_exceeded'
/**
 * While the allowance is known to be used up, dictation skips its cleanup call (the
 * text is typed as dictated either way). One call is let through this often, so an
 * upgrade or a reset is noticed without the user doing anything.
 */
const RECHECK_MS = 10 * 60_000

/** 00:00 UTC on the 1st of next month — when the server resets, used if it did not say. */
function nextMonthIso(now: number): string {
  const d = new Date(now)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString()
}

/** The notice in a 402 answer's body, or null when the body is not the quota error. */
function parseNotice(body: unknown, now: number): AiQuotaNotice | null {
  if (!body || typeof body !== 'object') return null
  const data = body as Record<string, unknown>
  if (data.code !== QUOTA_EXCEEDED_CODE) return null
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)
  const resetAt = typeof data.resetAt === 'string' && !Number.isNaN(Date.parse(data.resetAt)) ? data.resetAt : nextMonthIso(now)
  return {
    plan: data.plan === 'pro' ? 'pro' : 'free',
    limitTokens: num(data.limitTokens),
    usedTokens: num(data.usedTokens),
    resetAt,
    seenAt: now
  }
}

class AiQuota {
  private notice: AiQuotaNotice | null = null
  private listeners = new Set<(notice: AiQuotaNotice | null) => void>()
  /** `resetAt` of the quota period the dictation notification was already shown for. */
  private announcedPeriod: string | null = null

  /** The latest "allowance used up" answer, or null if there is none or its month is over. */
  current(now = Date.now()): AiQuotaNotice | null {
    if (this.notice && now >= Date.parse(this.notice.resetAt)) this.set(null)
    return this.notice
  }

  /** True if a quota answer arrived at or after `since` (ms) — i.e. the call started then failed for this reason. */
  exceededSince(since: number): boolean {
    const notice = this.current()
    return notice !== null && notice.seenAt >= since
  }

  /** Dictation: is a cleanup call pointless right now? */
  shouldSkipCleanup(now = Date.now()): boolean {
    const notice = this.current(now)
    return notice !== null && now - notice.seenAt < RECHECK_MS
  }

  /**
   * Dictation tells the user once per quota period per app run that cleanup is paused.
   * Returns the notice the first time, null afterwards.
   */
  claimDictationNotice(): AiQuotaNotice | null {
    const notice = this.current()
    if (!notice || this.announcedPeriod === notice.resetAt) return null
    this.announcedPeriod = notice.resetAt
    return notice
  }

  /** Forget the notice: the account changed, the provider changed, or the server says there is allowance again. */
  clear(): void {
    if (this.notice) this.set(null)
  }

  onChange(fn: (notice: AiQuotaNotice | null) => void): void {
    this.listeners.add(fn)
  }

  /**
   * `fetch` for chat-completion calls. Returns the response untouched — callers keep
   * their own failure handling (and must not retry a 402) — but records a quota answer,
   * and forgets an old one as soon as a call succeeds again.
   */
  async fetch(url: string, init: RequestInit): Promise<Response> {
    const startedAt = Date.now()
    const response = await fetch(url, init)
    if (response.status === 402) {
      const notice = parseNotice(await response.clone().json().catch(() => null), Date.now())
      if (notice) this.set(notice)
    } else if (response.ok && this.notice && startedAt > this.notice.seenAt) {
      // Only a call that began after the notice proves there is allowance again; one
      // that was already in flight (e.g. another part of the same mind map) does not.
      this.clear()
    }
    return response
  }

  private set(notice: AiQuotaNotice | null): void {
    this.notice = notice
    for (const fn of this.listeners) fn(notice)
  }
}

export const aiQuota = new AiQuota()
