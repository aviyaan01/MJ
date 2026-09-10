import platform as _platform
import subprocess as _subprocess

# ── Nuclear: force CREATE_NO_WINDOW on EVERY subprocess call on Windows ───────
# This patches Popen itself, so no per-file flag is needed anywhere.
if _platform.system() == "Windows":
    _OrigPopen = _subprocess.Popen
    _CREATE_NO_WINDOW = getattr(_subprocess, "CREATE_NO_WINDOW", 0x08000000)

    class _Popen(_OrigPopen):
        def __init__(self, args, **kw):
            kw["creationflags"] = (
                kw.get("creationflags", 0) | _CREATE_NO_WINDOW
            )
            kw.pop("startupinfo", None)  # drop any stale/shared STARTUPINFO
            super().__init__(args, **kw)

    _subprocess.Popen = _Popen
# ─────────────────────────────────────────────────────────────────────────────

import asyncio
import json
import os
import re
import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')
import threading
import time
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any

import sounddevice as sd
from google import genai
from google.genai import types

from actions.advanced_settings import (
    toggle_bluetooth,
    advanced_settings,
)

from actions.fallback_pipeline import record_audio, transcribe, speak, FallbackBrain
from actions.browser_control import browser_control
from actions.browser_manager import browser_manager
from actions.calendar_manager import calendar_manager
from actions.code_helper import code_helper
from actions.computer_control import computer_control
from actions.computer_settings import computer_settings
from actions.desktop import desktop_control
from actions.dev_agent import dev_agent
from actions.file_controller import file_controller
from actions.file_processor import file_processor
from actions.flight_finder import flight_finder
from actions.game_updater import game_updater
from actions.open_app import close_app, open_app
from actions.proactive import ProactiveEngine
from actions.reminder import reminder
from actions.routine import routine_manager
from actions.screen_processor import _capture_camera, _capture_screen
from actions.memory_manager import (
    handle_remember_fact,
    handle_recall_facts,
    handle_forget_fact,
    get_core_memory_summary,
)
from actions.send_message import send_message
from actions.smart_home import smart_home
from actions.system_monitor import SystemMonitor, get_system_status
from actions.weather_report import weather_action
from actions.web_search import web_search as web_search_action
from actions.window_controller import window_controller
from actions.vscode_control import vscode_control
from actions.youtube_video import youtube_video
from core.tts import interrupt_playback
from memory.config_manager import (
    get_barge_in_threshold,
    get_brief_enabled,
    get_followup_listen_seconds,
)
from memory.memory_manager import (
    format_memory_for_prompt,
    load_memory,
    update_memory,
)
from memory.routines_manager import load_routines, update_routine_last_run
from ui import UltronUI


def get_base_dir():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent


BASE_DIR = get_base_dir()
API_CONFIG_PATH = BASE_DIR / "config" / "api_keys.json"
PROMPT_PATH = BASE_DIR / "core" / "prompt.txt"
LIVE_MODEL = "gemini-3.1-flash-live-preview"
CHANNELS = 1
SEND_SAMPLE_RATE = 16000
RECEIVE_SAMPLE_RATE = 24000
CHUNK_SIZE = 512


class ApiKeyMissing(Exception):
    """Raised when config/api_keys.json or .env is missing, broken, or has no real key."""


def _get_api_key() -> str:
    from utils.env import get_api_key
    key = get_api_key("gemini_api_key")
    if not key or key.strip() in ("", "YOUR_GEMINI_API_KEY_HERE"):
        try:
            with open(API_CONFIG_PATH, "r", encoding="utf-8") as f:
                key = json.load(f).get("gemini_api_key", "")
        except Exception:
            pass
    if not key or key.strip() in ("", "YOUR_GEMINI_API_KEY_HERE"):
        raise ApiKeyMissing("No API key set in .env or config/api_keys.json")
    return key.strip()


def _load_system_prompt() -> str:
    try:
        base_prompt = PROMPT_PATH.read_text(encoding="utf-8")
    except Exception:
        base_prompt = (
            "You are MJ, a highly intelligent AI assistant. "
            "Be concise, direct, and always use the provided tools to complete tasks. "
            "Never simulate or guess results — always call the appropriate tool."
        )
    
    memory_summary = get_core_memory_summary()
    return f"{base_prompt}\n\n[SYSTEM MEMORY VAULT]\n{memory_summary}"


_CTRL_RE = re.compile(r"<ctrl\d+>", re.IGNORECASE)


def _clean_transcript(text: str) -> str:
    text = _CTRL_RE.sub("", text)
    text = re.sub(r"[\x00-\x08\x0b-\x1f]", "", text)
    return text.strip()


from core.tool_declarations import TOOL_DECLARATIONS

# --- Plugin system ---


