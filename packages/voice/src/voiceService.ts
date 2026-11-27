import {
  AppError,
  ErrorCodes,
  VoiceStates,
  type LanguageMode,
  type StructuredErrorPayload,
  type VoiceClientSecretDTO,
  type VoiceState,
} from '@mj/shared';
import {
  XAI_REALTIME_SAMPLE_RATE,
  computeRmsLevel,
  float32ToPcm16Base64,
  pcm16Base64ToFloat32,
  resampleFloat32,
} from './audioCodec.js';
import { VoiceStateMachine } from './voiceStateMachine.js';

export interface VoiceAudioLevels {
  inputLevel: number;
  outputLevel: number;
}

export interface VoiceServiceCallbacks {
  fetchClientSecret: () => Promise<VoiceClientSecretDTO>;
  fetchTtsAudio?: (text: string, signal: AbortSignal) => Promise<ArrayBuffer>;
  onStateChange?: (state: VoiceState, detail: string) => void;
  onMuteChange?: (muted: boolean) => void;
  onAudioLevel?: (levels: VoiceAudioLevels) => void;
  onUserTranscript?: (transcript: string) => void;
  onAssistantTranscriptDelta?: (delta: string) => void;
  onAssistantTranscriptDone?: (fullText: string) => void;
  onError?: (error: StructuredErrorPayload) => void;
  onSessionEnded?: (summary: {
    durationSeconds: number;
    status: 'success' | 'error' | 'aborted';
    errorCode?: string;
  }) => void;
}

export interface VoiceRuntimeOptions {
  voiceId: string;
  languageMode: LanguageMode;
  speakingRate: number;
  volume: number;
  voiceOutputEnabled: boolean;
}

const WORKLET_PROCESSOR_CODE = `
class MjMicCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}
registerProcessor('mj-mic-capture-processor', MjMicCaptureProcessor);
`;

const MAX_RECONNECT_ATTEMPTS = 2;

export class MjVoiceService {
  private readonly stateMachine = new VoiceStateMachine();
  private readonly callbacks: VoiceServiceCallbacks;
  private options: VoiceRuntimeOptions;

  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  private captureNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  private muteSinkNode: GainNode | null = null;
  private outputGainNode: GainNode | null = null;
  private outputAnalyserNode: AnalyserNode | null = null;
  private workletBlobUrl: string | null = null;

  private ws: WebSocket | null = null;
  private activeSources = new Set<AudioBufferSourceNode>();
  private nextPlaybackTime = 0;
  private levelRafId: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackTtsAbort: AbortController | null = null;
  private fallbackAudioBufferSource: AudioBufferSourceNode | null = null;

  private isMuted = false;
  private manualStop = false;
  private reconnectAttempts = 0;
  private sessionStartedAtMs: number | null = null;
  private currentInputLevel = 0;
  private currentAssistantTranscript = '';
  private lastAssistantText = '';
  private responseActive = false;

  constructor(callbacks: VoiceServiceCallbacks, initialOptions: VoiceRuntimeOptions) {
    this.callbacks = callbacks;
    this.options = { ...initialOptions };

    this.stateMachine.subscribe((state, detail) => {
      this.callbacks.onStateChange?.(state, detail ?? '');
    });
  }

  public getState(): VoiceState {
    return this.stateMachine.getState();
  }

  public getMuted(): boolean {
    return this.isMuted;
  }

  public getLastAssistantText(): string {
    return this.lastAssistantText;
  }

  public setLastAssistantText(text: string): void {
    this.lastAssistantText = text;
  }

  public updateOptions(partial: Partial<VoiceRuntimeOptions>): void {
    this.options = { ...this.options, ...partial };

    if (this.outputGainNode && this.audioContext) {
      const targetGain = this.options.voiceOutputEnabled ? this.options.volume : 0;
      this.outputGainNode.gain.setTargetAtTime(
        targetGain,
        this.audioContext.currentTime,
        0.02,
      );
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN && (partial.voiceId || partial.languageMode)) {
      // Voice/language updates apply cleanly on next session or live session update if supported
    }
  }

