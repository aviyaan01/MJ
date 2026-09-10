from __future__ import annotations

import json
import re
from typing import Any

from memory.routines_manager import (
    delete_routine,
    get_routine,
    list_routines,
    load_routines,
    save_routine,
    update_routine_last_run,
)


def _is_dangerous_power_action(tool: str, args: dict[str, Any]) -> tuple[bool, str]:
    """Check if the given tool/args perform dangerous system power actions."""
    if tool in ("shutdown_mj", "shutdown_ultron", "shutdown_jarvis"):
        return True, tool

    if tool == "computer_settings":
        try:
            from actions.computer_settings import _DANGEROUS_ACTIONS, peek_settings_action
            action = peek_settings_action(args)
            if action in _DANGEROUS_ACTIONS or action in ("shutdown", "restart", "log_off", "sleep"):
                return True, action or "shutdown"
        except Exception:
            action = str(args.get("action", "")).lower().strip()
            if action in ("shutdown", "restart", "log_off", "sleep"):
                return True, action

    return False, ""


def execute_action_step(tool: str, args: dict[str, Any], player=None) -> str:
    """Synchronously execute a single routine step using the corresponding action handler."""
    tool_name = (tool or "").strip().lower()

    # Safety check
    is_dangerous, act_name = _is_dangerous_power_action(tool_name, args)
    if is_dangerous:
        return f"Skipped dangerous power action '{act_name}'."

    try:
        if tool_name == "open_app":
            from actions.open_app import open_app
            r = open_app(parameters=args, response=None, player=player)
            return r or f"Opened {args.get('app_name', 'app')}."

        elif tool_name == "close_app":
            from actions.open_app import close_app
            r = close_app(parameters=args, player=player)
            return r or f"Closed {args.get('app_name', 'app')}."

        elif tool_name == "weather_report":
            from actions.weather_report import weather_action
            r = weather_action(parameters=args, player=player)
            return r or "Weather delivered."

        elif tool_name == "browser_control":
            from actions.browser_control import browser_control
            r = browser_control(parameters=args, player=player)
            return r or "Browser action completed."

        elif tool_name == "file_controller":
            from actions.file_controller import file_controller
            r = file_controller(parameters=args, player=player)
            return r or "File action completed."

        elif tool_name == "send_message":
            from actions.send_message import send_message
            r = send_message(parameters=args, response=None, player=player)
            return r or f"Message sent to {args.get('receiver', 'recipient')}."

        elif tool_name == "reminder":
            from actions.reminder import reminder
            r = reminder(parameters=args, response=None, player=player)
            return r or "Reminder scheduled."

        elif tool_name == "youtube_video":
            from actions.youtube_video import youtube_video
            r = youtube_video(parameters=args, player=player)
            return r or "YouTube action completed."

        elif tool_name == "computer_settings":
            from actions.computer_settings import computer_settings
            r = computer_settings(parameters=args, response=None, player=player)
            return r or "Computer settings updated."

        elif tool_name == "desktop_control":
            from actions.desktop import desktop_control
            r = desktop_control(parameters=args, player=player)
            return r or "Desktop action completed."

        elif tool_name == "code_helper":
            from actions.code_helper import code_helper
            r = code_helper(parameters=args, player=player)
            return r or "Code helper completed."

        elif tool_name == "dev_agent":
            from actions.dev_agent import dev_agent
            r = dev_agent(parameters=args, player=player)
            return r or "Dev agent completed."

        elif tool_name == "web_search":
            from actions.web_search import web_search
            r = web_search(parameters=args, player=player)
            return r or "Web search completed."

        elif tool_name == "file_processor":
            from actions.file_processor import file_processor
            r = file_processor(parameters=args, player=player)
            return r or "File processor completed."

        elif tool_name == "computer_control":
            from actions.computer_control import computer_control
            r = computer_control(parameters=args, player=player)
            return r or "Computer control completed."

        elif tool_name == "game_updater":
            from actions.game_updater import game_updater
            r = game_updater(parameters=args, player=player)
            return r or "Game updater completed."

        elif tool_name == "flight_finder":
            from actions.flight_finder import flight_finder
            r = flight_finder(parameters=args, player=player)
            return r or "Flight search completed."

        elif tool_name == "system_status":
            from actions.system_monitor import get_system_status
            return str(get_system_status())

        else:
            return f"Unknown tool '{tool_name}'."
    except Exception as e:
        return f"Error executing '{tool_name}': {e}"


