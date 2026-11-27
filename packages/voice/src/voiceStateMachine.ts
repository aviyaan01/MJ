import { VoiceStates, type VoiceState } from '@mj/shared';

export interface VoiceStateMeta {
  state: VoiceState;
  label: string;
  description: string;
  tone: 'neutral' | 'good' | 'warn' | 'error';
  stepOrder: number;
}

export const VOICE_STATE_META: Record<VoiceState, VoiceStateMeta> = {
  [VoiceStates.IDLE]: {
    state: VoiceStates.IDLE,
    label: 'Idle',
    description: 'Standing by. Press Talk to start a voice session.',
    tone: 'neutral',
    stepOrder: 1,
  },
  [VoiceStates.REQUESTING_PERMISSION]: {
    state: VoiceStates.REQUESTING_PERMISSION,
    label: 'Requesting Permission',
    description: 'Waiting for browser microphone permission.',
    tone: 'warn',
    stepOrder: 2,
  },
  [VoiceStates.CONNECTING]: {
    state: VoiceStates.CONNECTING,
    label: 'Connecting',
    description: 'Acquiring ephemeral token and opening Grok realtime socket…',
    tone: 'neutral',
    stepOrder: 3,
  },
  [VoiceStates.LISTENING]: {
    state: VoiceStates.LISTENING,
    label: 'Listening',
    description: 'Microphone active. Speak naturally in English, বাংলা, or Banglish.',
    tone: 'good',
    stepOrder: 4,
  },
  [VoiceStates.PROCESSING]: {
    state: VoiceStates.PROCESSING,
    label: 'Processing',
    description: 'Speech captured. Generating Grok response…',
    tone: 'neutral',
    stepOrder: 5,
  },
  [VoiceStates.SPEAKING]: {
    state: VoiceStates.SPEAKING,
    label: 'Speaking',
    description: 'MJ is speaking. Speak or press Interrupt to barge in.',
    tone: 'good',
    stepOrder: 6,
  },
  [VoiceStates.INTERRUPTED]: {
    state: VoiceStates.INTERRUPTED,
    label: 'Interrupted',
    description: 'Assistant speech interrupted. Returning to listening…',
    tone: 'warn',
    stepOrder: 7,
  },
  [VoiceStates.RECONNECTING]: {
    state: VoiceStates.RECONNECTING,
    label: 'Reconnecting',
    description: 'Voice connection interrupted. Reconnecting…',
    tone: 'warn',
    stepOrder: 8,
  },
  [VoiceStates.ERROR]: {
    state: VoiceStates.ERROR,
    label: 'Error',
    description: 'Voice session encountered an error.',
    tone: 'error',
    stepOrder: 9,
  },
};

export const ALL_VOICE_STATES: VoiceState[] = [
  VoiceStates.IDLE,
  VoiceStates.REQUESTING_PERMISSION,
  VoiceStates.CONNECTING,
  VoiceStates.LISTENING,
  VoiceStates.PROCESSING,
  VoiceStates.SPEAKING,
  VoiceStates.INTERRUPTED,
  VoiceStates.RECONNECTING,
  VoiceStates.ERROR,
];

const ALLOWED_TRANSITIONS: Record<VoiceState, ReadonlySet<VoiceState>> = {
  idle: new Set([
    VoiceStates.REQUESTING_PERMISSION,
    VoiceStates.CONNECTING,
    VoiceStates.SPEAKING,
    VoiceStates.ERROR,
  ]),
  requesting_permission: new Set([
    VoiceStates.CONNECTING,
    VoiceStates.ERROR,
    VoiceStates.IDLE,
  ]),
  connecting: new Set([
    VoiceStates.LISTENING,
    VoiceStates.RECONNECTING,
    VoiceStates.ERROR,
    VoiceStates.IDLE,
  ]),
  listening: new Set([
    VoiceStates.PROCESSING,
    VoiceStates.SPEAKING,
    VoiceStates.RECONNECTING,
    VoiceStates.ERROR,
    VoiceStates.IDLE,
  ]),
  processing: new Set([
    VoiceStates.SPEAKING,
    VoiceStates.LISTENING,
    VoiceStates.INTERRUPTED,
    VoiceStates.RECONNECTING,
    VoiceStates.ERROR,
    VoiceStates.IDLE,
  ]),
  speaking: new Set([
    VoiceStates.LISTENING,
    VoiceStates.INTERRUPTED,
    VoiceStates.PROCESSING,
    VoiceStates.RECONNECTING,
    VoiceStates.ERROR,
    VoiceStates.IDLE,
  ]),
  interrupted: new Set([
    VoiceStates.LISTENING,
    VoiceStates.PROCESSING,
    VoiceStates.RECONNECTING,
    VoiceStates.ERROR,
    VoiceStates.IDLE,
  ]),
  reconnecting: new Set([
    VoiceStates.CONNECTING,
    VoiceStates.LISTENING,
    VoiceStates.ERROR,
    VoiceStates.IDLE,
  ]),
  error: new Set([
    VoiceStates.IDLE,
    VoiceStates.REQUESTING_PERMISSION,
    VoiceStates.CONNECTING,
    VoiceStates.RECONNECTING,
  ]),
};

export type VoiceStateListener = (state: VoiceState, detail?: string) => void;

/**
 * Deterministic 9-state voice interaction state machine (Section 05).
 */
export class VoiceStateMachine {
  private current: VoiceState = VoiceStates.IDLE;
  private detail: string = VOICE_STATE_META.idle.description;
  private readonly listeners = new Set<VoiceStateListener>();

  public getState(): VoiceState {
    return this.current;
  }

  public getDetail(): string {
    return this.detail;
  }

  public canTransition(next: VoiceState): boolean {
    if (next === this.current) return true;
    return ALLOWED_TRANSITIONS[this.current].has(next);
  }

  public transition(next: VoiceState, customDetail?: string): boolean {
    if (!this.canTransition(next)) {
      return false;
    }
    this.current = next;
    this.detail = customDetail ?? VOICE_STATE_META[next].description;
    for (const listener of this.listeners) {
      listener(this.current, this.detail);
    }
    return true;
  }

  public reset(): void {
    this.current = VoiceStates.IDLE;
    this.detail = VOICE_STATE_META.idle.description;
    for (const listener of this.listeners) {
      listener(this.current, this.detail);
    }
  }

  public subscribe(listener: VoiceStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
