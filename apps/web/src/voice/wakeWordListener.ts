import type { LanguageMode } from '@mj/shared';

export interface WakeWordStatus {
  active: boolean;
  supported: boolean;
  message: string;
  activeLanguage?: string;
}

export interface WakeWordOptions {
  languageMode?: LanguageMode;
  languages?: string[];
  phrases?: string[];
  canRun?: () => boolean;
}

export const BROWSER_CLICK_REQUIRED_MESSAGE =
  'Browser requires one click to grant microphone access before wake-word standby can start.';

export const DEFAULT_WAKE_PHRASES: readonly string[] = [
  // English & Banglish
  'hey mj',
  'hi mj',
  'hello mj',
  'ok mj',
  'okay mj',
  'mj assistant',
  'ei mj',
  'shuno mj',
  'mj shuno',
  'sun mj',
  // Bangla
  'হেই এমজে',
  'হে এমজে',
  'হাই এমজে',
  'হ্যালো এমজে',
  'ওকে এমজে',
  'শুনো এমজে',
  'এই এমজে',
  'হেই এম জে',
  'এমজে',
  // Hindi
  'हे एमजे',
  'हाय एमजे',
  'हेलो एमजे',
  'नमस्ते एमजे',
  'ओके एमजे',
  'सुनो एमजे',
  'अरे एमजे',
  'हे एम जे',
];

export function resolveWakeWordLanguages(options?: {
  languageMode?: LanguageMode;
  languages?: string[];
}): string[] {
  if (options?.languages && options.languages.length > 0) {
    return Array.from(new Set(options.languages.map((l) => l.trim()).filter(Boolean)));
  }
  switch (options?.languageMode) {
    case 'bn':
      return ['bn-BD', 'en-US', 'hi-IN'];
    case 'en':
    case 'banglish':
      return ['en-US', 'bn-BD', 'hi-IN'];
    case 'auto':
    default: {
      const browserLang =
        typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : '';
      if (browserLang.startsWith('bn')) {
        return ['bn-BD', 'en-US', 'hi-IN'];
      }
      if (browserLang.startsWith('hi')) {
        return ['hi-IN', 'en-US', 'bn-BD'];
      }
      return ['en-US', 'bn-BD', 'hi-IN'];
    }
  }
}

