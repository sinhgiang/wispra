import type { Settings } from '@shared/types'

export function GeneralSection({ settings }: { settings: Settings }): React.JSX.Element {
  return (
    <section>
      <h2>General</h2>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={settings.launchAtLogin}
          onChange={(e) => void window.api.setSettings({ launchAtLogin: e.target.checked })}
        />
        <div className="toggle-info">
          <span className="toggle-label">Launch at login</span>
          <span className="toggle-desc">Start Wispra automatically when you sign in</span>
        </div>
        <div className="toggle-switch" />
      </label>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={settings.aiPostProcess}
          onChange={(e) => void window.api.setSettings({ aiPostProcess: e.target.checked })}
        />
        <div className="toggle-info">
          <span className="toggle-label">AI cleanup</span>
          <span className="toggle-desc">Fix spelling &amp; add punctuation after transcription</span>
        </div>
        <div className="toggle-switch" />
      </label>

      <div className="autostop-row">
        <span className="autostop-label">Auto-stop recording after</span>
        <select
          className="autostop-select"
          value={settings.autoStopMinutes}
          onChange={(e) => void window.api.setSettings({ autoStopMinutes: Number(e.target.value) })}
        >
          {[1, 2, 5, 10].map((m) => (
            <option key={m} value={m}>{m} min</option>
          ))}
        </select>
      </div>
    </section>
  )
}
