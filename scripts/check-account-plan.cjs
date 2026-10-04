/*
 * Automated check for the plan card on the Account page with Wispra Cloud.
 *
 * Run with `npm run check:account-plan` (builds first). No account or network:
 *
 *   A. accountInfoFrom() (bundled from src/ on the fly) on the answers GET /api/usage gives:
 *      an unlimited account (`unlimited: true`, limits null — as the server sends since
 *      wispra-web T-0081), the Free plan, Pro, and an older server without the new fields.
 *   B. The built Settings renderer with stub IPC: the Account page for each of those —
 *      "Wispra Cloud · Unlimited" with no bar and no "/ 30 min", a limit shown only when
 *      there is one, and the Free plan unchanged.
 *
 * The app's own main process is not started; the window and its data folder are throwaway.
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wispra-check-'))
const IPC = Object.fromEntries(
  [...fs.readFileSync(path.join(ROOT, 'src/shared/ipc.ts'), 'utf8').matchAll(/^\s*([A-Z0-9_]+):\s*'([^']+)'/gm)].map((m) => [m[1], m[2]])
)
app.setPath('userData', path.join(TMP, 'userdata'))
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const results = []
const check = (name, ok, detail) => {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const USER = { email: 'alex@example.com' }

// What GET /api/usage answers (shape from wispra-web app/api/usage/route.ts).
const ANSWERS = {
  unlimited: { plan: 'free', unlimited: true, usageSeconds: 734, limitSeconds: null, aiTokensUsed: 51234, aiTokensLimit: null, aiTokensResetAt: '2026-11-01T00:00:00.000Z', subscribeUrl: 'https://example.com/checkout' },
  free: { plan: 'free', unlimited: false, usageSeconds: 600, limitSeconds: 1800, aiTokensUsed: 1200, aiTokensLimit: 300000, aiTokensResetAt: '2026-11-01T00:00:00.000Z', subscribeUrl: 'https://example.com/checkout' },
  pro: { plan: 'pro', unlimited: false, usageSeconds: 5400, limitSeconds: null, aiTokensUsed: 90000, aiTokensLimit: 3000000, subscribeUrl: null },
  old: { plan: 'free', usageSeconds: 120, limitSeconds: 1800, subscribeUrl: null }
}

let lib = null
function partA() {
  const { accountInfoFrom, hasAiAllowanceLeft } = lib
  const u = accountInfoFrom(ANSWERS.unlimited, USER)
  check('unlimited account: marked unlimited, no transcription limit, no AI text limit, usage kept', u.unlimited === true && u.limitSeconds === null && u.aiTokensLimit === undefined && u.usageSeconds === 734 && u.aiTokensUsed === 51234, u)
  check('unlimited account: AI allowance counts as left (a stale "used up" notice is cleared)', hasAiAllowanceLeft(u))
  const f = accountInfoFrom(ANSWERS.free, USER)
  check('Free plan: the server\x27s limits are kept', !f.unlimited && f.limitSeconds === 1800 && f.aiTokensLimit === 300000, f)
  const p = accountInfoFrom(ANSWERS.pro, USER)
  check('Pro: no transcription limit, the AI text limit kept', p.plan === 'pro' && p.limitSeconds === null && p.aiTokensLimit === 3000000)
  const o = accountInfoFrom(ANSWERS.old, USER)
  check('an older server without the new fields: Free plan as before, no AI text line', o.limitSeconds === 1800 && o.aiTokensUsed === undefined && !o.unlimited)
  check('a reply that is not an object does not throw', accountInfoFrom(null, USER).plan === 'free')
}

async function partB() {
  let current = 'unlimited'
  for (const channel of Object.values(IPC)) ipcMain.handle(channel, () => null)
  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, fn)
  }
  handle(IPC.GET_SETTINGS, () => ({ ...lib.DEFAULT_SETTINGS, provider: 'proxy' }))
  handle(IPC.GET_ACCOUNT_INFO, () => lib.accountInfoFrom(ANSWERS[current], USER))

  const win = new BrowserWindow({ width: 900, height: 700, x: -4000, y: -4000, show: false, skipTaskbar: true, webPreferences: { preload: path.join(ROOT, 'out/preload/index.js'), contextIsolation: true, backgroundThrottling: false } })
  win.showInactive()
  win.setPosition(-4000, -4000)
  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) errors.push(message)
  })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const card = async (which) => {
    current = which
    await win.loadFile(path.join(ROOT, 'out/renderer/index.html'), { query: { page: 'settings' } })
    await sleep(600)
    if (process.env.CHECK_DEBUG) console.log('PAGE', (await js('document.body.innerText')).slice(0, 300), errors)
    await js(`(() => { const b = [...document.querySelectorAll('header button')].find((x) => x.textContent.trim() === 'Account'); b.click(); return true })()`)
    for (let i = 0; i < 40; i++) {
      if (await js(`!![...document.querySelectorAll('.plan-card')].find((c) => c.textContent.includes('alex@example.com'))`)) break
      await sleep(100)
    }
    return js(`(() => { const c = [...document.querySelectorAll('.plan-card')].find((x) => x.textContent.includes('alex@example.com')); return c ? { name: c.querySelector('.plan-name').textContent, badge: c.querySelector('.plan-badge').textContent, text: c.innerText, bars: c.querySelectorAll('.usage-bar-track').length, upgrade: !!c.querySelector('a[href*="checkout"]') } : null })()`)
  }

  let c = await card('unlimited')
  check('unlimited: the card says "Wispra Cloud · Unlimited"', c && c.name === 'Wispra Cloud · Unlimited' && c.badge === 'Unlimited', c && { name: c.name, badge: c.badge })
  check('unlimited: no usage bar, no "/ 30 min", no maximum anywhere, no upgrade button', c && c.bars === 0 && !/\/ ?30 min|Wispra Free/.test(c.text) && !/\d\s*\/\s*\d/.test(c.text) && !c.upgrade, c && { text: c.text, bars: c.bars })
  check('unlimited: what was used is still shown, as plain numbers', c && /12\.2 min transcribed this month/.test(c.text) && /AI text: 51,234 tokens used this month/.test(c.text), c && c.text)
  if (process.env.CHECK_SHOTS) {
    fs.mkdirSync(process.env.CHECK_SHOTS, { recursive: true })
    await js(`[...document.querySelectorAll('.plan-card')].find((x) => x.textContent.includes('alex@example.com')).scrollIntoView({ block: 'center' })`)
    fs.writeFileSync(path.join(process.env.CHECK_SHOTS, 'account-unlimited.png'), (await win.webContents.capturePage()).toPNG())
  }

  c = await card('free')
  check('Free plan: unchanged — "Wispra Free", bars against the server\x27s limits, upgrade button', c && c.name === 'Wispra Free' && c.bars === 2 && /10\.0 \/ 30 min used this month/.test(c.text) && /1,200 \/ 300,000 tokens/.test(c.text) && c.upgrade, c && { name: c.name, text: c.text })

  c = await card('pro')
  check('Pro: "Wispra Pro", no transcription maximum, the AI text bar against its limit', c && c.name === 'Wispra Pro' && c.bars === 1 && /90\.0 min transcribed this month/.test(c.text) && /90,000 \/ 3,000,000 tokens/.test(c.text), c && { name: c.name, text: c.text })

  c = await card('old')
  check('older server: the Free card as before, without an AI text line', c && c.name === 'Wispra Free' && c.bars === 1 && /2\.0 \/ 30 min used this month/.test(c.text) && !/AI text/.test(c.text), c && c.text)
  check('no errors in the renderer console', errors.length === 0, errors.slice(0, 5))
}

app.whenReady().then(async () => {
  const killer = setTimeout(() => {
    console.log('FAIL  timed out')
    app.exit(1)
  }, 120_000)
  const outfile = path.join(TMP, 'account-lib.cjs')
  require('esbuild').buildSync({
    stdin: { contents: `export { accountInfoFrom, hasAiAllowanceLeft } from './src/main/accountInfo'
export { DEFAULT_SETTINGS } from './src/shared/constants'`, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    outfile,
    logLevel: 'silent'
  })
  lib = require(outfile)
  try {
    partA()
    await partB()
  } catch (err) {
    check('check run completed', false, String(err && err.stack ? err.stack : err))
  }
  clearTimeout(killer)
  const failures = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failures}/${results.length} checks passed`)
  app.exit(failures ? 1 : 0)
})
