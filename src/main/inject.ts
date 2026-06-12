import { clipboard } from 'electron'
import { execFile } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { CLIPBOARD_RESTORE_DELAY_MS } from '@shared/constants'

/**
 * Types text into whatever app is focused at recording START (not at paste time).
 * Flow: capture HWND on start → save clipboard → write text → restore focus → Ctrl+V → restore clipboard.
 * Uses AttachThreadInput so SetForegroundWindow works even when another app owns the foreground.
 * All injections go through a serial queue so two dictations never interleave clipboard ops.
 */
let queue: Promise<void> = Promise.resolve()

/** Call at recording START to remember which window to paste into later. */
export async function captureTargetWindow(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class HwndCapture {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
}
"@
[HwndCapture]::GetForegroundWindow()
`
  return runPs1(script)
}

export function injectText(text: string, targetWindow: string | null = null): Promise<void> {
  const task = queue.then(() => doInject(text, targetWindow))
  queue = task.catch(() => undefined)
  return task
}

async function doInject(text: string, targetWindow: string | null): Promise<void> {
  const prevText = clipboard.readText()
  const prevImage = clipboard.readImage()
  clipboard.writeText(text)
  try {
    await simulatePaste(targetWindow)
    await delay(CLIPBOARD_RESTORE_DELAY_MS)
  } finally {
    if (!prevImage.isEmpty()) clipboard.writeImage(prevImage)
    else clipboard.writeText(prevText)
  }
}

function simulatePaste(targetWindow: string | null): Promise<void> {
  if (process.platform === 'darwin') {
    return run('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'])
  }
  if (process.platform === 'win32') {
    if (targetWindow) {
      // Use AttachThreadInput to reliably bring the target window to front, then paste.
      const hwnd = targetWindow.trim()
      const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class FocusPaste {
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    public static void Paste(long hwndLong) {
        IntPtr hwnd = new IntPtr(hwndLong);
        uint pid;
        uint targetTid = GetWindowThreadProcessId(hwnd, out pid);
        uint myTid = GetCurrentThreadId();
        if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
        AttachThreadInput(myTid, targetTid, true);
        SetForegroundWindow(hwnd);
        BringWindowToTop(hwnd);
        AttachThreadInput(myTid, targetTid, false);
        System.Threading.Thread.Sleep(120);
        SendKeys.SendWait("^v");
    }
}
"@ -ReferencedAssemblies "System.Windows.Forms"
[FocusPaste]::Paste(${hwnd})
`
      return runPs1(script).then(() => undefined)
    }
    // No saved target — paste into whatever is focused now.
    const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("^v")
`
    return runPs1(script).then(() => undefined)
  }
  return run('xdotool', ['key', '--clearmodifiers', 'ctrl+v'])
}

/** Write a PS1 script to a temp file, execute it, delete it, return stdout. */
function runPs1(script: string): Promise<string> {
  const tmp = join(tmpdir(), `wispra_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`)
  writeFileSync(tmp, script, 'utf8')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', tmp],
      { timeout: 15_000, windowsHide: true },
      (err, stdout) => {
        try { unlinkSync(tmp) } catch { /* ignore */ }
        if (err) reject(new Error('Could not paste into the focused app'))
        else resolve(stdout.trim())
      }
    )
  })
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000, windowsHide: true }, (err) => {
      if (err) reject(new Error('Could not paste into the focused app'))
      else resolve()
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
