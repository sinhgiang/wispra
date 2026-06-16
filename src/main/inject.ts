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

/** Stores the last successfully injected text and its target window, used by undoLastInjection. */
let lastInjectedText: string | null = null
let lastInjectedHwnd: string | null = null

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

/** Call at recording START to capture both HWND and process name for context-aware AI. */
export async function captureTargetContext(): Promise<{ hwnd: string; processName: string } | null> {
  if (process.platform !== 'win32') return null
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinCtx {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$hwnd = [WinCtx]::GetForegroundWindow()
[uint]$pid = 0
[WinCtx]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
"$hwnd|$($proc.ProcessName)"
`
  try {
    const result = await runPs1(script)
    const parts = result.split('|')
    return { hwnd: parts[0].trim(), processName: (parts[1] ?? '').trim().toLowerCase() }
  } catch {
    return null
  }
}

/** Simulates Ctrl+Z in the target window to undo the last paste. */
export function undoLastInjection(targetHwnd: string | null): Promise<void> {
  const hwnd = targetHwnd ?? lastInjectedHwnd
  if (!hwnd || process.platform !== 'win32') return Promise.resolve()
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class WinUndo {
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    public static void Undo(long hwndLong) {
        IntPtr hwnd = new IntPtr(hwndLong);
        uint pid;
        uint targetTid = GetWindowThreadProcessId(hwnd, out pid);
        uint myTid = GetCurrentThreadId();
        AttachThreadInput(myTid, targetTid, true);
        SetForegroundWindow(hwnd);
        AttachThreadInput(myTid, targetTid, false);
        System.Threading.Thread.Sleep(80);
        SendKeys.SendWait("^z");
    }
}
"@ -ReferencedAssemblies "System.Windows.Forms"
[WinUndo]::Undo(${hwnd})
`
  return runPs1(script).then(() => undefined).catch(() => undefined)
}

export function getLastInjectedText(): string | null {
  return lastInjectedText
}

export function injectText(text: string, targetWindow: string | null = null): Promise<void> {
  const task = queue.then(() => doInject(text, targetWindow))
  queue = task.catch(() => undefined)
  return task
}

async function doInject(text: string, targetWindow: string | null): Promise<void> {
  lastInjectedText = text
  lastInjectedHwnd = targetWindow
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
      // Bring the target window to foreground, then paste.
      // KEY: attach to the CURRENT foreground thread (not the target thread) so that
      // SetForegroundWindow bypasses Windows' foreground-lock restriction. Also poll
      // GetForegroundWindow() until the switch actually completes before sending Ctrl+V,
      // because SendKeys sends to whichever window IS in the foreground at call time.
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
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    public static void Paste(long hwndLong) {
        IntPtr hwnd = new IntPtr(hwndLong);
        if (!IsWindow(hwnd)) return;
        uint pid;
        uint targetTid = GetWindowThreadProcessId(hwnd, out pid);
        uint myTid = GetCurrentThreadId();
        if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
        // Attach to the CURRENT foreground window's thread — this is what allows
        // SetForegroundWindow to succeed on Windows 10/11 when another app owns focus.
        IntPtr fgHwnd = GetForegroundWindow();
        uint fgPid;
        uint fgTid = GetWindowThreadProcessId(fgHwnd, out fgPid);
        AttachThreadInput(myTid, fgTid, true);
        if (fgTid != targetTid) AttachThreadInput(myTid, targetTid, true);
        SetForegroundWindow(hwnd);
        BringWindowToTop(hwnd);
        // Poll until the OS confirms the target window is in foreground (max 500ms).
        int waited = 0;
        while (GetForegroundWindow() != hwnd && waited < 500) {
            System.Threading.Thread.Sleep(20);
            waited += 20;
        }
        SendKeys.SendWait("^v");
        AttachThreadInput(myTid, fgTid, false);
        if (fgTid != targetTid) AttachThreadInput(myTid, targetTid, false);
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
