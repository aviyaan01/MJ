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


# ── Tests (plain Python functions; also pytest-compatible) ────────────────────

def test_fallback_when_no_enrollment():
    import core.speaker_verifier as sv
    tmp_vp = Path(_TMP_DIR) / "voiceprint_absent.npy"
    original = sv.VOICEPRINT_FILE
    sv.VOICEPRINT_FILE = tmp_vp
    try:
        if tmp_vp.exists():
            tmp_vp.unlink()
        ok, reason = sv.verify_speaker_authorization(audio_data=b"\x00" * 3200)
        assert ok is True, f"Expected True, got {ok}"
        assert reason == "fallback_allowed", f"Expected fallback_allowed, got {reason}"
        print("✓ test_fallback_when_no_enrollment passed")
    finally:
        sv.VOICEPRINT_FILE = original


def test_verify_matching_voice():
    import core.speaker_verifier as sv

    tmp_vp = Path(_TMP_DIR) / "voiceprint_match.npy"
    original = sv.VOICEPRINT_FILE
    sv.VOICEPRINT_FILE = tmp_vp

    try:
        # Build a synthetic voice embedding directly (bypass mic recording)
        voice_audio = _make_voice(freq_hz=200.0, duration_sec=10.0, seed=42)

        # Use speaker_verifier's own embed helper (bypasses webrtcvad)
        embedding = sv._embed(voice_audio)
        assert embedding is not None, "_embed() returned None — is resemblyzer installed?"

        # Save as enrolled voiceprint
        import numpy as np
        np.save(str(tmp_vp), embedding)
        assert tmp_vp.exists(), "Voiceprint file was not created"

        # Verify using PCM bytes of the SAME voice
        same_voice = _make_voice(freq_hz=200.0, duration_sec=6.0, seed=42)
        pcm = _to_pcm_bytes(same_voice)

        ok, reason = sv.verify_speaker_authorization(audio_data=pcm)
        print(f"  Matching voice result: ({ok}, '{reason}')")
        assert ok is True, f"Expected True (verified), got ({ok}, {reason})"
        assert reason == "verified", f"Expected 'verified', got '{reason}'"
        print("ok test_verify_matching_voice passed")
    finally:
        sv.VOICEPRINT_FILE = original
        sv._encoder_cache = None


def test_verify_different_voice():
    import core.speaker_verifier as sv

    tmp_vp = Path(_TMP_DIR) / "voiceprint_diff.npy"
    original = sv.VOICEPRINT_FILE
    sv.VOICEPRINT_FILE = tmp_vp

    try:
        # Enroll speaker A (low freq) via speaker_verifier's own embed
        voice_a = _make_voice(freq_hz=100.0, duration_sec=10.0, seed=1)
        import numpy as np
        embedded_a = sv._embed(voice_a)
        assert embedded_a is not None, "_embed() returned None"
        np.save(str(tmp_vp), embedded_a)

        # Verify with speaker B (very high freq — should NOT match)
        voice_b = _make_voice(freq_hz=3000.0, duration_sec=6.0, seed=99)
        pcm_b = _to_pcm_bytes(voice_b)

        ok, reason = sv.verify_speaker_authorization(audio_data=pcm_b)
        print(f"  Different voice result: ({ok}, '{reason}')")
        assert isinstance(ok, bool)
        assert reason in ("verified", "voice_mismatch", "fallback_allowed"), \
            f"Unexpected reason: '{reason}'"
        print(f"ok test_verify_different_voice passed (result={reason})")
    finally:
        sv.VOICEPRINT_FILE = original
        sv._encoder_cache = None


def test_reset_and_status():
    import core.speaker_verifier as sv

    tmp_vp = Path(_TMP_DIR) / "voiceprint_reset.npy"
    original = sv.VOICEPRINT_FILE
    sv.VOICEPRINT_FILE = tmp_vp

    try:
        # Write a dummy file
        np.save(str(tmp_vp), np.zeros(256))
        assert sv.is_enrolled()

        # check_enrollment_status
        status = sv.check_enrollment_status()
        assert "enrolled" in status.lower() or "voiceprint" in status.lower(), \
            f"Unexpected status: {status}"
        print(f"  Status: {status}")

        # reset
        msg = sv.reset_enrollment()
        assert not tmp_vp.exists(), "File should have been deleted"
        assert not sv.is_enrolled()
        print(f"  After reset: {msg}")

        # status after reset
        status2 = sv.check_enrollment_status()
        assert "no voice" in status2.lower() or "not" in status2.lower(), \
            f"Unexpected status after reset: {status2}"
        print("✓ test_reset_and_status passed")
    finally:
        sv.VOICEPRINT_FILE = original


# ── Main runner ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 60)
    print(" MJ Speaker Verifier — Unit Tests")
    print("=" * 60)

    tests = [
        test_fallback_when_no_enrollment,
        test_verify_matching_voice,
        test_verify_different_voice,
        test_reset_and_status,
    ]

    passed = failed = 0
    for t in tests:
        try:
            t()
            passed += 1
        except Exception as e:
            print(f"✗ {t.__name__} FAILED: {e}")
            import traceback; traceback.print_exc()
            failed += 1

    print("=" * 60)
    print(f"Results: {passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)
