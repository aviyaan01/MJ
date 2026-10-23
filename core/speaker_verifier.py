from __future__ import annotations

"""
Speaker Enrollment & Verification — core/speaker_verifier.py
=============================================================
Primary path : resemblyzer VoiceEncoder → cosine-similarity comparison.
Fallback     : returns (True, "fallback_allowed") when resemblyzer/numpy
               are unavailable or no voiceprint has been enrolled yet,
               so MJ still works without the library.

Tune SIMILARITY_THRESHOLD (0.0–1.0) to balance security vs convenience:
  - Higher → stricter (fewer false-accepts, more false-rejects)
  - Lower  → looser  (more permissive)
"""

import sys
if hasattr(sys.stdout, 'reconfigure'):
    try: sys.stdout.reconfigure(encoding='utf-8')
    except Exception: pass
if hasattr(sys.stderr, 'reconfigure'):
    try: sys.stderr.reconfigure(encoding='utf-8')
    except Exception: pass
import time
import warnings
from pathlib import Path
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    import numpy  # only used for type annotations; not imported at runtime

# ── Constants ────────────────────────────────────────────────────────────────

SIMILARITY_THRESHOLD: float = 0.75   # cosine-similarity required to pass
ENROLL_DURATION_SEC: int    = 9      # seconds of speech to record during enroll
SAMPLE_RATE: int            = 16_000 # Hz — resemblyzer expects 16 kHz mono


# ── Paths ─────────────────────────────────────────────────────────────────────

def _get_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent.parent


BASE_DIR        = _get_base_dir()
VOICEPRINT_FILE = BASE_DIR / "memory" / "voiceprint.npy"


# ── Optional dependency guards ────────────────────────────────────────────────

def _load_numpy():
    try:
        import numpy as np
        return np
    except ImportError:
        return None


def _load_resemblyzer():
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            from resemblyzer import VoiceEncoder
        return VoiceEncoder
    except ImportError:
        return None


# ── Cached encoder (loaded once on first use) ─────────────────────────────────

_encoder_cache = None   # VoiceEncoder instance or False (unavailable)


def _get_encoder():
    global _encoder_cache
    if _encoder_cache is not None:
        return _encoder_cache          # already tried (may be False)
    VoiceEncoder = _load_resemblyzer()
    if VoiceEncoder is None:
        print("[SpeakerVerifier] [!] resemblyzer not installed — verification inactive.")
        _encoder_cache = False
        return False
    try:
        _encoder_cache = VoiceEncoder(device="cpu", verbose=False)
        print("[SpeakerVerifier] [OK] VoiceEncoder ready.")
    except Exception as e:
        print(f"[SpeakerVerifier] [!] VoiceEncoder init failed: {e}")
        _encoder_cache = False
    return _encoder_cache


# ── Public helpers ────────────────────────────────────────────────────────────

def is_enrolled() -> bool:
    """True if a speaker voiceprint has been saved to disk."""
    return VOICEPRINT_FILE.exists()


def _record_raw(duration: int = ENROLL_DURATION_SEC) -> "numpy.ndarray | None":
    """
    Record `duration` seconds of 16-kHz mono float32 audio via sounddevice.
    Returns a 1-D numpy float32 array, or None on failure.
    """
    np = _load_numpy()
    if np is None:
        print("[SpeakerVerifier] numpy not installed — cannot record.")
        return None
    try:
        import sounddevice as sd
        print(f"[SpeakerVerifier] 🎤 Recording {duration}s …")
        recording = sd.rec(
            duration * SAMPLE_RATE,
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="float32",
            blocking=True,
        )
        return recording.flatten()
    except Exception as e:
        print(f"[SpeakerVerifier] Recording error: {e}")
        return None


def _wav_bytes_to_float32(audio_data: bytes) -> "numpy.ndarray | None":
    """Convert raw PCM int16 bytes (from Gemini Live stream) to float32 array."""
    np = _load_numpy()
    if np is None:
        return None
    try:
        arr = np.frombuffer(audio_data, dtype=np.int16).astype(np.float32)
        # Normalise int16 range → float range expected by resemblyzer
        arr /= 32768.0
        return arr
    except Exception as e:
        print(f"[SpeakerVerifier] PCM decode error: {e}")
        return None