  public async startSession(): Promise<void> {
    const current = this.stateMachine.getState();
    if (
      current === VoiceStates.REQUESTING_PERMISSION ||
      current === VoiceStates.CONNECTING ||
      current === VoiceStates.LISTENING ||
      current === VoiceStates.PROCESSING ||
      current === VoiceStates.SPEAKING
    ) {
      return;
    }

    this.manualStop = false;
    this.reconnectAttempts = 0;
    this.isMuted = false;
    this.callbacks.onMuteChange?.(false);

    // Step 1: Explicit browser microphone permission request
    this.stateMachine.transition(VoiceStates.REQUESTING_PERMISSION);

    try {
      await this.initAudioAndMic();
    } catch (err) {
      const mapped = mapBrowserVoiceError(err);
      this.emitVoiceError(mapped);
      await this.teardownAudioOnly();
      return;
    }

    // Step 2: Connect WebSocket with backend-issued ephemeral token
    this.sessionStartedAtMs = Date.now();
    await this.openRealtimeSocket(false);
  }

  public async stopSession(reason: 'manual' | 'error' = 'manual'): Promise<void> {
    this.manualStop = reason === 'manual';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopFallbackTts();
    this.flushPlaybackQueue();
    this.closeSocketCleanly();
    await this.teardownAudioOnly();

    const startedAt = this.sessionStartedAtMs;
    this.sessionStartedAtMs = null;

    if (startedAt !== null) {
      const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      this.callbacks.onSessionEnded?.({
        durationSeconds,
        status: reason === 'manual' ? 'success' : 'error',
      });
    }

    this.currentInputLevel = 0;
    this.callbacks.onAudioLevel?.({ inputLevel: 0, outputLevel: 0 });
    this.isMuted = false;
    this.callbacks.onMuteChange?.(false);

    if (reason === 'manual') {
      this.stateMachine.reset();
    }
  }

