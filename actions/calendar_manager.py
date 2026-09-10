# actions/calendar_manager.py
"""Google Calendar integration for MJ — fetch events and create quick events."""
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from utils.env import get_base_dir

# ── Paths ────────────────────────────────────────────────────────────────────
_CRED_FILE = get_base_dir() / "config" / "credentials.json"
_TOKEN_FILE = get_base_dir() / "config" / "google_calendar_token.json"

# Google Calendar API scope
_SCOPES = ["https://www.googleapis.com/auth/calendar"]

_SETUP_MSG = (
    "Google Calendar is not configured yet.\n\n"
    "To set it up:\n"
    "1. Go to https://console.cloud.google.com/apis/credentials\n"
    "2. Create an OAuth 2.0 Client ID (Desktop application).\n"
    "3. Download the JSON file and save it as:\n"
    f"   {_CRED_FILE}\n"
    "4. Enable the Google Calendar API in your GCP project.\n"
    "5. Say 'check my calendar' again — MJ will open a browser for one-time authorization."
)


def _get_service():
    """Authenticate and return a Google Calendar API service object."""
    if not _CRED_FILE.exists():
        return None, _SETUP_MSG

    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
    except ImportError:
        return None, (
            "Required libraries are missing. Install them with:\n"
            "  pip install google-auth-oauthlib google-api-python-client\n"
            "Then try again."
        )

    creds = None

    # Load existing token
    if _TOKEN_FILE.exists():
        try:
            creds = Credentials.from_authorized_user_file(str(_TOKEN_FILE), _SCOPES)
        except Exception:
            creds = None

    # Refresh or re-authorize
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
            except Exception:
                creds = None

        if not creds:
            try:
                flow = InstalledAppFlow.from_client_secrets_file(str(_CRED_FILE), _SCOPES)
                creds = flow.run_local_server(port=0, open_browser=True)
            except Exception as e:
                return None, f"OAuth authorization failed: {e}"

        # Persist token for next time
        _TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        _TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")

    try:
        service = build("calendar", "v3", credentials=creds, cache_discovery=False)
        return service, None
    except Exception as e:
        return None, f"Failed to build Calendar service: {e}"


# ── Actions ──────────────────────────────────────────────────────────────────

def _get_events(params: dict) -> str:
    """Fetch upcoming calendar events for today or tomorrow."""
    service, err = _get_service()
    if err:
        return err

    period = str(params.get("period", "today")).lower().strip()
    max_results = int(params.get("max_results", 10))

    now = datetime.now()
    if period in ("tomorrow", "kal", "agamikal"):
        day_start = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    else:
        day_start = now

    day_end = day_start.replace(hour=23, minute=59, second=59, microsecond=999999)
    if period in ("tomorrow", "kal", "agamikal"):
        pass  # day_end is already end of tomorrow
    elif period in ("week", "this_week", "eishoptaho"):
        day_end = day_start + timedelta(days=7)

    time_min = day_start.isoformat() + "Z" if day_start.tzinfo is None else day_start.isoformat()
    time_max = day_end.isoformat() + "Z" if day_end.tzinfo is None else day_end.isoformat()

    try:
        result = service.events().list(
            calendarId="primary",
            timeMin=time_min,
            timeMax=time_max,
            maxResults=max_results,
            singleEvents=True,
            orderBy="startTime",
        ).execute()

        events = result.get("items", [])
        if not events:
            return f"No events found for {period}. Your schedule is clear!"

        lines = [f"📅 Schedule for {period.title()} ({len(events)} event{'s' if len(events) > 1 else ''}):"]
        for ev in events:
            start = ev.get("start", {})
            dt_str = start.get("dateTime", start.get("date", ""))
            # Parse for display
            try:
                dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
                time_fmt = dt.strftime("%I:%M %p")
            except Exception:
                time_fmt = dt_str

            summary = ev.get("summary", "(No title)")
            location = ev.get("location", "")
            loc_str = f" @ {location}" if location else ""
            lines.append(f"  - {time_fmt}: {summary}{loc_str}")

        return "\n".join(lines)

    except Exception as e:
        return f"Error fetching calendar events: {e}"


def _add_event(params: dict) -> str:
    """Create a new calendar event."""
    service, err = _get_service()
    if err:
        return err

    title = params.get("title") or params.get("summary") or params.get("name", "Untitled Event")
    date_str = params.get("date", "")
    time_str = params.get("time", "")
    duration_min = int(params.get("duration", 60))
    description = params.get("description", "")
    location = params.get("location", "")

    # Parse start time
    now = datetime.now()
    if date_str:
        try:
            if "tomorrow" in date_str.lower():
                base_date = now + timedelta(days=1)
            else:
                base_date = datetime.strptime(date_str, "%Y-%m-%d")
        except ValueError:
            try:
                base_date = datetime.strptime(date_str, "%d/%m/%Y")
            except ValueError:
                base_date = now
    else:
        base_date = now

    if time_str:
        try:
            t = datetime.strptime(time_str.strip().upper(), "%I:%M %p")
            start_dt = base_date.replace(hour=t.hour, minute=t.minute, second=0, microsecond=0)
        except ValueError:
            try:
                t = datetime.strptime(time_str.strip(), "%H:%M")
                start_dt = base_date.replace(hour=t.hour, minute=t.minute, second=0, microsecond=0)
            except ValueError:
                start_dt = base_date.replace(second=0, microsecond=0)
    else:
        start_dt = base_date.replace(hour=now.hour, minute=now.minute, second=0, microsecond=0) + timedelta(hours=1)

    end_dt = start_dt + timedelta(minutes=duration_min)

    event_body = {
        "summary": title,
        "start": {"dateTime": start_dt.isoformat(), "timeZone": "Asia/Dhaka"},
        "end": {"dateTime": end_dt.isoformat(), "timeZone": "Asia/Dhaka"},
    }
    if description:
        event_body["description"] = description
    if location:
        event_body["location"] = location

    try:
        created = service.events().insert(calendarId="primary", body=event_body).execute()
        link = created.get("htmlLink", "")
        return (
            f"Event created: '{title}' on {start_dt.strftime('%B %d, %Y')} "
            f"at {start_dt.strftime('%I:%M %p')} ({duration_min} min).\n"
            f"Link: {link}"
        )
    except Exception as e:
        return f"Failed to create event: {e}"


# ── Main dispatcher ──────────────────────────────────────────────────────────

def calendar_manager(parameters: dict, player: Any = None) -> str:
    """Main entry point for the calendar_manager tool."""
    action = str(parameters.get("action", "get_events")).lower().strip()

    if action in ("get_events", "get", "events", "schedule", "today", "tomorrow", "check"):
        return _get_events(parameters)
    elif action in ("add_event", "add", "create", "create_event", "new_event"):
        return _add_event(parameters)
    elif action in ("setup", "configure", "auth"):
        service, err = _get_service()
        if err:
            return err
        return "Google Calendar is already authenticated and ready."
    else:
        return (
            f"Unknown calendar action: '{action}'. "
            "Available: get_events (fetch schedule), add_event (create event), setup (configure auth)."
        )
