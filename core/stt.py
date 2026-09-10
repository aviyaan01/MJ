"""
Speech-to-Text engines for MJ.

STT Architecture & Multilingual Support:
1. Gemini Live API (Primary in main.py): Direct 16kHz PCM audio streaming.
   Natively recognizes English, Bangla (Bengali), and code-switched Banglish.
2. WhisperSTT (Offline fallback): faster-whisper with automatic language detection (default: None / auto).
   Supports 99+ languages including Bengali (bn) and English (en).
3. VoskSTT (Lightweight streaming): Kaldi-based model (defaults to en-us).
"""
import json

import numpy as np


def _setup_hf_environment(model_name: str, device: str, compute: str):
    import importlib
    import os

    try:
        fw = importlib.import_module("faster_whisper")
        WhisperModel = getattr(fw, "WhisperModel")
    except ImportError as _imp_err:
        raise ImportError(
            "The 'faster-whisper' package is required for offline Whisper speech recognition.\n"
            "Install it via: pip install faster-whisper (or .venv\\Scripts\\pip install faster-whisper)"
        ) from _imp_err

    try:
        return WhisperModel(model_name, device=device, compute_type=compute)
    except Exception as _first_err:
        _e = str(_first_err).lower()
        _offline_keywords = (
            "offline", "not found", "cache", "localentry",
            "does not exist", "outgoing", "local_files_only",
        )
        if any(k in _e for k in _offline_keywords):
            print(f"[STT] Whisper '{model_name}' not in local cache — downloading (one-time, internet required)…")
            os.environ.pop("HF_HUB_OFFLINE",      None)
            os.environ.pop("TRANSFORMERS_OFFLINE", None)
            os.environ.pop("HF_DATASETS_OFFLINE",  None)
            try:
                return WhisperModel(model_name, device=device, compute_type=compute)
            except Exception as _dl_err:
                raise RuntimeError(
                    f"Whisper '{model_name}' model download failed.\n"
                    f"Internet access is required the first time to download the speech model (~75–290 MB).\n"
                    f"After the first download it runs fully offline.\n"
                    f"Details: {_dl_err}"
                ) from _dl_err
        else:
            raise

class WhisperSTT:
    """Offline transcription using faster-whisper."""

    def __init__(self, model_name: str = "base", language: str | None = None):
        print(f"[STT] Loading Whisper '{model_name}'…")
        device, compute = "cpu", "int8"
        try:
            import importlib
            # Check ctranslate2 or torch for CUDA GPU support dynamically
            ct2 = importlib.import_module("ctranslate2")
            if getattr(ct2, "get_cuda_device_count", lambda: 0)() > 0:
                device, compute = "cuda", "float16"
        except Exception:
            try:
                import importlib
                t = importlib.import_module("torch")
                if getattr(getattr(t, "cuda", None), "is_available", lambda: False)():
                    device, compute = "cuda", "float16"
            except Exception:
                pass

        self._model = _setup_hf_environment(model_name, device, compute)

        self._language = None if (not language or language.strip().lower() == "auto") else language.strip().lower()
        print(f"[STT] Whisper '{model_name}' ready ({device})")

    def transcribe(self, audio: np.ndarray, initial_prompt: str | None = None) -> str:
        """Transcribe a float32 mono 16 kHz numpy array. Returns transcript string."""
        try:
            prompt = initial_prompt or "MJ speech recognition in English, Bengali (Bangla), and Banglish."
            segments, _ = self._model.transcribe(
                audio,
                language=self._language,
                initial_prompt=prompt,
                beam_size=1,                       # greedy — 2-3x faster
                best_of=1,
                condition_on_previous_text=False,  # no hallucinations, faster
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 300},
            )
            return " ".join(s.text for s in segments).strip()
        except Exception as e:
            print(f"[STT] Transcription error: {e}")
            raise


class VoskSTT:
    """Streaming transcription using Vosk."""

    def __init__(self, model_path: str | None = None, language: str = "en-us"):
        import importlib
        try:
            vk = importlib.import_module("vosk")
            KaldiRecognizer = getattr(vk, "KaldiRecognizer")
            Model = getattr(vk, "Model")
        except ImportError as _imp_err:
            raise ImportError(
                "The 'vosk' package is required for offline Vosk speech recognition.\n"
                "Install it via: pip install vosk (or .venv\\Scripts\\pip install vosk)"
            ) from _imp_err

        print("[STT] Loading Vosk model…")
        if model_path:
            model = Model(model_path)
        else:
            lang  = language.strip().lower() if language and language.strip().lower() != "auto" else "en-us"
            model = Model(lang=lang)
        self._rec = KaldiRecognizer(model, 16000)
        print("[STT] Vosk ready.")

    def process_chunk(self, audio_bytes: bytes) -> tuple[str, bool]:
        """Feed raw int16 LE PCM bytes. Returns (text, is_final)."""
        if self._rec.AcceptWaveform(audio_bytes):
            result = json.loads(self._rec.Result())
            return result.get("text", ""), True
        partial = json.loads(self._rec.PartialResult())
        return partial.get("partial", ""), False