class UltronLive:
    def __init__(self, ui: UltronUI):
        self.ui = ui
        self._asst_name = "MJ"  # updated each session from config
        self.session: Any = None
        self.audio_in_queue: asyncio.Queue = asyncio.Queue()
        self.out_queue: asyncio.Queue = asyncio.Queue()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._is_speaking = False
        self._speaking_lock = threading.Lock()
        self._phone_active = False  # True while phone mic is streaming; pauses PC mic
        self._pending_vision = None  # (img_bytes, mime_type, question, angle) to inject after tool response
        self._vision_cam_active = (
            False  # True if camera was opened for vision → auto-close after response
        )
        self._vision_close_pending = (
            False  # True after vision injected; next turn_complete closes camera
        )
        self._vision_last_time = (
            0.0  # monotonic time of last screen_process call (cooldown guard)
        )
        self._vision_busy = (
            False  # True while a vision capture/inject cycle is in flight
        )
        self._interrupted = False  # True while draining audio after user interrupt
        self.ui.on_text_command = self._on_text_command
        self.ui.on_remote_clicked = self._make_remote_key
        self.ui.on_interrupt = self.interrupt
        self._turn_done_event: asyncio.Event | None = None
        self._dashboard = None
        self._briefing_sent = False  # morning briefing fires once per process
        self._sys_monitor = SystemMonitor()  # persistent cooldown state
        self._proactive = ProactiveEngine()
        self._last_user_speech = time.monotonic()  # updated on every user utterance
        self._last_assistant_turn_done = time.monotonic()  # set when a reply finishes playing
        self._pending_dangerous_action = None  # (action, args) awaiting spoken yes/no
        self._followup_task: asyncio.Task | None = None
        self._last_target_app = ""  # pronoun/context tracking ("it", "that", "ota", "eita")
        self._last_target_app_time = 0.0
        self._unrelated_action_count = 0
        self.vision_active = False  # Voice-toggled continuous vision (off by default to save RAM/CPU/quota)
        self.fallback_active = False  # True when using Whisper/ElevenLabs fallback
        self._last_user_audio: bytes | None = None  # Rolling buffer of last mic chunk for speaker verification

    def _perform_startup_diagnostics(self) -> None:
        """Verify Admin privileges, system tools (VS Code), and dependencies on startup."""
        import shutil
        from utils.env import get_os

        # 1. Administrator Privilege Check
        is_admin = False
        if get_os() == "Windows":
            try:
                import ctypes
                is_admin = bool(ctypes.windll.shell32.IsUserAnAdmin())
            except Exception:
                is_admin = False
        else:
            is_admin = os.geteuid() == 0 if hasattr(os, "geteuid") else False

        if not is_admin:
            print("\033[91m" + "=" * 80)
            print("  [!] WARNING: MJ is NOT running as Administrator.")
            print("  Deep system settings and power controls will fail.")
            print("  Please restart the terminal as Administrator.")
            print("=" * 80 + "\033[0m")
            self.ui.write_log("WARN: MJ is NOT running as Administrator. Deep system settings may fail.")
        else:
            print("\033[92m[MJ] [OK] Administrator privileges verified.\033[0m")

        # 2. Visual Studio Code in PATH Check
        code_path = shutil.which("code")
        if not code_path:
            print("\033[93m" + "=" * 80)
            print("  [!] WARNING: 'code' command was not found in system PATH.")
            print("  code_helper and dev_agent will not be able to auto-launch Visual Studio Code.")
            print("=" * 80 + "\033[0m")
            self.ui.write_log("WARN: 'code' not found in PATH. VS Code auto-launch disabled.")
        else:
            print(f"[MJ] [OK] Visual Studio Code CLI detected: {code_path}")

    def _get_active_target_app(self) -> str:
        """
        Pronoun resolution rule:
        Target app reference expires if:
        1. Time-based expiry: >90 seconds elapsed since app was targeted.
        2. Context-drift expiry: >=2 unrelated actions performed since app was targeted.
        """
        if not self._last_target_app:
            return ""
        now = time.monotonic()
        if (now - self._last_target_app_time) > 90.0 or self._unrelated_action_count >= 2:
            self._last_target_app = ""
            return ""
        return self._last_target_app

    def _start_followup_timer(self):
        """Keep mic open for follow-up turns (default 7s). If no speech, go to SLEEPING."""
        self._reset_followup_timer()

        async def _waiter():
            try:
                wait_sec = get_followup_listen_seconds()
                await asyncio.sleep(wait_sec)
                now = time.monotonic()
                if (now - self._last_assistant_turn_done) >= wait_sec and not self._is_speaking:
                    print(f"[MJ] ⏳ Follow-up window ({wait_sec}s) expired without speech — returning to idle.")
                    self.set_app_state("SLEEPING")
            except asyncio.CancelledError:
                pass

        if self._loop and self._loop.is_running():
            self._followup_task = asyncio.create_task(_waiter())

    def _reset_followup_timer(self):
        """Cancel pending follow-up timeout when user speaks or starts action."""
        task = getattr(self, "_followup_task", None)
        if task and not task.done():
            task.cancel()
            self._followup_task = None

    def _make_remote_key(self):
        """Called from Qt main thread when user presses Remote Control."""
        if self._dashboard is None:
            self.ui.write_log(
                "SYS: Dashboard unavailable. "
                'Run: pip install fastapi "uvicorn[standard]" cryptography'
            )
            return None
        key = self._dashboard.new_key()
        url = self._dashboard.get_url()
        manual = self._dashboard.get_manual_url()
        return url, key, f"{url}/auto-login?key={key}", manual

    def _on_text_command(self, text: str):
        if not text:
            return
        clean_text = text.strip()

        # 1. State Management Override: Wake system up instantly
        self.set_app_state("PROCESSING")
        self.ui.write_log(f"USER: {clean_text}")

        # 2. Microphone toggle controls
        if clean_text in ("/toggle_mic", "toggle_mic", "mute", "unmute"):
            if clean_text == "mute":
                self.ui.muted = True
            elif clean_text == "unmute":
                self.ui.muted = False
            else:
                self.ui.muted = not self.ui.muted
            new_state = "MUTED" if self.ui.muted else "LISTENING"
            self.set_app_state(new_state)
            self.ui.write_log(
                f"SYS: Microphone {'MUTED (OFF)' if self.ui.muted else 'UNMUTED (ON)'}."
            )
            return

        # 3. Schedule async command processing
        loop = self._loop
        if loop and loop.is_running():
            asyncio.run_coroutine_threadsafe(self._process_text_command(clean_text), loop)
        else:
            threading.Thread(
                target=self._process_text_command_sync, args=(clean_text,), daemon=True
            ).start()

    async def _process_text_command(self, text: str):
        loop = asyncio.get_event_loop()
        lower = text.lower().strip()
        self.set_app_state("THINKING")

        # 0. Dangerous Action Confirmation Resolution (Bangla + English)
        if self._pending_dangerous_action:
            AFFIRMATIVE_WORDS = {
                "yes", "yeah", "yep", "sure", "proceed", "confirm", "do it",
                "ok", "okay", "y", "hae", "hæ", "haa", "ha", "thik ache",
                "thikache", "koro", "korun", "chalau", "choluk", "shuru koro", "houk"
            }
            NEGATIVE_WORDS = {
                "no", "nope", "cancel", "stop", "abort", "don't", "dont",
                "n", "na", "naa", "korio na", "korben na", "bad dao", "baddao",
                "cholbe na", "lagbe na", "thak"
            }
            if lower in AFFIRMATIVE_WORDS or any(w in lower.split() for w in ("yes", "hae", "confirm", "proceed", "koro", "thik")):
                act, orig_args = self._pending_dangerous_action
                self._pending_dangerous_action = None
                orig_args["confirmed"] = "yes"
                res = await self._handle_computer_settings(orig_args, loop)
                self.ui.show_content(self._asst_name, res)
                self.ui.write_log(f"{self._asst_name}: {res}")
                if not self.ui.muted:
                    self.set_app_state("LISTENING")
                return
            elif lower in NEGATIVE_WORDS or any(w in lower.split() for w in ("no", "cancel", "na", "stop", "abort")):
                self._pending_dangerous_action = None
                res = "Power action cancelled."
                self.ui.show_content(self._asst_name, res)
                self.ui.write_log(f"{self._asst_name}: {res}")
                if not self.ui.muted:
                    self.set_app_state("LISTENING")
                return

        # 1. Close application by name direct match (English & Bangla)
        close_match = re.match(r"^(?:close|quit|kill|terminate|exit|bondho koro|bondho kor|off koro)\s+(.+)$", lower)
        if not close_match:
            close_match = re.match(r"^(.+?)\s+(?:bondho koro|bondho kor|close koro|off koro)$", lower)
        if close_match:
            app_target = close_match.group(1).strip()
            res = await self._handle_close_app({"app_name": app_target}, loop)
            self.ui.show_content(self._asst_name, res)
            self.ui.write_log(f"{self._asst_name}: {res}")
            if not self.ui.muted:
                self.set_app_state("LISTENING")
            return

        # Fast direct intent matches (e.g. open chrome, system status, search, weather)
        open_match = re.match(r"^(?:open|launch|start|run|khulo|chalu koro)\s+(.+)$", lower)
        if not open_match:
            open_match = re.match(r"^(.+?)\s+(?:open koro|khulo|chalu koro)$", lower)
        if open_match:
            app_target = open_match.group(1).strip()
            res = await self._handle_open_app({"app_name": app_target}, loop)
            self.ui.show_content(self._asst_name, res)
            self.ui.write_log(f"{self._asst_name}: {res}")
            if not self.ui.muted:
                self.set_app_state("LISTENING")
            return

        if lower in ("system status", "status", "sysinfo", "stats", "specs", "system metrics"):
            res = await self._handle_system_status({}, loop)
            self.ui.show_content(self._asst_name, res)
            self.ui.write_log(f"{self._asst_name}: {res}")
            if not self.ui.muted:
                self.set_app_state("LISTENING")
            return

        # Check phrase-triggered routine match for text commands
        for r in load_routines():
            if r.get("enabled", True) and r.get("trigger_type") == "phrase":
                t_phrase = (r.get("trigger_value") or "").strip().lower()
                if t_phrase and (t_phrase == lower or t_phrase in lower):
                    r_name = r.get("name", "unnamed")
                    update_routine_last_run(r_name, datetime.now().strftime("%Y-%m-%d %H:%M"))
                    self.ui.write_log(f"⚡ Routine Triggered: '{r_name}'")
                    self.speak(f"Running {r_name} routine.")
                    for step in r.get("steps", []):
                        tool_name = step.get("tool")
                        args = step.get("args", {})
                        if tool_name in self.TOOL_REGISTRY:
                            try:
                                handler = self.TOOL_REGISTRY[tool_name]
                                await handler(self, args, loop)
                            except Exception as err:
                                print(f"[Routine] Step '{tool_name}' failed: {err}")
                    if not self.ui.muted:
                        self.set_app_state("LISTENING")
                    return

        # Direct Power Commands: Sleep, Shutdown, Restart, Lock
        sleep_triggers = (
            "sleep", "sleep mode", "sleep mood", "sleep pc", "sleep laptop",
            "laptop sleep koro", "pc sleep koro", "sleep koro", "turn on sleep mode",
            "sleep mood on", "sleep mode on", "sleep mood on koro", "sleep mode on koro",
            "screen sleep", "display sleep"
        )
        if lower in sleep_triggers:
            ack = "Putting laptop to sleep..."
            self.ui.show_content(self._asst_name, ack)
            self.ui.write_log(f"{self._asst_name}: {ack}")
            self.speak("Putting your laptop to sleep right now.")
            await asyncio.sleep(0.5)
            res = await self._handle_computer_settings({"action": "sleep", "confirmed": "yes"}, loop)
            return

        shutdown_triggers = (
            "shutdown", "shut down", "shutdown pc", "shut down pc", "shutdown laptop",
            "laptop shutdown koro", "pc bondho koro", "computer bondho koro",
            "pc off koro", "laptop off koro"
        )
        if lower in shutdown_triggers:
            self._pending_dangerous_action = ("shutdown", {"action": "shutdown"})
            prompt_q = "Are you sure you want to shut down the computer? (Computer bondho korbo?)"
            self.ui.show_content(self._asst_name, prompt_q)
            self.ui.write_log(f"{self._asst_name}: {prompt_q}")
            self.speak(prompt_q)
            return

        # Direct Browser / Document Scrolling & Navigation (English & Bangla)
        scroll_down_triggers = (
            "scroll down", "down scroll", "scroll niche", "niche scroll", "niche scroll koro",
            "niche jao", "niche jaw", "upor theke niche jao", "upor theke niche jaw",
            "upor theke scroll kore niche jao", "upor theke scroll kore niche jaw",
            "page down", "scroll further down"
        )
        if lower in scroll_down_triggers or any(lower == t for t in scroll_down_triggers):
            res = await self._handle_computer_settings({"action": "scroll_down"}, loop)
            self.ui.show_content(self._asst_name, "Scrolling down...")
            self.ui.write_log(f"{self._asst_name}: Scrolled down")
            if not self.ui.muted:
                self.set_app_state("LISTENING")
            return

        scroll_up_triggers = (
            "scroll up", "up scroll", "scroll upore", "upore scroll", "upore scroll koro",
            "upore jao", "upore jaw", "niche theke upore jao", "niche theke upore jaw",
            "niche theke scroll kore upore jao", "niche theke scroll kore upore jaw",
            "page up", "scroll back up"
        )
        if lower in scroll_up_triggers or any(lower == t for t in scroll_up_triggers):
            res = await self._handle_computer_settings({"action": "scroll_up"}, loop)
            self.ui.show_content(self._asst_name, "Scrolling up...")
            self.ui.write_log(f"{self._asst_name}: Scrolled up")
            if not self.ui.muted:
                self.set_app_state("LISTENING")
            return

        if lower in ("scroll top", "scroll to top", "ekdom upore", "ekdom upore jao", "top scroll"):
            res = await self._handle_computer_settings({"action": "scroll_top"}, loop)
            self.ui.show_content(self._asst_name, "Scrolled to top.")
            self.ui.write_log(f"{self._asst_name}: Scrolled to top")
            if not self.ui.muted:
                self.set_app_state("LISTENING")
            return

        if lower in ("scroll bottom", "scroll to bottom", "ekdom niche", "ekdom niche jao", "bottom scroll"):
            res = await self._handle_computer_settings({"action": "scroll_bottom"}, loop)
            self.ui.show_content(self._asst_name, "Scrolled to bottom.")
            self.ui.write_log(f"{self._asst_name}: Scrolled to bottom")
            if not self.ui.muted:
                self.set_app_state("LISTENING")
            return

        if lower in ("reload", "refresh", "refresh page", "page refresh koro", "reload koro"):
            res = await self._handle_computer_settings({"action": "refresh_page"}, loop)
            self.ui.show_content(self._asst_name, "Page refreshed.")
            self.ui.write_log(f"{self._asst_name}: Page refreshed")
            if not self.ui.muted:
                self.set_app_state("LISTENING")
            return

        weather_match = re.match(r"^weather(?:\s+in|\s+for|\s+report)?\s*(.*)$", lower)
        if weather_match and weather_match.group(1):
            city = weather_match.group(1).strip()
            res = await self._handle_weather_report({"city": city}, loop)
            self.ui.show_content(self._asst_name, res)
            self.ui.write_log(f"{self._asst_name}: {res}")
            if not self.ui.muted:
                self.set_app_state("LISTENING")
            return

        search_match = re.match(r"^(?:search|google|find)\s+(.+)$", lower)
        if search_match:
            query = search_match.group(1).strip()
            res = await self._handle_web_search({"query": query}, loop)
            self.ui.show_content(self._asst_name, res)
            self.ui.write_log(f"{self._asst_name}: {res}")
            if not self.ui.muted:
                self.set_app_state("LISTENING")
            return

        # If Live session is active, forward to Gemini Live session
        if self.session is not None:
            try:
                await self.session.send_client_content(
                    turns=[
                        types.Content(
                            parts=[types.Part.from_text(text=text)]
                        )
                    ],
                    turn_complete=True,
                )
                return
            except Exception as e:
                print(f"[MJ] Live text send failed: {e}")

        # Local LLM / general command fallback
        try:
            from core.llm_client import call_llm
            resp = await loop.run_in_executor(
                None, lambda: call_llm([{"role": "user", "content": text}])
            )
            content = (resp.get("content", "") if isinstance(resp, dict) else str(resp or "")).strip()
            if content:
                self.ui.show_content(self._asst_name, content)
                self.ui.write_log(f"{self._asst_name}: {content}")
            else:
                ack = f"Command received: '{text}'"
                self.ui.show_content(self._asst_name, ack)
                self.ui.write_log(f"{self._asst_name}: {ack}")
        except Exception:
            ack = f"Executed: '{text}'"
            self.ui.show_content(self._asst_name, ack)
            self.ui.write_log(f"{self._asst_name}: {ack}")

        if not self.ui.muted:
            self.set_app_state("LISTENING")

    def _process_text_command_sync(self, text: str):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self._process_text_command(text))
        finally:
            loop.close()

    def set_app_state(self, state: str):
        self.ui.set_state(state)
        if self._dashboard:
            try:
                loop = self._loop or asyncio.get_event_loop()
                if loop and loop.is_running():
                    asyncio.run_coroutine_threadsafe(
                        self._dashboard.broadcast({"type": "state", "state": state}),
                        loop,
                    )
            except Exception:
                pass

    def set_speaking(self, value: bool):
        with self._speaking_lock:
            self._is_speaking = value
        if value:
            self._reset_followup_timer()
            self.set_app_state("SPEAKING")
        elif not self.ui.muted:
            self.set_app_state("LISTENING")

    def interrupt(self) -> None:
        """Stop MJ mid-speech: drain queued audio and open mic immediately."""
        self._interrupted = True
        q = self.audio_in_queue
        if q:
            drained = 0
            while True:
                try:
                    q.get_nowait()
                    drained += 1
                except Exception:
                    break
            if drained:
                print(f"[MJ] ✋ Interrupted — {drained} audio chunks discarded")
        self.set_speaking(False)
        if self._turn_done_event:
            self._turn_done_event.clear()
        self.ui.write_log("SYS: Interrupted — listening...")

    def speak(self, text: str):
        if not self._loop or not self.session:
            return
        asyncio.run_coroutine_threadsafe(
            self.session.send_client_content(
                turns=[{"role": "user", "parts": [{"text": text}]}], turn_complete=True
            ),
            self._loop,
        )

    def speak_error(self, tool_name: str, error: str):
        short = error[:120]
        self.ui.write_log(f"ERR: {tool_name} — {short}")
        self.speak(f"Sir, {tool_name} encountered an error. {short}")

    def _build_config(self) -> types.LiveConnectConfig:
        from datetime import datetime

        # Load customization from config
        try:
            _cfg = json.loads(open(API_CONFIG_PATH, encoding="utf-8").read())
            self._asst_name = (_cfg.get("assistant_name") or "MJ").strip()
            _user_name = (_cfg.get("user_name") or "").strip()
        except Exception:
            self._asst_name = "MJ"
            _user_name = ""

        memory = load_memory()
        mem_str = format_memory_for_prompt(memory)
        sys_prompt = _load_system_prompt()

        now = datetime.now()
        time_str = now.strftime("%A, %B %d, %Y — %I:%M %p")
        time_ctx = (
            f"[CURRENT DATE & TIME]\n"
            f"Right now it is: {time_str}\n"
            f"Use this to calculate exact times for reminders.\n\n"
        )

        # Identity injection — overrides any hardcoded name in prompt.txt
        _addr = (
            f"ADDRESS: Always call the user '{_user_name}'."
            if _user_name
            else 'ADDRESS: When speaking Turkish → always say "efendim". '
            'When speaking English → say "sir". Never mix languages.'
        )
        identity_ctx = (
            f"[IDENTITY]\n"
            f"Your name is {self._asst_name}. "
            f"Always refer to yourself as {self._asst_name}.\n"
            f"{_addr}\n\n"
        )

        mj_voice_instruction = (
            "[CRITICAL VOICE & PERSONALITY DIRECTIVE]\n"
            "YOU ARE MJ, A WARM, CHEERFUL, FRIENDLY, AND HIGHLY INTELLIGENT AI COMPANION.\n"
            "YOU HAVE A LIVELY, SWEET, AND DELIGHTFUL FEMALE VOICE.\n"
            "SPEAK NATURALLY, WARMLY, AND CONVERSATIONALLY LIKE A CLOSE, SMART FRIEND.\n"
            "KEEP YOUR RESPONSES CRISP, FAST, INSTANTANEOUS, AND ENGAGING WITHOUT UNNECESSARY LONG DELAYS.\n"
            "WHEN SPEAKING BANGLA OR BANGLISH, SPEAK FLUENTLY, SWEETLY, AND NATURALLY (e.g. 'Hae Anvvi, bolo ki korbo?', 'Sure, ami dekhchi!').\n"
            "BE ENERGETIC, HELPFUL, AND DELIGHTFUL IN EVERY INTERACTION.\n\n"
        )

        parts = [mj_voice_instruction, time_ctx, identity_ctx]
        if mem_str:
            parts.append(mem_str)
        parts.append(sys_prompt)

        return types.LiveConnectConfig(
            response_modalities=[types.Modality.AUDIO],
            output_audio_transcription=types.AudioTranscriptionConfig(),
            input_audio_transcription=types.AudioTranscriptionConfig(),
            system_instruction="\n".join(parts),
            tools=[{"function_declarations": TOOL_DECLARATIONS}],
            session_resumption=types.SessionResumptionConfig(),
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Aoede")
                )
            ),
            thinking_config=types.ThinkingConfig(thinking_level="minimal"),
        )

    async def _handle_open_app(self, args, loop):
        app_name = (args.get("app_name") or args.get("name") or "").strip()
        if app_name:
            self._last_target_app = app_name
            self._last_target_app_time = time.monotonic()
            self._unrelated_action_count = 0
        r = await loop.run_in_executor(
            None, lambda: open_app(parameters=args, response=None, player=self.ui)
        )
        return r or f"Opened {app_name or 'application'}."

    async def _handle_weather_report(self, args, loop):
        r = await loop.run_in_executor(
            None, lambda: weather_action(parameters=args, player=self.ui)
        )
        return r or "Weather delivered."

    async def _handle_browser_control(self, args, loop):
        r = await loop.run_in_executor(
            None, lambda: browser_control(parameters=args, player=self.ui)
        )
        return r or "Done."

    async def _handle_file_controller(self, args, loop):
        r = await loop.run_in_executor(
            None, lambda: file_controller(parameters=args, player=self.ui)
        )
        return r or "Done."

    async def _handle_send_message(self, args, loop):
        r = await loop.run_in_executor(
            None,
            lambda: send_message(
                parameters=args, response=None, player=self.ui, session_memory=None
            ),
        )
        return r or f"Message sent to {args.get('receiver')}."

    async def _handle_reminder(self, args, loop):
        r = await loop.run_in_executor(
            None, lambda: reminder(parameters=args, response=None, player=self.ui)
        )
        return r or "Reminder set."

    async def _handle_youtube_video(self, args, loop):
        r = await loop.run_in_executor(
            None, lambda: youtube_video(parameters=args, response=None, player=self.ui)
        )
        return r or "Done."

    async def _handle_screen_process(self, args, loop):
        import time as _t_mod

        _now = _t_mod.monotonic()
        _cooldown = 4.0  # seconds — covers echo window after speaking ends
        if self._vision_busy or (_now - self._vision_last_time) < _cooldown:
            _wait = max(0, _cooldown - (_now - self._vision_last_time))
            print(
                f"[Vision] ⏳ Cooldown active ({_wait:.1f}s remaining) — ignoring duplicate call"
            )
            return "Vision is still processing the previous request. I will not call this again."
        else:
            self._vision_busy = True
            self._vision_last_time = _now
            angle = args.get("angle", "screen").lower()
            user_text = args.get("text", "What do you see?")
            if angle == "camera":
                img_b, mime_t = await loop.run_in_executor(None, _capture_camera)
                self.ui.start_camera_stream()
                self._vision_cam_active = True
                print(f"[Vision] 📷 Camera: {len(img_b):,} bytes")
                _stall = "camera"
            else:
                img_b, mime_t = await loop.run_in_executor(None, _capture_screen)
                print(f"[Vision] 🖥️  Screen: {len(img_b):,} bytes")
                _stall = "screen"
            self._pending_vision = (img_b, mime_t, user_text, angle)
            return (
                f"[VISION_ACTIVE] {_stall.capitalize()} captured. "
                f"Immediately say ONE short natural sentence in the user's own language, "
                f"telling them you are looking at their {_stall} right now. "
                f"Do NOT describe or guess content — the actual image arrives in the NEXT message."
            )

    async def _handle_close_app(self, args, loop):
        target = (args.get("app_name") or args.get("name") or "").strip()
        if target.lower() in ("it", "that", "ota", "eita", "app", "application", "this", ""):
            active = self._get_active_target_app()
            if active:
                target = active
                args["app_name"] = target
                self._last_target_app = ""  # Cleared after closing
            else:
                # Fallback: close focused foreground window if pronoun expired
                from actions.computer_settings import close_foreground_app
                await loop.run_in_executor(None, close_foreground_app)
                return "Closed current focused window."
        elif target:
            self._last_target_app = target
            self._last_target_app_time = time.monotonic()
            self._unrelated_action_count = 0

        r = await loop.run_in_executor(
            None, lambda: close_app(parameters=args, response=None, player=self.ui)
        )
        return r or f"Closed {target or 'application'}."

    async def _handle_close_camera(self, args, loop):
        self.ui.stop_camera_stream()
        return "Camera closed."

    async def _handle_computer_settings(self, args, loop):
        from actions.computer_settings import _DANGEROUS_ACTIONS, peek_settings_action
        action = peek_settings_action(args)
        confirmed = str(args.get("confirmed", "")).lower() in ("yes", "true", "1", "confirm")

        if action in _DANGEROUS_ACTIONS:
            try:
                from core.speaker_verifier import verify_speaker_authorization
                _last_audio = getattr(self, "_last_user_audio", None)
                auth_ok, reason = verify_speaker_authorization(audio_data=_last_audio)
                if not auth_ok:
                    return f"BLOCKED: Voice authentication failed for {action}. Action cancelled for security."
            except Exception:
                pass

        if action in _DANGEROUS_ACTIONS and not confirmed:
            self._pending_dangerous_action = (action, args)
            action_display = action.replace("_", " ")
            return (
                f"CONFIRMATION_REQUIRED: You are attempting to {action_display} the computer. "
                f"Before proceeding, you MUST ask the user directly for spoken confirmation: "
                f"'Are you sure you want to {action_display} the computer?'. "
                f"Do NOT execute this action until the user clearly answers with yes."
            )

        self._pending_dangerous_action = None
        r = await loop.run_in_executor(
            None,
            lambda: computer_settings(parameters=args, response=None, player=self.ui),
        )
        return r or "Done."

    async def _handle_desktop_control(self, args, loop):
        r = await loop.run_in_executor(
            None, lambda: desktop_control(parameters=args, player=self.ui)
        )
        return r or "Done."

    async def _handle_vscode_control(self, args, loop):
        r = await loop.run_in_executor(
            None, lambda: vscode_control(parameters=args, player=self.ui)
        )
        return r or "Done."

    async def _handle_code_helper(self, args, loop):
        r = await loop.run_in_executor(
            None, lambda: code_helper(parameters=args, player=self.ui, speak=self.speak)
        )
        return r or "Done."

    async def _handle_dev_agent(self, args, loop):
        r = await loop.run_in_executor(
            None, lambda: dev_agent(parameters=args, player=self.ui, speak=self.speak)
        )
        return r or "Done."

    async def _handle_voice_enrollment(self, args, loop):
        from core.speaker_verifier import (
            enroll_speaker,
            check_enrollment_status,
            reset_enrollment,
        )
        action = str(args.get("action", "")).lower().strip()
        if action == "enroll_voice":
            r = await loop.run_in_executor(
                None, lambda: enroll_speaker(speak_fn=self.speak)
            )
        elif action == "check_enrollment":
            r = await loop.run_in_executor(None, check_enrollment_status)
        elif action == "reset_enrollment":
            r = await loop.run_in_executor(None, reset_enrollment)
        else:
            r = f"Unknown voice_enrollment action: {action}"
        return r or "Done."

    async def _handle_web_search(self, args, loop):
        r = await loop.run_in_executor(
            None, lambda: web_search_action(parameters=args, player=self.ui)
        )
        result = r or "Done."
        # Mirror results to the on-screen content panel
        _mode = args.get("mode", "search")
        if r and not r.startswith("No results") and not r.startswith("Search failed"):
            _query = args.get("query") or ", ".join(args.get("items", []))
            _label = f"{_mode.upper()} — {_query[:38]}" if _query else _mode.upper()
            self.ui.show_content(_label, r)
        return result

    async def _handle_file_processor(self, args, loop):
        if not args.get("file_path") and self.ui.current_file:
            args["file_path"] = self.ui.current_file
        r = await loop.run_in_executor(
            None,
            lambda: file_processor(parameters=args, player=self.ui, speak=self.speak),
        )
        return r or "Done."

    async def _handle_computer_control(self, args, loop):
        r = await loop.run_in_executor(
            None, lambda: computer_control(parameters=args, player=self.ui)
        )
        return r or "Done."

    async def _handle_game_updater(self, args, loop):
        r = await loop.run_in_executor(
            None,
            lambda: game_updater(parameters=args, player=self.ui, speak=self.speak),
        )
        return r or "Done."

    async def _handle_flight_finder(self, args, loop):
        r = await loop.run_in_executor(
            None, lambda: flight_finder(parameters=args, player=self.ui)
        )
        return r or "Done."

    async def _handle_system_status(self, args, loop):
        r = await loop.run_in_executor(None, get_system_status)
        return str(r)

    async def _handle_routine_manager(self, args, loop):
        r = await loop.run_in_executor(
            None, lambda: routine_manager(parameters=args, player=self.ui)
        )
        return r or "Routine processed."

    async def _handle_advanced_settings(self, args, loop):
        r = await loop.run_in_executor(
            None, lambda: advanced_settings(parameters=args, player=self.ui)
        )
        return r or "Done."

    async def _handle_browser_manager(self, args, loop):
        r = await loop.run_in_executor(
            None, lambda: browser_manager(parameters=args, player=self.ui)
        )
        return r or "Done."

    async def _handle_window_controller(self, args, loop):
        r = await loop.run_in_executor(
            None, lambda: window_controller(parameters=args, player=self.ui)
        )
        return r or "Done."

    async def _handle_calendar_manager(self, args, loop):
        r = await loop.run_in_executor(
            None, lambda: calendar_manager(parameters=args, player=self.ui)
        )
        return r or "Done."

    async def _handle_smart_home(self, args, loop):
        r = await loop.run_in_executor(
            None, lambda: smart_home(parameters=args, player=self.ui)
        )
        return r or "Done."

    async def _handle_vision_control(self, args, loop):
        action = str(args.get("action", "")).lower().strip()
        if action in ("start", "start_vision", "enable", "on", "watch", "watch_screen", "resume"):
            self.vision_active = True
            self.ui.write_log("👁️ Screen Vision: ACTIVE (Always Watching)")
            if self._dashboard:
                try:
                    await self._dashboard.broadcast({
                        "type": "toast",
                        "title": "VISION: ACTIVE",
                        "text": "Continuous screen vision started.",
                        "category": "vision"
                    })
                except Exception:
                    pass
            return "Continuous screen vision is now ACTIVE. I am watching your screen."
        elif action in ("stop", "stop_vision", "disable", "off", "stop_watching", "pause"):
            self.vision_active = False
            self.ui.write_log("👁️ Screen Vision: STOPPED (Saving Resources)")
            if self._dashboard:
                try:
                    await self._dashboard.broadcast({
                        "type": "toast",
                        "title": "VISION: STOPPED",
                        "text": "Continuous screen vision stopped.",
                        "category": "vision"
                    })
                except Exception:
                    pass
            return "Continuous screen vision is now STOPPED to save RAM and CPU. Say 'watch my screen' whenever you want me to resume."
        else:
            status_str = "ACTIVE" if getattr(self, "vision_active", False) else "STOPPED"
            return f"Continuous screen vision is currently {status_str}."

    async def _handle_shutdown(self, args, loop):
        self.ui.write_log("SYS: Shutdown requested.")
        self.speak("Goodbye, sir.")

        def _shutdown():
            import os
            import time

            time.sleep(1)
            os._exit(0)

        threading.Thread(target=_shutdown, daemon=True).start()
        return "Done."

    TOOL_REGISTRY = {
        "open_app": _handle_open_app,
        "close_app": _handle_close_app,
        "weather_report": _handle_weather_report,
        "browser_control": _handle_browser_control,
        "browser_manager": _handle_browser_manager,
        "file_controller": _handle_file_controller,
        "send_message": _handle_send_message,
        "reminder": _handle_reminder,
        "youtube_video": _handle_youtube_video,
        "screen_process": _handle_screen_process,
        "close_camera": _handle_close_camera,
        "computer_settings": _handle_computer_settings,
        "advanced_settings": _handle_advanced_settings,
        "window_controller": _handle_window_controller,
        "vision_control": _handle_vision_control,
        "start_vision": lambda self, args, loop: self._handle_vision_control({"action": "start"}, loop),
        "stop_vision": lambda self, args, loop: self._handle_vision_control({"action": "stop"}, loop),
        "desktop_control": _handle_desktop_control,
        "code_helper": _handle_code_helper,
        "vscode_control": _handle_vscode_control,
        "dev_agent": _handle_dev_agent,
        "web_search": _handle_web_search,
        "file_processor": _handle_file_processor,
        "computer_control": _handle_computer_control,
        "game_updater": _handle_game_updater,
        "flight_finder": _handle_flight_finder,
        "system_status": _handle_system_status,
        "routine_manager": _handle_routine_manager,
        "calendar_manager": _handle_calendar_manager,
        "smart_home": _handle_smart_home,
        "remember_fact": handle_remember_fact,
        "recall_facts": handle_recall_facts,
        "forget_fact": handle_forget_fact,
        "shutdown_mj": _handle_shutdown,
        "shutdown_ultron": _handle_shutdown,
        "shutdown_jarvis": _handle_shutdown,
        "voice_enrollment": _handle_voice_enrollment,
    }

    async def _execute_tool(self, fc) -> types.FunctionResponse:
        name = fc.name
        args = dict(fc.args or {})

        print(f"[MJ] 🔧 {name}  {args}")
        self.set_app_state("THINKING")

        if name == "save_memory":
            category = args.get("category", "notes")
            key = args.get("key", "")
            value = args.get("value", "")
            if key and value:
                update_memory({category: {key: {"value": value}}})
                print(f"[Memory] 💾 save_memory: {category}/{key} = {value}")
            if not self.ui.muted:
                self.set_app_state("LISTENING")
            return types.FunctionResponse(
                id=fc.id, name=name, response={"result": "ok", "silent": True}
            )

        loop = asyncio.get_event_loop()
        result = "Done."

        try:
            from memory.analytics_manager import log_tool_usage
            log_tool_usage(name)
        except Exception:
            pass

        try:
            if name not in ("open_app", "close_app", "save_memory"):
                self._unrelated_action_count += 1
            handler = self.TOOL_REGISTRY.get(name)
            if handler:
                result = await handler(self, args, loop)
            else:
                result = f"Unknown tool: {name}"

        except Exception as e:
            result = f"Tool '{name}' failed: {e}"
            traceback.print_exc()
            self.speak_error(name, str(e))

        if self._dashboard:
            try:
                loop.create_task(self._dashboard.broadcast({
                    "type": "toast",
                    "title": f"TOOL: {name.upper()}",
                    "text": str(result)[:60] if result else "Executed successfully.",
                    "category": "tool",
                }))
            except Exception:
                pass

        if not self.ui.muted:
            self.set_app_state("LISTENING")

        print(f"[MJ] 📤 {name} → {str(result)[:80]}")
        return types.FunctionResponse(id=fc.id, name=name, response={"result": result})

    async def _send_realtime(self):
        while True:
            msg = await self.out_queue.get()
            if self.session is not None:
                try:
                    await self.session.send_realtime_input(audio=msg)
                    self._audio_chunks_sent = getattr(self, "_audio_chunks_sent", 0) + 1
                except Exception as e:
                    print(f"[MJ] ⚠️ send_realtime error: {e}")
                    raise

    async def _listen_audio(self):
        print("[MJ] 🎤 Mic started")
        loop = asyncio.get_event_loop()
        import numpy as np

        barge_threshold = get_barge_in_threshold()
        speech_threshold = max(500.0, barge_threshold * 0.55)
        consecutive_barge_frames = 0
        self._audio_chunks_sent = 0

        async def _audio_heartbeat():
            while True:
                await asyncio.sleep(5.0)
                with self._speaking_lock:
                    speaking = self._is_speaking
                sent = getattr(self, "_audio_chunks_sent", 0)
                print(
                    f"[Audio Monitor] Mic Muted: {self.ui.muted} | Assistant Speaking: {speaking} | "
                    f"Phone Active: {self._phone_active} | Chunks Sent: {sent}"
                )

        heartbeat_task = asyncio.create_task(_audio_heartbeat())

        def _push_chunk(chunk_dict):
            try:
                if self.out_queue:
                    if self.out_queue.full():
                        try:
                            self.out_queue.get_nowait()
                        except Exception:
                            pass
                    self.out_queue.put_nowait(chunk_dict)
            except Exception:
                pass

        def callback(indata, frames, time_info, status):
            nonlocal consecutive_barge_frames
            data = indata.tobytes()
            with self._speaking_lock:
                ultron_speaking = self._is_speaking

            # Compute RMS amplitude for visualizer & barge-in
            try:
                arr = np.frombuffer(data, dtype=np.int16)
                rms = float(np.sqrt(np.mean(arr.astype(np.float32) ** 2) + 1e-12))
            except Exception:
                rms = 0.0

            # Forward real-time audio level for orb animations
            if not self.ui.muted and not self._phone_active:
                level = min(1.0, rms / 4000.0)
                if level > 0.02:
                    self.ui.set_audio_level(level)
                    if self._dashboard:
                        loop.call_soon_threadsafe(
                            asyncio.create_task,
                            self._dashboard.broadcast({"type": "audio_level", "level": level}),
                        )

            # Barge-in: user talks while assistant is speaking (requires 2 consecutive frames ~40ms)
            if ultron_speaking:
                if rms > barge_threshold:
                    consecutive_barge_frames += 1
                    if consecutive_barge_frames >= 2:
                        print(
                            f"[MJ] 🎙️ Barge-in (RMS {rms:.0f} > {barge_threshold:.0f}) — stopping assistant speech immediately."
                        )
                        interrupt_playback()
                        loop.call_soon_threadsafe(self.interrupt)
                        if not self.ui.muted and not self._phone_active:
                            loop.call_soon_threadsafe(
                                _push_chunk,
                                {"data": data, "mime_type": "audio/pcm;rate=16000"},
                            )
                else:
                    consecutive_barge_frames = 0
                return

            consecutive_barge_frames = 0
            if not self.ui.muted and not self._phone_active:
                if rms > speech_threshold:
                    self._last_user_speech = time.monotonic()
                    self._reset_followup_timer()
                    print(f"[Mic Audio] 🎙️ Voice detected! RMS: {rms:.1f} (Threshold: {speech_threshold:.1f})")
                    # Rolling cache for speaker verification — keep last ~5 s of voice data
                    _prev = self._last_user_audio or b""
                    _combined = _prev + data
                    _MAX_BYTES = SEND_SAMPLE_RATE * 2 * 5  # 5 s @ 16kHz int16 = 160000 bytes
                    self._last_user_audio = _combined[-_MAX_BYTES:]
                loop.call_soon_threadsafe(
                    _push_chunk, {"data": data, "mime_type": "audio/pcm;rate=16000"}
                )

        try:
            dev_idx = sd.default.device[0] if sd.default.device and sd.default.device[0] is not None else None
            with sd.InputStream(
                device=dev_idx,
                samplerate=SEND_SAMPLE_RATE,
                channels=CHANNELS,
                dtype="int16",
                blocksize=CHUNK_SIZE,
                latency="low",
                callback=callback,
            ):
                print(f"[MJ] 🎤 Mic stream open (Device #{dev_idx}, Sample Rate: {SEND_SAMPLE_RATE}Hz)")
                while True:
                    await asyncio.sleep(0.02)
        except Exception as e:
            print(f"[MJ] ❌ Mic: {e}")
            raise
        finally:
            heartbeat_task.cancel()

    async def _receive_audio(self):
        print("[MJ] 👂 Recv started")
        out_buf, in_buf = [], []

        try:
            while True:
                if self.session is None:
                    await asyncio.sleep(0.05)
                    continue
                async for response in self.session.receive():
                    if response.data:
                        if self._interrupted:
                            pass  # discard: interrupted
                        else:
                            if self._turn_done_event and self._turn_done_event.is_set():
                                self._turn_done_event.clear()
                            # Split into ~25 ms slices for ultra-low latency playback streaming
                            _audio_data = response.data
                            _SLICE = 1200
                            for _i in range(0, len(_audio_data), _SLICE):
                                self.audio_in_queue.put_nowait(
                                    _audio_data[_i : _i + _SLICE]
                                )

                    if response.server_content:
                        sc = response.server_content

                        if sc.output_transcription and sc.output_transcription.text:
                            txt = _clean_transcript(sc.output_transcription.text)
                            if txt and txt != (out_buf[-1] if out_buf else ""):
                                out_buf.append(txt)

                        if sc.input_transcription and sc.input_transcription.text:
                            txt = _clean_transcript(sc.input_transcription.text)
                            if txt:
                                in_buf.append(txt)
                                self._last_user_speech = time.monotonic()
                                self.set_app_state("THINKING")
                                print(f"[Gemini Input] 🗣️ User transcript chunk: '{txt}'")

                        if sc.turn_complete:
                            if self._turn_done_event:
                                self._turn_done_event.set()

                            # If this turn_complete ends an interrupted response, clear the
                            # flag and skip all further processing for that turn.
                            if self._interrupted:
                                self._interrupted = False
                                in_buf = []
                                out_buf = []
                                continue

                            full_in = " ".join(in_buf).strip()
                            if full_in:
                                print(f"[Turn Complete] 👤 User said: '{full_in}'")
                                self.ui.write_log(f"You: {full_in}")
                                if self._dashboard:
                                    asyncio.create_task(
                                        self._dashboard.broadcast(
                                            {
                                                "type": "log",
                                                "speaker": "user",
                                                "text": full_in,
                                                "ts": datetime.now().isoformat(),
                                            }
                                        )
                                    )

                                # Check phrase-triggered routine matches BEFORE normal turn processing
                                matched_routine = None
                                lower_in = full_in.lower()
                                for r in load_routines():
                                    if r.get("enabled", True) and r.get("trigger_type") == "phrase":
                                        t_phrase = (r.get("trigger_value") or "").strip().lower()
                                        if t_phrase and t_phrase in lower_in:
                                            matched_routine = r
                                            break

                                if matched_routine:
                                    r_name = matched_routine.get("name", "unnamed")
                                    update_routine_last_run(r_name, datetime.now().strftime("%Y-%m-%d %H:%M"))
                                    self.ui.write_log(f"⚡ Spoken Routine Triggered: '{r_name}'")
                                    self.speak(f"Running {r_name} routine.")

                                    loop = asyncio.get_running_loop()
                                    for step in matched_routine.get("steps", []):
                                        tool_name = step.get("tool")
                                        args = step.get("args", {})
                                        if tool_name in self.TOOL_REGISTRY:
                                            try:
                                                handler = self.TOOL_REGISTRY[tool_name]
                                                await handler(self, args, loop)
                                            except Exception as err:
                                                print(f"[Routine] Step '{tool_name}' failed: {err}")
                                    in_buf = []
                                    out_buf = []
                                    continue

                            in_buf = []

                            full_out = " ".join(out_buf).strip()
                            if full_out:
                                self.ui.write_log(f"{self._asst_name}: {full_out}")
                                if self._dashboard:
                                    asyncio.create_task(
                                        self._dashboard.broadcast(
                                            {
                                                "type": "log",
                                                "speaker": "mj",
                                                "text": full_out,
                                                "ts": datetime.now().isoformat(),
                                            }
                                        )
                                    )
                            out_buf = []

                            # Vision injection: model finished tool-response turn → now send the image
                            if self._pending_vision and self.session:
                                import base64 as _b64

                                img_b, mime_t, question, angle = self._pending_vision
                                self._pending_vision = None
                                await self.session.send_client_content(
                                    turns=[
                                        types.Content(
                                            parts=[
                                                types.Part.from_bytes(
                                                    data=img_b,
                                                    mime_type=mime_t,
                                                ),
                                                types.Part.from_text(text=question),
                                            ]
                                        )
                                    ],
                                    turn_complete=True,
                                )
                                # Mark next turn_complete behaviour depending on angle
                                if self._vision_cam_active:
                                    # Camera: keep busy until MJ finishes speaking the answer
                                    self._vision_cam_active = False
                                    self._vision_close_pending = True
                                else:
                                    # Screen-only: no camera to close; release busy flag now
                                    self._vision_busy = False
                            elif self._vision_close_pending:
                                # This turn_complete IS the vision answer — close camera + release busy flag
                                self._vision_close_pending = False
                                self._vision_busy = False

                                async def _cam_close():
                                    await asyncio.sleep(2.0)
                                    self.ui.stop_camera_stream()

                                asyncio.create_task(_cam_close())

                    if response.tool_call:
                        fn_responses = []
                        fcalls = getattr(response.tool_call, "function_calls", None) or []
                        for fc in fcalls:
                            print(f"[MJ] 📞 {fc.name}")
                            fr = await self._execute_tool(fc)
                            fn_responses.append(fr)
                        if self.session and fn_responses:
                            await self.session.send_tool_response(
                                function_responses=fn_responses
                            )
        except Exception as e:
            print(f"[MJ] ❌ Recv: {e}")
            traceback.print_exc()
            raise

    async def _play_audio(self):
        print("[MJ] 🔊 Play started")

        stream = sd.RawOutputStream(
            samplerate=RECEIVE_SAMPLE_RATE,
            channels=CHANNELS,
            dtype="int16",
            blocksize=CHUNK_SIZE,
            latency="low",
        )
        stream.start()

        try:
            while True:
                try:
                    chunk = await asyncio.wait_for(
                        self.audio_in_queue.get(), timeout=0.02
                    )
                except asyncio.TimeoutError:
                    if (
                        self._turn_done_event
                        and self._turn_done_event.is_set()
                        and self.audio_in_queue.empty()
                    ):
                        self.set_speaking(False)
                        self._turn_done_event.clear()
                        self._last_assistant_turn_done = time.monotonic()
                        self._start_followup_timer()
                    continue
                self.set_speaking(True)
                try:
                    await asyncio.to_thread(stream.write, chunk)
                except (RuntimeError, asyncio.CancelledError):
                    break  # executor shutting down — exit cleanly
        except Exception as e:
            print(f"[MJ] ❌ Play: {e}")
            raise
        finally:
            self.set_speaking(False)
            stream.stop()
            stream.close()

    # ── Morning briefing ────────────────────────────────────────────────────────

    async def _send_startup_briefing(self) -> None:
        """
        Startup briefing:
          Instant greeting & status report (no news prefetching).
        """
        memory = load_memory()
        identity = memory.get("identity", {})

        def _val(k: str) -> str:
            e = identity.get(k, {})
            return (e.get("value", "") if isinstance(e, dict) else str(e)).strip()

        lang = _val("language")
        name = _val("name")
        time_str = datetime.now().strftime("%H:%M")

        await asyncio.sleep(0.3)
        if not self.session:
            return

        # ── Instant greeting & status ─────────────────────────────────────────
        lang_clause = f" Respond in {lang}." if lang else ""
        name_clause = f" Address the user as {name}." if name else ""
        p1 = (
            f"Greet the user warmly, mention it is {time_str}, state that MJ systems and HUD are fully operational, "
            f"and ask how you can assist today. One or two short sweet sentences only. Do not call any tools.{lang_clause}{name_clause}"
        )

        # Clear the turn-done event
        if self._turn_done_event:
            self._turn_done_event.clear()

        await self.session.send_client_content(
            turns=[{"role": "user", "parts": [{"text": p1}]}],
            turn_complete=True,
        )
        self.ui.write_log("SYS: Startup briefing greeting sent.")

    # ── System monitor ──────────────────────────────────────────────────────────

    # ── Proactive mode ──────────────────────────────────────────────────────────

    async def _continuous_screen_stream(self) -> None:
        """
        Background task: continuously captures a lightweight screen frame every 3.5 seconds
        and streams it to Gemini Live session ONLY when self.vision_active is True.
        Saves RAM, CPU, bandwidth, and API quota when vision is toggled off.
        """
        import io
        from PIL import Image

        while True:
            try:
                await asyncio.sleep(3.5)
                if not getattr(self, "vision_active", False):
                    continue
                if self.session is None or self.ui.muted:
                    continue

                loop = asyncio.get_running_loop()

                def _grab():
                    try:
                        from PIL import ImageGrab
                        img = ImageGrab.grab()
                        w = 640
                        h = max(100, int(w * img.height / img.width))
                        img_small = img.resize((w, h), Image.Resampling.LANCZOS)
                        buf = io.BytesIO()
                        img_small.save(buf, format="JPEG", quality=45, optimize=True)
                        return buf.getvalue()
                    except Exception:
                        return None

                jpeg_bytes = await loop.run_in_executor(None, _grab)
                if jpeg_bytes and self.session is not None and getattr(self, "vision_active", False):
                    try:
                        await self.session.send_realtime_input(
                            video={"data": jpeg_bytes, "mime_type": "image/jpeg"}
                        )
                    except Exception as err:
                        pass
            except asyncio.CancelledError:
                break
            except Exception:
                await asyncio.sleep(3.5)

    async def _run_proactive_mode(self) -> None:
        """
        Background task: periodically checks if the user has been silent long enough,
        then hands time + memory context to Gemini so it can decide what (if anything)
        to say proactively. No hardcoded rules — Gemini makes the call.
        """
        while True:
            await asyncio.sleep(60)  # evaluate once per minute

            if not self.session:
                continue

            with self._speaking_lock:
                speaking = self._is_speaking
            if speaking:
                continue

            if not self._proactive.should_trigger(self._last_user_speech):
                continue

            self._proactive.mark_triggered()

            try:
                memory = await asyncio.to_thread(load_memory)
                prompt = self._proactive.build_prompt(memory)
                await self.session.send_client_content(
                    turns=[{"role": "user", "parts": [{"text": prompt}]}],
                    turn_complete=True,
                )
                self.ui.write_log("SYS: Proactive check-in.")
            except Exception as e:
                print(f"[Proactive] ⚠️ {e}")

    # ── Routine scheduler ───────────────────────────────────────────────────────

    async def _run_routine_scheduler(self) -> None:
        """
        Background task: periodically checks if the current HH:MM matches any enabled
        time-triggered routine whose last_run wasn't today, executes its steps via
        TOOL_REGISTRY, and updates last_run.
        """
        while True:
            await asyncio.sleep(20.0)
            try:
                now = datetime.now()
                current_time = now.strftime("%H:%M")
                today_str = now.strftime("%Y-%m-%d")

                routines = await asyncio.to_thread(load_routines)
                for r in routines:
                    if not r.get("enabled", True):
                        continue
                    if r.get("trigger_type") != "time":
                        continue
                    if r.get("trigger_value") == current_time:
                        last_run = r.get("last_run")
                        if last_run and str(last_run).startswith(today_str):
                            continue

                        r_name = r.get("name", "unnamed")
                        await asyncio.to_thread(
                            update_routine_last_run, r_name, today_str
                        )
                        self.ui.write_log(
                            f"⏰ Scheduled Routine Triggered: '{r_name}' ({current_time})"
                        )
                        if self._dashboard:
                            asyncio.create_task(
                                self._dashboard.broadcast(
                                    {
                                        "type": "log",
                                        "speaker": "system",
                                        "text": f"⏰ Running scheduled routine: {r_name}",
                                        "ts": datetime.now().isoformat(),
                                    }
                                )
                            )

                        loop = asyncio.get_running_loop()
                        for step in r.get("steps", []):
                            tool_name = step.get("tool")
                            args = step.get("args", {})
                            if tool_name in self.TOOL_REGISTRY:
                                try:
                                    handler = self.TOOL_REGISTRY[tool_name]
                                    await handler(self, args, loop)
                                except Exception as err:
                                    print(
                                        f"[Routine] Step '{tool_name}' failed: {err}"
                                    )
            except Exception as e:
                print(f"[RoutineScheduler] Error: {e}")

    # ── Phone audio relay ────────────────────────────────────────────────────────

    async def _relay_phone_audio(self) -> None:
        """Forward phone mic PCM chunks from dashboard queue into the Gemini Live session."""
        if not self._dashboard or not hasattr(self._dashboard, "_phone_audio_queue"):
            return
        q = self._dashboard._phone_audio_queue
        while True:
            try:
                chunk = await asyncio.wait_for(q.get(), timeout=1.0)
            except asyncio.TimeoutError:
                # No audio for 1 s → phone mic inactive, give PC mic back
                self._phone_active = False
                continue
            self._phone_active = True  # phone is streaming — silence PC mic
            with self._speaking_lock:
                speaking = self._is_speaking
            if not speaking and not self.ui.muted:
                try:
                    self.out_queue.put_nowait(chunk)
                except asyncio.QueueFull:
                    pass

    def _on_phone_connected(self) -> None:
        self.ui.write_log("SYS: Phone connected via Remote Dashboard.")
        self.ui.notify_phone_connected()

    # ── dashboard command relay ─────────────────────────────────────────────

    async def _process_dashboard_commands(self) -> None:
        import base64

        if not self._dashboard or not hasattr(self._dashboard, "_command_queue"):
            return
        while True:
            try:
                item = await asyncio.wait_for(
                    self._dashboard._command_queue.get(), timeout=0.02
                )
                if not item:
                    continue
                for _ in range(80):
                    if self.session:
                        break
                    await asyncio.sleep(0.05)
                if self.session:
                    if isinstance(item, dict) and item.get("type") == "image":
                        b64_str = item.get("data", "")
                        mime = item.get("mime", "image/jpeg")
                        img_bytes = base64.b64decode(b64_str)
                        self.ui.write_log(
                            "SYS: Image received. MJ analyzing image..."
                        )
                        await self.session.send_realtime_input(
                            video={"data": img_bytes, "mime_type": mime}
                        )
                        await self.session.send_client_content(
                            turns=[
                                {
                                    "role": "user",
                                    "parts": [
                                        {
                                            "text": "Please analyze this attached image in full detail, describe every visual element, and explain what it represents."
                                        }
                                    ],
                                }
                            ],
                            turn_complete=True,
                        )
                    else:
                        text = str(item).strip()
                        if text:
                            if text in ("/toggle_mic", "toggle_mic", "mute", "unmute"):
                                if text == "mute":
                                    self.ui.muted = True
                                elif text == "unmute":
                                    self.ui.muted = False
                                else:
                                    self.ui.muted = not self.ui.muted
                                new_state = "MUTED" if self.ui.muted else "LISTENING"
                                self.set_app_state(new_state)
                                self.ui.write_log(
                                    f"SYS: Microphone {'MUTED (OFF)' if self.ui.muted else 'UNMUTED (ON)'}."
                                )
                                continue
                            await self.session.send_client_content(
                                turns=[{"role": "user", "parts": [{"text": text}]}],
                                turn_complete=True,
                            )
                            self.ui.write_log(f"[Web]: {text}")
                else:
                    text = str(item).strip() if not isinstance(item, dict) else ""
                    if text:
                        self.ui.write_log(f"[Web Offline]: {text}")
                        res = await self._handle_offline_command(text)
                        self.ui.write_log(f"MJ (Offline): {res}")
                        if self._dashboard:
                            await self._dashboard.broadcast({
                                "type": "log",
                                "speaker": "assistant",
                                "text": f"(Offline) {res}",
                            })
                    else:
                        print("[Dashboard] Dropped item (no active session)")
            except asyncio.TimeoutError:
                pass
            except Exception as e:
                print(f"[Dashboard] Command error: {e}")
                await asyncio.sleep(0.1)

    async def _handle_offline_command(self, text: str) -> str:
        """Execute local commands when network/Gemini Live is offline."""
        cmd = text.strip().lower()
        loop = asyncio.get_running_loop()
        print(f"[Offline Handler] Command: {cmd}")

        # Open App
        if cmd.startswith("open ") or cmd.startswith("launch "):
            app_name = cmd.split(" ", 1)[1].strip()
            handler = self.TOOL_REGISTRY.get("open_app")
            if handler:
                res = await handler(self, {"app_name": app_name}, loop)
                return str(res)

        # Close App
        if cmd.startswith("close ") or cmd.startswith("exit "):
            app_name = cmd.split(" ", 1)[1].strip()
            handler = self.TOOL_REGISTRY.get("close_app")
            if handler:
                res = await handler(self, {"app_name": app_name}, loop)
                return str(res)

        # System Status
        if any(w in cmd for w in ("status", "battery", "cpu", "ram", "memory")):
            return await self._handle_system_status({}, loop)

        # Audio / Volume Control
        if "mute" in cmd or "unmute" in cmd or "volume" in cmd:
            handler = self.TOOL_REGISTRY.get("computer_settings")
            if handler:
                if "unmute" in cmd:
                    return str(await handler(self, {"action": "unmute"}, loop))
                elif "mute" in cmd:
                    return str(await handler(self, {"action": "mute"}, loop))
                elif "volume up" in cmd or "increase volume" in cmd:
                    return str(await handler(self, {"action": "volume_up"}, loop))
                elif "volume down" in cmd or "decrease volume" in cmd:
                    return str(await handler(self, {"action": "volume_down"}, loop))

        # Routines
        if "routine" in cmd:
            handler = self.TOOL_REGISTRY.get("routine_manager")
            if handler:
                return str(await handler(self, {"action": "list"}, loop))

        return "Offline mode active. Available actions: open <app>, close <app>, system status, volume controls."

    # ── main loop ───────────────────────────────────────────────────────────

    async def run(self):
        self._loop = asyncio.get_event_loop()

        # Run system diagnostics (Admin privileges & VS Code CLI checks)
        self._perform_startup_diagnostics()

        # Start dashboard (optional — needs: pip install fastapi "uvicorn[standard]" cryptography)
        try:
            from dashboard.server import DashboardServer

            self._dashboard = DashboardServer()
            self._dashboard.set_connect_callback(self._on_phone_connected)
            asyncio.create_task(self._dashboard.serve())
            asyncio.create_task(self._process_dashboard_commands())
            # webbrowser.open(f"http://127.0.0.1:{PORT}")
        except Exception as e:
            print(f"[Dashboard] Disabled: {e}")
            self._dashboard = None

        while True:
            try:
                print("[MJ] Connecting to Gemini Live...")
                self.set_app_state("THINKING")
                config = self._build_config()

                # Fresh client on every reconnect — avoids stale HTTP session state
                client = genai.Client(
                    api_key=_get_api_key(), http_options={"api_version": "v1beta"}
                )

                async with (
                    client.aio.live.connect(model=LIVE_MODEL, config=config) as session,
                    asyncio.TaskGroup() as tg,
                ):
                    self.session = session
                    self.audio_in_queue = asyncio.Queue()
                    self.out_queue = asyncio.Queue(maxsize=200)
                    self._turn_done_event = asyncio.Event()

                    # Reset transient state that must not carry over from a previous session
                    self._pending_vision = None
                    self._vision_cam_active = False
                    self._vision_close_pending = False
                    self._vision_busy = False
                    self._vision_last_time = 0.0
                    self._interrupted = False

                    print("[MJ] Connected.")
                    self.ui.muted = False
                    self._audio_chunks_sent = 0
                    self.set_app_state("LISTENING")
                    self.ui.write_log("SYS: MJ online — Connected.")

                    if self._dashboard:
                        await self._dashboard.broadcast(
                            {"type": "status", "state": "active"}
                        )

                    tg.create_task(self._send_realtime())
                    tg.create_task(self._listen_audio())
                    tg.create_task(self._receive_audio())
                    tg.create_task(self._play_audio())
                    tg.create_task(self._run_proactive_mode())
                    tg.create_task(self._run_routine_scheduler())
                    tg.create_task(self._continuous_screen_stream())
                    if self._dashboard:
                        tg.create_task(self._relay_phone_audio())

                    # Wake Word or Morning briefing — fires once per process launch
                    if not self._briefing_sent:
                        self._briefing_sent = True
                        if "--wake-word" in sys.argv:
                            tg.create_task(
                                self.session.send_client_content(
                                    turns=[{"role": "user", "parts": [{"text": "wake up mj"}]}],
                                    turn_complete=True,
                                )
                            )
                        elif get_brief_enabled():
                            tg.create_task(self._send_startup_briefing())

            except KeyboardInterrupt:
                raise
            except SystemExit:
                raise
            except BaseException as e:
                # Catches both Exception and BaseExceptionGroup (Python 3.11+
                # TaskGroup raises BaseExceptionGroup when tasks are cancelled
                # externally, which `except Exception` would miss, letting the
                # exception escape the while-loop and causing asyncio.run() to
                # start shutdown — resulting in "executor after shutdown" errors).
                err_str = str(e)
                print(f"[MJ] Error ({type(e).__name__}): {e}")
                traceback.print_exc()

                # Invalid / missing / broken API key — stop hammering the API, prompt re-configuration
                if (
                    isinstance(e, ApiKeyMissing)
                    or "API key not valid" in err_str
                    or "1007" in err_str
                    or "1008" in err_str
                    or "denied access" in err_str
                    or "not found for API version" in err_str
                ):
                    self.ui.write_log(
                        "ERR: Gemini API key missing or invalid. Please provide a Google AI Studio key (starts with AIzaSy...)"
                    )
                    self.ui.set_state("SLEEPING")
                    self.ui.prompt_reconfig("Gemini API key is invalid or unauthorized. Please paste your Google AI Studio key (starts with AIzaSy...).")
                    while not self.ui._win._ready:
                        await asyncio.sleep(1)
                    print("[MJ] New API key saved — reconnecting...")
                    _conn_backoff = 3
                    continue

                # Network / timeout errors — log clearly and back off
                is_net_err = any(
                    k in err_str
                    for k in (
                        "TimeoutError",
                        "timed out",
                        "getaddrinfo",
                        "CancelledError",
                        "ConnectionRefusedError",
                        "OSError",
                        "Cannot connect",
                    )
                )
                if is_net_err:
                    self.ui.write_log("NET: Connection failed. Switching to Fallback Mode...")
                    try:
                        await self._run_fallback_mode()
                    except Exception as fallback_e:
                        print(f"[Fallback Error] {fallback_e}")
                        _conn_backoff = 10
                        self._conn_backoff = _conn_backoff
                else:
                    self._conn_backoff = 3

                if self._dashboard:
                    await self._dashboard.broadcast(
                        {"type": "conn_error", "message": err_str[:200]}
                    )
            finally:
                self.session = None

            self.set_speaking(False)
            self.set_app_state("SLEEPING")

            if self._dashboard:
                await self._dashboard.broadcast({"type": "status", "state": "sleeping"})

            delay = getattr(self, "_conn_backoff", 3)
            print(f"[MJ] Reconnecting in {delay}s...")
            await asyncio.sleep(delay)


    async def _run_fallback_mode(self) -> None:
        """Fallback mode using Whisper and ElevenLabs when Gemini Live fails."""
        self.fallback_active = True
        self.ui.set_state("FALLBACK MODE")
        self.ui.write_log("SYS: Entering Fallback Pipeline (Whisper -> GenAI -> ElevenLabs).")
        
        if self._dashboard:
            await self._dashboard.broadcast({"type": "status", "state": "fallback"})

        fallback_brain = FallbackBrain(system_instruction=_load_system_prompt())
        
        hello_text = "Connection lost. I am now in fallback mode."
        print(f"[Fallback] {hello_text}")
        await speak(hello_text)

        while self.fallback_active:
            self.ui.set_state("LISTENING (FALLBACK)")
            audio_bytes = await record_audio()
            
            if not audio_bytes:
                continue

            self.ui.set_state("THINKING (FALLBACK)")
            transcript = await transcribe(audio_bytes)
            
            if not transcript or len(transcript.strip()) < 2:
                continue

            self.ui.write_log(f"User (Fallback): {transcript}")
            
            self.set_speaking(True)
            self.ui.set_state("SPEAKING (FALLBACK)")
            
            response_text = await fallback_brain.generate_response(transcript, self)
            
            self.ui.write_log(f"MJ (Fallback): {response_text}")
            
            if response_text:
                await speak(response_text)
                
            self.set_speaking(False)

MJLive = UltronLive
JarvisLive = UltronLive


import socket

_single_instance_sock = None


def _ensure_single_instance():
    global _single_instance_sock
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 39152))
        _single_instance_sock = sock
    except OSError:
        print(
            "[MJ] ⚠️ MJ is already running in another process! Exiting duplicate instance to prevent window flickering.",
            file=sys.stderr,
        )
        sys.exit(0)


def main():
    _ensure_single_instance()
    ui = UltronUI("face.png")

    def runner():
        ui.wait_for_api_key()
        ultron = UltronLive(ui)
        try:
            asyncio.run(ultron.run())
        except KeyboardInterrupt:
            print("\n🔴 Shutting down...")

    threading.Thread(target=runner, daemon=True).start()
    ui.root.mainloop()


if __name__ == "__main__":
    main()