  public setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (this.mediaStream) {
      for (const track of this.mediaStream.getAudioTracks()) {
        track.enabled = !muted;
      }
    }
    if (muted) {
      this.currentInputLevel = 0;
      this.callbacks.onAudioLevel?.({ inputLevel: 0, outputLevel: this.measureOutputLevel() });
    }
    this.callbacks.onMuteChange?.(muted);
  }

  public toggleMute(): boolean {
    this.setMuted(!this.isMuted);
    return this.isMuted;
  }

  public interrupt(): void {
    this.stopFallbackTts();
    this.flushPlaybackQueue();

    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.responseActive) {
      this.ws.send(JSON.stringify({ type: 'response.cancel' }));
    }

    this.responseActive = false;
    const current = this.stateMachine.getState();
    if (current === VoiceStates.SPEAKING || current === VoiceStates.PROCESSING) {
      this.stateMachine.transition(VoiceStates.INTERRUPTED);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        setTimeout(() => {
          if (this.stateMachine.getState() === VoiceStates.INTERRUPTED) {
            this.stateMachine.transition(VoiceStates.LISTENING);
          }
        }, 250);
      } else {
        this.stateMachine.reset();
      }
    }
  }

  /**
   * Plays text aloud using xAI TTS fallback (`POST /api/voice/tts`).
   * Used for "Repeat Response" or "Read Aloud" in text chat.
   */
  public async speakTextViaTts(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!this.options.voiceOutputEnabled) {
      throw new AppError({
        code: ErrorCodes.AUDIO_PLAYBACK_FAILED,
        category: 'voice',
        statusCode: 400,
        message: 'Voice output is currently disabled in Settings -> Voice.',
        retryable: false,
      });
    }
    if (!this.callbacks.fetchTtsAudio) {
      throw new AppError({
        code: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
        category: 'voice',
        statusCode: 503,
      });
    }

    this.lastAssistantText = trimmed;
    this.stopFallbackTts();
    this.flushPlaybackQueue();

    const controller = new AbortController();
    this.fallbackTtsAbort = controller;

    try {
      const ctx = await this.ensurePlaybackContext();
      this.stateMachine.transition(VoiceStates.SPEAKING, 'Speaking response…');
      this.startOutputLevelLoop();

      const audioBytes = await this.callbacks.fetchTtsAudio(trimmed, controller.signal);
      if (controller.signal.aborted) return;

      const decoded = await ctx.decodeAudioData(audioBytes.slice(0));
      if (controller.signal.aborted) return;

      const source = ctx.createBufferSource();
      source.buffer = decoded;
      source.playbackRate.value = this.options.speakingRate;
      source.connect(this.outputGainNode!);

      this.fallbackAudioBufferSource = source;
      source.onended = () => {
        if (this.fallbackAudioBufferSource === source) {
          this.fallbackAudioBufferSource = null;
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.stateMachine.transition(VoiceStates.LISTENING);
          } else if (this.stateMachine.getState() === VoiceStates.SPEAKING) {
            this.stateMachine.reset();
          }
        }
      };
      source.start();
    } catch (err) {
      if (controller.signal.aborted) return;
      const appErr = toVoiceAppError(err, ErrorCodes.AUDIO_PLAYBACK_FAILED, 'voice');
      this.emitVoiceError(appErr);
    }
  }

  public async repeatLastResponse(): Promise<void> {
    if (!this.lastAssistantText) return;
    await this.speakTextViaTts(this.lastAssistantText);
  }

  private async openRealtimeSocket(isReconnect: boolean): Promise<void> {
    this.stateMachine.transition(
      isReconnect ? VoiceStates.RECONNECTING : VoiceStates.CONNECTING,
    );

    let secret: VoiceClientSecretDTO;
    try {
      secret = await this.callbacks.fetchClientSecret();
    } catch (err) {
      const appErr = toVoiceAppError(err, ErrorCodes.VOICE_SERVICE_UNAVAILABLE, 'voice');
      this.emitVoiceError(appErr);
      await this.stopSession('error');
      return;
    }

    if (this.manualStop) return;

    const wsUrl = secret.realtimeUrl.includes('?')
      ? secret.realtimeUrl
      : `${secret.realtimeUrl}?model=${encodeURIComponent(secret.model)}`;

    let opened = false;
    const socket = new WebSocket(wsUrl, [`xai-client-secret.${secret.token}`]);
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket || this.manualStop) {
        socket.close();
        return;
      }
      opened = true;
      this.reconnectAttempts = 0;

      const sessionUpdatePayload = {
        type: 'session.update',
        session: {
          voice: secret.voice || this.options.voiceId,
          instructions: secret.instructions,
          turn_detection: {
            type: 'server_vad',
          },
          audio: {
            input: {
              format: {
                type: 'audio/pcm',
                rate: XAI_REALTIME_SAMPLE_RATE,
              },
            },
            output: {
              format: {
                type: 'audio/pcm',
                rate: XAI_REALTIME_SAMPLE_RATE,
              },
            },
          },
        },
      };

      socket.send(JSON.stringify(sessionUpdatePayload));
      this.stateMachine.transition(VoiceStates.LISTENING);
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      this.handleRealtimeServerEvent(event.data);
    };

    socket.onerror = () => {
      if (!opened && !this.manualStop) {
        this.emitVoiceError(
          new AppError({
            code: ErrorCodes.WEBSOCKET_CONNECTION_FAILED,
            category: 'voice',
            statusCode: 502,
          }),
        );
      }
    };

    socket.onclose = (closeEvent) => {
      if (this.ws !== socket) return;
      this.ws = null;

      if (this.manualStop || closeEvent.code === 1000) {
        return;
      }

      if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts += 1;
        this.stateMachine.transition(
          VoiceStates.RECONNECTING,
          `Voice connection interrupted. Reconnecting (${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`,
        );
        const delayMs = Math.min(4000, 700 * 2 ** (this.reconnectAttempts - 1)) + Math.random() * 350;
        this.reconnectTimer = setTimeout(() => {
          void this.openRealtimeSocket(true);
        }, delayMs);
      } else {
        this.emitVoiceError(
          new AppError({
            code: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
            category: 'voice',
            statusCode: 503,
            retryable: true,
          }),
        );
        void this.stopSession('error');
      }
    };
  }

  private handleRealtimeServerEvent(rawJson: string): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawJson) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = typeof payload.type === 'string' ? payload.type : '';

    if (type === 'input_audio_buffer.speech_started') {
      // Barge-in when user starts speaking while MJ is speaking
      if (
        this.stateMachine.getState() === VoiceStates.SPEAKING ||
        this.activeSources.size > 0
      ) {
        this.flushPlaybackQueue();
        this.responseActive = false;
        this.stateMachine.transition(VoiceStates.INTERRUPTED);
        setTimeout(() => {
          if (
            this.stateMachine.getState() === VoiceStates.INTERRUPTED &&
            this.ws?.readyState === WebSocket.OPEN
          ) {
            this.stateMachine.transition(VoiceStates.LISTENING);
          }
        }, 180);
      } else {
        this.stateMachine.transition(VoiceStates.LISTENING);
      }
      return;
    }

    if (type === 'input_audio_buffer.speech_stopped') {
      this.stateMachine.transition(VoiceStates.PROCESSING);
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = typeof payload.transcript === 'string' ? payload.transcript.trim() : '';
      if (transcript) {
        this.callbacks.onUserTranscript?.(transcript);
      }
      return;
    }

    if (type === 'response.created') {
      this.responseActive = true;
      this.currentAssistantTranscript = '';
      if (this.stateMachine.getState() !== VoiceStates.SPEAKING) {
        this.stateMachine.transition(VoiceStates.PROCESSING);
      }
      return;
    }

    if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
      const deltaB64 = typeof payload.delta === 'string' ? payload.delta : '';
      if (!deltaB64) return;
      if (this.stateMachine.getState() !== VoiceStates.SPEAKING) {
        this.stateMachine.transition(VoiceStates.SPEAKING);
      }
      this.enqueuePcmAudioChunk(deltaB64);
      return;
    }

    if (
      type === 'response.output_audio_transcript.delta' ||
      type === 'response.audio_transcript.delta' ||
      type === 'response.text.delta'
    ) {
      const delta = typeof payload.delta === 'string' ? payload.delta : '';
      if (!delta) return;
      this.currentAssistantTranscript += delta;
      this.callbacks.onAssistantTranscriptDelta?.(delta);
      return;
    }

    if (
      type === 'response.output_audio_transcript.done' ||
      type === 'response.audio_transcript.done'
    ) {
      const finalTranscript =
        typeof payload.transcript === 'string' && payload.transcript.trim()
          ? payload.transcript.trim()
          : this.currentAssistantTranscript.trim();
      if (finalTranscript) {
        this.lastAssistantText = finalTranscript;
      }
      return;
    }

    if (type === 'response.done') {
      this.responseActive = false;
      const finalText = this.currentAssistantTranscript.trim();
      if (finalText) {
        this.lastAssistantText = finalText;
        this.callbacks.onAssistantTranscriptDone?.(finalText);
      }
      this.currentAssistantTranscript = '';

      if (this.activeSources.size === 0 && this.ws?.readyState === WebSocket.OPEN) {
        this.stateMachine.transition(VoiceStates.LISTENING);
      }
      return;
    }

    if (type === 'error') {
      const errObj =
        payload.error && typeof payload.error === 'object'
          ? (payload.error as Record<string, unknown>)
          : payload;
      const msg =
        typeof errObj.message === 'string'
          ? errObj.message
          : 'Grok voice session returned an error.';
      this.emitVoiceError(
        new AppError({
          code: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
          category: 'voice',
          statusCode: 502,
          message: msg,
        }),
      );
    }
  }

  private async ensurePlaybackContext(): Promise<AudioContext> {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      throw new AppError({
        code: ErrorCodes.UNSUPPORTED_AUDIO_FORMAT,
        category: 'voice',
      });
    }

    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new AudioCtx({ latencyHint: 'interactive' });
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    if (!this.outputGainNode || !this.outputAnalyserNode) {
      const gain = this.audioContext.createGain();
      gain.gain.value = this.options.voiceOutputEnabled ? this.options.volume : 0;

      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 256;

      gain.connect(analyser);
      analyser.connect(this.audioContext.destination);

      this.outputGainNode = gain;
      this.outputAnalyserNode = analyser;
    }

    return this.audioContext;
  }

  private async initAudioAndMic(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new AppError({
        code: ErrorCodes.UNSUPPORTED_AUDIO_FORMAT,
        category: 'voice',
        message: 'Browser microphone capture APIs are unavailable in this context.',
      });
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    this.mediaStream = stream;
    const ctx = await this.ensurePlaybackContext();
    const source = ctx.createMediaStreamSource(stream);
    this.micSourceNode = source;

    // Silent sink keeps AudioWorklet / ScriptProcessor active without local mic echo
    const muteSink = ctx.createGain();
    muteSink.gain.value = 0;
    muteSink.connect(ctx.destination);
    this.muteSinkNode = muteSink;

    const handleFrame = (samples: Float32Array) => {
      if (this.isMuted) {
        this.currentInputLevel = 0;
        return;
      }

      this.currentInputLevel = computeRmsLevel(samples);

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      const resampled = resampleFloat32(samples, ctx.sampleRate, XAI_REALTIME_SAMPLE_RATE);
      const base64Audio = float32ToPcm16Base64(resampled);
      this.ws.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: base64Audio,
        }),
      );
    };

    let attachedWorklet = false;
    if (typeof AudioWorkletNode !== 'undefined' && ctx.audioWorklet) {
      try {
        const blob = new Blob([WORKLET_PROCESSOR_CODE], { type: 'application/javascript' });
        this.workletBlobUrl = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(this.workletBlobUrl);
        const workletNode = new AudioWorkletNode(ctx, 'mj-mic-capture-processor');
        workletNode.port.onmessage = (ev: MessageEvent<Float32Array>) => {
          if (ev.data instanceof Float32Array) {
            handleFrame(ev.data);
          }
        };
        source.connect(workletNode);
        workletNode.connect(muteSink);
        this.captureNode = workletNode;
        attachedWorklet = true;
      } catch {
        attachedWorklet = false;
      }
    }

    if (!attachedWorklet) {
      const processor = ctx.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (ev) => {
        const channel = ev.inputBuffer.getChannelData(0);
        handleFrame(new Float32Array(channel));
      };
      source.connect(processor);
      processor.connect(muteSink);
      this.captureNode = processor;
    }

    this.startOutputLevelLoop();
  }

  private enqueuePcmAudioChunk(base64Pcm16: string): void {
    if (!this.audioContext || !this.outputGainNode) return;
    const samples = pcm16Base64ToFloat32(base64Pcm16);
    if (samples.length === 0) return;

    const buffer = this.audioContext.createBuffer(1, samples.length, XAI_REALTIME_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = this.options.speakingRate;
    source.connect(this.outputGainNode);

    const now = this.audioContext.currentTime;
    const startTime = Math.max(now + 0.015, this.nextPlaybackTime);
    const adjustedDuration = buffer.duration / Math.max(0.5, this.options.speakingRate);
    this.nextPlaybackTime = startTime + adjustedDuration;

    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
      if (
        this.activeSources.size === 0 &&
        !this.responseActive &&
        this.stateMachine.getState() === VoiceStates.SPEAKING &&
        this.ws?.readyState === WebSocket.OPEN
      ) {
        this.stateMachine.transition(VoiceStates.LISTENING);
      }
    };

    source.start(startTime);
  }

  private flushPlaybackQueue(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // already ended
      }
    }
    this.activeSources.clear();
    this.nextPlaybackTime = this.audioContext ? this.audioContext.currentTime : 0;
  }

  private stopFallbackTts(): void {
    this.fallbackTtsAbort?.abort();
    this.fallbackTtsAbort = null;
    if (this.fallbackAudioBufferSource) {
      try {
        this.fallbackAudioBufferSource.stop();
        this.fallbackAudioBufferSource.disconnect();
      } catch {
        // ignore
      }
      this.fallbackAudioBufferSource = null;
    }
  }

  private startOutputLevelLoop(): void {
    if (this.levelRafId !== null || typeof requestAnimationFrame === 'undefined') return;

    const tick = () => {
      const outputLevel = this.measureOutputLevel();
      this.callbacks.onAudioLevel?.({
        inputLevel: this.currentInputLevel,
        outputLevel,
      });

      const active =
        this.ws !== null ||
        this.activeSources.size > 0 ||
        this.fallbackAudioBufferSource !== null;
      if (active) {
        this.levelRafId = requestAnimationFrame(tick);
      } else {
        this.levelRafId = null;
      }
    };

    this.levelRafId = requestAnimationFrame(tick);
  }

  private measureOutputLevel(): number {
    if (!this.outputAnalyserNode || (this.activeSources.size === 0 && !this.fallbackAudioBufferSource)) {
      return 0;
    }
    const buf = new Float32Array(this.outputAnalyserNode.fftSize);
    this.outputAnalyserNode.getFloatTimeDomainData(buf);
    return computeRmsLevel(buf);
  }

  private closeSocketCleanly(): void {
    if (!this.ws) return;
    const sock = this.ws;
    this.ws = null;
    try {
      sock.onopen = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onclose = null;
      if (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING) {
        sock.close(1000, 'Session ended');
      }
    } catch {
      // ignore close errors
    }
  }

  private async teardownAudioOnly(): Promise<void> {
    if (this.levelRafId !== null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.levelRafId);
      this.levelRafId = null;
    }

    try {
      this.captureNode?.disconnect();
      this.micSourceNode?.disconnect();
      this.muteSinkNode?.disconnect();
    } catch {
      // ignore disconnect errors
    }
    this.captureNode = null;
    this.micSourceNode = null;
    this.muteSinkNode = null;

    if (this.workletBlobUrl) {
      URL.revokeObjectURL(this.workletBlobUrl);
      this.workletBlobUrl = null;
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        await this.audioContext.close();
      } catch {
        // ignore
      }
    }
    this.audioContext = null;
    this.outputGainNode = null;
    this.outputAnalyserNode = null;
  }

  private emitVoiceError(appError: AppError): void {
    this.stateMachine.transition(VoiceStates.ERROR, appError.message);
    this.callbacks.onError?.(appError.toPayload());
  }
}

