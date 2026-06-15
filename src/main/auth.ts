import { app, shell } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@shared/constants'

export interface AuthState {
  accessToken: string
  refreshToken: string
  expiresAt: number  // Unix ms
  userId: string
  email: string
  avatarUrl?: string
}

type AuthListener = (state: AuthState | null) => void

// Fixed local port for OAuth callback — must be added to Supabase allowed redirect URLs:
// http://127.0.0.1:19420/**
const OAUTH_CALLBACK_PORT = 19420

class AuthManager {
  private state: AuthState | null = null
  private listeners = new Set<AuthListener>()

  private get filePath(): string {
    return join(app.getPath('userData'), 'auth.json')
  }

  load(): void {
    try {
      if (!existsSync(this.filePath)) return
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (raw && typeof raw === 'object' && raw.accessToken) {
        this.state = raw as AuthState
      }
    } catch {
      this.state = null
    }
  }

  private persist(): void {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      if (this.state) {
        writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8')
      } else {
        try { unlinkSync(this.filePath) } catch { /* already gone */ }
      }
    } catch { /* non-fatal */ }
  }

  getState(): AuthState | null {
    return this.state ? { ...this.state } : null
  }

  isLoggedIn(): boolean {
    return this.state !== null
  }

  /** Returns access token if logged in, or null. Refreshes automatically when near expiry. */
  async getValidToken(): Promise<string | null> {
    if (!this.state) return null

    const fiveMinutes = 5 * 60 * 1000
    if (this.state.expiresAt - Date.now() < fiveMinutes) {
      const ok = await this.refresh()
      if (!ok) return null
    }

    return this.state?.accessToken ?? null
  }

  private async refresh(): Promise<boolean> {
    if (!this.state?.refreshToken) return false

    try {
      const response = await fetch(
        `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ refresh_token: this.state.refreshToken }),
          signal: AbortSignal.timeout(10_000),
        }
      )

      if (!response.ok) {
        this.logout()
        return false
      }

      const data = (await response.json()) as {
        access_token: string
        refresh_token: string
        expires_in: number
      }

      this.state = {
        ...this.state,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      }
      this.persist()
      return true
    } catch {
      return false
    }
  }

  /**
   * Opens the browser for Google OAuth. Starts a local HTTP server on port 19420
   * to receive the callback — the server page closes itself after handing off tokens.
   */
  openLoginBrowser(): void {
    const redirectUri = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}/callback`

    const server = createServer((req, res) => {
      const url = req.url ?? '/'

      if (url.startsWith('/callback')) {
        // Browser arrived at our local callback URL.
        // Serve a page that reads the URL fragment (which servers can't see)
        // and posts tokens back to us, then closes itself.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Wispra — Signing in</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0 }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
      background: #07070F; color: #EEEEF5;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      min-height: 100vh; gap: 14px;
    }
    .badge {
      width: 52px; height: 52px; border-radius: 14px;
      background: #4F6EF7;
      display: flex; align-items: center; justify-content: center;
    }
    h2 { font-size: 18px; font-weight: 600; }
    p  { font-size: 13px; color: #888; }
  </style>
</head>
<body>
  <div class="badge">
    <svg width="22" height="24" viewBox="0 0 14 16" fill="none">
      <rect x="4" y="0.5" width="6" height="9" rx="3" fill="white"/>
      <path d="M1.5 8C1.5 11.038 4.014 13 7 13C9.986 13 12.5 11.038 12.5 8"
            stroke="white" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="7" y1="13" x2="7" y2="15.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="4" y1="15.5" x2="10" y2="15.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  </div>
  <h2 id="msg">Signing in to Wispra…</h2>
  <p id="sub">This window will close automatically.</p>
  <script>
    const hash = window.location.hash.slice(1)
    if (!hash || !hash.includes('access_token')) {
      document.getElementById('msg').textContent = 'Sign-in failed'
      document.getElementById('sub').textContent = 'Please close this window and try again.'
    } else {
      fetch('/token?' + hash)
        .then(() => {
          document.getElementById('msg').textContent = '✓ You\\'re signed in!'
          window.close()
        })
        .catch(() => {
          document.getElementById('msg').textContent = '✓ You\\'re signed in!'
          document.getElementById('sub').textContent = 'Return to Wispra and close this window.'
        })
    }
  </script>
</body>
</html>`)
      } else if (url.startsWith('/token?')) {
        // The page fetched /token?access_token=...&refresh_token=...
        const params = new URLSearchParams(url.slice('/token?'.length))
        const accessToken = params.get('access_token')
        const refreshToken = params.get('refresh_token')
        const expiresIn = parseInt(params.get('expires_in') ?? '3600', 10)

        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('ok')

        server.close()

        if (accessToken && refreshToken) {
          void this.processTokens(accessToken, refreshToken, expiresIn)
        }
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    server.on('error', () => {
      // Port busy — fall back to wispra:// direct protocol
      const params = new URLSearchParams({ provider: 'google', redirect_to: 'wispra://auth' })
      void shell.openExternal(`${SUPABASE_URL}/auth/v1/authorize?${params.toString()}`)
    })

    server.listen(OAUTH_CALLBACK_PORT, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      const params = new URLSearchParams({
        provider: 'google',
        redirect_to: `http://127.0.0.1:${port}/callback`,
      })
      void shell.openExternal(`${SUPABASE_URL}/auth/v1/authorize?${params.toString()}`)
    })

    // Safety: shut server down after 5 minutes if login is abandoned
    setTimeout(() => server.close(), 5 * 60 * 1000)
  }

  /** Fetches user info and saves auth state. Called both by local server and wispra:// fallback. */
  private async processTokens(accessToken: string, refreshToken: string, expiresIn: number): Promise<void> {
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (!userResp.ok) return

    const user = (await userResp.json()) as {
      id: string
      email?: string
      user_metadata?: { avatar_url?: string; picture?: string }
    }

    this.state = {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      userId: user.id,
      email: user.email ?? '',
      avatarUrl: user.user_metadata?.avatar_url ?? user.user_metadata?.picture,
    }
    this.persist()
    this.emit()
  }

  /**
   * Handles the wispra://auth#access_token=... callback (fallback when local server is busy).
   * Returns true if login succeeded.
   */
  async handleCallback(url: string): Promise<boolean> {
    try {
      const fragmentOrQuery = url.includes('#')
        ? url.split('#')[1]
        : (url.split('?')[1] ?? '')
      const params = new URLSearchParams(fragmentOrQuery)

      const accessToken = params.get('access_token')
      const refreshToken = params.get('refresh_token')
      const expiresIn = parseInt(params.get('expires_in') ?? '3600', 10)

      if (!accessToken || !refreshToken) return false

      await this.processTokens(accessToken, refreshToken, expiresIn)
      return this.state !== null
    } catch {
      return false
    }
  }

  logout(): void {
    this.state = null
    this.persist()
    this.emit()
  }

  onChange(fn: AuthListener): void {
    this.listeners.add(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.getState())
  }
}

export const auth = new AuthManager()
