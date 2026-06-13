import type { Settings } from '@shared/types'

export function GeneralSection({ settings }: { settings: Settings }): React.JSX.Element {
  return (
    <section>
      <h2>General</h2>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.launchAtLogin}
          onChange={(e) => void window.api.setSettings({ launchAtLogin: e.target.checked })}
        />
        Launch Wispra when I sign in
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.aiPostProcess}
          onChange={(e) => void window.api.setSettings({ aiPostProcess: e.target.checked })}
        />
        AI cleanup — fix spelling &amp; add punctuation after transcription
      </label>
      <label className="check">
        Auto-stop recording after
        <select
          value={settings.autoStopMinutes}
          onChange={(e) => void window.api.setSettings({ autoStopMinutes: Number(e.target.value) })}
        >
          {[1, 2, 5, 10].map((m) => (
            <option key={m} value={m}>
              {m} min
            </option>
          ))}
        </select>
      </label>
    </section>
  )
}
