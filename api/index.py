"""
api/index.py — Vercel Serverless ASGI Entrypoint for Project MJ Neural Web Dashboard.

Provides serverless routing for:
- Futuristic 3D Neural Canvas Dashboard
- System Telemetry & Status API
- Settings & Preferences Management
- Quick Notes & Memory Tasks
- Tool Analytics & System Logs
"""

import os
import sys
from pathlib import Path

# Add project root to sys.path so modules can be imported
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

# Set cloud environment marker for serverless mode
os.environ.setdefault("MJ_CLOUD_MODE", "1")

try:
    from dashboard.server import DashboardServer
    server = DashboardServer()
    app = server.app
except Exception as e:
    # Graceful fallback in case of missing optional dependencies
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse

    app = FastAPI(title="MJ AI Assistant — Cloud Dashboard")

    @app.get("/")
    async def root_fallback():
        return JSONResponse({
            "name": "MJ AI Desktop Assistant",
            "status": "online",
            "mode": "cloud_serverless",
            "message": "Dashboard initialized. Configure GEMINI_API_KEY in Vercel environment variables."
        })
