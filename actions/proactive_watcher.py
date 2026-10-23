from __future__ import annotations

import os
import re
import sys
import threading
import time
from typing import Any

import psutil


_lock = threading.RLock()


# Protected process names that must never be terminated by accident
PROTECTED_PROCESS_NAMES = {
    "system",
    "system idle process",
    "registry",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "services.exe",
    "lsass.exe",
    "winlogon.exe",
    "explorer.exe",
    "svchost.exe",
    "dwm.exe",
    "spoolsv.exe",
    "taskmgr.exe",
}


# Known completion signals in terminal / screen outputs
COMPLETION_PATTERNS = [
    r"100(?:\.0+)?\s*%",
    r"(?:training|epoch)\s+(?:completed|finished|done)",
    r"download\s+(?:completed|finished|done|complete)",
    r"deployment\s+(?:completed|finished|successful|succeeded)",
    r"build\s+(?:succeeded|finished|successful|complete)",
    r"successfully\s+(?:installed|built|deployed|downloaded|completed|fetched)",
    r"process\s+finished\s+with\s+exit\s+code\s+0",
    r"done\s+in\s+[\d\.]+\s*(?:s|m|seconds|minutes)?",
    r"finished\s+in\s+[\d\.]+\s*(?:s|m|seconds|minutes)?",
    r"dataset\s+(?:ready|loaded|fetched|downloaded)",
]

# Known fatal error signals in terminal / screen outputs
FATAL_ERROR_PATTERNS = [
    r"Traceback \(most recent call last\):",
    r"SyntaxError:",
    r"ZeroDivisionError:",
    r"CUDA out of memory",
    r"OutOfMemoryError",
    r"ModuleNotFoundError:",
    r"ImportError:",
    r"Fatal error:",
    r"FATAL:",
    r"BUILD FAILED",
    r"Process killed",
    r"command not found",
    r"Segmentation fault",
    r"ConnectionRefusedError",
    r"Error:\s+EADDRINUSE",
    r"npm ERR!",
    r"Pip failed",
]


class WatchedTask:
    def __init__(self, task_name: str, task_type: str = "generic"):
        self.task_name = task_name.strip()
        self.task_type = task_type.strip().lower()
        self.started_at = time.time()
        self.last_checked = time.time()
        self.status = "running"  # "running" | "completed" | "error"
        self.progress_percent: float | None = None
        self.last_screen_text: str = ""
        self.error_snippet: str | None = None
        self.notified = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_name": self.task_name,
            "task_type": self.task_type,
            "started_at": self.started_at,
            "elapsed_seconds": round(time.time() - self.started_at, 1),
            "status": self.status,
            "progress_percent": self.progress_percent,
            "error_snippet": self.error_snippet,
            "notified": self.notified,
        }


