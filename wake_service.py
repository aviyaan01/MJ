"""
Wake Word Service for MJ (MJ AI Engine)
=======================================
A lightweight background listener that waits for the wake word and
automatically launches MJ (main.py) if it is not already running.

Engine priority:
  1. Picovoice Porcupine (ultra-lightweight, offline, <1% CPU)
     Requires PICOVOICE_ACCESS_KEY in .env
  2. Fallback: SpeechRecognition + Google Web Speech API (legacy)

Usage:
    python wake_service.py

Add to Windows Startup for always-on wake word detection:
    1. Press Win+R, type "shell:startup"
    2. Create a shortcut to: pythonw.exe "C:\\path\\to\\wake_service.py"
"""

import os
import struct
import subprocess
import sys
import time
from pathlib import Path

# ── Configuration ─────────────────────────────────────────────────────────────
WAKE_PHRASES = [
    "wake up mj",
    "mj wake up",
    "hey mj",
    "hello mj",
    "hi mj",
    "mj",
    "wake up",
    "wakey wakey",
]

# How many seconds of audio to capture per recognition attempt (legacy fallback)
LISTEN_TIMEOUT  = 3
PHRASE_TIMEOUT   = 5
CHECK_INTERVAL   = 1.0     # seconds between listen cycles
COOLDOWN_AFTER_LAUNCH = 15  # seconds to wait after launching before listening again

# After MJ is running, follow-up turns stay open this long after each reply
# (no wake word required). Configurable via config/api_keys.json
# key "followup_listen_seconds". Default 7.
FOLLOWUP_LISTEN_SECONDS = 7

BASE_DIR = Path(__file__).resolve().parent
MAIN_SCRIPT = BASE_DIR / "main.py"
CUSTOM_KEYWORD_DIR = BASE_DIR / "config"


def get_followup_listen_seconds() -> float:
    """Seconds to keep listening after an assistant reply (default 7)."""
    try:
        from memory.config_manager import load_api_keys
        raw = load_api_keys().get("followup_listen_seconds", FOLLOWUP_LISTEN_SECONDS)
        secs = float(raw)
        return max(1.0, min(secs, 60.0))
    except Exception:
        return float(FOLLOWUP_LISTEN_SECONDS)


def text_has_wake_phrase(text: str) -> bool:
    """True if recognized speech contains a configured wake phrase."""
    lowered = (text or "").lower().strip()
    if not lowered:
        return False
    return any(phrase in lowered for phrase in WAKE_PHRASES)





def _is_mj_running() -> bool:
    """Check if main.py is already running via socket probe to port 39152."""
    import socket
    try:
        with socket.create_connection(("127.0.0.1", 39152), timeout=0.1):
            return True
    except (TimeoutError, ConnectionRefusedError, OSError):
        return False


