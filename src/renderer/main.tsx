import React from 'react'
import { createRoot } from 'react-dom/client'

const page = new URLSearchParams(window.location.search).get('page')

async function init(): Promise<void> {
  let Component: React.ComponentType

  if (page === 'overlay') {
    const { App } = await import('./overlay/App')
    Component = App
    // Overlay needs transparent background
    document.body.style.background = 'transparent'
    document.documentElement.style.background = 'transparent'
  } else {
    const { App } = await import('./settings/App')
    Component = App
  }

  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Component />
    </React.StrictMode>
  )
}

void init()
