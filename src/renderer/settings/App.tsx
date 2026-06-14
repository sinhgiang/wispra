import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import { ApiKeySection } from './sections/ApiKey'
import { HotkeySection } from './sections/Hotkey'
import { LanguageSection } from './sections/Language'
import { GeneralSection } from './sections/General'
import { UpdatesSection } from './sections/Updates'
import { HistorySection } from './sections/History'
import { OnboardingBanner } from './sections/Onboarding'
import { ModesSection } from './sections/Modes'
import { VocabularySection } from './sections/Vocabulary'
import { TranscribeSection } from './sections/Transcribe'
import { AccountSection } from './sections/Account'
import './settings.css'

type Tab = 'settings' | 'transcribe' | 'history'

function MicIcon(): React.JSX.Element {
  return (
    <svg width="14" height="16" viewBox="0 0 14 16" fill="none">
      <rect x="4" y="0.5" width="6" height="9" rx="3" fill="white" />
      <path d="M1.5 8C1.5 11.038 4.014 13 7 13C9.986 13 12.5 11.038 12.5 8" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="7" y1="13" x2="7" y2="15.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="4" y1="15.5" x2="10" y2="15.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [tab, setTab] = useState<Tab>('settings')

  useEffect(() => {
    void window.api.getSettings().then(setSettings)
    window.api.onSettingsChanged(setSettings)
  }, [])

  if (!settings) return <div className="app loading">Loading…</div>

  return (
    <div className="app">
      <header>
        <div className="wordmark">
          <div className="wordmark-badge">
            <MicIcon />
          </div>
          <h1>Wispra</h1>
        </div>
        <nav className="tab-nav">
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            Settings
          </button>
          <button className={tab === 'transcribe' ? 'active' : ''} onClick={() => setTab('transcribe')}>
            Transcribe
          </button>
          <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
            History
          </button>
        </nav>
      </header>

      {tab === 'settings' ? (
        <main key="settings">
          <OnboardingBanner settings={settings} />
          <ApiKeySection settings={settings} />
          <HotkeySection settings={settings} />
          <LanguageSection settings={settings} />
          <GeneralSection settings={settings} />
          <ModesSection settings={settings} />
          <VocabularySection settings={settings} />
          <AccountSection settings={settings} />
          <UpdatesSection settings={settings} />
        </main>
      ) : tab === 'transcribe' ? (
        <main key="transcribe">
          <TranscribeSection settings={settings} />
        </main>
      ) : (
        <main key="history">
          <HistorySection />
        </main>
      )}
    </div>
  )
}