def _preprocess_wav_novad(audio_float32: "numpy.ndarray", source_sr: int = SAMPLE_RATE) -> "numpy.ndarray":
    """
    Lightweight VAD-free preprocessor — resamples to 16 kHz, normalises, trims
    leading/trailing silence by RMS.  Does NOT require webrtcvad.
    """
    np = _load_numpy()
    if np is None:
        return audio_float32

    # 1. Resample if needed (uses scipy.signal which is already a resemblyzer dep)
    wav = audio_float32
    if source_sr != SAMPLE_RATE:
        try:
            from scipy.signal import resample_poly
            from math import gcd
            g = gcd(source_sr, SAMPLE_RATE)
            wav = resample_poly(wav, SAMPLE_RATE // g, source_sr // g).astype(np.float32)
        except Exception:
            pass  # keep original if scipy unavailable

    # 2. Normalize peak
    peak = np.max(np.abs(wav))
    if peak > 1e-6:
        wav = wav / peak

    # 3. Trim silence by RMS (simple energy-based VAD)
    frame_len = int(SAMPLE_RATE * 0.025)  # 25 ms frames
    hop = frame_len // 2
    rms_threshold = 0.015
    voiced = []
    for i in range(0, len(wav) - frame_len, hop):
        frame = wav[i : i + frame_len]
        if float(np.sqrt(np.mean(frame ** 2))) >= rms_threshold:
            voiced.append(frame)
    if voiced:
        wav = np.concatenate(voiced).astype(np.float32)

    return wav


def _embed(audio_float32: "numpy.ndarray") -> "numpy.ndarray | None":
    """
    Extract a fixed-size speaker embedding from a float32 audio array.
    Returns a 1-D numpy float64 array (256-dim), or None on failure.
    """
    encoder = _get_encoder()
    if not encoder:
        return None
    np = _load_numpy()
    if np is None:
        return None
    try:
        # Use our own VAD-free preprocessor — no webrtcvad dependency
        wav = _preprocess_wav_novad(audio_float32, source_sr=SAMPLE_RATE)
        return encoder.embed_utterance(wav)  # type: ignore[return-value]  # resemblyzer has no stubs
    except Exception as e:
        print(f"[SpeakerVerifier] Embedding error: {e}")
        return None


def _cosine_similarity(a: "numpy.ndarray", b: "numpy.ndarray") -> float:
    """Cosine similarity in [−1, 1]; higher → more similar."""
    import numpy as np
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


# ── Enrollment ────────────────────────────────────────────────────────────────

def enroll_speaker(speak_fn=None) -> str:
    """
    Guides the user through a ~9-second voice enrollment and saves the
    embedding to memory/voiceprint.npy.

    Parameters
    ----------
    speak_fn : callable | None
        Optional TTS callback ``speak_fn(text: str)`` used to prompt the user
        verbally.  If None, only print() is used.

    Returns
    -------
    str
        Human-readable status message.
    """
    np = _load_numpy()
    if np is None:
        return "Enrollment failed: numpy is not installed."

    encoder = _get_encoder()
    if not encoder:
        return (
            "Enrollment failed: resemblyzer is not installed. "
            "Run: pip install resemblyzer"
        )

    prompt = (
        "Please speak naturally for about ten seconds so I can learn your voice. "
        "Say anything — your name, describe your day, or count out loud."
    )
    print(f"[SpeakerVerifier] ENROLL: {prompt}")
    if speak_fn:
        try:
            speak_fn(prompt)
            time.sleep(0.5)   # brief pause before recording
        except Exception:
            pass

    audio = _record_raw(ENROLL_DURATION_SEC)
    if audio is None or len(audio) < SAMPLE_RATE:
        msg = "Enrollment failed: could not capture enough audio."
        print(f"[SpeakerVerifier] {msg}")
        return msg

    embedding = _embed(audio)
    if embedding is None:
        msg = "Enrollment failed: could not extract voice embedding."
        print(f"[SpeakerVerifier] {msg}")
        return msg

    VOICEPRINT_FILE.parent.mkdir(parents=True, exist_ok=True)
    np.save(str(VOICEPRINT_FILE), embedding)
    print(f"[SpeakerVerifier] [OK] Voiceprint saved -> {VOICEPRINT_FILE}")

    confirm = "Voice enrollment complete. I've learned your voice and will use it to verify your identity before executing sensitive commands."
    if speak_fn:
        try:
            speak_fn(confirm)
        except Exception:
            pass
    return confirm


def reset_enrollment() -> str:
    """Delete the stored voiceprint."""
    if VOICEPRINT_FILE.exists():
        VOICEPRINT_FILE.unlink()
        return "Voiceprint deleted. Speaker verification is now disabled."
    return "No voiceprint was enrolled — nothing to reset."


def check_enrollment_status() -> str:
    """Return a human-readable enrollment status."""
    if not is_enrolled():
        return "No voice is currently enrolled. Say 'MJ, enroll my voice' to set one up."
    mtime = VOICEPRINT_FILE.stat().st_mtime
    from datetime import datetime
    dt = datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M")
    return (
        f"A voiceprint is enrolled (recorded on {dt}). "
        f"Speaker verification is ACTIVE with a similarity threshold of {SIMILARITY_THRESHOLD}."
    )


# ── Verification ──────────────────────────────────────────────────────────────

def verify_speaker_authorization(audio_data: bytes | None = None) -> tuple[bool, str]:
    """
    Non-blocking speaker verification for high-risk actions (shutdown, restart, …).

    Parameters
    ----------
    audio_data : bytes | None
        Raw PCM int16 bytes from the Gemini Live audio stream.

    Returns
    -------
    (True,  "verified")        — voice matches enrolled voiceprint.
    (False, "voice_mismatch")  — voice does NOT match (block the action).
    (True,  "fallback_allowed")— no voiceprint or library missing (warn + allow).
    (False, "voice_too_quiet") — audio too short/quiet to embed.
    """
    np = _load_numpy()

    # ── Fast-path: nothing enrolled or no audio ───────────────────────────────
    if not is_enrolled():
        print("[SpeakerVerifier] [!] No voiceprint enrolled — verification skipped (fallback_allowed).")
        return True, "fallback_allowed"

    if not audio_data:
        print("[SpeakerVerifier] [!] No audio_data provided — verification skipped (fallback_allowed).")
        return True, "fallback_allowed"

    if np is None:
        print("[SpeakerVerifier] [!] numpy unavailable — verification skipped (fallback_allowed).")
        return True, "fallback_allowed"

    encoder = _get_encoder()
    if not encoder:
        print("[SpeakerVerifier] [!] resemblyzer unavailable — verification skipped (fallback_allowed).")
        return True, "fallback_allowed"

    # ── Convert incoming PCM bytes → float32 ─────────────────────────────────
    audio_arr = _wav_bytes_to_float32(audio_data)
    if audio_arr is None or len(audio_arr) < SAMPLE_RATE // 2:
        print("[SpeakerVerifier] Audio too short to verify.")
        return False, "voice_too_quiet"

    # Basic energy check — reject silence
    energy = float(np.mean(audio_arr ** 2))
    if energy < 1e-6:
        print("[SpeakerVerifier] Audio too quiet to verify.")
        return False, "voice_too_quiet"

    # ── Load enrolled embedding ───────────────────────────────────────────────
    try:
        enrolled_embedding = np.load(str(VOICEPRINT_FILE), allow_pickle=False)
    except Exception as e:
        print(f"[SpeakerVerifier] Could not load voiceprint: {e} — fallback_allowed.")
        return True, "fallback_allowed"

    # ── Embed incoming audio ──────────────────────────────────────────────────
    live_embedding = _embed(audio_arr)
    if live_embedding is None:
        print("[SpeakerVerifier] Embedding failed — fallback_allowed.")
        return True, "fallback_allowed"

    # ── Compare ───────────────────────────────────────────────────────────────
    similarity = _cosine_similarity(enrolled_embedding, live_embedding)
    print(f"[SpeakerVerifier] Cosine similarity: {similarity:.4f} (threshold: {SIMILARITY_THRESHOLD})")

    if similarity >= SIMILARITY_THRESHOLD:
        return True, "verified"

    print(f"[SpeakerVerifier] ✗ Voice mismatch (similarity={similarity:.4f} < {SIMILARITY_THRESHOLD})")
    return False, "voice_mismatch"
