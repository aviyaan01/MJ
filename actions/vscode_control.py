import urllib.request
import json
import subprocess
from pathlib import Path
from utils.env import get_os

VSCODE_PORT = 62453
VSCODE_URL = f"http://127.0.0.1:{VSCODE_PORT}/execute"

def _send_to_extension(data: dict) -> dict:
    try:
        req = urllib.request.Request(
            VSCODE_URL, 
            data=json.dumps(data).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req, timeout=3.0) as response:
            return json.loads(response.read().decode('utf-8'))
    except Exception as e:
        return {"success": False, "error": str(e)}

def _fallback_cli(command: list) -> str:
    try:
        shell = get_os() == "Windows"
        subprocess.run(command, shell=shell, check=True)
        return "Command executed via CLI fallback."
    except Exception as e:
        return f"CLI fallback failed: {e}"

def vscode_control(parameters: dict, player=None) -> str:
    action = parameters.get("action", "").lower().strip()
    
    if player:
        player.write_log(f"[VSCode] Executing {action}...")

    # Action: goto_line
    if action == "goto_line":
        file_path = parameters.get("file_path")
        if not file_path:
            return "Please provide a file_path."
        line = parameters.get("line", 1)
        col = parameters.get("column", 1)
        
        # Try extension first
        res = _send_to_extension({"action": "goto_line", "file": file_path, "line": line, "column": col})
        if res.get("success"):
            return res["result"]["message"]
        
        # Fallback to CLI
        if player: player.write_log("[VSCode] Server unreachable, using CLI fallback...")
        return _fallback_cli(["code", "--goto", f"{file_path}:{line}:{col}"])

    # Action: diff
    elif action == "diff":
        file1 = parameters.get("file1")
        file2 = parameters.get("file2")
        if not file1 or not file2:
            return "Please provide file1 and file2 for diff."
        
        res = _send_to_extension({"action": "diff", "file1": file1, "file2": file2})
        if res.get("success"):
            return res["result"]["message"]
            
        if player: player.write_log("[VSCode] Server unreachable, using CLI fallback...")
        return _fallback_cli(["code", "--diff", file1, file2])

    # Action: run_in_terminal
    elif action == "run_in_terminal":
        command = parameters.get("command")
        if not command:
            return "Please provide a command to run."
            
        res = _send_to_extension({"action": "run_in_terminal", "command": command})
        if res.get("success"):
            return res["result"]["message"]
            
        if player: player.write_log("[VSCode] Server unreachable, executing command directly via subprocess...")
        # Fallback: run the command in a subprocess and return output
        try:
            shell = get_os() == "Windows"
            result = subprocess.run(command, shell=shell, capture_output=True, text=True, timeout=30)
            return f"Executed directly (fallback).\nOutput:\n{result.stdout}\n{result.stderr}"
        except Exception as e:
            return f"Direct execution failed: {e}"

    # Action: list_open_tabs
    elif action == "list_open_tabs":
        res = _send_to_extension({"action": "list_open_tabs"})
        if res.get("success"):
            tabs = res["result"]["tabs"]
            if not tabs:
                return "No open tabs found."
            return "Open tabs:\n" + "\n".join(tabs)
        return "Could not fetch open tabs. Make sure the MJ VS Code Extension is installed and VS Code is open."

    # Action: close_tab
    elif action == "close_tab":
        file_path = parameters.get("file_path")
        res = _send_to_extension({"action": "close_tab", "file": file_path})
        if res.get("success"):
            return res["result"]["message"]
        return "Could not close tab. Make sure the extension is running."
        
    # Action: insert_text
    elif action == "insert_text":
        text = parameters.get("text")
        if not text:
            return "Please provide text to insert."
        line = parameters.get("line")
        col = parameters.get("column")
        
        payload = {"action": "insert_text", "text": text}
        if line is not None:
            payload["line"] = line
        if col is not None:
            payload["column"] = col
            
        res = _send_to_extension(payload)
        if res.get("success"):
            return res["result"]["message"]
        return "Could not insert text. Make sure the extension is running."
        
    # Action: reuse_window (just opening a file or folder in existing window)
    elif action == "reuse_window":
        file_path = parameters.get("file_path")
        if not file_path:
            return "Please provide a file_path."
        return _fallback_cli(["code", "-r", file_path])

    return f"Unknown vscode_control action: {action}"