def _launch_mj() -> bool:
    """Launch MJ main.py in a new detached process."""
    python = sys.executable
    # On Windows, use pythonw.exe to avoid console window
    pythonw = Path(python).parent / "pythonw.exe"
    if pythonw.exists():
        exe = str(pythonw)
    else:
        exe = python

    try:
        if sys.platform == "win32":
            # DETACHED_PROCESS = 0x00000008
            # CREATE_NEW_PROCESS_GROUP = 0x00000200
            subprocess.Popen(
                [exe, str(MAIN_SCRIPT), "--wake-word"],
                cwd=str(BASE_DIR),
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
                close_fds=True,
            )
        else:
            subprocess.Popen(
                [exe, str(MAIN_SCRIPT), "--wake-word"],
                cwd=str(BASE_DIR),
                start_new_session=True,
                close_fds=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        return True
    except Exception as e:
        print(f"[WakeService] Failed to launch MJ: {e}")
        return False


def _log(msg: str):
    ts = time.strftime("%H:%M:%S")
    print(f"[WakeService {ts}] {msg}")


def _on_wake_detected():
    """Common handler when wake word is detected — launch MJ if not running."""
    _log(">> Wake word detected!")
    if _is_mj_running():
        _log("MJ is already running -- no action needed.")
    else:
        _log("MJ is not running -- launching now...")
        success = _launch_mj()
        if success:
            _log(f"MJ launched successfully! Cooling down for {COOLDOWN_AFTER_LAUNCH}s...")
            time.sleep(COOLDOWN_AFTER_LAUNCH)
        else:
            _log("Failed to launch MJ.")


# ══════════════════════════════════════════════════════════════════════════════
# ENGINE 1: OpenWakeWord (preferred — local, offline, no API keys)
# ══════════════════════════════════════════════════════════════════════════════

def _run_openwakeword_engine():
    """
    OpenWakeWord engine.
    Uses pyaudio for raw PCM capture and openwakeword for keyword detection.
    Models run locally via ONNX without any API keys.
    """
    try:
        from openwakeword.model import Model
        import pyaudio  # type: ignore
        import numpy as np  # type: ignore
    except ImportError:
        _log("openwakeword is missing! Install with: pip install openwakeword")
        return False

    # Initialize the OpenWakeWord model with a built-in pre-trained model.
    # "hey_jarvis" is a highly reliable built-in model.
    target_models = ["hey_jarvis"]
    _log(f"Initializing OpenWakeWord with models: {', '.join(target_models)}...")
    
    try:
        oww_model = Model(wakeword_models=target_models, inference_framework="onnx")
    except Exception as e:
        _log(f"Failed to load OpenWakeWord model: {e}")
        return False

    pa = pyaudio.PyAudio()
    audio_stream = None

    # OpenWakeWord typically requires 16kHz, mono, 16-bit PCM.
    # The default chunk size is 1280 (80ms at 16kHz).
    CHUNK_SIZE = 1280
    FORMAT = pyaudio.paInt16
    CHANNELS = 1
    RATE = 16000

    try:
        audio_stream = pa.open(
            rate=RATE,
            channels=CHANNELS,
            format=FORMAT,
            input=True,
            frames_per_buffer=CHUNK_SIZE,
        )

        _log(f"OpenWakeWord engine active (sample_rate={RATE}, chunk={CHUNK_SIZE})")
        _log("Listening for wake word... (say 'Hey Jarvis')")

        while True:
            try:
                # Read raw bytes from microphone
                pcm_bytes = audio_stream.read(CHUNK_SIZE, exception_on_overflow=False)
                
                # Convert bytes to numpy int16 array
                audio_data = np.frombuffer(pcm_bytes, dtype=np.int16)
                
                # Feed the audio chunk to the model
                prediction = oww_model.predict(audio_data)

                # openwakeword predict() returns a dict, but type checkers sometimes infer tuple
                if not isinstance(prediction, dict):
                    prediction = prediction[0]

                # Check if any of the target models exceeded the confidence threshold
                for mdl, score in prediction.items():
                    if score > 0.5:
                        _log(f"Keyword '{mdl}' detected! (Score: {score:.2f})")
                        _on_wake_detected()
                        
                        # Reset the model state so it doesn't repeatedly trigger on the same audio
                        oww_model.reset()
                        break

            except KeyboardInterrupt:
                _log("Wake service stopped by user.")
                break
            except IOError:
                # Audio buffer overflow — skip this frame
                continue
            except Exception as e:
                _log(f"Audio processing error: {e}")
                time.sleep(0.5)

    finally:
        if audio_stream is not None:
            try:
                audio_stream.close()
            except Exception:
                pass
        pa.terminate()
        _log("OpenWakeWord engine stopped.")

    return True


# ══════════════════════════════════════════════════════════════════════════════
# ENGINE 2: SpeechRecognition fallback (legacy — cloud-based, heavier)
# ══════════════════════════════════════════════════════════════════════════════

def _run_legacy_speech_recognition():
    """
    Legacy wake word engine using SpeechRecognition + Google Web Speech API.
    Falls back to offline Vosk if available. Higher CPU/latency than Porcupine.
    """
    try:
        import speech_recognition as sr
    except ImportError:
        print("=" * 60)
        print("  SpeechRecognition is required for the fallback wake service.")
        print("  Install it with:  pip install SpeechRecognition PyAudio")
        print("=" * 60)
        sys.exit(1)

    from typing import Any

    recognizer: Any = sr.Recognizer()
    recognizer.energy_threshold = 300
    recognizer.dynamic_energy_threshold = True
    recognizer.pause_threshold = 0.8

    try:
        mic = sr.Microphone()
    except Exception as e:
        print(f"[WakeService] No microphone found: {e}")
        print("[WakeService] Make sure PyAudio is installed: pip install PyAudio")
        sys.exit(1)

    _log("[Legacy] SpeechRecognition wake service started")
    _log(f"Wake phrases: {', '.join(WAKE_PHRASES)}")

    with mic as source:
        _log("Calibrating for ambient noise (2 seconds)...")
        recognizer.adjust_for_ambient_noise(source, duration=2)
        _log("Calibration complete. Listening for wake word...")

    while True:
        try:
            with mic as source:
                try:
                    audio = recognizer.listen(
                        source,
                        timeout=LISTEN_TIMEOUT,
                        phrase_time_limit=PHRASE_TIMEOUT,
                    )
                except sr.WaitTimeoutError:
                    continue

            # Optional VAD pre-filter
            try:
                import audioop
                rms = audioop.rms(audio.frame_data, audio.sample_width)
                if rms < recognizer.energy_threshold:
                    continue
            except Exception:
                pass

            # Try to recognize speech
            text = ""
            try:
                text = recognizer.recognize_google(audio, language="en-US")
            except sr.UnknownValueError:
                continue
            except sr.RequestError:
                try:
                    text = recognizer.recognize_vosk(audio)
                except Exception:
                    _log("Speech API unavailable and no offline fallback")
                    time.sleep(5)
                    continue

            if not text:
                continue

            text_lower = text.lower().strip()
            _log(f'Heard: "{text_lower}"')

            if text_has_wake_phrase(text_lower):
                _on_wake_detected()

        except KeyboardInterrupt:
            _log("Wake service stopped by user.")
            break
        except Exception as e:
            _log(f"Error: {e}")
            time.sleep(2)


# ══════════════════════════════════════════════════════════════════════════════
# Main Entry Point
# ══════════════════════════════════════════════════════════════════════════════

def main():
    """
    Auto-select the best available wake word engine:
      1. Porcupine (if pvporcupine + pyaudio installed and PICOVOICE_ACCESS_KEY set)
      2. SpeechRecognition fallback
    """
    _log("=" * 50)
    _log("MJ Wake Word Service v2.0")
    _log(f"MJ script: {MAIN_SCRIPT}")
    _log("=" * 50)

    # Try OpenWakeWord first
    try:
        import openwakeword  # noqa: F401
        import pyaudio  # type: ignore
        _log("OpenWakeWord engine available -- using local, offline wake word detection")
        _run_openwakeword_engine()
        return
    except ImportError as e:
        _log(f"OpenWakeWord libraries not installed ({e})")
        _log("Install with: pip install openwakeword pyaudio")
        _log("Falling back to SpeechRecognition engine...")

    # Fallback to legacy engine
    _run_legacy_speech_recognition()


if __name__ == "__main__":
    main()
