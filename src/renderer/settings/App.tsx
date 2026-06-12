import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import { ApiKeySection } from './sections/ApiKey'
import { HotkeySection } from './sections/Hotkey'
import { LanguageSection } from './sections/Language'
import { GeneralSection } from './sections/General'
import { UpdatesSection } from './sections/Updates'
import { HistorySection } from './sections/History'
import './settings.css'

type Tab = 'general' | 'history'

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [tab, setTab] = useState<Tab>('general')

  useEffect(() => {
    void window.api.getSettings().then(setSettings)
    window.api.onSettingsChanged(setSettings)
  }, [])

  if (!settings) return <div className="app loading">Loading…</div>

  return (
    <div className="app">
      <header>
        <h1>Wispra</h1>
        <nav>
          <button className={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')}>
            Settings
          </button>
          <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
            History
          </button>
        </nav>
      </header>

      {tab === 'general' ? (
        <main>
          <ApiKeySection settings={settings} />
          <HotkeySection settings={settings} />
          <LanguageSection settings={settings} />
          <GeneralSection settings={settings} />
          <UpdatesSection settings={settings} />
        </main>
      ) : (
        <main>
          <HistorySection />
        </main>
      )}
    </div>
  )
}
