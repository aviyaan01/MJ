# Stage 2 — Realtime Voice API, Security & End-to-End Verification

## 1. Ephemeral Token & Realtime WebSocket Flow (Sections 03, 05, 08)

1. User clicks **Talk / Start Listening** (mic is never activated automatically or silently).
2. Browser requests microphone access (`navigator.mediaDevices.getUserMedia`) and transitions through `requesting_permission` -> `connecting`.
3. Browser calls authenticated `POST /api/voice/client-secret`.
4. Fastify validates the `HttpOnly` session cookie, verifies `XAI_API_KEY` and hard budget cap, loads recent turns from the active conversation, builds MJ voice instructions (`buildMjVoiceInstructions`), and calls `POST https://api.x.ai/v1/realtime/client_secrets` with `{ expires_after: { seconds: 300 } }`.
5. Fastify returns only `{ token, expiresAt, realtimeUrl, model, voice, languageMode, instructions, contextTurns }`. The permanent `XAI_API_KEY` never leaves the backend.
6. Browser opens `new WebSocket("wss://api.x.ai/v1/realtime?model=...", ["xai-client-secret." + token])` and sends `session.update` with `voice`, `instructions`, `turn_detection: { type: "server_vad" }`, and 24 kHz `audio/pcm` input/output settings.
7. Recognized user transcripts (`conversation.item.input_audio_transcription.completed`) and assistant spoken transcripts (`response.output_audio_transcript.delta` / `response.done`) persist into SQLite via `POST /api/conversations/:id/voice-turns` (`channel: "voice"`) so voice and text share one unified history.

## 2. Voice State Machine (All 9 States Visible in UI)

`VoiceStateBar` renders all 9 states from Section 05 with live highlighting:
`Idle` -> `Requesting Permission` -> `Connecting` -> `Listening` -> `Processing` -> `Speaking` -> `Interrupted` -> `Reconnecting` -> `Error`.

## 3. Manual End-to-End Voice Verification

1. **Permission Denied Handling**: Block mic permission in Chrome/Edge, press **Talk**, and verify `[MIC_PERMISSION_DENIED]` renders cleanly without crashing or activating recording.
2. **Ephemeral Token Isolation**: Inspect DevTools Network -> `POST /api/voice/client-secret` response and WebSocket handshake; confirm only the temporary `client_secret` is used and `XAI_API_KEY` never appears anywhere in the browser.
3. **English, Bengali & Banglish Conversation**:
   - Speak in English (`"Hey MJ, what are we working on?"`) -> confirm MJ responds naturally in English audio and saves both turns in Chat.
   - Speak in Banglish/Bangla (`"Amar ekta portfolio website banano dorkar"`) -> confirm MJ responds naturally without forced English translation.
4. **Controls**:
   - **Mute / Unmute**: Toggle Mute during `Listening`; verify orb stops reacting to mic audio (`Mic Muted` pill shown).
   - **Interrupt / Barge-in**: Start speaking while MJ is `Speaking` OR click **Interrupt**; verify audio playback halts immediately (`Interrupted` -> `Listening`).
   - **Repeat / Read Aloud**: Click **Repeat** on Home or **Read aloud** in Chat to test `POST /api/voice/tts` fallback playback.
   - **Stop**: Click **Stop** to close the WebSocket, release microphone tracks (`Mic Off`), and record voice session duration into **Settings -> Usage & Budget**.
   - **Follow-Up Auto-Listen & Barge-In**: With `voice.autoListen` enabled (default `true`), MJ reopens the microphone for `voice.followupListenSeconds` (default `7s`, `3–30s`) after finishing a spoken reply and returns to `"Say Hey MJ to wake me"` if silent. Speaking above `voice.bargeInThreshold` (`1400` PCM16 RMS) during playback halts TTS immediately and resumes listening.
   - **Browser Click vs Tauri Desktop Wake Word**: Web browsers require **one user click** to grant microphone access before `WakeWordListener` can listen on page load. In the Tauri desktop app (`apps/desktop`), startup wake-word standby runs **only if** the user explicitly enabled `wakeWordStandby`.