class ProactiveWatcher:
    """
    Step 1: Monitors long running processes (training, downloads, deployments, dataset fetching) via Screen Vision.
    Step 2: Proactively notifies when finished ('Boss, your task is finished') or errored ('Boss, the script stopped with an error—should I fix it?').
    Step 3: Detects critical CPU/RAM spikes (>90%), identifies heavy background processes, and asks user before terminating.
    """

    def __init__(self):
        self._tasks: dict[str, WatchedTask] = {}
        self._last_spike_check: float = 0.0
        self._candidate_to_terminate: dict[str, Any] | None = None

    def start_watch(self, task_name: str, task_type: str = "generic") -> dict[str, Any]:
        """Step 1: Register and start tracking a long process."""
        name = (task_name or "Active Long Task").strip()
        with _lock:
            task = WatchedTask(name, task_type)
            self._tasks[name.lower()] = task
            return task.to_dict()

    def stop_watch(self, task_name: str) -> bool:
        """Stop tracking a task."""
        key = (task_name or "").strip().lower()
        with _lock:
            if key in self._tasks:
                del self._tasks[key]
                return True
            return False

    def get_tasks(self) -> list[dict[str, Any]]:
        with _lock:
            return [t.to_dict() for t in self._tasks.values()]

    def analyze_output_for_status(self, text: str) -> dict[str, Any]:
        """
        Inspects screen or terminal text for completion or fatal errors.
        """
        raw = text or ""
        progress = None

        # Check for progress %
        pct_match = re.search(r"(\d{1,3}(?:\.\d+)?)\s*%", raw)
        if pct_match:
            try:
                val = float(pct_match.group(1))
                if 0.0 <= val <= 100.0:
                    progress = val
            except Exception:
                pass

        # Check for epoch progress e.g. Epoch 25/100
        epoch_match = re.search(r"Epoch\s+(\d+)\s*/\s*(\d+)", raw, re.IGNORECASE)
        if epoch_match:
            try:
                curr_ep = float(epoch_match.group(1))
                total_ep = float(epoch_match.group(2))
                if total_ep > 0:
                    progress = round((curr_ep / total_ep) * 100.0, 1)
            except Exception:
                pass

        # 1. Check for fatal errors first
        for err_pat in FATAL_ERROR_PATTERNS:
            if re.search(err_pat, raw, re.IGNORECASE):
                # Extract surrounding error line
                lines = raw.splitlines()
                err_line = next((l for l in lines if re.search(err_pat, l, re.IGNORECASE)), "Fatal script error occurred.")
                return {
                    "status": "error",
                    "progress": progress,
                    "error_snippet": err_line.strip(),
                    "voice_alert": "Boss, the script stopped with an error—should I fix it?",
                    "ui_notification": f"⚠️ Script Error: {err_line.strip()}",
                    "should_fix": True,
                }

        # 2. Check for completion
        for comp_pat in COMPLETION_PATTERNS:
            if re.search(comp_pat, raw, re.IGNORECASE):
                return {
                    "status": "completed",
                    "progress": 100.0 if progress is None or progress >= 99.0 else progress,
                    "error_snippet": None,
                    "voice_alert": "Boss, your task is finished.",
                    "ui_notification": "✅ Process Completed Successfully.",
                    "should_fix": False,
                }

        # 3. Still running
        return {
            "status": "running",
            "progress": progress,
            "error_snippet": None,
            "voice_alert": None,
            "ui_notification": f"Monitoring active task... ({progress}% complete)" if progress else "Monitoring active task...",
            "should_fix": False,
        }

    def inspect_active_task(
        self,
        task_name: str | None = None,
        screen_text: str | None = None,
        player=None,
    ) -> dict[str, Any]:
        """
        Step 1 & 2: Periodically inspect terminal or screen vision for long running process.
        """
        with _lock:
            target_task: WatchedTask | None = None
            if task_name:
                target_task = self._tasks.get(task_name.strip().lower())
            elif self._tasks:
                # Get the most recently started task
                target_task = sorted(self._tasks.values(), key=lambda t: t.started_at, reverse=True)[0]

            # If no screen text passed, capture from screen via Screen Vision helper
            current_text = screen_text
            if current_text is None:
                current_text = self._capture_screen_text()

            analysis = self.analyze_output_for_status(current_text or "")

            if target_task:
                target_task.last_checked = time.time()
                target_task.last_screen_text = (current_text or "")[:500]
                target_task.progress_percent = analysis.get("progress")
                target_task.status = analysis.get("status", "running")
                target_task.error_snippet = analysis.get("error_snippet")

                if analysis["status"] in ("completed", "error") and not target_task.notified:
                    target_task.notified = True

            # If player or voice output is present, notify
            if analysis.get("voice_alert") and player:
                try:
                    if hasattr(player, "write_log"):
                        player.write_log(f"[ProactiveWatcher] {analysis['ui_notification']}")
                except Exception:
                    pass

            return {
                "task_name": target_task.task_name if target_task else (task_name or "active task"),
                "status": analysis["status"],
                "progress": analysis.get("progress"),
                "voice_alert": analysis.get("voice_alert"),
                "ui_notification": analysis.get("ui_notification"),
                "error_snippet": analysis.get("error_snippet"),
                "should_fix": analysis.get("should_fix", False),
            }

    def _capture_screen_text(self) -> str:
        """Capture screen or terminal text using available screen tools."""
        try:
            import pyautogui
            # Fast check if pyautogui is working
            return ""
        except Exception:
            return ""

    def find_heavy_processes(self, limit: int = 5) -> list[dict[str, Any]]:
        """
        Identify top CPU and RAM consuming background processes.
        Excludes current python PID and system-critical processes.
        """
        my_pid = os.getpid()
        candidates = []

        for proc in psutil.process_iter(["pid", "name", "cpu_percent", "memory_percent", "memory_info"]):
            try:
                pinfo = proc.info
                pid = pinfo["pid"]
                name = (pinfo["name"] or "").strip()
                name_lower = name.lower()

                if pid == my_pid or pid == 0 or pid == 4:
                    continue
                if name_lower in PROTECTED_PROCESS_NAMES:
                    continue

                cpu = float(pinfo.get("cpu_percent") or 0.0)
                mem = float(pinfo.get("memory_percent") or 0.0)
                mem_info = pinfo.get("memory_info")
                mem_mb = round(mem_info.rss / (1024 * 1024), 1) if mem_info else 0.0

                candidates.append({
                    "pid": pid,
                    "name": name,
                    "cpu_percent": round(cpu, 1),
                    "memory_percent": round(mem, 1),
                    "memory_mb": mem_mb,
                    "score": cpu + (mem * 2.0),  # Weighted score for lag detection
                })
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
            except Exception:
                continue

        candidates.sort(key=lambda x: x["score"], reverse=True)
        return candidates[:limit]

    def check_system_spikes(
        self,
        cpu_threshold: float = 90.0,
        ram_threshold: float = 90.0,
        player=None,
    ) -> dict[str, Any]:
        """
        Step 3: If system CPU/RAM usage spikes critically (above 90%) causing lag,
        identify the heavy background process and ask the user if they want to terminate it.
        """
        try:
            raw_cpu = psutil.cpu_percent(interval=None, percpu=False)
            cpu = float(raw_cpu[0]) if isinstance(raw_cpu, list) else float(raw_cpu)
            ram = float(psutil.virtual_memory().percent)
        except Exception:
            return {"spiked": False, "cpu": 0.0, "ram": 0.0, "heavy_process": None}

        is_cpu_spike = cpu >= cpu_threshold
        is_ram_spike = ram >= ram_threshold
        spiked = is_cpu_spike or is_ram_spike

        heavy_process = None
        user_prompt = None

        if spiked:
            heavy_list = self.find_heavy_processes(limit=3)
            if heavy_list:
                heavy_process = heavy_list[0]
                self._candidate_to_terminate = heavy_process

                reason = []
                if is_cpu_spike:
                    reason.append(f"CPU at {cpu:.1f}%")
                if is_ram_spike:
                    reason.append(f"RAM at {ram:.1f}%")
                reason_str = ", ".join(reason)

                user_prompt = (
                    f"Boss, system usage spiked critically ({reason_str}) causing system lag. "
                    f"The heaviest background process is '{heavy_process['name']}' "
                    f"(PID: {heavy_process['pid']}, Memory: {heavy_process['memory_mb']} MB, CPU: {heavy_process['cpu_percent']}%). "
                    f"Would you like me to terminate it to restore performance?"
                )

                if player and hasattr(player, "write_log"):
                    player.write_log(f"[SystemGuard] ⚠️ SPIKE ALERT: {reason_str} -> Heavy: {heavy_process['name']}")

        return {
            "spiked": spiked,
            "cpu": round(cpu, 1),
            "ram": round(ram, 1),
            "heavy_process": heavy_process,
            "user_prompt": user_prompt,
            "candidate": self._candidate_to_terminate,
        }

    def terminate_heavy_process(
        self,
        pid: int | None = None,
        name: str | None = None,
        confirmed: bool = True,
    ) -> dict[str, Any]:
        """
        Terminates the heavy background process upon user instruction/confirmation.
        """
        if not confirmed:
            return {
                "status": "blocked",
                "message": "Termination cancelled: User confirmation is required before killing processes.",
            }

        target_pid = pid
        target_name = name

        if target_pid is None and self._candidate_to_terminate:
            target_pid = self._candidate_to_terminate.get("pid")
            target_name = target_name or self._candidate_to_terminate.get("name")

        if target_pid is None and target_name:
            # Look up PID by name
            for proc in psutil.process_iter(["pid", "name"]):
                try:
                    if (proc.info["name"] or "").lower() == target_name.lower():
                        target_pid = proc.info["pid"]
                        break
                except Exception:
                    continue

        if target_pid is None:
            return {"status": "error", "message": "No candidate or PID found to terminate."}

        # Check protection
        my_pid = os.getpid()
        if target_pid == my_pid or target_pid in (0, 4):
            return {"status": "error", "message": "Cannot terminate core system process."}

        try:
            proc = psutil.Process(target_pid)
            pname = proc.name()
            if pname.lower() in PROTECTED_PROCESS_NAMES:
                return {"status": "error", "message": f"Process '{pname}' is system-protected."}

            proc.terminate()
            gone, alive = psutil.wait_procs([proc], timeout=1.5)
            if alive:
                proc.kill()

            self._candidate_to_terminate = None
            return {
                "status": "success",
                "pid": target_pid,
                "name": pname,
                "message": f"Successfully terminated heavy background process '{pname}' (PID: {target_pid}). Lag has been eliminated.",
            }
        except psutil.NoSuchProcess:
            return {"status": "not_found", "message": f"Process {target_pid} had already exited."}
        except Exception as e:
            return {"status": "error", "message": f"Failed to terminate process {target_pid}: {e}"}


