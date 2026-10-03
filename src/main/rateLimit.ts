import type { DailyLimitInfo } from '@shared/types'

/**
 * Reading an AI provider's "too many requests" answer (HTTP 429). Groq has limits per
 * minute (tokens and requests per minute — TPM/RPM, cleared within a minute, worth
 * waiting out) and per day (TPD/RPD — can take hours to clear, so waiting is pointless:
 * the user is told instead). Its message says which, with the numbers:
 *
 *   "Rate limit reached for model `openai/gpt-oss-120b` … on tokens per day (TPD):
 *    Limit 200000, Used 198051, Requested 4320. Please try again in 18m12.288s. …"
 *
 * The Wispra Cloud proxy passes that message on (as a string inside its own "error"), but
 * not Groq's headers — so the message is read first and `retry-after` only fills in the wait.
 */

export interface RateLimitInfo {
  scope: 'minute' | 'day'
  unit?: 'tokens' | 'requests' | 'neurons'
  limit?: number
  used?: number
  /** How long the provider asks to wait (ms). */
  retryAfterMs: number
}

/**
 * Cloudflare Workers AI's free plan ends for the day with an error about the "daily free
 * allocation" of neurons (wording taken from its documentation's description; the exact
 * text of a live answer has not been seen). It resets at 00:00 UTC.
 */
const DAILY_ALLOCATION = /daily (?:free )?allocation|\bneurons?\b/i

/** True when an error answer (any status) is a daily allocation running out. */
export function isDailyAllocation(body: string): boolean {
  return DAILY_ALLOCATION.test(providerMessage(body))
}

/** The next 00:00 UTC, ms from now. */
function untilUtcMidnight(now = Date.now()): number {
  const next = new Date(now)
  next.setUTCHours(24, 0, 0, 0)
  return next.getTime() - now
}

/** A wait this long can only be a daily limit, even when the message does not say so. */
const DAY_SCOPE_MIN_WAIT_MS = 5 * 60_000

/** The provider's message inside an error body: {"error": {"message": "…"}}, {"error": "…"} (the Wispra Cloud proxy), or the text itself. */
export function providerMessage(body: string): string {
  try {
    const error = (JSON.parse(body) as { error?: unknown })?.error
    if (typeof error === 'string') return providerMessage(error)
    const message = (error as { message?: unknown } | undefined)?.message
    if (typeof message === 'string') return message
  } catch {
    /* not JSON — the text is the message */
  }
  return body
}

/** "try again in 18m12.288s" / "in 1h2m3s" / "in 7.5s" → ms; undefined when the message gives no time. */
function waitFromMessage(message: string): number | undefined {
  const m = /try again in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?/i.exec(message)
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined
  return Math.round(((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000)
}

/** Reads a 429 answer: per-minute or per-day, which unit, the numbers, and how long to wait. */
export function parseRateLimit(retryAfter: string | null, body: string): RateLimitInfo {
  const message = providerMessage(body)
  const header = Number(retryAfter)
  const allocation = DAILY_ALLOCATION.test(message)
  const retryAfterMs =
    Number.isFinite(header) && header > 0 ? header * 1000 : (waitFromMessage(message) ?? (allocation ? untilUtcMidnight() : 5000))
  const named = /per day|\((?:TPD|RPD)\)|daily/i.test(message) ? 'day' : /per minute|\((?:TPM|RPM)\)/i.test(message) ? 'minute' : null
  const scope = named ?? (retryAfterMs >= DAY_SCOPE_MIN_WAIT_MS ? 'day' : 'minute')
  const unit = /tokens per|\(TP[MD]\)/i.test(message)
    ? 'tokens'
    : /requests per|\(RP[MD]\)/i.test(message)
      ? 'requests'
      : /\bneurons?\b/i.test(message)
        ? 'neurons'
        : undefined
  const numbers = /Limit\s*:?\s*(\d+)\s*,\s*Used\s*:?\s*(\d+)/i.exec(message)
  const info: RateLimitInfo = { scope, retryAfterMs }
  if (unit) info.unit = unit
  if (numbers) {
    info.limit = Number(numbers[1])
    info.used = Number(numbers[2])
  }
  return info
}

/** What the UI is told about a daily limit: the numbers, when it resets, and which route hit it. */
export function dailyLimitInfo(info: RateLimitInfo, viaCloud: boolean, now = Date.now()): DailyLimitInfo {
  const daily: DailyLimitInfo = { unit: info.unit ?? 'tokens', resetAt: now + info.retryAfterMs, viaCloud }
  if (info.used !== undefined) daily.used = info.used
  if (info.limit !== undefined) daily.limit = info.limit
  return daily
}
