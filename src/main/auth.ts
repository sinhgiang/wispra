import { app, shell } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
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

  /** Opens the user's default browser to the Google OAuth consent screen. */
  openLoginBrowser(): void {
    const params = new URLSearchParams({
      provider: 'google',
      // Redirect to a web page that forwards tokens to the app and closes itself
      redirect_to: 'https://wispra-web.vercel.app/auth/callback',
    })
    void shell.openExternal(`${SUPABASE_URL}/auth/v1/authorize?${params.toString()}`)
  }

  /**
   * Handles the wispra://auth#access_token=...&refresh_token=... callback URL.
   * Returns true if login succeeded.
   */
  async handleCallback(url: string): Promise<boolean> {
    try {
      // Supabase puts tokens in the URL fragment or query depending on redirect mode
      const fragmentOrQuery = url.includes('#')
        ? url.split('#')[1]
        : (url.split('?')[1] ?? '')
      const params = new URLSearchParams(fragmentOrQuery)

      const accessToken = params.get('access_token')
      const refreshToken = params.get('refresh_token')
      const expiresIn = parseInt(params.get('expires_in') ?? '3600', 10)

      if (!accessToken || !refreshToken) return false

      // Fetch user info from Supabase
      const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(10_000),
      })

      if (!userResp.ok) return false

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
      return true
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