def routine_manager(parameters: dict[str, Any], player=None) -> str:
    """Action handler for managing and running multi-step automations."""
    action = str(parameters.get("action", "list")).strip().lower()

    if action == "create":
        name = str(parameters.get("name", "")).strip()
        if not name:
            return "Please provide a name for the routine."

        trigger_type = str(parameters.get("trigger_type", "phrase")).strip().lower()
        if trigger_type not in ("time", "phrase"):
            return "Trigger type must be either 'time' or 'phrase'."

        trigger_value = str(parameters.get("trigger_value", "")).strip()
        if not trigger_value:
            return (
                "Please provide a trigger value (e.g. '07:00' for time or 'leaving now' for phrase)."
            )

        # Validate time format (24h HH:MM)
        if trigger_type == "time":
            # Auto-pad e.g. "7:00" -> "07:00"
            if re.match(r"^\d:[0-5]\d$", trigger_value):
                trigger_value = f"0{trigger_value}"
            if not re.match(r"^(?:[01]\d|2[0-3]):[0-5]\d$", trigger_value):
                return "Time trigger must be in 24h 'HH:MM' format (e.g., '07:00', '18:30')."

        # Parse steps
        raw_steps = parameters.get("steps")
        if isinstance(raw_steps, str):
            try:
                steps = json.loads(raw_steps)
            except Exception as e:
                return f"Could not parse steps JSON: {e}"
        elif isinstance(raw_steps, list):
            steps = raw_steps
        else:
            return "Steps must be a JSON-encoded array of {'tool': ..., 'args': {...}} objects."

        if not steps or not isinstance(steps, list):
            return "Routine must contain at least one valid step."

        # Validate steps and check safety
        validated_steps = []
        for idx, step in enumerate(steps, 1):
            if not isinstance(step, dict) or "tool" not in step:
                return f"Step {idx} is missing a 'tool' field."
            tool = str(step.get("tool", "")).strip()
            args = step.get("args", {})
            if not isinstance(args, dict):
                args = {}

            # Safety check: reject dangerous power actions
            is_dangerous, act_name = _is_dangerous_power_action(tool, args)
            if is_dangerous:
                return (
                    f"Cannot save dangerous power action ('{act_name}') in an automated routine. "
                    f"Please run shutdown, restart, sleep, or log off manually."
                )

            validated_steps.append({"tool": tool, "args": args})

        # Save routine
        saved = save_routine({
            "name": name,
            "trigger_type": trigger_type,
            "trigger_value": trigger_value,
            "steps": validated_steps,
            "enabled": True,
            "last_run": None,
        })

        if player:
            player.write_log(
                f"[Routine] Created: '{name}' ({trigger_type} -> '{trigger_value}', {len(validated_steps)} steps)"
            )

        step_summary = ", ".join(f"{s['tool']}" for s in validated_steps)
        trigger_desc = (
            f"daily at {trigger_value}" if trigger_type == "time" else f"when you say '{trigger_value}'"
        )
        return f"Routine '{name}' created successfully! It will run {trigger_desc} with steps: {step_summary}."

    elif action == "list":
        routines = list_routines()
        if not routines:
            return "No automated routines are currently configured."

        lines = [f"Found {len(routines)} routine(s):"]
        for r in routines:
            status = "Enabled" if r.get("enabled", True) else "Disabled"
            ttype = r.get("trigger_type", "phrase")
            tval = r.get("trigger_value", "")
            steps = r.get("steps", [])
            steps_desc = " -> ".join(f"{s.get('tool')}" for s in steps) or "No steps"
            last_run = r.get("last_run") or "Never"
            lines.append(
                f"• {r.get('name')}: [{ttype.upper()}: '{tval}'] ({status}) — Steps: {steps_desc} (Last run: {last_run})"
            )
        return "\n".join(lines)

    elif action == "delete":
        name = str(parameters.get("name", "")).strip()
        if not name:
            return "Please provide the name of the routine to delete."

        if delete_routine(name):
            if player:
                player.write_log(f"[Routine] Deleted: '{name}'")
            return f"Routine '{name}' has been deleted."
        return f"Routine '{name}' not found."

    elif action == "run_now":
        name = str(parameters.get("name", "")).strip()
        steps_to_run = []

        if name:
            target_routine = get_routine(name)
            if not target_routine:
                return f"Routine '{name}' not found."
            steps_to_run = target_routine.get("steps", [])
            update_routine_last_run(name)
        else:
            raw_steps = parameters.get("steps")
            if isinstance(raw_steps, str):
                try:
                    steps_to_run = json.loads(raw_steps)
                except Exception:
                    steps_to_run = []
            elif isinstance(raw_steps, list):
                steps_to_run = raw_steps

        if not steps_to_run:
            return "No steps found to execute."

        results = []
        for idx, step in enumerate(steps_to_run, 1):
            tool = step.get("tool", "")
            args = step.get("args", {})
            res = execute_action_step(tool, args, player)
            results.append(f"Step {idx} ({tool}): {res}")

        if player:
            player.write_log(f"[Routine] Executed '{name or 'custom'}': {len(steps_to_run)} steps")

        return f"Executed routine '{name or 'custom'}':\n" + "\n".join(results)

    else:
        return f"Unknown routine action '{action}'. Use create, list, delete, or run_now."
