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

export function resolveFreeVoiceLanguages(languageMode: LanguageMode): string[] {
  if (languageMode === 'bn') return ['bn-BD', 'en-US'];
  if (languageMode === 'en') return ['en-US'];
  const browserLang =
    typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : '';
  return browserLang.startsWith('bn') ? ['bn-BD', 'en-US'] : ['en-US', 'bn-BD'];
}

export function speakWithBrowserSpeechSynthesis(
  text: string,
  options: {
    volume: number;
    speakingRate: number;
    languageMode: LanguageMode;
    voiceOutputEnabled?: boolean;
    onStart?: () => void;
    onEnd?: () => void;
    onError?: (msg: string) => void;
  },
): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    options.onEnd?.();
    return false;
  }
  if (options.voiceOutputEnabled === false) {
    options.onEnd?.();
    return false;
  }
  const UtteranceCtor =
    typeof window !== 'undefined'
      ? ((
          window as unknown as {
            SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
          }
        ).SpeechSynthesisUtterance ??
        (typeof SpeechSynthesisUtterance !== 'undefined' ? SpeechSynthesisUtterance : null))
      : null;

  if (typeof window === 'undefined' || !('speechSynthesis' in window) || !UtteranceCtor) {
    options.onError?.('Browser speech synthesis is unavailable.');
    options.onEnd?.();
    return false;
  }

  window.speechSynthesis.cancel();
  const utterance = new UtteranceCtor(trimmed.slice(0, 1200));
  const hasBengaliScript = /[\u0980-\u09FF]/.test(trimmed);
  utterance.lang = hasBengaliScript || options.languageMode === 'bn' ? 'bn-BD' : 'en-US';
  utterance.volume = Math.max(0, Math.min(1, options.volume));
  utterance.rate = Math.max(0.7, Math.min(1.6, options.speakingRate));

  const voices =
    typeof window.speechSynthesis.getVoices === 'function'
      ? window.speechSynthesis.getVoices()
      : [];
  const prefix = utterance.lang.split('-')[0]!.toLowerCase();
  const matchedVoice = voices.find((v) => v.lang.toLowerCase().startsWith(prefix));
  if (matchedVoice) {
    utterance.voice = matchedVoice;
  }

  utterance.onend = () => {
    options.onEnd?.();
  };
  utterance.onerror = () => {
    options.onEnd?.();
  };

  options.onStart?.();
  window.speechSynthesis.speak(utterance);
  return true;
}

export interface FreeBrowserVoiceController {
  stop: () => void;
  interrupt: () => void;
}

export type WebSpeechUnavailableReason = 'unsupported' | 'network' | 'service-not-allowed';

/**
 * Shared Browser SpeechSynthesis reply speaker used by both Web Speech and Server STT fallbacks.
 */
export function speakVoiceReply(
  replyText: string,
  options: {
    volume: number;
    speakingRate: number;
    languageMode: LanguageMode;
    voiceOutputEnabled: boolean;
    onStateChange: (state: VoiceState, detail: string) => void;
    onFinish: () => void;
    isStopped?: () => boolean;
    statusPrefix?: string;
  },
): boolean {
  const prefix = options.statusPrefix ? `${options.statusPrefix} · ` : '';
  const spoke = speakWithBrowserSpeechSynthesis(replyText, {
    volume: options.volume,
    speakingRate: options.speakingRate,
    languageMode: options.languageMode,
    voiceOutputEnabled: options.voiceOutputEnabled,
    onStart: () => {
      if (options.isStopped?.()) return;
      options.onStateChange(
        VoiceStates.SPEAKING,
        `${prefix}Speaking via Free Browser TTS ($0.00)…`,
      );
    },
    onEnd: () => {
      if (!options.isStopped?.()) {
        options.onStateChange(VoiceStates.IDLE, 'Ready');
        options.onFinish();
      }
    },
  });
  if (!spoke && !options.isStopped?.()) {
    options.onStateChange(VoiceStates.IDLE, 'Ready');
    options.onFinish();
  }
  return spoke;
}

export function startFreeBrowserVoiceSession(params: {
  languageMode: LanguageMode;
  volume: number;
  speakingRate: number;
  voiceOutputEnabled: boolean;
  statusPrefix?: string;
  onStateChange: (state: VoiceState, detail: string) => void;
  onTranscriptPreview: (text: string) => void;
  onSubmitTranscript: (text: string) => Promise<string>;
  onFinish: () => void;
  onErrorMessage: (msg: string) => void;
  onUnavailable?: (reason: WebSpeechUnavailableReason, detail: string) => void;
}): FreeBrowserVoiceController {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    if (params.onUnavailable) {
      params.onUnavailable('unsupported', 'Web Speech unavailable in this browser.');
    } else {
      params.onErrorMessage(
        'Web Speech unavailable in this browser. Chrome or Edge supports Web Speech, or use Server STT.',
      );
      params.onFinish();
    }
    return { stop: () => {}, interrupt: () => {} };
  }

  let stopped = false;
  let handledFinal = false;
  const candidateLangs = resolveFreeVoiceLanguages(params.languageMode);
  let langIdx = 0;
  let recognition: BrowserSpeechRecognition;

  const startRecognitionPass = () => {
    const activeLang = candidateLangs[langIdx] ?? 'en-US';
    recognition = new Ctor();
    recognition.lang = activeLang;
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    const prefix = params.statusPrefix ? `${params.statusPrefix} · ` : '';
    params.onStateChange(
      VoiceStates.LISTENING,
      `${prefix}Listening (Free Browser Voice · ${activeLang} · $0.00)… Speak now`,
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
            speakVoiceReply(replyText, {
              volume: params.volume,
              speakingRate: params.speakingRate,
              languageMode: params.languageMode,
              voiceOutputEnabled: params.voiceOutputEnabled,
              onStateChange: params.onStateChange,
              onFinish: params.onFinish,
              isStopped: () => stopped,
            });
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
      if (
        (errType === 'language-not-supported' || errType === 'no-speech') &&
        langIdx + 1 < candidateLangs.length
      ) {
        langIdx += 1;
        startRecognitionPass();
        return;
      }
      if (errType === 'network' || errType === 'service-not-allowed') {
        handledFinal = true;
        try {
          recognition.abort();
        } catch {
          // ignore abort race
        }
        if (params.onUnavailable) {
          params.onUnavailable(errType, `Web Speech unavailable (${errType}).`);
        } else {
          params.onErrorMessage(`Web Speech unavailable (${errType}).`);
          params.onFinish();
        }
        return;
      }
      if (errType === 'not-allowed') {
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
  };

  startRecognitionPass();

  return {
    stop: () => {
      stopped = true;
      try {
        recognition?.abort();
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