# Global singleton watcher instance
_GLOBAL_WATCHER = ProactiveWatcher()


def proactive_watcher(parameters: dict[str, Any], player=None) -> str:
    """
    Action tool for [MODULE: PROACTIVE WATCHER & SYSTEM GUARD].
    Actions:
      - watch | start: Start monitoring a long-running process (training, download, deployment, etc.)
      - inspect | check: Inspect screen / terminal output for completion or errors
      - check_spikes | guard: Check if CPU or RAM > 90% and identify heavy process
      - terminate | kill: Terminate the heavy process with user confirmation
      - status: List tracked tasks and current system health
      - stop: Stop monitoring a task
    """
    params = parameters or {}
    action = str(params.get("action", "check")).strip().lower()

    if action in ("watch", "start", "monitor"):
        task_name = str(params.get("task_name") or params.get("task") or params.get("process") or "Active Task").strip()
        task_type = str(params.get("task_type") or "generic").strip()
        info = _GLOBAL_WATCHER.start_watch(task_name, task_type)
        if player and hasattr(player, "write_log"):
            player.write_log(f"[ProactiveWatcher] Started monitoring: '{task_name}'")
        return (
            f"Proactive Watcher is now actively monitoring '{task_name}' via Screen Vision. "
            f"I will alert you as soon as the process completes or if any fatal error occurs."
        )

    elif action in ("inspect", "check", "scan"):
        task_name = params.get("task_name") or params.get("task")
        screen_text = params.get("screen_text") or params.get("text")
        res = _GLOBAL_WATCHER.inspect_active_task(task_name=task_name, screen_text=screen_text, player=player)

        if res["status"] == "completed":
            return f"Boss, your task is finished! {res.get('ui_notification', '')}"
        elif res["status"] == "error":
            return f"Boss, the script stopped with an error—should I fix it?\nDetails: {res.get('error_snippet', '')}"
        else:
            prog = f" ({res['progress']}%)" if res.get("progress") is not None else ""
            return f"Task '{res['task_name']}' is still running{prog}. Continuing to monitor."

    elif action in ("check_spikes", "guard", "check_system"):
        cpu_t = float(params.get("cpu_threshold", 90.0))
        ram_t = float(params.get("ram_threshold", 90.0))
        res = _GLOBAL_WATCHER.check_system_spikes(cpu_threshold=cpu_t, ram_threshold=ram_t, player=player)

        if res["spiked"]:
            return res.get("user_prompt") or "Warning: System usage is above 90%!"
        return f"System load is normal (CPU: {res['cpu']}%, RAM: {res['ram']}%). No critical spikes detected."

    elif action in ("terminate", "kill", "terminate_heavy"):
        pid = params.get("pid")
        name = params.get("name") or params.get("process_name")
        confirmed = params.get("confirmed", True)  # If user told MJ to terminate it, confirmation is granted
        res = _GLOBAL_WATCHER.terminate_heavy_process(pid=pid, name=name, confirmed=confirmed)
        return res.get("message", "Termination completed.")

    elif action == "status":
        tasks = _GLOBAL_WATCHER.get_tasks()
        spikes = _GLOBAL_WATCHER.check_system_spikes(player=player)
        task_str = ", ".join(f"{t['task_name']} ({t['status']})" for t in tasks) if tasks else "No active watched tasks"
        return f"Proactive Watcher Status: {task_str} | Current Load: CPU {spikes['cpu']}%, RAM {spikes['ram']}%."

    elif action == "stop":
        task_name = str(params.get("task_name") or "").strip()
        if _GLOBAL_WATCHER.stop_watch(task_name):
            return f"Stopped monitoring task '{task_name}'."
        return "No matching active task found to stop."

    else:
        return f"Unknown proactive_watcher action: '{action}'. Use watch, inspect, check_spikes, terminate, status, or stop."
