import { app } from 'electron'
import type { Settings } from '@shared/types'

/**
 * Registry value name for the unpackaged (dev) build's login item. An unpackaged Electron
 * shares the installed app's default value name (its AppUserModelId), so without a name of
 * its own every dev launch would overwrite or delete the installed Wispra's autostart entry.
 */
const DEV_LOGIN_ITEM_NAME = 'Wispra (dev)'

/**
 * Makes the OS login item match `settings.launchAtLogin`.
 *
 * `userToggled` is true only when the user flips the switch. A packaged app also syncs at
 * startup and on every settings change, which re-creates an entry that went missing. An
 * unpackaged dev run only touches the OS on an explicit toggle, so merely launching it
 * never adds or removes anything.
 */
export function syncLaunchAtLogin(settings: Settings, userToggled = false): void {
  if (process.platform === 'linux') return
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin })
    return
  }
  if (!userToggled) return
  // In dev process.execPath is the raw electron.exe in node_modules. Without an explicit
  // path/args, Windows would launch that binary with no app argument at login, which falls
  // back to Electron's own default screen instead of Wispra — mirrors the same
  // !app.isPackaged handling used for setAsDefaultProtocolClient in index.ts.
  app.setLoginItemSettings({
    openAtLogin: settings.launchAtLogin,
    path: process.execPath,
    args: [app.getAppPath()],
    name: DEV_LOGIN_ITEM_NAME
  })
}
