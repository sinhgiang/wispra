import { FREE_LIMIT_SECONDS } from '@shared/constants'
import type { AccountInfo } from '@shared/types'

/**
 * Turns Wispra Cloud's GET /api/usage answer into what the Account page shows. Pure.
 *
 * The server sends `unlimited: true` for accounts exempt from the monthly limits (whatever
 * their plan), and `null` for a limit that does not apply (`limitSeconds` for Pro or
 * unlimited, `aiTokensLimit` for unlimited). A null limit is passed on as "no maximum" —
 * never replaced by the Free plan's numbers.
 */
export function accountInfoFrom(data: unknown, user: { email: string; avatarUrl?: string }): AccountInfo {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
  const unlimited = d.unlimited === true
  const plan = d.plan === 'pro' ? 'pro' : 'free'
  const info: AccountInfo = {
    email: user.email,
    avatarUrl: user.avatarUrl,
    plan,
    usageSeconds: num(d.usageSeconds) ?? 0,
    // An older server that leaves the field out: the Free plan's minutes, unless the account has no limit.
    limitSeconds: d.limitSeconds === null || unlimited || plan === 'pro' ? null : (num(d.limitSeconds) ?? FREE_LIMIT_SECONDS),
    subscribeUrl: typeof d.subscribeUrl === 'string' ? d.subscribeUrl : null
  }
  if (unlimited) info.unlimited = true
  const used = num(d.aiTokensUsed)
  if (used !== undefined) {
    info.aiTokensUsed = used
    const limit = num(d.aiTokensLimit)
    if (limit !== undefined && limit > 0 && !unlimited) info.aiTokensLimit = limit
    if (typeof d.aiTokensResetAt === 'string') info.aiTokensResetAt = d.aiTokensResetAt
  }
  return info
}

/** Whether the account still has AI text allowance left (no limit counts as left). */
export function hasAiAllowanceLeft(info: AccountInfo): boolean {
  return info.aiTokensLimit === undefined || (info.aiTokensUsed ?? 0) < info.aiTokensLimit
}
