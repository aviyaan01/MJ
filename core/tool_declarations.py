TOOL_DECLARATIONS = [
    {
        "name": "open_app",
        "description": (
            "Opens any application on the computer. "
            "Use this whenever the user asks to open, launch, or start any app, "
            "website, or program. Always call this tool — never just say you opened it."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "app_name": {
                    "type": "STRING",
                    "description": "Exact name of the application (e.g. 'WhatsApp', 'Chrome', 'Spotify')"
                }
            },
            "required": ["app_name"]
        }
    },
    {
        "name": "web_search",
        "description": (
            "Searches the web. Use for ANY question about current facts, events, prices, "
            "or topics — always prefer this over guessing. "
            "Modes: 'search' (default), 'news' (latest headlines on a topic), "
            "'research' (deep comprehensive answer), 'price' (product cost lookup), "
            "'compare' (side-by-side comparison of items)."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "query":  {"type": "STRING", "description": "Search query or topic"},
                "mode":   {"type": "STRING", "description": "search | news | research | price | compare"},
                "items":  {"type": "ARRAY",  "items": {"type": "STRING"}, "description": "Items to compare (compare mode)"},
                "aspect": {"type": "STRING", "description": "Comparison aspect: price | specs | reviews | features"},
            },
            "required": ["query"]
        }
    },
    {
        "name": "system_status",
        "description": (
            "Returns real-time system metrics: CPU usage, RAM, GPU load, CPU temperature, "
            "uptime, and process count. Use when the user asks about computer performance, "
            "temperature, memory, or resource usage."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {},
        }
    },
    {
        "name": "weather_report",
        "description": "Gives the weather report to user",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "city": {"type": "STRING", "description": "City name"}
            },
            "required": ["city"]
        }
    },
    {
        "name": "send_message",
        "description": "Sends a text message via WhatsApp, Telegram, or other messaging platform.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "receiver":     {"type": "STRING", "description": "Recipient contact name"},
                "message_text": {"type": "STRING", "description": "The message to send"},
                "platform":     {"type": "STRING", "description": "Platform: WhatsApp, Telegram, etc."}
            },
            "required": ["receiver", "message_text", "platform"]
        }
    },
    {
        "name": "reminder",
        "description": "Sets a timed reminder using Task Scheduler.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "date":    {"type": "STRING", "description": "Date in YYYY-MM-DD format"},
                "time":    {"type": "STRING", "description": "Time in HH:MM format (24h)"},
                "message": {"type": "STRING", "description": "Reminder message text"}
            },
            "required": ["date", "time", "message"]
        }
    },
    {
        "name": "youtube_video",
        "description": (
            "Controls YouTube. Use for: playing videos, summarizing a video's content, "
            "getting video info, or showing trending videos."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action": {"type": "STRING", "description": "play | summarize | get_info | trending (default: play)"},
                "query":  {"type": "STRING", "description": "Search query for play action"},
                "save":   {"type": "BOOLEAN", "description": "Save summary to Notepad (summarize only)"},
                "region": {"type": "STRING", "description": "Country code for trending e.g. TR, US"},
                "url":    {"type": "STRING", "description": "Video URL for get_info action"},
            },
            "required": []
        }
    },
    {
        "name": "screen_process",
        "description": (
            "Captures the screen or webcam image and lets you analyze it. "
            "MUST be called when user asks what is on screen, what you see, "
            "look at camera, analyze my screen, etc. "
            "You have NO visual ability without this tool. "
            "After the image is captured it is sent directly to you — describe what you see and answer the user's question. "
            "When using camera: the live view stays open until user says close it or calls close_camera."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "angle": {"type": "STRING", "description": "'screen' to capture display, 'camera' for webcam. Default: 'screen'"},
                "text":  {"type": "STRING", "description": "The question or instruction about the captured image"}
            },
            "required": ["text"]
        }
    },
    {
        "name": "close_camera",
        "description": (
            "Closes the live camera view shown on screen. "
            "Call when user says: close camera, stop camera, turn off camera, "
            "kamerayı kapat, kapat, creepy, etc."
        ),
        "parameters": {"type": "OBJECT", "properties": {}, "required": []}
    },
    {
        "name": "close_app",
        "description": (
            "Closes a running application by name, wherever it is running. "
            "Use when the user names an app to quit, kill, or close "
            "(e.g. 'close Chrome', 'quit Spotify', 'kill Discord'). "
            "This terminates the process — it is NOT the same as closing the current window. "
            "For the currently focused window only, use computer_settings with action close_foreground_app."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "app_name": {
                    "type": "STRING",
                    "description": "Name of the application to close (e.g. 'Chrome', 'Spotify', 'Notepad')"
                }
            },
            "required": ["app_name"]
        }
    },
    {
        "name": "computer_settings",
        "description": (
            "Controls the computer: volume, brightness, window management, keyboard shortcuts, "
            "typing text on screen, fullscreen, dark mode, WiFi, "
            "scrolling, tab management, zoom, screenshots, lock screen, refresh/reload page. "
            "Foreground-window close: action close_foreground_app or close_current_window "
            "(closes only the focused window — NOT a named process). "
            "To quit a named application (Chrome, Spotify, etc.) you MUST use the close_app tool instead. "
            "Power: action shutdown = shut down the COMPUTER (never the assistant); "
            "restart = reboot the computer; sleep = sleep/suspend the computer; "
            "log_off = log off the current user. "
            "These power actions require a spoken yes/no confirmation from the user before they run. "
            "Do NOT use this tool to stop MJ itself — that is shutdown_mj."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action":      {"type": "STRING", "description": "The action to perform"},
                "description": {"type": "STRING", "description": "Natural language description of what to do"},
                "value":       {"type": "STRING", "description": "Optional value: volume level, text to type, etc."},
                "confirmed":   {"type": "STRING", "description": "Set by the runtime after the user says yes to a dangerous power action. Do not invent this."},
            },
            "required": []
        }
    },
    {
        "name": "browser_control",
        "description": (
            "Controls any web browser. Use for: opening websites, searching the web, "
            "clicking elements, filling forms, scrolling, screenshots, navigation, any web-based task. "
            "Simple open/search requests launch the user's own browser normally (their real profile "
            "and logged-in accounts); interactive actions (click, type, fill_form...) attach an "
            "automation browser. "
            "Always pass the 'browser' parameter when the user specifies a browser (e.g. 'open in Edge', "
            "'use Firefox', 'open Chrome'). Multiple browsers can run simultaneously."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action":      {"type": "STRING", "description": "go_to | search | click | type | scroll | fill_form | smart_click | smart_type | get_text | get_url | press | new_tab | close_tab | screenshot | back | forward | reload | switch | list_browsers | close | close_all"},
                "browser":     {"type": "STRING", "description": "Target browser: chrome | edge | firefox | opera | operagx | brave | vivaldi | safari. Omit to use the currently active browser."},
                "url":         {"type": "STRING", "description": "URL for go_to / new_tab action"},
                "query":       {"type": "STRING", "description": "Search query for search action"},
                "engine":      {"type": "STRING", "description": "Search engine: google | bing | duckduckgo | yandex (default: google)"},
                "selector":    {"type": "STRING", "description": "CSS selector for click/type"},
                "text":        {"type": "STRING", "description": "Text to click or type"},
                "description": {"type": "STRING", "description": "Element description for smart_click/smart_type"},
                "direction":   {"type": "STRING", "description": "up | down for scroll"},
                "amount":      {"type": "INTEGER", "description": "Scroll amount in pixels (default: 500)"},
                "key":         {"type": "STRING", "description": "Key name for press action (e.g. Enter, Escape, F5)"},
                "path":        {"type": "STRING", "description": "Save path for screenshot"},
                "incognito":   {"type": "BOOLEAN", "description": "Open in private/incognito mode"},
                "clear_first": {"type": "BOOLEAN", "description": "Clear field before typing (default: true)"},
            },
            "required": ["action"]
        }
    },
    {
        "name": "file_controller",
        "description": "Manages files and folders anywhere on the PC: create folders (any directory/drive), create files, list, delete, move, copy, rename, read, write, find, disk usage.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action":      {"type": "STRING", "description": "list | create_file | create_folder | delete | move | copy | rename | read | write | find | largest | disk_usage | organize_desktop | info"},
                "path":        {"type": "STRING", "description": "File/folder path or shortcut: desktop, downloads, documents, home, or full path like C:/..., D:/..."},
                "destination": {"type": "STRING", "description": "Destination path for move/copy"},
                "new_name":    {"type": "STRING", "description": "New name for rename"},
                "content":     {"type": "STRING", "description": "Content for create_file/write"},
                "name":        {"type": "STRING", "description": "File/folder name to create or search for"},
                "extension":   {"type": "STRING", "description": "File extension to search (e.g. .pdf)"},
                "count":       {"type": "INTEGER", "description": "Number of results for largest"},
            },
            "required": ["action"]
        }
    },
    {
        "name": "desktop_control",
        "description": "Controls the desktop: wallpaper, organize, clean, list, stats.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action": {"type": "STRING", "description": "wallpaper | wallpaper_url | organize | clean | list | stats | task"},
                "path":   {"type": "STRING", "description": "Image path for wallpaper"},
                "url":    {"type": "STRING", "description": "Image URL for wallpaper_url"},
                "mode":   {"type": "STRING", "description": "by_type or by_date for organize"},
                "task":   {"type": "STRING", "description": "Natural language desktop task"},
            },
            "required": ["action"]
        }
    },
    {
        "name": "code_helper",
        "description": "Writes, edits, explains, runs, or builds code files ANYWHERE on the computer and automatically opens them in Visual Studio Code.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action":      {"type": "STRING", "description": "write | edit | explain | run | build | open_in_vscode | auto (default: auto)"},
                "description": {"type": "STRING", "description": "What the code should do or what change to make"},
                "language":    {"type": "STRING", "description": "Programming language (default: python)"},
                "output_path": {"type": "STRING", "description": "Where to save the file (any drive/path)"},
                "file_path":   {"type": "STRING", "description": "Path to existing file for edit/explain/run/build/open_in_vscode"},
                "code":        {"type": "STRING", "description": "Raw code string for explain"},
                "args":        {"type": "STRING", "description": "CLI arguments for run/build"},
                "timeout":     {"type": "INTEGER", "description": "Execution timeout in seconds (default: 30)"},
            },
            "required": ["action"]
        }
    },
    {
        "name": "dev_agent",
        "description": "Builds complete multi-file projects from scratch: plans, writes files, installs deps, opens VSCode, runs and fixes errors.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "description":  {"type": "STRING", "description": "What the project should do"},
                "language":     {"type": "STRING", "description": "Programming language (default: python)"},
                "project_name": {"type": "STRING", "description": "Optional project folder name"},
                "timeout":      {"type": "INTEGER", "description": "Run timeout in seconds (default: 30)"},
            },
            "required": ["description"]
        }
    },
    {
        "name": "computer_control",
        "description": "Direct computer control: type, click, hotkeys, scroll, move mouse, screenshots, find elements on screen.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action":      {"type": "STRING", "description": "type | smart_type | click | double_click | right_click | hotkey | press | scroll | move | copy | paste | screenshot | wait | clear_field | focus_window | screen_find | screen_click | random_data | user_data"},
                "text":        {"type": "STRING", "description": "Text to type or paste"},
                "x":           {"type": "INTEGER", "description": "X coordinate"},
                "y":           {"type": "INTEGER", "description": "Y coordinate"},
                "keys":        {"type": "STRING", "description": "Key combination e.g. 'ctrl+c'"},
                "key":         {"type": "STRING", "description": "Single key e.g. 'enter'"},
                "direction":   {"type": "STRING", "description": "up | down | left | right"},
                "amount":      {"type": "INTEGER", "description": "Scroll amount (default: 3)"},
                "seconds":     {"type": "NUMBER",  "description": "Seconds to wait"},
                "title":       {"type": "STRING",  "description": "Window title for focus_window"},
                "description": {"type": "STRING",  "description": "Element description for screen_find/screen_click"},
                "type":        {"type": "STRING",  "description": "Data type for random_data"},
                "field":       {"type": "STRING",  "description": "Field for user_data: name|email|city"},
                "clear_first": {"type": "BOOLEAN", "description": "Clear field before typing (default: true)"},
                "path":        {"type": "STRING",  "description": "Save path for screenshot"},
            },
            "required": ["action"]
        }
    },
    {
        "name": "game_updater",
        "description": (
            "THE ONLY tool for ANY Steam or Epic Games request. "
            "Use for: installing, downloading, updating games, listing installed games, "
            "checking download status, scheduling updates. "
            "ALWAYS call directly for any Steam/Epic/game request. "
            "NEVER use browser_control or web_search for Steam/Epic."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action":    {"type": "STRING",  "description": "update | install | list | download_status | schedule | cancel_schedule | schedule_status (default: update)"},
                "platform":  {"type": "STRING",  "description": "steam | epic | both (default: both)"},
                "game_name": {"type": "STRING",  "description": "Game name (partial match supported)"},
                "app_id":    {"type": "STRING",  "description": "Steam AppID for install (optional)"},
                "hour":      {"type": "INTEGER", "description": "Hour for scheduled update 0-23 (default: 3)"},
                "minute":    {"type": "INTEGER", "description": "Minute for scheduled update 0-59 (default: 0)"},
                "shutdown_when_done": {"type": "BOOLEAN", "description": "Shut down PC when download finishes"},
            },
            "required": []
        }
    },
    {
        "name": "flight_finder",
        "description": "Searches Google Flights and speaks the best options.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "origin":      {"type": "STRING",  "description": "Departure city or airport code"},
                "destination": {"type": "STRING",  "description": "Arrival city or airport code"},
                "date":        {"type": "STRING",  "description": "Departure date (any format)"},
                "return_date": {"type": "STRING",  "description": "Return date for round trips"},
                "passengers":  {"type": "INTEGER", "description": "Number of passengers (default: 1)"},
                "cabin":       {"type": "STRING",  "description": "economy | premium | business | first"},
                "save":        {"type": "BOOLEAN", "description": "Save results to Notepad"},
            },
            "required": ["origin", "destination", "date"]
        }
    },
    {
        "name": "shutdown_mj",
        "description": (
            "Stops the MJ assistant process only. Does NOT shut down, restart, "
            "sleep, or log off the computer. "
            "Call this when the user wants to end the conversation, close the assistant, "
            "say goodbye, or stop MJ — in ANY language. "
            "If the user wants to shut down / restart / sleep the PC, use computer_settings "
            "with action shutdown, restart, or sleep instead."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {},
        }
    },
    {
    "name": "file_processor",
    "description": (
        "Processes any file that the user has uploaded or dropped onto the interface. "
        "Use this when the user refers to an uploaded file and wants an action on it. "
        "Supports: images (describe/ocr/resize/compress/convert), "
        "PDFs (summarize/extract_text/to_word), "
        "Word docs & text files (summarize/fix/reformat/translate), "
        "CSV/Excel (analyze/stats/filter/sort/convert), "
        "JSON/XML (validate/format/analyze), "
        "code files (explain/review/fix/optimize/run/document/test), "
        "audio (transcribe/trim/convert/info), "
        "video (trim/extract_audio/extract_frame/compress/transcribe/info), "
        "archives (list/extract), "
        "presentations (summarize/extract_text). "
        "ALWAYS call this tool when a file has been uploaded and the user gives a command about it. "
        "If the user's command is ambiguous, pick the most logical action for that file type."
    ),
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "file_path": {
                "type": "STRING",
                "description": "Full path to the uploaded file. Leave empty to use the currently uploaded file."
            },
            "action": {
                "type": "STRING",
                "description": (
                    "What to do with the file. Examples by type:\n"
                    "image: describe | ocr | resize | compress | convert | info\n"
                    "pdf: summarize | extract_text | to_word | info\n"
                    "docx/txt: summarize | fix | reformat | translate_hint | word_count | to_bullet\n"
                    "csv/excel: analyze | stats | filter | sort | convert | info\n"
                    "json: validate | format | analyze | to_csv\n"
                    "code: explain | review | fix | optimize | run | document | test\n"
                    "audio: transcribe | trim | convert | info\n"
                    "video: trim | extract_audio | extract_frame | compress | transcribe | info | convert\n"
                    "archive: list | extract\n"
                    "pptx: summarize | extract_text | analyze"
                )
            },
            "instruction": {
                "type": "STRING",
                "description": "Free-form instruction if action doesn't cover it. E.g. 'translate this to Turkish', 'find all email addresses'"
            },
            "format": {
                "type": "STRING",
                "description": "Target format for conversion. E.g. 'mp3', 'pdf', 'csv', 'png'"
            },
            "width":     {"type": "INTEGER", "description": "Target width for image resize"},
            "height":    {"type": "INTEGER", "description": "Target height for image resize"},
            "scale":     {"type": "NUMBER",  "description": "Scale factor for image resize (e.g. 0.5)"},
            "quality":   {"type": "INTEGER", "description": "Quality 1-100 for image/video compress"},
            "start":     {"type": "STRING",  "description": "Start time for trim: seconds or HH:MM:SS"},
            "end":       {"type": "STRING",  "description": "End time for trim: seconds or HH:MM:SS"},
            "timestamp": {"type": "STRING",  "description": "Timestamp for video frame extraction HH:MM:SS"},
            "column":    {"type": "STRING",  "description": "Column name for CSV filter/sort"},
            "value":     {"type": "STRING",  "description": "Filter value for CSV filter"},
            "condition": {"type": "STRING",  "description": "Filter condition: equals|contains|gt|lt"},
            "ascending": {"type": "BOOLEAN", "description": "Sort order for CSV sort (default: true)"},
            "save":      {"type": "BOOLEAN", "description": "Save result to file (default: true)"},
            "destination": {"type": "STRING", "description": "Output folder for archive extract"},
        },
        "required": []
    }
},
    {
        "name": "save_memory",
        "description": (
            "Save an important personal fact about the user to long-term memory. "
            "Call this silently whenever the user reveals something worth remembering: "
            "name, age, city, job, preferences, hobbies, relationships, projects, or future plans. "
            "Do NOT call for: weather, reminders, searches, or one-time commands. "
            "Do NOT announce that you are saving — just call it silently. "
            "Values must be in English regardless of the conversation language."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "category": {
                    "type": "STRING",
                    "description": (
                        "identity — name, age, birthday, city, job, language, nationality | "
                        "preferences — favorite food/color/music/film/game/sport, hobbies | "
                        "projects — active projects, goals, things being built | "
                        "relationships — friends, family, partner, colleagues | "
                        "wishes — future plans, things to buy, travel dreams | "
                        "notes — habits, schedule, anything else worth remembering"
                    )
                },
                "key":   {"type": "STRING", "description": "Short snake_case key (e.g. name, favorite_food, sister_name)"},
                "value": {"type": "STRING", "description": "Concise value in English (e.g. Fatih, pizza, older sister)"},
            },
            "required": ["category", "key", "value"]
        }
    },
    {
        "name": "routine_manager",
        "description": (
            "Manages automated multi-step routines. Use when the user wants to create, "
            "list, delete, or manually execute saved automations that trigger at a scheduled time "
            "(24h 'HH:MM') or via a spoken trigger phrase (e.g. 'leaving now'). "
            "When creating a routine, confirm the steps back to the user in one sentence before saving."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action": {
                    "type": "STRING",
                    "description": "create | list | delete | run_now"
                },
                "name": {
                    "type": "STRING",
                    "description": "Routine name (e.g. 'morning_music', 'leaving_home')"
                },
                "trigger_type": {
                    "type": "STRING",
                    "description": "time | phrase"
                },
                "trigger_value": {
                    "type": "STRING",
                    "description": "Time in 'HH:MM' (24h format, e.g. '07:00') or spoken trigger phrase (e.g. 'leaving now')"
                },
                "steps": {
                    "type": "STRING",
                    "description": (
                        "JSON-encoded array of steps e.g. "
                        "'[{\"tool\": \"open_app\", \"args\": {\"app_name\": \"spotify\"}}, {\"tool\": \"youtube_video\", \"args\": {\"query\": \"lofi music\"}}]'. "
                        "Uses existing tool names: open_app, close_app, computer_settings, youtube_video, web_search, etc."
                    )
                }
            },
            "required": ["action"]
        }
    },
    {
        "name": "advanced_settings",
        "description": (
            "Deep OS and hardware configuration: Bluetooth toggling/status, screen resolution, "
            "network & DNS cache flushing, adapter resets, power plans (High Performance, Balanced, Battery Saver), "
            "and direct navigation to Windows Settings URIs (ms-settings:*)."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action":  {"type": "STRING", "description": "bluetooth | flush_dns | reset_network | network_info | power_plan | display_resolution | open_settings | run_powershell"},
                "value":   {"type": "STRING", "description": "Setting value: on/off for bluetooth, high_performance/balanced/power_saver for power_plan, resolution e.g. 1920x1080, or settings page name e.g. display, sound, wifi"},
                "command": {"type": "STRING", "description": "Raw PowerShell command when action is run_powershell"}
            },
            "required": ["action"]
        }
    },
    {
        "name": "browser_manager",
        "description": (
            "Advanced tab management specifically for Chrome and Brave browsers: "
            "switch to specific tab (1-9), close active tab, close multiple tabs (e.g. first 2 tabs), "
            "new tab with URL, reopen closed tab, next/prev tab navigation."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action":     {"type": "STRING", "description": "switch_tab | close_tab | close_tabs | new_tab | reopen_tab | next_tab | prev_tab"},
                "tab_number": {"type": "INTEGER", "description": "Tab number (1-9) for switch_tab"},
                "count":      {"type": "INTEGER", "description": "Number of tabs to close for close_tabs"},
                "url":        {"type": "STRING", "description": "URL to open for new_tab"},
                "browser":    {"type": "STRING", "description": "chrome | brave (default: chrome)"},
                "command":    {"type": "STRING", "description": "Natural language command e.g. 'close the first 2 tabs'"}
            },
            "required": []
        }
    },
    {
        "name": "window_controller",
        "description": (
            "Extreme window and desktop state management: "
            "minimize all windows (show desktop), close all user applications gracefully, or restore windows."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action": {"type": "STRING", "description": "minimize_all | show_desktop | close_all | restore_all"}
            },
            "required": ["action"]
        }
    },
    {
        "name": "vision_control",
        "description": (
            "Controls the background continuous screen vision stream. "
            "Use 'start_vision' when the user says 'watch my screen', 'keep an eye on my screen', 'start vision'. "
            "Use 'stop_vision' when the user says 'stop watching', 'stop vision', 'pause screen stream' to save RAM/CPU."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action": {"type": "STRING", "description": "start_vision | stop_vision | status"}
            },
            "required": ["action"]
        }
    },
    {
        "name": "calendar_manager",
        "description": (
            "Google Calendar integration: fetch today's or tomorrow's schedule, "
            "create new events, and manage calendar entries. "
            "Use when the user asks about their schedule, meetings, appointments, "
            "or wants to add/create a calendar event."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action": {
                    "type": "STRING",
                    "description": "get_events (fetch schedule) | add_event (create event) | setup (configure auth)"
                },
                "period": {
                    "type": "STRING",
                    "description": "today | tomorrow | week (for get_events, default: today)"
                },
                "title": {
                    "type": "STRING",
                    "description": "Event title/summary (for add_event)"
                },
                "date": {
                    "type": "STRING",
                    "description": "Event date in YYYY-MM-DD format or 'tomorrow' (for add_event)"
                },
                "time": {
                    "type": "STRING",
                    "description": "Event start time e.g. '3:00 PM' or '15:00' (for add_event)"
                },
                "duration": {
                    "type": "INTEGER",
                    "description": "Duration in minutes (default: 60)"
                },
                "description": {
                    "type": "STRING",
                    "description": "Optional event description/notes"
                },
                "location": {
                    "type": "STRING",
                    "description": "Optional event location"
                }
            },
            "required": ["action"]
        }
    },
    {
        "name": "smart_home",
        "description": (
            "Controls smart home IoT devices via Home Assistant, IFTTT, or Tuya webhooks. "
            "Toggle lights, AC, fans, smart plugs on/off; check device status; list configured devices. "
            "Use when the user says 'turn on the light', 'switch off the AC', 'is the fan on?', "
            "'bedroom light off koro', 'batti jwalao', etc."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action": {
                    "type": "STRING",
                    "description": "toggle_device | check_status | list_devices | ifttt | setup"
                },
                "device": {
                    "type": "STRING",
                    "description": "Natural language device name e.g. 'bedroom light', 'AC', 'fan', 'smart plug'"
                },
                "state": {
                    "type": "STRING",
                    "description": "on | off | toggle (for toggle_device, default: toggle)"
                },
                "event": {
                    "type": "STRING",
                    "description": "IFTTT webhook event name (for ifttt action)"
                },
                "value1": {
                    "type": "STRING",
                    "description": "IFTTT value1 parameter"
                }
            },
            "required": ["action"]
        }
    },
    {
        "name": "remember_fact",
        "description": "Saves a new fact into MJ's long-term memory. Use this whenever the user tells you something important about themselves, their preferences, or facts they want you to remember across sessions.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "fact": {"type": "STRING", "description": "The specific fact to remember (e.g. 'User loves black coffee')"},
                "category": {"type": "STRING", "description": "Category of the fact (e.g. 'preferences', 'projects', 'family', 'general')"}
            },
            "required": ["fact"]
        }
    },
    {
        "name": "recall_facts",
        "description": "Searches MJ's long-term memory vault for facts matching a specific query or category. Use this if you need to remember something you previously saved.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "query": {"type": "STRING", "description": "Search keyword or topic"},
                "category": {"type": "STRING", "description": "Filter by category"}
            }
        }
    },
    {
        "name": "forget_fact",
        "description": "Deletes a fact from long-term memory using its fact_id.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "fact_id": {"type": "STRING", "description": "The ID of the fact to delete"}
            },
            "required": ["fact_id"]
        }
    },
    {
        "name": "vscode_control",
        "description": "Provides deep automation for an already-running VS Code instance. Use for jumping to specific lines, viewing diffs, running terminal commands, listing tabs, closing tabs, and inserting text.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action": {"type": "STRING", "description": "goto_line | diff | run_in_terminal | list_open_tabs | close_tab | reuse_window | insert_text"},
                "file_path": {"type": "STRING", "description": "Target file path for goto_line, reuse_window, or close_tab"},
                "line": {"type": "INTEGER", "description": "Line number for goto_line or insert_text"},
                "column": {"type": "INTEGER", "description": "Column number for goto_line or insert_text"},
                "file1": {"type": "STRING", "description": "First file path for diff"},
                "file2": {"type": "STRING", "description": "Second file path for diff"},
                "command": {"type": "STRING", "description": "Command to run for run_in_terminal"},
                "text": {"type": "STRING", "description": "Text to insert for insert_text"}
            },
            "required": ["action"]
        }
    },
    {
        "name": "voice_enrollment",
        "description": (
            "Manages MJ's speaker verification system. "
            "Use 'enroll_voice' when the user says 'enroll my voice', 'learn my voice', or 'set up voice recognition'. "
            "Use 'check_enrollment' to report whether a voiceprint is saved. "
            "Use 'reset_enrollment' when the user says 'forget my voice', 'reset voice', or 'delete my voiceprint'."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action": {
                    "type": "STRING",
                    "description": "enroll_voice | check_enrollment | reset_enrollment"
                }
            },
            "required": ["action"]
        }
    }
]

