import { useState } from 'react'
import type { Settings } from '@shared/types'

const DISMISS_KEY = 'wispra_onboarding_v2'

type Step = 'welcome' | 'apikey' | 'done'

export function OnboardingBanner({ settings }: { settings: Settings }): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1')
  const [step, setStep] = useState<Step>('welcome')
  const [key, setKey] = useState('')
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'busy'; text: string } | null>(null)

  const hasKey = !!(settings.groqApiKey || settings.openaiApiKey || settings.provider === 'local')
  if (hasKey || dismissed) return null

  function dismiss(): void {
    localStorage.setItem(DISMISS_KEY, '1')
    setDismissed(true)
  }

  async function saveKey(): Promise<void> {
    const trimmed = key.trim()
    if (!trimmed) return
    setStatus({ kind: 'busy', text: 'Testing key…' })
    const result = await window.api.testApiKey('groq', trimmed)
    if (result.ok) {
      await window.api.setSettings({ groqApiKey: trimmed, provider: 'groq' })
      setStatus({ kind: 'ok', text: 'Key saved and verified' })
      setTimeout(() => setStep('done'), 700)
    } else {
      setStatus({ kind: 'err', text: result.error ?? 'Key test failed.' })
    }
  }

  const hotkeyKeys = (settings.hotkey ?? 'Ctrl+Shift+Space').split('+')

  return (
    <div className="modal-overlay">
      <div className="modal onboarding-wizard">

        {/* ── Step: Welcome ── */}
        {step === 'welcome' && (
          <div className="ob-center">
            <div className="ob-icon-wrap ob-icon-brand">
              <MicIcon />
            </div>
            <h2 className="ob-title">Welcome to Wispra</h2>
            <p className="ob-subtitle">
              Voice dictation in any app — Notepad, Chrome, VS Code, Slack.
              Let's get you set up in 60 seconds.
            </p>
            <ol className="ob-steps">
              {[
                'Get a free Groq API key',
                'Press your hotkey anywhere',
                'Speak — text appears instantly',
              ].map((text, i) => (
                <li key={i} className="ob-step-item">
                  <span className="ob-step-num">{i + 1}</span>
                  <span className="ob-step-text">{text}</span>
                </li>
              ))}
            </ol>
            <div className="ob-actions">
              <button className="primary ob-btn-main" onClick={() => setStep('apikey')}>
                Get Started →
              </button>
              <button className="ob-btn-skip" onClick={dismiss}>Skip</button>
            </div>
          </div>
        )}

        {/* ── Step: API key ── */}
        {step === 'apikey' && (
          <>
            <div className="modal-header">
              <div className="ob-step-indicator">
                <span className="ob-step-dot active" />
                <span className="ob-step-dot" />
              </div>
              <span className="ob-step-title">Add your Groq API key</span>
              <button className="icon-btn" onClick={dismiss} aria-label="Skip setup">
                <CloseIcon />
              </button>
            </div>

            <div className="modal-body">
              <p className="ob-body-hint">
                Groq is free — no credit card needed. Create your key at{' '}
                <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">
                  console.groq.com/keys
                </a>
                , then paste it below.
              </p>

              <div className="ob-key-row">
                <input
                  type="password"
                  value={key}
                  placeholder="gsk_…"
                  autoFocus
                  spellCheck={false}
                  style={{ flex: 1, maxWidth: '100%' }}
                  onChange={(e) => { setKey(e.target.value); setStatus(null) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && key.trim()) void saveKey() }}
                />
                <button
                  className="primary"
                  onClick={() => void saveKey()}
                  disabled={!key.trim() || status?.kind === 'busy'}
                >
                  {status?.kind === 'busy' ? 'Testing…' : 'Save & Test'}
                </button>
              </div>

              {status && <p className={`status ${status.kind}`}>{status.text}</p>}
            </div>

            <div className="modal-footer">
              <button onClick={dismiss}>Skip for now</button>
            </div>
          </>
        )}

        {/* ── Step: Done ── */}
        {step === 'done' && (
          <div className="ob-center">
            <div className="ob-icon-wrap ob-icon-ok">
              <CheckIcon />
            </div>
            <h2 className="ob-title">You're all set!</h2>
            <p className="ob-subtitle">
              Focus any app — then press your hotkey to start dictating.
            </p>

            <div className="ob-hotkey-display">
              {hotkeyKeys.map((k, i) => (
                <span key={i} className="ob-hotkey-item">
                  <kbd>{k}</kbd>
                  {i < hotkeyKeys.length - 1 && <span className="ob-plus">+</span>}
                </span>
              ))}
            </div>

            <p className="ob-done-tip">
              Works in any text field. Your clipboard is never affected.
            </p>

            <div className="ob-actions">
              <button className="primary ob-btn-main" onClick={dismiss}>
                Start Wispra
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}

function MicIcon(): React.JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="white">
      <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3z" />
      <path d="M18 11a1 1 0 1 0-2 0 4 4 0 1 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.92V19H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.08A6 6 0 0 0 18 11z" />
    </svg>
  )
}

function CheckIcon(): React.JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
