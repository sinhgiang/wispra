import type { DailyLimitInfo } from '@shared/types'

/**
 * What the Mind map, Transcript and Website / social tabs say when the AI provider's
 * DAILY limit is reached (Groq's "tokens per day" / "requests per day"). Unlike the
 * per-minute limit, nothing waits it out: it can take hours to clear.
 */

/** "about 18 min", "about 2 h 5 min", "a moment". */
function inAbout(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'a moment'
  if (minutes < 60) return `about ${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `about ${hours} h ${rest} min` : `about ${hours} h`
}

/**
 * The sentence with the numbers: "The AI provider's daily limit is reached: 198,051 of
 * 200,000 tokens used today. It resets in about 18 min (at 7:42 PM)."
 */
export function dailyLimitText(info: DailyLimitInfo, now = Date.now()): string {
  const unit = info.unit === 'requests' ? 'requests' : 'tokens'
  const numbers =
    info.used !== undefined && info.limit !== undefined
      ? ` ${info.used.toLocaleString()} of ${info.limit.toLocaleString()} ${unit} used today.`
      : ` The ${unit} allowed per day are used up.`
  const at = new Date(info.resetAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const reset = info.resetAt > now ? ` It resets in ${inAbout(info.resetAt - now)} (at ${at}).` : ' It should have reset by now.'
  return `The AI provider's daily limit is reached:${numbers}${reset}`
}

/** What to do about it; `action` is the button the tab offers ("Continue", "Try again"). */
export function dailyLimitAdvice(info: DailyLimitInfo, action: string): string {
  return info.viaCloud
    ? `Wait until then and press ${action}.`
    : `Wait until then and press ${action} — or choose "Use Wispra Cloud" on the Account tab.`
}
