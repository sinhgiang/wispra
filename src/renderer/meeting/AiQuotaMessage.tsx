import type { ReactElement } from 'react'
import type { AiQuotaNotice } from '@shared/types'

/** "October 1" in the user's locale — the day the monthly allowance resets. */
export function formatQuotaReset(resetAt: string): string {
  return new Date(resetAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
}

/**
 * Shown wherever an AI text feature (summary, content tabs, chat, mind map) could not
 * run because this month's Wispra Cloud AI allowance is used up (see AiQuotaNotice):
 * says so, when it resets, and what the user can do now. `subscribeUrl` is the Pro
 * checkout link from the account info, when there is one.
 */
export function AiQuotaMessage({
  notice,
  subscribeUrl
}: {
  notice: AiQuotaNotice
  subscribeUrl?: string | null
}): ReactElement {
  const usage =
    notice.limitTokens > 0
      ? `${notice.usedTokens.toLocaleString()} of ${notice.limitTokens.toLocaleString()} tokens used on the ${notice.plan === 'pro' ? 'Pro' : 'Free'} plan. `
      : ''
  return (
    <div className="ai-quota-message" role="status">
      <strong>You've used all of this month's AI allowance.</strong>
      <span>
        {usage}It resets on {formatQuotaReset(notice.resetAt)}.
      </span>
      <span>
        To keep going now:{' '}
        {notice.plan === 'free' && (
          <>
            {subscribeUrl ? (
              <a href={subscribeUrl} target="_blank" rel="noreferrer">
                upgrade to Pro
              </a>
            ) : (
              'upgrade to Pro (Account tab)'
            )}
            , or{' '}
          </>
        )}
        sign out in the Account tab and use your own Groq API key.
      </span>
    </div>
  )
}
