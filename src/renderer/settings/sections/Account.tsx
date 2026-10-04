import { useEffect, useState } from 'react'
import type { AccountInfo, McpLinkStatus, Settings, SyncStatus } from '@shared/types'

// Deep link straight to Claude.ai's "Add custom connector" dialog, so the user only
// has to paste — confirmed working URL (not guessed) as of Claude.ai's current UI.
const CLAUDE_ADD_CONNECTOR_URL = 'https://claude.ai/customize/connectors?modal=add-custom-connector'

const EXPIRY_OPTIONS: { value: string; label: string; days: number | null }[] = [
  { value: '7', label: '7 days', days: 7 },
  { value: '30', label: '30 days', days: 30 },
  { value: '90', label: '90 days', days: 90 },
  { value: 'never', label: 'No expiration', days: null },
]

// Shows only the stable domain/path prefix — the secret part of the credential is never
// rendered, so it can't leak via a screenshot or shoulder-surfing. Copy still uses the real URL.
function maskMcpUrl(url: string): string {
  const idx = url.lastIndexOf('/')
  if (idx === -1) return '••••••••••••••••••••••••'
  return `${url.slice(0, idx + 1)}••••••••••••••••••••`
}

function formatExpiry(expiresAt: string | null): { text: string; expired: boolean } {
  if (!expiresAt) return { text: 'No expiration', expired: false }
  const date = new Date(expiresAt)
  const formatted = date.toLocaleDateString()
  return date.getTime() < Date.now() ? { text: `Expired ${formatted}`, expired: true } : { text: `Expires ${formatted}`, expired: false }
}

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

/**
 * Where transcription and AI text go: Wispra Cloud (the signed-in account, counted toward
 * its monthly allowance) or straight to Groq with the user's own key. Switching only
 * changes `provider` — a saved key is never removed, and its value is never shown.
 */
function AiRouteChoice({ settings, signedIn }: { settings: Settings; signedIn: boolean }): React.JSX.Element {
  const keySaved = !!settings.groqApiKey
  const usingCloud = settings.provider === 'proxy'
  const usingOwnKey = settings.provider === 'groq'
  const [askingKey, setAskingKey] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [keyStatus, setKeyStatus] = useState<{ kind: 'busy' | 'err'; text: string } | null>(null)

  function choose(provider: 'proxy' | 'groq'): void {
    setAskingKey(false)
    setKeyStatus(null)
    void window.api.setSettings({ provider })
  }

  async function saveKey(): Promise<void> {
    const trimmed = keyInput.trim()
    if (!trimmed) return
    setKeyStatus({ kind: 'busy', text: 'Testing key…' })
    const result = await window.api.testApiKey('groq', trimmed)
    if (!result.ok) {
      setKeyStatus({ kind: 'err', text: result.error ?? 'Key test failed.' })
      return
    }
    await window.api.setSettings({ groqApiKey: trimmed, provider: 'groq' })
    setKeyInput('')
    setKeyStatus(null)
    setAskingKey(false)
  }

  const otherRoute = settings.provider === 'openai' ? 'OpenAI' : settings.provider === 'local' ? 'a local server' : null

  return (
    <div className="ai-route" role="radiogroup" aria-label="Where transcription and AI run">
      <div className="ai-route-title">Where transcription and AI run</div>
      <label className={`ai-route-option${usingCloud ? ' selected' : ''}${signedIn ? '' : ' disabled'}`}>
        <input type="radio" name="ai-route" checked={usingCloud} disabled={!signedIn} onChange={() => choose('proxy')} />
        <div className="ai-route-text">
          <span className="ai-route-name">Use Wispra Cloud</span>
          <span className="ai-route-desc">
            Transcription and AI text (cleanup, summaries, mind maps, posts, chat) go through Wispra&apos;s server and{' '}
            <strong>count toward this account&apos;s monthly minutes and AI allowance</strong>.
            {signedIn ? '' : ' Sign in with Google first.'}
          </span>
        </div>
      </label>
      <label className={`ai-route-option${usingOwnKey || askingKey ? ' selected' : ''}`}>
        <input
          type="radio"
          name="ai-route"
          checked={usingOwnKey || askingKey}
          onChange={() => (keySaved ? choose('groq') : setAskingKey(true))}
        />
        <div className="ai-route-text">
          <span className="ai-route-name">Use my own Groq API key</span>
          <span className="ai-route-desc">
            Everything goes straight to Groq with your key. <strong>Nothing is counted on this page</strong> — your key&apos;s
            own Groq limits apply. {keySaved ? 'A key is saved on this computer.' : 'No key is saved yet.'}
          </span>
        </div>
      </label>
      {askingKey && !keySaved && (
        <div className="ai-route-key">
          <input
            type="password"
            placeholder="Paste your Groq API key (gsk_…)"
            value={keyInput}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <button className="primary" disabled={!keyInput.trim() || keyStatus?.kind === 'busy'} onClick={() => void saveKey()}>
            Save key
          </button>
          {keyStatus && <span className={`ai-route-status ${keyStatus.kind}`}>{keyStatus.text}</span>}
        </div>
      )}
      {otherRoute && <p className="ai-route-note">Right now Wispra uses {otherRoute}. Choosing one of the above switches to it.</p>}
      <p className="ai-route-note">Switching never deletes a saved key.</p>
    </div>
  )
}

