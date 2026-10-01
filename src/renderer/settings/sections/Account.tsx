import { useEffect, useState } from 'react'
import type { AccountInfo, McpLinkStatus, Settings, SyncStatus } from '@shared/types'

const FREE_LIMIT_SECONDS = 30 * 60

function formatMinutes(seconds: number): string {
  return (seconds / 60).toFixed(1)
}

function formatSyncStatus(status: SyncStatus | null): string | null {
  if (!status) return null
  if (status.syncing) return 'Syncing…'
  if (status.lastError) return 'Sync failed — will retry'
  if (status.lastSyncedAt) return `Last synced ${new Date(status.lastSyncedAt).toLocaleString()}`
  return null
}

export function AccountSection({ settings }: { settings: Settings }): React.JSX.Element {
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null | 'loading'>('loading')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const [mcpStatus, setMcpStatus] = useState<McpLinkStatus | null>(null)
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpCopied, setMcpCopied] = useState(false)

  useEffect(() => {
    void window.api.getAccountInfo().then((info) => {
      setAccountInfo(info)
      setIsLoggedIn(info !== null)
    })

    window.api.onAuthStateChanged((state) => {
      setIsLoggedIn(state !== null)
      if (!state) {
        setAccountInfo(null)
      } else {
        void window.api.getAccountInfo().then(setAccountInfo)
      }
    })

    void window.api.getSyncStatus().then(setSyncStatus)
    window.api.onSyncStatusChanged(setSyncStatus)
  }, [])

  useEffect(() => {
    if (isLoggedIn && settings.cloudSyncEnabled) {
      void window.api.getMcpLink().then(setMcpStatus)
    }
  }, [isLoggedIn, settings.cloudSyncEnabled])

  async function handleSyncNow(): Promise<void> {
    setSyncBusy(true)
    try {
      setSyncStatus(await window.api.syncNow())
    } finally {
      setSyncBusy(false)
    }
  }

  async function handleGenerateMcpLink(confirmMessage?: string): Promise<void> {
    if (confirmMessage && !window.confirm(confirmMessage)) return
    setMcpBusy(true)
    try {
      setMcpStatus(await window.api.generateMcpLink())
      setMcpCopied(false)
    } finally {
      setMcpBusy(false)
    }
  }

  async function handleRevokeMcpLink(): Promise<void> {
    if (!window.confirm('Revoke this connection? Any AI assistant using this link will stop being able to read your data.')) return
    setMcpBusy(true)
    try {
      setMcpStatus(await window.api.revokeMcpLink())
    } finally {
      setMcpBusy(false)
    }
  }

  function handleCopyMcpLink(): void {
    if (!mcpStatus?.url) return
    window.api.copyText(mcpStatus.url)
    setMcpCopied(true)
    setTimeout(() => setMcpCopied(false), 2000)
  }

  async function handleLogin(): Promise<void> {
    setLoginBusy(true)
    try {
      await window.api.loginWithGoogle()
    } finally {
      setLoginBusy(false)
    }
  }

  async function handleLogout(): Promise<void> {
    setLogoutBusy(true)
    try {
      await window.api.logout()
      setAccountInfo(null)
    } finally {
      setLogoutBusy(false)
    }
  }

  return (
    <section>
      <h2>Account</h2>

      {/* ── Logged-out state ──────────────────────────────────── */}
      {!isLoggedIn && (
        <>
          <div className="plan-card plan-pro">
            <div className="plan-header">
              <span className="plan-name">Wispra Cloud</span>
              <span className="plan-badge" style={{ background: 'var(--accent)', color: 'white' }}>New</span>
            </div>
            <p className="plan-desc" style={{ marginBottom: '10px' }}>
              <strong>No API key needed.</strong> 30 free minutes/month — unlimited with Pro ($6/month).
              Sign in with Google to activate.
            </p>
            <button
              className="primary"
              style={{ marginTop: '4px', display: 'inline-flex', alignItems: 'center', gap: '7px' }}
              disabled={loginBusy}
              onClick={() => void handleLogin()}
            >
              <GoogleIcon />
              {loginBusy ? 'Opening browser…' : 'Sign in with Google'}
            </button>
          </div>
        </>
      )}

      {/* ── Loading state ─────────────────────────────────────── */}
      {isLoggedIn && accountInfo === 'loading' && (
        <div className="plan-card plan-byok">
          <p className="plan-desc" style={{ opacity: 0.5 }}>Loading account…</p>
        </div>
      )}

      {/* ── Logged-in state ───────────────────────────────────── */}
      {isLoggedIn && accountInfo !== null && accountInfo !== 'loading' && (
        <div
          className="plan-card"
          style={{
            borderColor: accountInfo.plan === 'pro' ? 'var(--accent)' : 'var(--border)',
            background: accountInfo.plan === 'pro' ? 'var(--accent-subtle)' : 'var(--surface)',
          }}
        >
          <div className="plan-header">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-2)' }}>{accountInfo.email}</span>
              <span className="plan-name">
                {accountInfo.plan === 'pro' ? 'Wispra Pro' : 'Wispra Free'}
              </span>
            </div>
            <span
              className="plan-badge"
              style={accountInfo.plan === 'pro' ? { background: 'var(--accent)', color: 'white' } : {}}
            >
              {accountInfo.plan === 'pro' ? 'Pro' : 'Free'}
            </span>
          </div>

          {/* Usage bar (free plan only) */}
          {accountInfo.plan === 'free' && (
            <div className="usage-bar-wrap">
              <div className="usage-bar-track">
                <div
                  className="usage-bar-fill"
                  style={{
                    width: `${Math.min(100, (accountInfo.usageSeconds / FREE_LIMIT_SECONDS) * 100)}%`,
                    background: accountInfo.usageSeconds >= FREE_LIMIT_SECONDS ? 'var(--danger)' : 'var(--accent)',
                  }}
                />
              </div>
              <span className="usage-bar-label">
                {formatMinutes(accountInfo.usageSeconds)} / 30 min used this month
              </span>
            </div>
          )}

          {accountInfo.plan === 'pro' && (
            <p className="plan-desc" style={{ marginTop: '8px' }}>
              Unlimited transcription, powered by Wispra cloud.
            </p>
          )}

          <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
            {accountInfo.plan === 'free' && accountInfo.subscribeUrl && (
              <a
                href={accountInfo.subscribeUrl}
                target="_blank"
                rel="noreferrer"
                className="primary"
                style={{
                  textDecoration: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  fontSize: '13px',
                  padding: '6px 14px',
                  borderRadius: 'var(--r-sm)',
                  background: 'var(--accent)',
                  color: 'white',
                }}
              >
                Upgrade to Pro — $6/month
              </a>
            )}
            <button
              onClick={() => void handleLogout()}
              disabled={logoutBusy}
              style={{ fontSize: '13px', color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer', padding: '0' }}
            >
              {logoutBusy ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      )}

      {/* ── Cloud sync ─────────────────────────────────────────── */}
      {isLoggedIn && (
        <div style={{ marginTop: '16px' }}>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.cloudSyncEnabled}
              onChange={(e) => void window.api.setSettings({ cloudSyncEnabled: e.target.checked })}
            />
            <div className="toggle-info">
              <span className="toggle-label">Sync to cloud</span>
              <span className="toggle-desc">
                Push your dictation history, meeting transcripts, and learned vocabulary to Wispra
                Cloud, so other tools can access them.
              </span>
            </div>
            <div className="toggle-switch" />
          </label>

          {settings.cloudSyncEnabled && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' }}>
              <button
                onClick={() => void handleSyncNow()}
                disabled={syncBusy || syncStatus?.syncing}
                style={{ fontSize: '13px', padding: '5px 12px', borderRadius: 'var(--r-sm)' }}
              >
                {syncBusy || syncStatus?.syncing ? 'Syncing…' : 'Sync now'}
              </button>
              {formatSyncStatus(syncStatus) && (
                <span style={{ fontSize: '12px', color: syncStatus?.lastError ? 'var(--danger)' : 'var(--text-2)' }}>
                  {formatSyncStatus(syncStatus)}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Remote MCP connection ─────────────────────────────────── */}
      {isLoggedIn && settings.cloudSyncEnabled && (
        <div className="plan-card" style={{ marginTop: '16px' }}>
          <div className="plan-header">
            <span className="plan-name">Connect AI assistants</span>
          </div>
          <p className="plan-desc" style={{ marginBottom: '10px' }}>
            Paste this link into ChatGPT, Claude.ai, Grok, or any MCP-compatible client to let it
            read your synced dictation history, meeting transcripts, and vocabulary. Anyone with
            the link can use it — treat it like a password.
          </p>

          {mcpStatus === null && <p className="plan-desc" style={{ opacity: 0.5 }}>Loading…</p>}

          {mcpStatus !== null && !mcpStatus.url && (
            <button className="primary" disabled={mcpBusy} onClick={() => void handleGenerateMcpLink()}>
              {mcpBusy ? 'Generating…' : 'Generate connection link'}
            </button>
          )}

          {mcpStatus !== null && mcpStatus.url && (
            <>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  type="text"
                  readOnly
                  value={mcpStatus.url}
                  onFocus={(e) => e.target.select()}
                  style={{
                    flex: 1,
                    fontSize: '12px',
                    padding: '6px 8px',
                    borderRadius: 'var(--r-sm)',
                    border: '1px solid var(--border)',
                    background: 'var(--surface)',
                    color: 'var(--text-2)',
                  }}
                />
                <button
                  onClick={handleCopyMcpLink}
                  style={{ fontSize: '13px', padding: '5px 12px', borderRadius: 'var(--r-sm)' }}
                >
                  {mcpCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <div style={{ display: 'flex', gap: '12px', marginTop: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  onClick={() =>
                    void handleGenerateMcpLink(
                      'Regenerate this link? The current one will stop working for any AI assistant already using it.'
                    )
                  }
                  disabled={mcpBusy}
                  style={{ fontSize: '13px', color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer', padding: '0' }}
                >
                  Regenerate
                </button>
                <button
                  onClick={() => void handleRevokeMcpLink()}
                  disabled={mcpBusy}
                  style={{ fontSize: '13px', color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer', padding: '0' }}
                >
                  Revoke
                </button>
                {mcpStatus.lastUsedAt && (
                  <span style={{ fontSize: '12px', color: 'var(--text-2)' }}>
                    Last used {new Date(mcpStatus.lastUsedAt).toLocaleString()}
                  </span>
                )}
              </div>
              {mcpStatus.lastError && (
                <p style={{ fontSize: '12px', color: 'var(--danger)', marginTop: '6px' }}>{mcpStatus.lastError}</p>
              )}
            </>
          )}
        </div>
      )}

    </section>
  )
}

function GoogleIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  )
}
