import asyncio
import io
import os
import traceback
from typing import Any, Dict

from google import genai
from utils.env import get_api_key
from core.tool_declarations import TOOL_DECLARATIONS

# --- Optional Dependencies ---
try:
    import openai
except ImportError:
    openai = None

try:
    import elevenlabs
except ImportError:
    elevenlabs = None

try:
    import speech_recognition as sr
except ImportError:
    sr = None


# --- Audio Recording ---
def _record_audio_sync(timeout: int = 5, phrase_time_limit: int = 15) -> bytes:
    """Synchronous audio recording using SpeechRecognition."""
    if not sr:
        print("[Fallback] speech_recognition not installed.")
        return b""

    recognizer = sr.Recognizer()
    recognizer.energy_threshold = 300
    recognizer.dynamic_energy_threshold = True
    recognizer.pause_threshold = 0.8

    try:
        with sr.Microphone() as source:
            print("[Fallback] Listening...")
            recognizer.adjust_for_ambient_noise(source, duration=0.5)
            audio = recognizer.listen(source, timeout=timeout, phrase_time_limit=phrase_time_limit)
            return audio.get_wav_data()
    except sr.WaitTimeoutError:
        return b""
    except Exception as e:
        print(f"[Fallback] Audio recording error: {e}")
        return b""

async def record_audio() -> bytes:
    """Async wrapper for recording audio."""
    return await asyncio.to_thread(_record_audio_sync)


# --- Transcription (Whisper) ---
async def transcribe(audio_bytes: bytes) -> str:
    """Transcribe audio bytes using OpenAI Whisper API."""
    if not openai:
        return "[OpenAI library not installed]"
    if not audio_bytes:
        return ""

    api_key = get_api_key("OPENAI_API_KEY")
    if not api_key:
        print("[Fallback] OPENAI_API_KEY not configured.")
        return ""

    client = openai.AsyncOpenAI(api_key=api_key)
    
    audio_file = io.BytesIO(audio_bytes)
    audio_file.name = "audio.wav"

    try:
        response = await client.audio.transcriptions.create(
            model="whisper-1",
            file=audio_file,
            language="en"
        )
        return response.text.strip()
    except Exception as e:
        print(f"[Fallback] Transcription Error: {e}")
        return ""


# --- Text Generation (Gemini REST API) ---
class FallbackBrain:
    def __init__(self, system_instruction: str = ""):
        self.api_key = get_api_key("GEMINI_API_KEY")
        self.client = genai.Client(api_key=self.api_key, http_options={"api_version": "v1beta"})
        self.chat = None
        self.system_instruction = system_instruction
        self.loop = asyncio.get_event_loop()
        
    async def start_chat(self):
        config = {
            "tools": [{"function_declarations": TOOL_DECLARATIONS}],
            "system_instruction": self.system_instruction,
            "temperature": 0.5
        }
        self.chat = await self.client.aio.chats.create(
            model="gemini-3.6-flash",
            config=config
        )

    async def generate_response(self, text: str, app: Any) -> str:
        if not self.chat:
            await self.start_chat()

        print(f"[Fallback Brain] User: {text}")
        try:
            response = await self.chat.send_message(text)
            
            # Handle manual tool calling loop
            while response.function_calls:
                tool_results = []
                for fc in response.function_calls:
                    print(f"[Fallback] Executing Tool: {fc.name}")
                    result_data = {"status": "error", "message": "Unknown tool"}
                    if fc.name in app.TOOL_REGISTRY:
                        try:
                            handler = app.TOOL_REGISTRY[fc.name]
                            # Ensure args is a dictionary
                            args = {k: v for k, v in fc.args.items()} if fc.args else {}
                            if asyncio.iscoroutinefunction(handler):
                                await handler(app, args, self.loop)
                            else:
                                await asyncio.to_thread(handler, app, args, self.loop)
                            result_data = {"status": "success", "message": f"Executed {fc.name}"}
                        except Exception as e:
                            print(f"[Fallback Tool Error] {e}")
                            result_data = {"status": "error", "message": str(e)}
                    
                    # google-genai expects tool responses as part of the Part object or as raw dicts
                    # The latest SDK allows passing dict directly or as types.Part
                    tool_results.append(
                        {"name": fc.name, "response": result_data}
                    )
                
                # Send tool results back to the model
                response = await self.chat.send_message(tool_results)

            return response.text if response.text else ""
        except Exception as e:
            traceback.print_exc()
            return f"Error generating response: {e}"


# --- Text-to-Speech (ElevenLabs) ---
def _speak_sync(text: str, voice_id: str):
    if not elevenlabs:
        return
    api_key = get_api_key("ELEVENLABS_API_KEY")
    if not api_key:
        print("[Fallback TTS] ELEVENLABS_API_KEY missing.")
        return
        
    client = elevenlabs.ElevenLabs(api_key=api_key)
    try:
        audio_generator = client.text_to_speech.convert(
            text=text,
            voice_id=voice_id,
            model_id="eleven_multilingual_v2",
            output_format="mp3_44100_128",
        )
        elevenlabs.play(audio_generator)
    except Exception as e:
        print(f"[Fallback TTS Error] {e}")

async def speak(text: str, voice_id: str = "EXAVITQu4vr4xnSDxMaL") -> None:
    if not text.strip() or not elevenlabs:
        return
    await asyncio.to_thread(_speak_sync, text, voice_id)