export function normalizeWakeTranscript(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\bm\.?\s*j\.?\b/g, 'mj')
    .replace(/\b(?:em\s+jay|emjay)\b/g, 'mj')
    .replace(/এম\s*জে/g, 'এমজে')
    .replace(/एम\s*जे/g, 'एमजे')
    .replace(/[.,!?।,:;'"()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchWakePhrase(
  transcript: string,
  phrases: readonly string[] = DEFAULT_WAKE_PHRASES,
): string | null {
  const normalizedTranscript = normalizeWakeTranscript(transcript);
  if (!normalizedTranscript) return null;
  const paddedTranscript = ` ${normalizedTranscript} `;

  for (const phrase of phrases) {
    const normalizedPhrase = normalizeWakeTranscript(phrase);
    if (!normalizedPhrase) continue;
    if (paddedTranscript.includes(` ${normalizedPhrase} `)) {
      return normalizedPhrase;
    }
  }
  return null;
}

export function canAutoStartWakeWordAtLaunch(ctx: {
  authenticated: boolean;
  isTauriDesktop: boolean;
  wakeWordStandby: boolean;
  microphoneAccess: boolean;
  voiceSessionAccess: boolean;
  hasBrowserUserGesture: boolean;
  browserMicPermission?: 'granted' | 'prompt' | 'denied' | 'unknown';
  micActive: boolean;
}): {
  allowed: boolean;
  reason:
  | 'unauthenticated_or_busy'
  | 'permission_off'
  | 'tauri_standby_enabled'
  | 'browser_permission_denied'
  | 'browser_click_required'
  | 'browser_gesture_or_granted';
} {
  if (!ctx.authenticated || ctx.micActive) {
    return { allowed: false, reason: 'unauthenticated_or_busy' };
  }
  if (!ctx.wakeWordStandby || !ctx.microphoneAccess || !ctx.voiceSessionAccess) {
    return { allowed: false, reason: 'permission_off' };
  }
  if (ctx.isTauriDesktop) {
    return { allowed: true, reason: 'tauri_standby_enabled' };
  }
  if (ctx.browserMicPermission === 'denied') {
    return { allowed: false, reason: 'browser_permission_denied' };
  }
  if (ctx.hasBrowserUserGesture || ctx.browserMicPermission === 'granted') {
    return { allowed: true, reason: 'browser_gesture_or_granted' };
  }
  return { allowed: false, reason: 'browser_click_required' };
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives?: number;
  lang: string;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Optional Multilingual Wake-Word Standby Listener (Section 14).
 * Always ships OFF; supports English, বাংলা, Banglish & हिन्दी phrases across restarts.
 * Browsers require one user click to grant microphone access; Tauri desktop allows startup
 * standby only when `wakeWordStandby` is explicitly enabled.
 */
export class WakeWordListener {
  private recognition: SpeechRecognitionLike | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldRun = false;
  private active = false;
  private langIndex = 0;
  private consecutiveErrors = 0;
  private disabledLanguages = new Set<string>();
  private options: WakeWordOptions;

  constructor(
    private readonly onWakeDetected: (transcript: string) => void,
    private readonly onStatusChange: (status: WakeWordStatus) => void,
    initialOptions: WakeWordOptions = {},
  ) {
    this.options = { ...initialOptions };
  }

  public isSupported(): boolean {
    return getSpeechRecognitionCtor() !== null;
  }

  public isActive(): boolean {
    return this.active;
  }

  public updateOptions(partial: Partial<WakeWordOptions>): void {
    this.options = { ...this.options, ...partial };
    this.disabledLanguages.clear();
    this.langIndex = 0;
  }

  private getCandidateLanguages(): string[] {
    const all = resolveWakeWordLanguages({
      languageMode: this.options.languageMode,
      languages: this.options.languages,
    });
    const enabled = all.filter((l) => !this.disabledLanguages.has(l));
    return enabled.length > 0 ? enabled : all;
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private scheduleRestart(delayMs: number, startInstanceFn: () => void): void {
    this.clearRestartTimer();
    if (!this.shouldRun) return;
    if (this.options.canRun && !this.options.canRun()) {
      this.stop();
      return;
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      startInstanceFn();
    }, delayMs);
  }

  public start(): boolean {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      this.active = false;
      this.shouldRun = false;
      this.onStatusChange({
        active: false,
        supported: false,
        message:
          'Wake-word standby requires SpeechRecognition support (Chrome/Edge) or Tauri desktop audio.',
      });
      return false;
    }

    if (this.options.canRun && !this.options.canRun()) {
      this.stop();
      return false;
    }

    if (this.shouldRun && (this.active || this.restartTimer !== null)) return true;
    this.shouldRun = true;
    this.consecutiveErrors = 0;

    const startInstance = () => {
      if (!this.shouldRun) return;
      if (this.options.canRun && !this.options.canRun()) {
        this.stop();
        return;
      }

      this.clearRestartTimer();

      const langs = this.getCandidateLanguages();
      const activeLang = langs[this.langIndex % langs.length] ?? 'en-US';
      const phrases =
        this.options.phrases && this.options.phrases.length > 0
          ? this.options.phrases
          : DEFAULT_WAKE_PHRASES;

      let rec: SpeechRecognitionLike;
      try {
        rec = new Ctor();
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 3;
        rec.lang = activeLang;

        let waitingRetryStatus: string | null = null;
        let retryDelayMs = 350;
        let skipRestartOnEnd = false;

        rec.onresult = (event) => {
          if (this.recognition !== rec || !this.shouldRun) return;
          this.consecutiveErrors = 0;

          for (let i = 0; i < event.results.length; i++) {
            const altList = event.results[i];
            if (!altList) continue;
            for (let a = 0; a < altList.length; a++) {
              const transcript = altList[a]?.transcript ?? '';
              const matched = matchWakePhrase(transcript, phrases);
              if (matched) {
                this.stop();
                this.onWakeDetected(transcript.trim().toLowerCase() || matched);
                return;
              }
            }
          }
        };

        rec.onerror = (ev) => {
          if (this.recognition !== rec || !this.shouldRun) return;
          const errType = ev.error ?? 'unknown';

          if (errType === 'not-allowed' || errType === 'service-not-allowed') {
            skipRestartOnEnd = true;
            this.shouldRun = false;
            this.active = false;
            this.recognition = null;
            this.clearRestartTimer();
            this.onStatusChange({
              active: false,
              supported: true,
              message:
                'Microphone permission denied for wake-word standby (browser requires one click to grant microphone access).',
            });
            return;
          }

          if (errType === 'audio-capture') {
            skipRestartOnEnd = true;
            this.shouldRun = false;
            this.active = false;
            this.recognition = null;
            this.clearRestartTimer();
            this.onStatusChange({
              active: false,
              supported: true,
              message: 'No microphone available for wake-word standby.',
            });
            return;
          }

          if (errType === 'language-not-supported') {
            if (langs.length > 1) {
              this.disabledLanguages.add(activeLang);
            }
            retryDelayMs = 250;
            waitingRetryStatus = `Wake-word switching recognition language from ${activeLang}…`;
            return;
          }

          if (errType === 'network') {
            this.consecutiveErrors += 1;
            retryDelayMs = Math.min(15_000, 1_500 * 2 ** Math.min(this.consecutiveErrors - 1, 3));
            waitingRetryStatus = `Wake-word standby reconnecting (${errType}, retry ${this.consecutiveErrors})…`;
            this.onStatusChange({
              active: false,
              supported: true,
              activeLanguage: activeLang,
              message: waitingRetryStatus,
            });
            return;
          }

          if (errType === 'no-speech' || errType === 'aborted') {
            retryDelayMs = 300;
            return;
          }

          this.consecutiveErrors += 1;
          retryDelayMs = Math.min(8_000, 800 * 2 ** Math.min(this.consecutiveErrors - 1, 3));
          waitingRetryStatus = `Wake-word standby restarting after speech error (${errType})…`;
        };

        rec.onend = () => {
          if (this.recognition !== rec) return;
          this.active = false;
          this.recognition = null;
          if (skipRestartOnEnd || !this.shouldRun) {
            if (!skipRestartOnEnd) {
              this.onStatusChange({
                active: false,
                supported: true,
                message: 'Wake-word standby is OFF.',
              });
            }
            return;
          }

          if (this.options.canRun && !this.options.canRun()) {
            this.stop();
            return;
          }

          if (!waitingRetryStatus && langs.length > 1) {
            this.langIndex += 1;
          }
          if (waitingRetryStatus) {
            this.onStatusChange({
              active: false,
              supported: true,
              activeLanguage: activeLang,
              message: waitingRetryStatus,
            });
          }
          this.scheduleRestart(retryDelayMs, startInstance);
        };

        this.recognition = rec;
        rec.start();
        this.active = true;
        this.onStatusChange({
          active: true,
          supported: true,
          activeLanguage: activeLang,
          message: `Wake-word standby active (${activeLang}) — say "Hey MJ", "হেই এমজে", or "हे एमजे".`,
        });
      } catch {
        this.active = false;
        this.recognition = null;
        this.consecutiveErrors += 1;
        if (this.consecutiveErrors <= 3 && this.shouldRun) {
          this.onStatusChange({
            active: false,
            supported: true,
            activeLanguage: activeLang,
            message: 'Wake-word listener restarting…',
          });
          this.scheduleRestart(500 * this.consecutiveErrors, startInstance);
        } else {
          this.shouldRun = false;
          this.onStatusChange({
            active: false,
            supported: true,
            message:
              'Could not start wake-word microphone listener (click once in browser to grant mic access).',
          });
        }
      }
    };

    startInstance();
    return true;
  }

  public stop(): void {
    this.shouldRun = false;
    this.active = false;
    this.clearRestartTimer();
    const rec = this.recognition;
    this.recognition = null;
    if (rec) {
      try {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        if (typeof rec.abort === 'function') {
          rec.abort();
        } else {
          rec.stop();
        }
      } catch {
        // ignore stop errors
      }
    }
    this.onStatusChange({
      active: false,
      supported: this.isSupported(),
      message: 'Wake-word standby is OFF.',
    });
  }
}
