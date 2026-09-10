"""
MJ SETUP SCRIPT
================
This is a portable first-time setup script for the MJ AI Desktop Assistant.
"""

import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent

def print_separator():
    print("=" * 60)

def check_python_version():
    if sys.version_info < (3, 10):
        print(f"[ERROR] Python 3.10+ is required. Found: {sys.version.split()[0]}")
        sys.exit(1)
    print(f"[OK] Python version: {sys.version.split()[0]}")

def upgrade_pip():
    print("[INFO] Checking/upgrading pip...")
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--upgrade", "pip", "--quiet"],
        check=False
    )
    print("[OK] Pip is up to date.")

def install_requirements():
    req_file = SCRIPT_DIR / "requirements.txt"
    if req_file.exists():
        print("[INFO] Installing dependencies from requirements.txt...")
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "-r", str(req_file)],
            check=True
        )
        print("[OK] Requirements installed.")

def setup_api_keys():
    config_dir = SCRIPT_DIR / "config"
    config_dir.mkdir(parents=True, exist_ok=True)
    api_keys_file = config_dir / "api_keys.json"
    api_keys_example = config_dir / "api_keys.json.example"
    
    # Initialize .env file if not present
    env_file = SCRIPT_DIR / ".env"
    env_example = SCRIPT_DIR / ".env.example"
    if not env_file.exists() and env_example.exists():
        try:
            shutil.copy(str(env_example), str(env_file))
            print("[OK] Initialized .env from .env.example.")
        except Exception as e:
            print(f"[WARN] Failed to copy .env.example: {e}")
    elif env_file.exists():
        print("[OK] .env file already exists.")

    if api_keys_file.exists():
        print("[OK] config/api_keys.json already exists.")
        return
        
    if api_keys_example.exists():
        try:
            shutil.copy(str(api_keys_example), str(api_keys_file))
            print("[OK] Copied api_keys.json.example to api_keys.json.")
        except Exception as e:
            print(f"[ERROR] Failed to copy example config: {e}")
            sys.exit(1)
    else:
        default_config = {
            "gemini_api_key": "YOUR_GEMINI_API_KEY_HERE",
            "os_system": "windows",
            "morning_brief_enabled": True,
            "assistant_name": "MJ",
            "user_name": "",
            "ui_color": "#00C2FF"
        }
        try:
            with open(api_keys_file, "w", encoding="utf-8") as f:
                json.dump(default_config, f, indent=4)
            print("[OK] Created default api_keys.json.")
        except Exception as e:
            print(f"[ERROR] Failed to create api_keys.json: {e}")
            sys.exit(1)

def write_setup_marker():
    marker_file = SCRIPT_DIR / ".mj_setup_complete"
    try:
        with open(marker_file, "w", encoding="utf-8") as f:
            f.write(f"Setup completed on: {datetime.now().isoformat()}")
        print("[OK] Wrote setup completion marker.")
    except Exception as e:
        print(f"[WARN] Failed to write setup marker: {e}")

def main():
    try:
        print_separator()
        print("          MJ AI DESKTOP ASSISTANT - SETUP")
        print_separator()
        check_python_version()
        upgrade_pip()
        install_requirements()
        setup_api_keys()
        write_setup_marker()
        
        print_separator()
        print(" MJ SETUP COMPLETE!")
        print_separator()
        print()
        print(" To launch MJ:")
        print("   python main.py")
        print("   OR double-click START_MJ.bat")
        print()
    except Exception as e:
        print(f"[ERROR] Setup failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