export function toVoiceAppError(
  err: unknown,
  fallbackCode: typeof ErrorCodes.VOICE_SERVICE_UNAVAILABLE | typeof ErrorCodes.AUDIO_PLAYBACK_FAILED = ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
  fallbackCategory: 'voice' = 'voice',
): AppError {
  if (err instanceof AppError) return err;

  if (err && typeof err === 'object' && 'payload' in err) {
    const payload = (err as { payload?: Partial<StructuredErrorPayload> }).payload;
    if (payload && typeof payload.code === 'string' && typeof payload.message === 'string') {
      return new AppError({
        code: payload.code as AppError['code'],
        category: payload.category ?? fallbackCategory,
        statusCode: payload.statusCode,
        message: payload.message,
        retryable: payload.retryable,
        retryAfterMs: payload.retryAfterMs,
        requestId: payload.requestId,
        cause: err,
      });
    }
  }

  return new AppError({
    code: fallbackCode,
    category: fallbackCategory,
    cause: err,
  });
}

export function mapBrowserVoiceError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  const domName = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message.toLowerCase() : '';

  if (
    domName === 'NotAllowedError' ||
    domName === 'PermissionDeniedError' ||
    msg.includes('permission denied')
  ) {
    return new AppError({
      code: ErrorCodes.MIC_PERMISSION_DENIED,
      category: 'voice',
      statusCode: 403,
      retryable: false,
      cause: err,
    });
  }

  if (
    domName === 'NotFoundError' ||
    domName === 'DevicesNotFoundError' ||
    msg.includes('requested device not found')
  ) {
    return new AppError({
      code: ErrorCodes.NO_MICROPHONE_DETECTED,
      category: 'voice',
      statusCode: 404,
      retryable: false,
      cause: err,
    });
  }

  if (domName === 'NotSupportedError' || domName === 'NotReadableError') {
    return new AppError({
      code: ErrorCodes.UNSUPPORTED_AUDIO_FORMAT,
      category: 'voice',
      statusCode: 400,
      retryable: false,
      cause: err,
    });
  }

  return new AppError({
    code: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
    category: 'voice',
    statusCode: 503,
    cause: err,
  });
}