/**
 * Backups for AI text when the main model reaches its DAILY limit: Groq's smaller model
 * (automatic, same key), then Cloudflare Workers AI once an account id and token are
 * saved here. The two values are tested before saving and never shown again.
 */
function AiBackupSection({ settings }: { settings: Settings }): React.JSX.Element | null {
  const saved = !!(settings.cloudflareAccountId && settings.cloudflareApiToken)
  const [accountId, setAccountId] = useState('')
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<{ kind: 'busy' | 'err'; text: string } | null>(null)

  // No backups for OpenAI or a local server (see resolveBackupRoutes): nothing to set up here.
  if (settings.provider === 'openai' || settings.provider === 'local') return null

  async function testAndSave(): Promise<void> {
    setStatus({ kind: 'busy', text: 'Testing with Cloudflare…' })
    const result = await window.api.testCloudflare(accountId.trim(), token.trim())
    if (!result.ok) {
      setStatus({ kind: 'err', text: result.error ?? 'Cloudflare did not accept these.' })
      return
    }
    await window.api.setSettings({ cloudflareAccountId: accountId.trim(), cloudflareApiToken: token.trim() })
    setAccountId('')
    setToken('')
    setStatus(null)
  }

  return (
    <div className="ai-route ai-backup">
      <div className="ai-route-title">Backup when the AI reaches its daily limit</div>
      <p className="ai-route-note">
        Mind maps, Transcript topics, summaries and posts: when Groq&apos;s gpt-oss-120b reaches its daily limit on your own
        key, Wispra goes on with Groq&apos;s smaller gpt-oss-20b (its own daily allowance), then with Cloudflare Workers AI if
        it is set up below. Each result says when a backup model wrote it. Transcription always stays on Groq.
      </p>
      <p className="ai-route-note ai-backup-warning">
        <strong>Use a Cloudflare account on the Workers Free plan only</strong> (no payment method). On Workers Paid, use beyond
        the free 10,000 neurons a day is billed. Wispra estimates its own use and stops for the day before that (the count
        resets at 00:00 UTC), but it cannot see what other Workers on the same account use.
      </p>
      {saved ? (
        <div className="ai-route-key ai-backup-key">
          <span className="ai-route-status">Cloudflare Workers AI is set up.</span>
          <button onClick={() => void window.api.setSettings({ cloudflareAccountId: '', cloudflareApiToken: '' })}>Remove</button>
        </div>
      ) : (
        <div className="ai-route-key ai-backup-key">
          <input
            type="password"
            placeholder="Cloudflare Account ID"
            value={accountId}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setAccountId(e.target.value)}
          />
          <input
            type="password"
            placeholder="Cloudflare API token (Workers AI)"
            value={token}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setToken(e.target.value)}
          />
          <button className="primary" disabled={!accountId.trim() || !token.trim() || status?.kind === 'busy'} onClick={() => void testAndSave()}>
            Test and save
          </button>
          {status && <span className={`ai-route-status ${status.kind}`}>{status.text}</span>}
        </div>
      )}
    </div>
  )
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
  const [copiedTarget, setCopiedTarget] = useState<string | null>(null)
  const [showMoreConnect, setShowMoreConnect] = useState(false)
  const [expiryChoice, setExpiryChoice] = useState('never')

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
      const days = EXPIRY_OPTIONS.find((o) => o.value === expiryChoice)?.days ?? null
      setMcpStatus(await window.api.generateMcpLink(days))
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

  function handleConnectClaude(): void {
    if (!mcpStatus?.url) return
    window.api.copyText(mcpStatus.url)
    window.open(CLAUDE_ADD_CONNECTOR_URL, '_blank', 'noreferrer')
    setCopiedTarget('claude')
    setTimeout(() => setCopiedTarget((t) => (t === 'claude' ? null : t)), 2000)
  }

  function copyFor(target: string, text: string): void {
    window.api.copyText(text)
    setCopiedTarget(target)
    setTimeout(() => setCopiedTarget((t) => (t === target ? null : t)), 2000)
  }

  // Copies the link AND opens the assistant's site, so the user lands on the paste
  // target with the link already on their clipboard — one click, not copy-then-hunt-for-tab.
  function copyAndOpen(target: string, text: string, openUrl: string): void {
    window.api.copyText(text)
    window.open(openUrl, '_blank', 'noreferrer')
    setCopiedTarget(target)
    setTimeout(() => setCopiedTarget((t) => (t === target ? null : t)), 2000)
  }

  function openCursorDeepLink(): void {
    if (!mcpStatus?.url) return
    const config = encodeURIComponent(btoa(JSON.stringify({ url: mcpStatus.url })))
    window.api.copyText(mcpStatus.url)
    window.open(`cursor://anysphere.cursor-deeplink/mcp/install?name=wispra&config=${config}`, '_blank', 'noreferrer')
    setCopiedTarget('cursor')
    setTimeout(() => setCopiedTarget((t) => (t === 'cursor' ? null : t)), 2000)
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
            borderColor: accountInfo.plan === 'pro' || accountInfo.unlimited ? 'var(--accent)' : 'var(--border)',
            background: accountInfo.plan === 'pro' || accountInfo.unlimited ? 'var(--accent-subtle)' : 'var(--surface)',
          }}
        >
          <div className="plan-header">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-2)' }}>{accountInfo.email}</span>
              <span className="plan-name">
                {accountInfo.unlimited ? 'Wispra Cloud · Unlimited' : accountInfo.plan === 'pro' ? 'Wispra Pro' : 'Wispra Free'}
              </span>
            </div>
            <span
              className="plan-badge"
              style={accountInfo.plan === 'pro' || accountInfo.unlimited ? { background: 'var(--accent)', color: 'white' } : {}}
            >
              {accountInfo.unlimited ? 'Unlimited' : accountInfo.plan === 'pro' ? 'Pro' : 'Free'}
            </span>
          </div>

          {/* Transcription minutes: a bar against the monthly limit when there is one (the
              server's number), otherwise just what was used — never a maximum that does not apply. */}
          {typeof accountInfo.limitSeconds === 'number' && accountInfo.limitSeconds > 0 ? (
            <div className="usage-bar-wrap">
              <div className="usage-bar-track">
                <div
                  className="usage-bar-fill"
                  style={{
                    width: `${Math.min(100, (accountInfo.usageSeconds / accountInfo.limitSeconds) * 100)}%`,
                    background: accountInfo.usageSeconds >= accountInfo.limitSeconds ? 'var(--danger)' : 'var(--accent)',
                  }}
                />
              </div>
              <span className="usage-bar-label">
                {formatMinutes(accountInfo.usageSeconds)} / {Math.round(accountInfo.limitSeconds / 60)} min used this month
              </span>
            </div>
          ) : (
            <>
              <p className="plan-desc" style={{ marginTop: '8px' }}>
                {accountInfo.unlimited
                  ? 'No monthly limits on transcription or AI text, powered by Wispra Cloud.'
                  : 'Unlimited transcription, powered by Wispra cloud.'}
              </p>
              <span className="usage-bar-label usage-plain">{formatMinutes(accountInfo.usageSeconds)} min transcribed this month</span>
            </>
          )}

          {/* AI text used this month — with a bar when the account has a limit, as a plain
              number when it has none (unlimited). Older servers do not send these fields. */}
          {typeof accountInfo.aiTokensUsed === 'number' && accountInfo.aiTokensLimit === undefined && (
            <span className="usage-bar-label usage-plain">AI text: {accountInfo.aiTokensUsed.toLocaleString()} tokens used this month</span>
          )}
          {typeof accountInfo.aiTokensUsed === 'number' && typeof accountInfo.aiTokensLimit === 'number' && accountInfo.aiTokensLimit > 0 && (
            <div className="usage-bar-wrap">
              <div className="usage-bar-track">
                <div
                  className="usage-bar-fill"
                  style={{
                    width: `${Math.min(100, (accountInfo.aiTokensUsed / accountInfo.aiTokensLimit) * 100)}%`,
                    background: accountInfo.aiTokensUsed >= accountInfo.aiTokensLimit ? 'var(--danger)' : 'var(--accent)',
                  }}
                />
              </div>
              <span className="usage-bar-label">
                AI text: {accountInfo.aiTokensUsed.toLocaleString()} / {accountInfo.aiTokensLimit.toLocaleString()} tokens used this month
                {accountInfo.aiTokensResetAt && !Number.isNaN(Date.parse(accountInfo.aiTokensResetAt))
                  ? ` · resets ${new Date(accountInfo.aiTokensResetAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`
                  : ''}
              </span>
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
            {accountInfo.plan === 'free' && !accountInfo.unlimited && accountInfo.subscribeUrl && (
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

      <AiRouteChoice settings={settings} signedIn={isLoggedIn} />
      <AiBackupSection settings={settings} />

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
            read your synced dictation history, meeting transcripts, and vocabulary. It's a
            credential — shown masked below, like a password — and only its hash is stored on
            the server, so Wispra itself can't recover it either.
          </p>

          {mcpStatus === null && <p className="plan-desc" style={{ opacity: 0.5 }}>Loading…</p>}

          {mcpStatus !== null && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', fontSize: '13px' }}>
                <label htmlFor="mcp-expiry" style={{ color: 'var(--text-2)' }}>
                  {mcpStatus.url ? 'New link expires in:' : 'Link expires in:'}
                </label>
                <select
                  id="mcp-expiry"
                  value={expiryChoice}
                  onChange={(e) => setExpiryChoice(e.target.value)}
                  style={{ fontSize: '13px', padding: '4px 6px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)' }}
                >
                  {EXPIRY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  type="text"
                  readOnly
                  value={mcpStatus.url ? maskMcpUrl(mcpStatus.url) : 'No link yet'}
                  style={{
                    flex: 1,
                    fontSize: '12px',
                    padding: '6px 8px',
                    borderRadius: 'var(--r-sm)',
                    border: '1px solid var(--border)',
                    background: 'var(--surface)',
                    color: 'var(--text-2)',
                    letterSpacing: '1px',
                  }}
                />
                {mcpStatus.url && (
                  <button
                    onClick={handleCopyMcpLink}
                    style={{ fontSize: '13px', padding: '5px 12px', borderRadius: 'var(--r-sm)' }}
                  >
                    {mcpCopied ? 'Copied!' : 'Copy'}
                  </button>
                )}
              </div>

              <div style={{ fontSize: '12px', color: formatExpiry(mcpStatus.expiresAt).expired ? 'var(--danger)' : 'var(--text-2)', marginTop: '4px' }}>
                {mcpStatus.url ? (
                  <>
                    {mcpStatus.createdAt && `Created ${new Date(mcpStatus.createdAt).toLocaleString()} · `}
                    {formatExpiry(mcpStatus.expiresAt).text}
                    {formatExpiry(mcpStatus.expiresAt).expired && ' — click Change link below to reconnect'}
                  </>
                ) : (
                  'Click "Create link" below. The AI assistant rows appear once you have a link to give them.'
                )}
              </div>

              <div style={{ display: 'flex', gap: '10px', marginTop: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  className="primary"
                  onClick={() =>
                    void handleGenerateMcpLink(
                      mcpStatus.url
                        ? `Change this link (${EXPIRY_OPTIONS.find((o) => o.value === expiryChoice)?.label.toLowerCase()})?\n\nThe current link will stop working immediately for any AI assistant already connected — you'll need to paste the new one in to reconnect it.`
                        : undefined
                    )
                  }
                  disabled={mcpBusy}
                  style={{ fontSize: '13px', padding: '6px 14px', borderRadius: 'var(--r-sm)' }}
                >
                  {mcpBusy ? 'Generating…' : mcpStatus.url ? 'Change link' : 'Create link'}
                </button>
                {mcpStatus.url && (
                  <button
                    onClick={() => void handleRevokeMcpLink()}
                    disabled={mcpBusy}
                    style={{ fontSize: '13px', color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer', padding: '0' }}
                  >
                    Revoke
                  </button>
                )}
                {mcpStatus.lastUsedAt && (
                  <span style={{ fontSize: '12px', color: 'var(--text-2)' }}>
                    Last used {new Date(mcpStatus.lastUsedAt).toLocaleString()}
                  </span>
                )}
              </div>
              {mcpStatus.lastError && (
                <p style={{ fontSize: '12px', color: 'var(--danger)', marginTop: '6px' }}>{mcpStatus.lastError}</p>
              )}

              {mcpStatus.url && (
                <div style={{ marginTop: '14px' }}>
                  <ConnectRow
                    name="Claude.ai"
                    description="Opens the “Add custom connector” dialog — paste the link that's already copied."
                    buttonLabel="Connect"
                    copiedLabel="Opened — paste it in"
                    copied={copiedTarget === 'claude'}
                    onClick={handleConnectClaude}
                  />
                  <ConnectRow
                    name="ChatGPT"
                    description='Opens ChatGPT. Settings → Connectors → Add → paste → choose "No authentication".'
                    buttonLabel="Connect"
                    copiedLabel="Opened — paste it in"
                    copied={copiedTarget === 'chatgpt'}
                    onClick={() => copyAndOpen('chatgpt', mcpStatus.url!, 'https://chatgpt.com/')}
                  />
                  <ConnectRow
                    name="Grok"
                    description="Opens Grok. Paste as a custom MCP connector URL — no plugin needed."
                    buttonLabel="Connect"
                    copiedLabel="Opened — paste it in"
                    copied={copiedTarget === 'grok'}
                    onClick={() => copyAndOpen('grok', mcpStatus.url!, 'https://grok.com/')}
                  />
                  <ConnectRow
                    name="Perplexity"
                    description="Opens Perplexity. Settings → Connectors → Custom connector (Remote) → paste."
                    buttonLabel="Connect"
                    copiedLabel="Opened — paste it in"
                    copied={copiedTarget === 'perplexity'}
                    onClick={() => copyAndOpen('perplexity', mcpStatus.url!, 'https://www.perplexity.ai/')}
                  />

                  <button
                    onClick={() => setShowMoreConnect((v) => !v)}
                    style={{
                      fontSize: '12px',
                      color: 'var(--text-2)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '8px 0 0',
                    }}
                  >
                    {showMoreConnect ? 'Fewer options ▲' : 'More options (Cursor, Claude Code, Codex) ▼'}
                  </button>

                  {showMoreConnect && (
                    <div>
                      <ConnectRow
                        name="Cursor"
                        description="One click installs the Wispra MCP server into Cursor."
                        buttonLabel="Add to Cursor"
                        copiedLabel="Opened Cursor!"
                        copied={copiedTarget === 'cursor'}
                        onClick={openCursorDeepLink}
                      />
                      <ConnectRow
                        name="Claude Code"
                        description="Copies a ready-to-run `claude mcp add` command."
                        buttonLabel="Copy command"
                        copiedLabel="Copied!"
                        copied={copiedTarget === 'claude-code'}
                        onClick={() => copyFor('claude-code', `claude mcp add --transport http wispra ${mcpStatus.url}`)}
                      />
                      <ConnectRow
                        name="Codex"
                        description="Paste the link into the url field of your MCP config."
                        buttonLabel="Copy link"
                        copiedLabel="Copied!"
                        copied={copiedTarget === 'codex'}
                        onClick={() => copyFor('codex', mcpStatus.url!)}
                      />
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

    </section>
  )
}

function ConnectRow({
  name,
  description,
  buttonLabel,
  copiedLabel,
  copied,
  onClick,
}: {
  name: string
  description: string
  buttonLabel: string
  copiedLabel: string
  copied: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 0',
        borderTop: '1px solid var(--border)',
      }}
    >
      <div>
        <div style={{ fontSize: '13px', fontWeight: 600 }}>{name}</div>
        <div style={{ fontSize: '12px', color: 'var(--text-2)' }}>{description}</div>
      </div>
      <button onClick={onClick} style={{ fontSize: '13px', padding: '5px 12px', borderRadius: 'var(--r-sm)', flexShrink: 0 }}>
        {copied ? copiedLabel : buttonLabel}
      </button>
    </div>
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
