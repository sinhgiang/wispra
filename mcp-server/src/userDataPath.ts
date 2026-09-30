import * as os from 'os'
import * as path from 'path'

/**
 * Resolves the same userData directory Electron's `app.getPath('userData')` resolves to
 * for Wispra (root package.json has no `productName` override, so the folder name is the
 * lowercase package name, "wispra", on every platform).
 */
export function resolveUserDataPath(): string {
  const override = process.env.WISPRA_USERDATA_DIR
  if (override) return override

  const platform = process.platform
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, 'wispra')
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'wispra')
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(xdgConfig, 'wispra')
}
