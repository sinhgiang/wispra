import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import type { UpdateStatus } from '@shared/types'

export function UpdatesSection({ settings }: { settings: Settings }): React.JSX.Element {
  const [status, setStatus] = useState<UpdateStatus>({ status: 'idle' })

  useEffect(() => {
    window.api.onUpdateStatus(setStatus)
  }, [])

  function statusText(): string {
    switch (status.status) {
      case 'checking': return 'Checking for updates…'
      case 'available': return `Update v${status.version} found — downloading…`
      case 'downloading': return `Downloading… ${status.percent}%`
      case 'downloaded': return `v${status.version} ready — restart to apply`
      case 'error': return status.message
      default: return 'Up to date'
    }
  }

  return (
    <section>
      <h2>Updates</h2>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.autoUpdate}
          onChange={(e) => void window.api.setSettings({ autoUpdate: e.target.checked })}
        />
        Automatically check for updates
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
        {status.status === 'downloaded' ? (
          <button onClick={() => window.api.installUpdate()}>Restart &amp; Install</button>
        ) : (
          <button
            onClick={() => void window.api.checkForUpdates()}
            disabled={status.status === 'checking' || status.status === 'downloading'}
          >
            Check for updates
          </button>
        )}
        <span style={{ fontSize: 13, opacity: 0.7 }}>{statusText()}</span>
      </div>
    </section>
  )
}
