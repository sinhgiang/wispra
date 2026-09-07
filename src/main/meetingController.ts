import { EventEmitter } from 'events'
import type { MeetingState } from '@shared/types'

/**
 * Single source of truth for Meeting Mode's recording state.
 * idle ─start()→ recording ⇄pause()/resume()⇄ paused ─stop()→ idle
 *                    ↘captureFailed()↙        ↘captureFailed()↙
 *                            error (renderer must call start() again to retry)
 */
export class MeetingController extends EventEmitter {
  private state: MeetingState = 'idle'

  getState(): MeetingState {
    return this.state
  }

  start(): void {
    if (this.state !== 'idle' && this.state !== 'error') return
    this.setState('recording')
    this.emit('start-capture')
  }

  pause(): void {
    if (this.state !== 'recording') return
    this.setState('paused')
    this.emit('pause-capture')
  }

  resume(): void {
    if (this.state !== 'paused') return
    this.setState('recording')
    this.emit('resume-capture')
  }

  stop(): void {
    if (this.state !== 'recording' && this.state !== 'paused') return
    this.setState('idle')
    this.emit('stop-capture')
  }

  captureFailed(message: string): void {
    if (this.state !== 'recording' && this.state !== 'paused') return
    this.setState('error')
    console.error('[meeting] capture failed:', message)
  }

  private setState(state: MeetingState): void {
    this.state = state
    this.emit('state-changed', state)
  }
}

export const meetingController = new MeetingController()
