import { useState } from 'react'
import type { Settings } from '@shared/types'

const DISMISS_KEY = 'wispra_onboarding_dismissed'

export function OnboardingBanner({ settings }: { settings: Settings }): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState(() => {
    return localStorage.getItem(DISMISS_KEY) === '1'
  })

  const hasKey = !!(settings.groqApiKey || settings.openaiApiKey || settings.provider === 'local')

  if (hasKey || dismissed) return null

  function dismiss(): void {
    localStorage.setItem(DISMISS_KEY, '1')
    setDismissed(true)
  }

  return (
    <div className="onboarding-banner">
      <button className="onboarding-close" onClick={dismiss} aria-label="Dismiss">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      <div className="onboarding-title">
        Welcome to Wispra
        <span className="onboarding-sub">
          Voice dictation in any app — supports Vietnamese, English &amp; 95+ languages
        </span>
      </div>

      <ol className="onboarding-steps">
        <li>
          <span className="step-num">1</span>
          <div className="step-body">
            <span className="step-label">Choose Groq below</span>
            <span className="step-desc">Free tier, fastest speed, no credit card needed</span>
          </div>
        </li>
        <li>
          <span className="step-num">2</span>
          <div className="step-body">
            <span className="step-label">Create your free API key</span>
            <span className="step-desc">
              <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">
                console.groq.com/keys ↗
              </a>
              {' '}— sign in with Google, copy the key
            </span>
          </div>
        </li>
        <li>
          <span className="step-num">3</span>
          <div className="step-body">
            <span className="step-label">Paste the key and click Save &amp; Test</span>
            <span className="step-desc">
              Then press <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>Space</kbd> anywhere to dictate.
              {' '}Enable <strong>AI cleanup</strong> + <strong>Vietnamese mode</strong> for best results.
            </span>
          </div>
        </li>
      </ol>
    </div>
  )
}
