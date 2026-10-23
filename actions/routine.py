from __future__ import annotations

import json
import re
from typing import Any

from memory.routines_manager import (
    WORKSPACE_PRESETS,
    delete_routine,
    find_routine_or_preset,
    get_routine,
    get_workspace_presets,
    list_routines,
    load_routines,
    record_routine_execution,
    save_routine,
    save_skill_macro,
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

        elif tool_name == "browser_manager":
            from actions.browser_manager import browser_manager
            r = browser_manager(parameters=args, player=player)
            return r or "Browser manager action completed."

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

        elif tool_name == "advanced_settings":
            from actions.computer_settings import advanced_settings
            r = advanced_settings(parameters=args, player=player)
            return r or "Advanced settings updated."

        elif tool_name == "desktop_control":
            from actions.desktop import desktop_control
            r = desktop_control(parameters=args, player=player)
            return r or "Desktop action completed."

        elif tool_name == "window_controller":
            from actions.window_controller import window_controller
            r = window_controller(parameters=args, player=player)
            return r or "Window action completed."

        elif tool_name == "code_helper":
            from actions.code_helper import code_helper
            r = code_helper(parameters=args, player=player)
            return r or "Code helper completed."

        elif tool_name == "vscode_control":
            from actions.code_helper import vscode_control
            r = vscode_control(parameters=args, player=player)
            return r or "VS Code action completed."

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

        elif tool_name == "clipboard_bridge":
            from actions.clipboard_bridge import clipboard_bridge
            r = clipboard_bridge(parameters=args, player=player)
            return r or "Clipboard bridge action completed."

        elif tool_name == "self_healing":
            from actions.self_healing import self_healing
            r = self_healing(parameters=args, player=player)
            return r or "Self healing action completed."

        elif tool_name == "privacy_shield":
            from actions.privacy_shield import privacy_shield
            r = privacy_shield(parameters=args, player=player)
            return r or "Privacy shield action completed."

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

        elif tool_name == "smart_home":
            from actions.smart_home import smart_home
            r = smart_home(parameters=args, player=player)
            return r or "Smart home action completed."

        elif tool_name == "save_memory":
            from memory.memory_manager import update_memory
            cat = args.get("category", "notes")
            k = args.get("key", "")
            v = args.get("value", "")
            if k and v:
                update_memory({cat: {k: {"value": v}}})
            return f"Saved memory {cat}/{k}."

        else:
            return f"Unknown tool '{tool_name}'."
    except Exception as e:
        return f"Error executing '{tool_name}': {e}"


def execute_macro_sequence(
    name_or_routine: str | dict[str, Any],
    player=None,
    auto_save_as_skill: bool = True,
    override_steps: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """
    Step 1: Executes full sequence of actions for a workspace routine (e.g. 'Start Coding Mode', 'Start Gaming Mode', 'Prepare Project Setup').
    Step 2: Saves successful multi-step action sequences into Conversational Memory & local JSON storage as a reusable skill.
    Step 3: Loads directly from saved macro steps without needing to plan from scratch.
    """
    routine_name = "Custom Macro"
    steps_to_run: list[dict[str, Any]] = []
    is_preset = False

    if isinstance(name_or_routine, dict):
        routine_name = name_or_routine.get("name") or "Custom Routine"
        steps_to_run = name_or_routine.get("steps") or []
        is_preset = bool(name_or_routine.get("is_preset", False))
    elif isinstance(name_or_routine, str) and name_or_routine.strip():
        routine_name = name_or_routine.strip()
        # Step 3: Direct loading without replanning
        matched = find_routine_or_preset(routine_name)
        if matched:
            steps_to_run = matched.get("steps") or []
            routine_name = matched.get("name") or routine_name
            is_preset = bool(matched.get("is_preset", False))

    if override_steps and isinstance(override_steps, list):
        steps_to_run = override_steps

    if not steps_to_run:
        return {
            "status": "error",
            "name": routine_name,
            "steps_count": 0,
            "results": [],
            "report": f"No steps found for routine '{routine_name}'.",
        }

    if player:
        player.write_log(f"[Macro Memory] 🚀 Executing '{routine_name}' ({len(steps_to_run)} steps)...")

    results = []
    successful_steps = 0

    for idx, step in enumerate(steps_to_run, 1):
        if not isinstance(step, dict):
            continue
        tool = step.get("tool", "")
        args = step.get("args", {})
        desc = step.get("description") or f"Execute {tool}"

        if player:
            player.write_log(f"[Macro Memory] Step {idx}/{len(steps_to_run)}: {desc} ({tool})")

        res = execute_action_step(tool, args, player=player)
        is_err = "Error executing" in res or "Unknown tool" in res
        if not is_err:
            successful_steps += 1
        results.append(f"Step {idx} ({tool}): {res}")

    # Record execution metrics
    record_routine_execution(routine_name, success=(successful_steps > 0))

    # Step 2: Auto-save successful multi-step action sequences as reusable skill
    if auto_save_as_skill and successful_steps >= 1 and not is_preset:
        try:
            save_skill_macro(
                name=routine_name,
                steps=steps_to_run,
                description=f"Automated workspace skill: {routine_name}",
                sync_conversational_memory=True,
            )
        except Exception:
            pass

    report = (
        f"[Skill & Macro Memory] Successfully executed routine '{routine_name}' "
        f"({successful_steps}/{len(steps_to_run)} steps succeeded):\n" + "\n".join(results)
    )

    return {
        "status": "ok",
        "name": routine_name,
        "steps_count": len(steps_to_run),
        "successful_steps": successful_steps,
        "results": results,
        "report": report,
    }


def routine_manager(parameters: dict[str, Any], player=None) -> str:
    """Action handler for managing and running multi-step automations."""
    params = parameters or {}
    action = str(params.get("action", "list")).strip().lower()

    if action in ("execute", "run_now", "run", "start", "macro"):
        name = str(params.get("name", "")).strip()
        raw_steps = params.get("steps")
        override_steps = None

        if isinstance(raw_steps, str):
            try:
                override_steps = json.loads(raw_steps)
            except Exception:
                override_steps = None
        elif isinstance(raw_steps, list):
            override_steps = raw_steps

        # If user passed a query or routine name
        if not name and params.get("routine"):
            name = str(params.get("routine")).strip()
        if not name and params.get("mode"):
            name = str(params.get("mode")).strip()

        exec_res = execute_macro_sequence(
            name_or_routine=name,
            player=player,
            auto_save_as_skill=True,
            override_steps=override_steps,
        )
        return exec_res.get("report") or f"Routine '{name}' executed."

    elif action in ("learn", "save", "create"):
        name = str(params.get("name", "")).strip()
        if not name:
            return "Please provide a name for the routine/skill to save."

        trigger_type = str(params.get("trigger_type", "phrase")).strip().lower()
        if trigger_type not in ("time", "phrase"):
            trigger_type = "phrase"

        trigger_value = str(params.get("trigger_value", name.lower())).strip()

        # Parse steps
        raw_steps = params.get("steps")
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

            desc = step.get("description") or f"Execute {tool}"
            validated_steps.append({"tool": tool, "args": args, "description": desc})

        # Save to local JSON storage & Conversational Memory
        saved = save_skill_macro(
            name=name,
            steps=validated_steps,
            description=str(params.get("description", "")),
            sync_conversational_memory=True,
        )

        if player:
            player.write_log(
                f"[Macro Memory] Learned skill: '{name}' ({len(validated_steps)} steps)"
            )

        step_summary = ", ".join(f"{s['tool']}" for s in validated_steps)
        return (
            f"Routine '{name}' successfully learned and saved to Conversational Memory as a reusable skill! "
            f"Steps ({len(validated_steps)}): {step_summary}. "
            f"Next time you say '{name}', it will execute directly without replanning."
        )

    elif action == "list":
        routines = list_routines()
        presets = get_workspace_presets()

        lines = [f"Found {len(routines)} custom routine(s) and {len(presets)} workspace preset(s):"]
        if presets:
            lines.append("\n[Built-in Workspace Presets]:")
            for p_name, p in presets.items():
                steps_desc = " -> ".join(f"{s.get('tool')}" for s in p.get("steps", []))
                lines.append(f"• {p_name}: {p.get('description', '')} (Steps: {steps_desc})")

        if routines:
            lines.append("\n[User Saved Routines & Skills]:")
            for r in routines:
                status = "Enabled" if r.get("enabled", True) else "Disabled"
                ttype = r.get("trigger_type", "phrase")
                tval = r.get("trigger_value", "")
                steps = r.get("steps", [])
                steps_desc = " -> ".join(f"{s.get('tool')}" for s in steps) or "No steps"
                last_run = r.get("last_run") or "Never"
                successes = r.get("success_count", 0)
                lines.append(
                    f"• {r.get('name')}: [{ttype.upper()}: '{tval}'] ({status}) — "
                    f"Runs: {successes} | Steps: {steps_desc} (Last run: {last_run})"
                )
        return "\n".join(lines)

    elif action == "delete":
        name = str(params.get("name", "")).strip()
        if not name:
            return "Please provide the name of the routine to delete."

        if delete_routine(name):
            if player:
                player.write_log(f"[Macro Memory] Deleted: '{name}'")
            return f"Routine '{name}' has been deleted."
        return f"Routine '{name}' not found."

    elif action in ("get", "details"):
        name = str(params.get("name", "")).strip()
        if not name:
            return "Please provide the name of the routine to inspect."
        found = find_routine_or_preset(name)
        if not found:
            return f"Routine '{name}' not found."
        steps_desc = "\n".join(f"  {i+1}. {s.get('tool')}: {s.get('args')}" for i, s in enumerate(found.get("steps", [])))
        return f"Routine: {found.get('name')}\nDescription: {found.get('description')}\nSteps:\n{steps_desc}"

    elif action == "presets":
        presets = get_workspace_presets()
        return "Workspace Presets:\n" + "\n".join(f"• {k}: {v.get('description')}" for k, v in presets.items())

    else:
        return f"Unknown routine action '{action}'. Use execute, learn, list, get, delete, or presets."

