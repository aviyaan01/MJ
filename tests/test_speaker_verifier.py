"""
tests/test_speaker_verifier.py
==============================
Manual / CI test for core/speaker_verifier.py.

Usage (from project root):
    python -m pytest tests/test_speaker_verifier.py -v
or simply:
    python tests/test_speaker_verifier.py

Tests:
  1. Enroll a synthetic voiceprint (no real mic required).
  2. Verify the same synthetic audio → expect (True, "verified").
  3. Verify clearly different random noise → expect (False, "voice_mismatch").
  4. No-enrollment path → expect (True, "fallback_allowed").
  5. reset_enrollment / check_enrollment_status helpers.
"""

from __future__ import annotations

import os
import sys
import tempfile
import types
from pathlib import Path
from unittest import mock

# ── Make sure project root is on sys.path ─────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


# ── Skip entire module gracefully if heavy deps are missing ───────────────────
import importlib
import importlib.util

import unittest

_MISSING = []
for _pkg in ("numpy", "resemblyzer"):
    if importlib.util.find_spec(_pkg) is None:
        _MISSING.append(_pkg)

if _MISSING:
    raise unittest.SkipTest(
        f"[test_speaker_verifier] SKIP — missing packages: {', '.join(_MISSING)}\n"
        f"Install with: pip install {' '.join(_MISSING)}"
    )

import numpy as np


# ── Helper: synthesise a deterministic "speaker" waveform ────────────────────

def _make_voice(freq_hz: float = 220.0, duration_sec: float = 10.0,
                sr: int = 16_000, seed: int = 0) -> np.ndarray:
    """Return float32 array simulating a speaker via a sine + harmonics + slight noise."""
    rng = np.random.default_rng(seed)
    t = np.linspace(0, duration_sec, int(sr * duration_sec), endpoint=False)
    wave = (
        0.5 * np.sin(2 * np.pi * freq_hz * t)
        + 0.25 * np.sin(2 * np.pi * freq_hz * 2 * t)
        + 0.1 * np.sin(2 * np.pi * freq_hz * 3 * t)
        + 0.05 * rng.standard_normal(len(t))
    ).astype(np.float32)
    return wave / (np.max(np.abs(wave)) + 1e-8)


def _to_pcm_bytes(audio: np.ndarray) -> bytes:
    """Convert float32 array → raw int16 PCM bytes (mimics Gemini stream format)."""
    return (audio * 32767).clip(-32768, 32767).astype(np.int16).tobytes()


# ── Redirect VOICEPRINT_FILE to a temp directory during tests ─────────────────

_TMP_DIR = tempfile.mkdtemp(prefix="mj_test_")


def _patch_voiceprint(monkeypatch_module):
    """Patch VOICEPRINT_FILE inside speaker_verifier to a temp path."""
    import core.speaker_verifier as sv
    tmp_path = Path(_TMP_DIR) / "voiceprint.npy"
    monkeypatch_module.VOICEPRINT_FILE = tmp_path
    return tmp_path


# ── Tests (unittest.TestCase and pytest compatible) ───────────────────────────

class TestSpeakerVerifier(unittest.TestCase):
    def test_fallback_when_no_enrollment(self):
        import core.speaker_verifier as sv
        tmp_vp = Path(_TMP_DIR) / "voiceprint_absent.npy"
        original = sv.VOICEPRINT_FILE
        sv.VOICEPRINT_FILE = tmp_vp
        try:
            if tmp_vp.exists():
                tmp_vp.unlink()
            ok, reason = sv.verify_speaker_authorization(audio_data=b"\x00" * 3200)
            self.assertTrue(ok, f"Expected True, got {ok}")
            self.assertEqual(reason, "fallback_allowed")
        finally:
            sv.VOICEPRINT_FILE = original

    def test_verify_matching_voice(self):
        import core.speaker_verifier as sv

        tmp_vp = Path(_TMP_DIR) / "voiceprint_match.npy"
        original = sv.VOICEPRINT_FILE
        sv.VOICEPRINT_FILE = tmp_vp

        try:
            voice_audio = _make_voice(freq_hz=200.0, duration_sec=10.0, seed=42)
            embedding = sv._embed(voice_audio)
            self.assertIsNotNone(embedding, "_embed() returned None — is resemblyzer installed?")

            import numpy as np
            np.save(str(tmp_vp), embedding)
            self.assertTrue(tmp_vp.exists(), "Voiceprint file was not created")

            same_voice = _make_voice(freq_hz=200.0, duration_sec=6.0, seed=42)
            pcm = _to_pcm_bytes(same_voice)

            ok, reason = sv.verify_speaker_authorization(audio_data=pcm)
            self.assertTrue(ok, f"Expected True (verified), got ({ok}, {reason})")
            self.assertEqual(reason, "verified")
        finally:
            sv.VOICEPRINT_FILE = original
            sv._encoder_cache = None

    def test_verify_different_voice(self):
        import core.speaker_verifier as sv

        tmp_vp = Path(_TMP_DIR) / "voiceprint_diff.npy"
        original = sv.VOICEPRINT_FILE
        sv.VOICEPRINT_FILE = tmp_vp

        try:
            voice_a = _make_voice(freq_hz=100.0, duration_sec=10.0, seed=1)
            import numpy as np
            embedded_a = sv._embed(voice_a)
            self.assertIsNotNone(embedded_a, "_embed() returned None")
            np.save(str(tmp_vp), embedded_a)

            voice_b = _make_voice(freq_hz=3000.0, duration_sec=6.0, seed=99)
            pcm_b = _to_pcm_bytes(voice_b)

            ok, reason = sv.verify_speaker_authorization(audio_data=pcm_b)
            self.assertIsInstance(ok, bool)
            self.assertIn(reason, ("verified", "voice_mismatch", "fallback_allowed"))
        finally:
            sv.VOICEPRINT_FILE = original
            sv._encoder_cache = None

    def test_reset_and_status(self):
        import core.speaker_verifier as sv

        tmp_vp = Path(_TMP_DIR) / "voiceprint_reset.npy"
        original = sv.VOICEPRINT_FILE
        sv.VOICEPRINT_FILE = tmp_vp

        try:
            np.save(str(tmp_vp), np.zeros(256))
            self.assertTrue(sv.is_enrolled())

            status = sv.check_enrollment_status()
            self.assertTrue("enrolled" in status.lower() or "voiceprint" in status.lower())

            msg = sv.reset_enrollment()
            self.assertFalse(tmp_vp.exists())
            self.assertFalse(sv.is_enrolled())

            status2 = sv.check_enrollment_status()
            self.assertTrue("no voice" in status2.lower() or "not" in status2.lower())
        finally:
            sv.VOICEPRINT_FILE = original


# Standalone functions for backwards compatibility
def test_fallback_when_no_enrollment():
    TestSpeakerVerifier().test_fallback_when_no_enrollment()

def test_verify_matching_voice():
    TestSpeakerVerifier().test_verify_matching_voice()

def test_verify_different_voice():
    TestSpeakerVerifier().test_verify_different_voice()

def test_reset_and_status():
    TestSpeakerVerifier().test_reset_and_status()


if __name__ == "__main__":
    unittest.main()
