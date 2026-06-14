import { useEffect, useState } from 'react'
import type { Settings, UpdateStatus } from '@shared/types'

export function UpdatesSection({ settings }: { settings: Settings }): React.JSX.Element {
  const [status, setStatus] = useState<UpdateStatus>({ status: 'idle' })

  useEffect(() => {
    window.api.onUpdateStatus(setStatus)
  }, [])

  const isDownloading = status.status === 'downloading'
  const isReady = status.status === 'downloaded'
  const isBusy = status.status === 'checking' || isDownloading

  function statusText(): string {
    switch (status.status) {
      case 'checking':   return 'Checking for updates…'
      case 'available':  return `v${status.version} found — starting download`
      case 'downloading': return `Downloading ${status.percent ?? 0}%`
      case 'downloaded': return `v${status.version} ready to install`
      case 'error':      return status.message
      default:           return "You're up to date"
    }
  }

  return (
    <section>
      <h2>Updates</h2>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={settings.autoUpdate}
          onChange={(e) => void window.api.setSettings({ autoUpdate: e.target.checked })}
        />
        <div className="toggle-info">
          <span className="toggle-label">Automatic updates</span>
          <span className="toggle-desc">Check and download updates in the background</span>
        </div>
        <div className="toggle-switch" />
      </label>

      {isDownloading && (
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${status.percent ?? 0}%` }} />
        </div>
      )}

      <div className="update-row">
        {isReady ? (
          <button className="primary" onClick={() => window.api.installUpdate()}>
            Restart &amp; Install
          </button>
        ) : (
          <button onClick={() => void window.api.checkForUpdates()} disabled={isBusy}>
            Check for updates
          </button>
        )}
        <span className={`update-status${isReady ? ' ready' : ''}`}>{statusText()}</span>
      </div>
    </section>
  )
}
