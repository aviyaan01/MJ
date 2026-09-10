# MJ — Multimodal Agentic AI Desktop Operating Layer & Neural Dashboard

<p align="center">
  <img src="config/jarvis.ico" width="96" height="96" alt="MJ Logo" />
</p>

<p align="center">
  <strong>Autonomous Multimodal AI Desktop Assistant powered by Google Gemini Live</strong><br>
  Continuous hands-free voice, sub-50ms barge-in interruption, native OS execution, and real-time 3D particle neural dashboard.
</p>

<p align="center">
  <a href="https://github.com"><img src="https://img.shields.io/badge/Python-3.10%20%7C%203.11-blue?logo=python" alt="Python Version"></a>
  <a href="https://aistudio.google.com"><img src="https://img.shields.io/badge/Google-Gemini%20Live-orange?logo=google" alt="Gemini Live"></a>
  <a href="https://fastapi.tiangolo.com"><img src="https://img.shields.io/badge/FastAPI-Dashboard-009688?logo=fastapi" alt="FastAPI"></a>
  <a href="https://vercel.com"><img src="https://img.shields.io/badge/Deploy-Vercel-black?logo=vercel" alt="Deploy to Vercel"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License"></a>
</p>

---

## ⚡ Key Highlights

- **Gemini Live Multimodal Engine**: Bi-directional 16 kHz raw PCM streaming with sub-300ms latency, native multilingual speech recognition (English, Bengali/Bangla, Banglish code-switching).
- **Sub-50ms Barge-In Interruption**: Live RMS amplitude monitoring instantly pauses assistant TTS speech whenever you begin talking.
- **Deep Operating System Execution**: Automated window management, application launcher, volume & brightness adjustment, sleep/shutdown protection, keyboard typing, and shortcuts.
- **Futuristic 3D Neural Web Dashboard**: Real-time 60 FPS HTML5 Canvas particle orb reacting to voice RMS levels, system telemetry HUD (CPU, RAM, Battery), notes manager, and remote pairing.
- **Universal Cloud & Local Deployment**: Run the full desktop voice companion on Windows, or deploy the web dashboard directly to **Vercel** serverless in one click.

---

## 🚀 Quick Start (Windows Desktop)

### Prerequisites
1. **Python 3.10+** (ensure `Add python.exe to PATH` is checked during install).
2. **Gemini API Key** from [Google AI Studio](https://aistudio.google.com/apikey).

### Option 1: 1-Click Setup (Recommended)
```bash
# 1. Clone the repository
git clone https://github.com/your-username/MJ.git
cd MJ

# 2. Run first-time setup
SETUP.bat
```
`SETUP.bat` automatically configures dependencies, copies `.env.example` to `.env`, and launches MJ.

### Option 2: Manual Terminal Setup
```bash
git clone https://github.com/your-username/MJ.git
cd MJ

# Create and activate virtual environment
python -m venv .venv
.venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Configure your environment
cp .env.example .env
# Open .env and insert your GEMINI_API_KEY

# Launch the assistant
python main.py
```

### Background Wake Word Listener
To keep MJ listening silently in the background for `"wake up mj"`:
```bash
Start_MJ_Wake_Word.bat
# or: python wake_service.py
```

---

## ☁️ Deploying to Vercel (Web Dashboard & Remote API)

The Neural Web Dashboard and telemetry API can be deployed to Vercel in seconds as an ASGI serverless application.

### 1-Click Deploy via Vercel CLI
```bash
npm i -g vercel
vercel
```

### Deploy via GitHub
1. Push your repository to GitHub.
2. In [Vercel Dashboard](https://vercel.com/new), select **Import Git Repository**.
3. Under **Environment Variables**, add:
   - `GEMINI_API_KEY` = `your_gemini_api_key`
   - `DASHBOARD_PIN` = `123456` (or any custom 6-digit PIN)
4. Click **Deploy**. Your dashboard is now live at `https://your-project.vercel.app`.

---

## 🔑 Environment Variables (`.env`)

All configurations, tokens, and hardware parameters are centralized in `.env`:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | *(Required)* | Google Gemini API key for real-time Live multimodal streaming |
| `ASSISTANT_NAME` | `MJ` | Name of the AI companion |
| `USER_NAME` | `""` | User's preferred display name |
| `MORNING_BRIEF_ENABLED` | `true` | Enables proactive briefing upon start |
| `UI_COLOR` | `#00C2FF` | Primary theme accent hex color |
| `FOLLOWUP_LISTEN_SECONDS`| `7.0` | Follow-up microphone open window after assistant speaks |
| `BARGE_IN_RMS_THRESHOLD` | `1400.0`| RMS microphone threshold to trigger instant TTS interrupt |
| `DASHBOARD_PIN` | `123456` | Master PIN to log into the web dashboard remotely or on Vercel |
| `OPENAI_API_KEY` | `""` | Optional fallback LLM key |
| `OPENWEATHER_API_KEY` | `""` | Optional weather report API key |
| `ELEVENLABS_API_KEY` | `""` | Optional high-fidelity ElevenLabs TTS key |
| `PICOVOICE_ACCESS_KEY` | `""` | Optional Picovoice Porcupine wake word key |
| `HOME_ASSISTANT_URL` | `""` | Home Assistant local/cloud URL |
| `HOME_ASSISTANT_TOKEN` | `""` | Home Assistant Long-Lived Access Token |
| `PORT` | `8000` | HTTP server port |

---

## 📂 Repository Structure

```
MJ/
├── main.py                     # Central coordinator & Gemini Live loop
├── ui.py                       # PyQt6 WebEngine HUD with 3D fluid particle orb
├── wake_service.py             # Always-on wake word daemon ("wake up mj")
├── MJ_SETUP.py                 # Setup orchestrator
├── .env                        # Local secrets (strictly gitignored)
├── .env.example                # Documented configuration template
├── requirements.txt            # PEP 508 cross-platform dependency manifest
├── vercel.json                 # Vercel serverless routing configuration
├── api/
│   └── index.py                # Vercel ASGI serverless handler
├── actions/                    # OS manipulation & intelligence layer
│   ├── computer_settings.py    # Volume, brightness, display & system sleep
│   ├── computer_control.py     # Keyboard, mouse, shortcuts
│   ├── open_app.py             # Smart app launcher & process manager
│   ├── system_monitor.py       # Hardware resource telemetry (CPU/RAM/GPU)
│   ├── web_search.py           # Real-time search & knowledge lookup
│   └── screen_processor.py     # Vision grounding & screenshot inspection
├── dashboard/                  # Remote web UI & REST/WebSocket server
│   ├── server.py               # FastAPI server with PIN & token security
│   └── static/                 # 3D fluid Canvas UI, login & crypto scripts
├── memory/                     # Local context storage & persistent routines
├── core/                       # LLM clients, tool specs, speaker verifier
└── tests/                      # Automated unit test suite
```

---

## 🧪 Testing & Verification

Run the automated test suite with Python's built-in `unittest`:
```bash
python -m unittest discover tests -v
```

---

## 🛡️ Security & Privacy Notice

- **Secrets Isolation**: Real API keys (`GEMINI_API_KEY`, etc.), voiceprints (`voiceprint.npy`), and user notes (`memory/*.json`) are **strictly excluded** in `.gitignore`.
- **Destructive Command Confirmation**: Commands such as computer shutdown, reboot, sleep, or mass process termination require affirmative spoken confirmation before execution.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
