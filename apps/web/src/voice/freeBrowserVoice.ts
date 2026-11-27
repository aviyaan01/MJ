import { VoiceStates, type LanguageMode, type VoiceState } from '@mj/shared';

interface BrowserSpeechRecognitionResult {
  isFinal: boolean;
  0?: { transcript?: string };
}

interface BrowserSpeechRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<BrowserSpeechRecognitionResult>;
}

interface BrowserSpeechRecognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((ev: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

export function isFreeBrowserVoiceSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

export interface FreeBrowserVoiceController {
  stop: () => void;
  interrupt: () => void;
}

export function startFreeBrowserVoiceSession(params: {
  languageMode: LanguageMode;
  volume: number;
  speakingRate: number;
  voiceOutputEnabled: boolean;
  onStateChange: (state: VoiceState, detail: string) => void;
  onTranscriptPreview: (text: string) => void;
  onSubmitTranscript: (text: string) => Promise<string>;
  onFinish: () => void;
  onErrorMessage: (msg: string) => void;
}): FreeBrowserVoiceController {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    params.onErrorMessage('Browser speech recognition is unavailable in this browser.');
    params.onFinish();
    return { stop: () => {}, interrupt: () => {} };
  }

  let stopped = false;
  let handledFinal = false;
  const recognition = new Ctor();
  recognition.lang = params.languageMode === 'bn' ? 'bn-BD' : 'en-US';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  params.onStateChange(
    VoiceStates.LISTENING,
    'Listening (Free Browser Voice · $0.00)… Speak now',
  );

  recognition.onresult = (event) => {
    if (stopped) return;
    let transcript = '';
    let isFinal = false;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const item = event.results[i];
      if (item?.[0]?.transcript) {
        transcript += item[0].transcript;
      }
      if (item?.isFinal) isFinal = true;
    }
    const trimmed = transcript.trim();
    if (!trimmed) return;
    params.onTranscriptPreview(trimmed);

    if (isFinal && !handledFinal) {
      handledFinal = true;
      try {
        recognition.stop();
      } catch {
        // ignore stop race
      }
      params.onStateChange(
        VoiceStates.PROCESSING,
        'Thinking via free AI provider…',
      );
      void (async () => {
        try {
          const replyText = await params.onSubmitTranscript(trimmed);
          if (stopped) return;
          if (
            params.voiceOutputEnabled &&
            replyText.trim() &&
            typeof window !== 'undefined' &&
            'speechSynthesis' in window
          ) {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(replyText.slice(0, 1200));
            utterance.volume = Math.max(0, Math.min(1, params.volume));
            utterance.rate = Math.max(0.7, Math.min(1.6, params.speakingRate));
            params.onStateChange(
              VoiceStates.SPEAKING,
              'Speaking via Free Browser TTS ($0.00)…',
            );
            utterance.onend = () => {
              if (!stopped) {
                params.onStateChange(VoiceStates.IDLE, 'Ready');
                params.onFinish();
              }
            };
            utterance.onerror = () => {
              if (!stopped) {
                params.onStateChange(VoiceStates.IDLE, 'Ready');
                params.onFinish();
              }
            };
            window.speechSynthesis.speak(utterance);
          } else {
            params.onStateChange(VoiceStates.IDLE, 'Ready');
            params.onFinish();
          }
        } catch (err) {
          if (!stopped) {
            params.onErrorMessage(
              err instanceof Error ? err.message : 'Free voice turn failed.',
            );
            params.onFinish();
          }
        }
      })();
    }
  };

  recognition.onerror = (ev) => {
    if (stopped || handledFinal) return;
    const errType = ev.error ?? 'unknown';
    if (errType === 'aborted') return;
    if (errType === 'not-allowed' || errType === 'service-not-allowed') {
      params.onErrorMessage('Microphone permission denied in browser.');
    } else if (errType === 'no-speech') {
      params.onStateChange(VoiceStates.IDLE, 'No speech detected.');
    } else {
      params.onErrorMessage(`Browser speech error: ${errType}`);
    }
    params.onFinish();
  };

  recognition.onend = () => {
    if (!stopped && !handledFinal) {
      params.onStateChange(VoiceStates.IDLE, 'Ready');
      params.onFinish();
    }
  };

  try {
    recognition.start();
  } catch (err) {
    params.onErrorMessage(err instanceof Error ? err.message : 'Could not start speech input.');
    params.onFinish();
  }

  return {
    stop: () => {
      stopped = true;
      try {
        recognition.abort();
      } catch {
        // ignore abort error
      }
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      params.onStateChange(VoiceStates.IDLE, 'Ready');
      params.onFinish();
    },
    interrupt: () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      params.onStateChange(VoiceStates.IDLE, 'Ready');
      params.onFinish();
    },
  };
}
