export interface WakeWordStatus {
  active: boolean;
  supported: boolean;
  message: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
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
 * Optional Wake-Word Standby Listener (Section 14).
 * Always ships OFF; only runs when explicitly enabled by the user AND
 * microphoneAccess is granted. Never fakes listening if browser API is missing.
 */
export class WakeWordListener {
  private recognition: SpeechRecognitionLike | null = null;
  private shouldRun = false;
  private active = false;

  constructor(
    private readonly onWakeDetected: (transcript: string) => void,
    private readonly onStatusChange: (status: WakeWordStatus) => void,
  ) {}

  public isSupported(): boolean {
    return getSpeechRecognitionCtor() !== null;
  }

  public isActive(): boolean {
    return this.active;
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

    if (this.shouldRun && this.active) return true;
    this.shouldRun = true;

    const startInstance = () => {
      if (!this.shouldRun) return;
      try {
        const rec = new Ctor();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = 'en-US';

        rec.onresult = (event) => {
          const idx = event.results.length - 1;
          const result = event.results[idx];
          const text = result?.[0]?.transcript?.trim().toLowerCase() ?? '';
          if (
            text.includes('hey mj') ||
            text.includes('hi mj') ||
            text.includes('okay mj') ||
            text.includes('mj assistant')
          ) {
            this.stop();
            this.onWakeDetected(text);
          }
        };

        rec.onerror = (ev) => {
          if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
            this.shouldRun = false;
            this.active = false;
            this.onStatusChange({
              active: false,
              supported: true,
              message: 'Microphone permission denied for wake-word standby.',
            });
          }
        };

        rec.onend = () => {
          this.active = false;
          if (this.shouldRun) {
            setTimeout(() => startInstance(), 400);
          } else {
            this.onStatusChange({
              active: false,
              supported: true,
              message: 'Wake-word standby is OFF.',
            });
          }
        };

        this.recognition = rec;
        rec.start();
        this.active = true;
        this.onStatusChange({
          active: true,
          supported: true,
          message: 'Wake-word standby active — listening for "Hey MJ".',
        });
      } catch {
        this.active = false;
        this.shouldRun = false;
        this.onStatusChange({
          active: false,
          supported: true,
          message: 'Could not start wake-word microphone listener.',
        });
      }
    };

    startInstance();
    return true;
  }

  public stop(): void {
    this.shouldRun = false;
    this.active = false;
    if (this.recognition) {
      try {
        this.recognition.onend = null;
        this.recognition.stop();
      } catch {
        // ignore stop errors
      }
      this.recognition = null;
    }
    this.onStatusChange({
      active: false,
      supported: this.isSupported(),
      message: 'Wake-word standby is OFF.',
    });
  }
}
