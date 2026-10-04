import { EventEmitter } from 'events'
import { ERROR_DISPLAY_MS } from '@shared/constants'
import type { AppState, StatePayload } from '@shared/types'

/**
 * The single state machine that owns the dictation lifecycle.
 * Everything (hotkey, tray, overlay clicks) calls into this class;
 * renderers only display the state it broadcasts.
 *
 *   idle -> recording -> processing -> idle
 *                  \-> error (auto-returns to idle)
 *
 * Events emitted:
 *  - 'state-changed' (StatePayload)  — broadcast to renderers
 *  - 'start-recording'               — overlay should start the mic
 *  - 'stop-recording'                — overlay should stop and send audio
 */
export class DictationController extends EventEmitter {
  private state: AppState = 'idle'
  /** Guards the gap between requesting stop and audio arriving. */
  private stopRequested = false
  private errorTimer: NodeJS.Timeout | null = null

  getState(): AppState {
    return this.state
  }

  /**
   * Hotkey press / overlay click: start or stop a session. A recording runs until the user
   * stops it — there is no time limit (the audio streams to a file, see dictationAudio.ts).
   */
  toggle(): void {
    if (this.state === 'idle' || this.state === 'error') {
      this.clearErrorTimer()
      this.setState('recording')
      this.stopRequested = false
      this.emit('start-recording')
    } else if (this.state === 'recording') {
      this.requestStop()
    }
    // 'processing': ignore — never overlap sessions.
  }

  private requestStop(): void {
    if (this.state !== 'recording' || this.stopRequested) return
    this.stopRequested = true
    this.emit('stop-recording')
  }

  /**
   * Overlay delivered the captured audio. The async `work` callback does
   * transcribe + inject + history; whatever happens we end at idle/error.
   */
  async handleAudio(work: () => Promise<void>): Promise<void> {
    if (this.state !== 'recording') return // stale delivery after a failure
    this.stopRequested = false
    this.setState('processing')
    try {
      await work()
      this.setState('idle')
    } catch (err) {
      this.fail(err instanceof Error ? err.message : 'Something went wrong')
    }
  }

  /** Recording could not start or crashed in the renderer. */
  recordingFailed(message: string): void {
    if (this.state !== 'recording') return
    this.stopRequested = false
    this.fail(message)
  }

  private fail(message: string): void {
    this.setState('error', message)
    this.clearErrorTimer()
    this.errorTimer = setTimeout(() => {
      if (this.state === 'error') this.setState('idle')
    }, ERROR_DISPLAY_MS)
  }

  private setState(state: AppState, message?: string): void {
    this.state = state
    const payload: StatePayload = { state, message }
    this.emit('state-changed', payload)
  }

  private clearErrorTimer(): void {
    if (this.errorTimer) {
      clearTimeout(this.errorTimer)
      this.errorTimer = null
    }
  }
}

export const controller = new DictationController()
