import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { auth } from './auth'
import { WISPRA_API_BASE } from '@shared/constants'
import type { McpLinkStatus } from '@shared/types'

interface McpLinkState {
  url?: string
  createdAt?: string
}

function stateFilePath(): string {
  return join(app.getPath('userData'), 'mcp.json')
}

function loadState(): McpLinkState {
  try {
    return JSON.parse(readFileSync(stateFilePath(), 'utf8')) as McpLinkState
  } catch {
    return {}
  }
}

function saveState(state: McpLinkState): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(stateFilePath(), JSON.stringify(state, null, 2), 'utf8')
  } catch (err) {
    console.error('Failed to persist MCP link state:', err)
  }
}

async function callTokenApi(token: string, method: 'GET' | 'POST' | 'DELETE'): Promise<Response> {
  return fetch(`${WISPRA_API_BASE}/api/mcp/token`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000)
  })
}

/**
 * Current connection status. Opportunistically refreshes `lastUsedAt` from wispra-web
 * (and drops the local link if the server reports it was revoked elsewhere); network
 * failure just falls back to the last known local state — never throws.
 */
export async function getStatus(): Promise<McpLinkStatus> {
  const state = loadState()
  const token = await auth.getValidToken()
  if (!token || !state.url) {
    return { url: state.url ?? null, createdAt: state.createdAt ?? null, lastUsedAt: null, lastError: null }
  }

  try {
    const res = await callTokenApi(token, 'GET')
    if (!res.ok) throw new Error(`Status check failed (${res.status})`)
    const data = (await res.json()) as { connected: boolean; createdAt: string | null; lastUsedAt: string | null }
    if (!data.connected) {
      saveState({})
      return { url: null, createdAt: null, lastUsedAt: null, lastError: null }
    }
    return { url: state.url, createdAt: state.createdAt ?? data.createdAt, lastUsedAt: data.lastUsedAt, lastError: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { url: state.url, createdAt: state.createdAt ?? null, lastUsedAt: null, lastError: message }
  }
}

/**
 * Generates (first time) or rotates (replaces) the connection link. The plaintext token
 * is only ever returned by this call — unlike the reference "shown once" UX, it's persisted
 * to mcp.json so the user can come back and copy it again later.
 */
export async function generateLink(): Promise<McpLinkStatus> {
  const token = await auth.getValidToken()
  if (!token) {
    return { url: null, createdAt: null, lastUsedAt: null, lastError: 'Sign in required.' }
  }

  try {
    const res = await callTokenApi(token, 'POST')
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Link generation failed (${res.status}): ${text.slice(0, 200)}`)
    }
    const data = (await res.json()) as { token: string }
    const createdAt = new Date().toISOString()
    const url = `${WISPRA_API_BASE}/api/mcp/${data.token}`
    saveState({ url, createdAt })
    return { url, createdAt, lastUsedAt: null, lastError: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const state = loadState()
    return { url: state.url ?? null, createdAt: state.createdAt ?? null, lastUsedAt: null, lastError: message }
  }
}

/**
 * Revokes the link server-side (so the URL stops working) and clears the local copy.
 * If the server call fails, the link is still live — the local copy is kept so the
 * user can see the error and retry, instead of silently losing their only record of it.
 */
export async function revokeLink(): Promise<McpLinkStatus> {
  const token = await auth.getValidToken()
  if (token) {
    try {
      const res = await callTokenApi(token, 'DELETE')
      if (!res.ok) throw new Error(`Revoke failed (${res.status})`)
    } catch (err) {
      console.error('Failed to revoke MCP link on server:', err)
      const state = loadState()
      return { url: state.url ?? null, createdAt: state.createdAt ?? null, lastUsedAt: null, lastError: err instanceof Error ? err.message : String(err) }
    }
  }
  saveState({})
  return { url: null, createdAt: null, lastUsedAt: null, lastError: null }
}
