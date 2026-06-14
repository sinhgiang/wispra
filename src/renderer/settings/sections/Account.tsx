import type { Settings } from '@shared/types'

const PRO_FEATURES = [
  'Unlimited transcription minutes (cloud-managed key)',
  'Priority Whisper processing queue',
  'Team sharing & collaboration',
  'Advanced analytics & usage reports'
]

export function AccountSection({ settings }: { settings: Settings }): React.JSX.Element {
  const hasByokKey = !!(settings.groqApiKey || settings.openaiApiKey)
  const isLocal = settings.provider === 'local'

  return (
    <section>
      <h2>Account</h2>

      <div className="plan-card plan-byok">
        <div className="plan-header">
          <span className="plan-name">BYOK — Free forever</span>
          <span className="plan-badge">Active</span>
        </div>
        <p className="plan-desc">
          {isLocal
            ? 'Running on your local server — no cloud costs.'
            : hasByokKey
            ? 'Using your own API key. You pay your provider directly at cost price.'
            : 'Add your API key in the Speech Recognition section to start dictating.'}
        </p>
      </div>

      <div className="plan-card plan-pro">
        <div className="plan-header">
          <span className="plan-name">Wispra Pro</span>
          <span className="plan-badge plan-badge-soon">Coming soon</span>
        </div>
        <p className="plan-desc" style={{ marginBottom: '10px' }}>
          From <strong>$6 / month</strong> or <strong>$49 / year</strong> — no API key needed.
        </p>
        <ul className="plan-features">
          {PRO_FEATURES.map((f) => (
            <li key={f}>
              <CheckIcon /> {f}
            </li>
          ))}
        </ul>
        <button
          className="primary"
          style={{ marginTop: '12px', opacity: 0.7, cursor: 'not-allowed' }}
          disabled
        >
          Notify me when available
        </button>
      </div>
    </section>
  )
}

function CheckIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="6.5" cy="6.5" r="6.5" fill="var(--ok)" fillOpacity="0.15" />
      <path d="M3.5 6.5L5.5 8.5L9.5 4.5" stroke="var(--ok)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
