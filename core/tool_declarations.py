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
        "description": (
            "Sends, edits, deletes messages or detects active chats on WhatsApp (Desktop & Web), Messenger, Facebook, LinkedIn, Telegram, Instagram, Discord. "
            "Follows 5-step cycle: 1) Focus app/tab; 2) Search contact via Ctrl+F / search box; 3) Visually verify header name via Screen Vision to avoid wrong recipient; 4) Send message; 5) Edit/delete last message using Up Arrow / context menu. "
            "Use 'send' to send a new message. "
            "Use 'edit' to edit/replace the last sent message. "
            "Use 'delete' to delete the last sent message for everyone. "
            "Use 'detect_chat' to check which contact or chat window is currently active/open. "
            "Use this whenever the user says 'message dao', 'msg pathao', 'take bolo', 'edit koro', 'delete koro', 'chat detect koro', etc."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action": {
                    "type": "STRING",
                    "description": "send (default) | edit | delete | detect_chat"
                },
                "message_text": {
                    "type": "STRING",
                    "description": "The message text to send or updated text for edit. Required for send and edit."
                },
                "receiver": {
                    "type": "STRING",
                    "description": "Recipient contact name, phone number, or 'current'/'active'/'take' for currently open chat (default: 'current')"
                },
                "platform": {
                    "type": "STRING",
                    "description": "Platform: 'whatsapp' (default), 'messenger', 'facebook', 'linkedin', 'telegram', 'instagram', 'discord', or 'current'"
                },
                "for_everyone": {
                    "type": "BOOLEAN",
                    "description": "Whether to delete for everyone (default: true) when action='delete'"
                }
            },
            "required": []
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
            "Controls computer and OS settings directly via native Windows system calls or shortcuts: "
            "volume (volume_up, volume_down, volume_mute, volume_set, volume_get), "
            "brightness (brightness_up, brightness_down), "
            "Wi-Fi (toggle_wifi, wifi), "
            "Bluetooth (toggle_bluetooth, bluetooth, bluetooth_on, bluetooth_off), "
            "power/sleep (sleep_computer, sleep, restart, shutdown, log_off), "
            "window management, fullscreen, dark mode, keyboard shortcuts, typing text on screen, "
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
                "action":      {"type": "STRING", "description": "The action to perform: volume_up | volume_down | volume_set | volume_get | mute | brightness_up | brightness_down | toggle_wifi | toggle_bluetooth | bluetooth_on | bluetooth_off | sleep | restart | shutdown | ..."},
                "description": {"type": "STRING", "description": "Natural language description of what to do"},
                "value":       {"type": "STRING", "description": "Optional value: volume level (0-100), text to type, key name, etc."},
                "state":       {"type": "STRING", "description": "Optional state for bluetooth/wifi: 'on' | 'off' | 'toggle'"},
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
        "description": (
            "Manages files and folders anywhere on the PC: organize files (moving by extension, pattern, or category "
            "instantly in the background without mouse dragging), verify destination folders and handle duplicate file "
            "names safely without overwriting data, create folders (any directory/drive), create files, list, delete, "
            "move, copy, rename, read, write, find, disk usage, and report exact counts of moved/modified files."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action":      {"type": "STRING", "description": "organize | organize_files | move | copy | list | create_file | create_folder | delete | rename | read | write | find | largest | disk_usage | organize_desktop | info"},
                "path":        {"type": "STRING", "description": "Source file/folder path or shortcut: desktop, downloads, documents, home, or full path like C:/..., D:/..."},
                "destination": {"type": "STRING", "description": "Destination path for move/copy/organize"},
                "new_name":    {"type": "STRING", "description": "New name for rename"},
                "content":     {"type": "STRING", "description": "Content for create_file/write"},
                "name":        {"type": "STRING", "description": "File/folder name to create or search for"},
                "extension":   {"type": "STRING", "description": "File extension to filter or organize (e.g. .pdf, .docx, .png)"},
                "pattern":     {"type": "STRING", "description": "Wildcard pattern to match (e.g. *.pdf, invoice_*)"},
                "by_type":     {"type": "BOOLEAN", "description": "Whether to organize files into categorized folders (Documents, Images, Videos, Music, Archives, Code)"},
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
        "description": "Writes, edits, explains, runs, or builds code files ANYWHERE on the computer and automatically opens them in Visual Studio Code. Can also edit code visible directly on screen (action='screen_edit') or fix terminal/IDE errors from screen (action='fix_error_on_screen') by reading the traceback, navigating to the file/line in VS Code, applying a clean fix, and re-running in terminal.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action":      {"type": "STRING", "description": "write | edit | screen_edit | fix_error_on_screen | explain | run | build | open_in_vscode | auto (default: auto)"},
                "description": {"type": "STRING", "description": "What the code should do or what change to make or error to fix"},
                "language":    {"type": "STRING", "description": "Programming language (default: python)"},
                "output_path": {"type": "STRING", "description": "Where to save the file (any drive/path)"},
                "file_path":   {"type": "STRING", "description": "Path to existing file for edit/explain/run/build/open_in_vscode/fix_error_on_screen (leave empty to auto-detect from screen/active window)"},
                "command":     {"type": "STRING", "description": "Terminal execution command to re-run after applying fix (e.g. 'python main.py')"},
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
        "description": "Direct computer control: type, smart_type, click, hotkeys, scroll, move mouse, screenshots, find elements on screen, cross_app_transfer.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action":      {"type": "STRING", "description": "type | smart_type | click | smart_click | double_click | right_click | hotkey | press | scroll | move | copy | paste | cross_app_transfer | clipboard_bridge | self_healing_click | check_frozen | restart_frozen | loop_breaker | privacy_shield | local_env | macro | screenshot | wait | clear_field | dismiss_popup | focus_window | screen_find | screen_click | random_data | user_data"},
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
                "press_enter": {"type": "BOOLEAN", "description": "Whether to press Enter key after typing to send/submit (default: false)"},
                "path":        {"type": "STRING",  "description": "Save path for screenshot"},
            },
            "required": ["action"]
        }
    },
    {
        "name": "clipboard_bridge",
        "description": (
            "Cross-app pipeline and clipboard bridge for moving information between applications "
            "(e.g., search topic on Brave, summarize, send on WhatsApp, or copy error from browser to VS Code). "
            "Step 1: Writes text directly to system clipboard and triggers Ctrl+V for instant, zero-typo pasting. "
            "Step 2: Maintains an in-memory 'Working Scratchpad' when switching windows (Alt+Tab) to preserve context. "
            "Step 3: Verifies that the target window is active in the foreground via Screen Vision / Window API before executing Ctrl+V or Enter."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action":        {"type": "STRING", "description": "transfer (default) | copy | paste | switch_and_paste | get_scratchpad | set_scratchpad | clear_scratchpad | verify_window"},
                "text":          {"type": "STRING", "description": "Text, summary, code, or error to transfer or copy"},
                "target_app":    {"type": "STRING", "description": "Target application name (e.g., 'whatsapp', 'vscode', 'brave', 'chrome', 'notepad')"},
                "source_app":    {"type": "STRING", "description": "Source application where text originated"},
                "press_enter":   {"type": "BOOLEAN", "description": "Whether to press Enter after pasting (e.g. to send message or run command)"},
                "clear_first":   {"type": "BOOLEAN", "description": "Whether to clear input field (Ctrl+A -> Backspace) before pasting"},
                "verify_window": {"type": "BOOLEAN", "description": "Verify that target window is active in foreground before pasting (default: true)"},
                "key":           {"type": "STRING", "description": "Scratchpad slot key (default: 'main')"},
            },
            "required": []
        }
    },
    {
        "name": "self_healing",
        "description": (
            "Self-healing and loop breaker system for OS automation to prevent infinite retry loops. "
            "Step 1: Enforces strict MAX_RETRY = 3 limit for visual clicks or terminal commands. "
            "Step 2: If clicking (X, Y) produces no visual change after 2 attempts, triggers Attempt A (scroll/dismiss modal with Esc), "
            "Attempt B (keyboard navigation via Tab/Enter/Space), and Attempt C (background Python/CLI script). "
            "Step 3: Detects frozen 'Not Responding' applications and cleanly restarts them via terminal (taskkill)."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action":           {"type": "STRING", "description": "click (self_healing_click) | check_frozen | restart_frozen | offer_restart | run_command | reset | status"},
                "x":                {"type": "INTEGER", "description": "X coordinate for click"},
                "y":                {"type": "INTEGER", "description": "Y coordinate for click"},
                "description":      {"type": "STRING", "description": "Description of UI element"},
                "app_name":         {"type": "STRING", "description": "Name or PID of target application (e.g. 'chrome', 'notepad', 'whatsapp')"},
                "command":          {"type": "STRING", "description": "Terminal command to run with MAX_RETRY protection"},
                "cli_fallback_cmd": {"type": "STRING", "description": "Optional background Python/CLI command for Attempt C fallback"},
                "keyboard_key":     {"type": "STRING", "description": "Key for Attempt B keyboard navigation (default: 'enter')"},
            },
            "required": []
        }
    },
    {
        "name": "privacy_shield",
        "description": (
            "Privacy shield and local routing system to protect sensitive user credentials during continuous screen vision. "
            "Step 1: If screen displays sensitive content (.env, API keys, passwords, banking portals, credentials), redacts and never echoes them aloud or stores in plain text logs. "
            "Step 2: Routes sensitive local file manipulations and system credentials strictly through the local offline model (mj-os-agent on Ollama) rather than external cloud calls. "
            "Step 3: Strictly guards against auto-filling or modifying passwords/API keys unless explicitly instructed by the user in the current turn."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action":       {"type": "STRING", "description": "redact | check_sensitive | local_env | local_model | check_autofill"},
                "text":         {"type": "STRING", "description": "Text to sanitize, check, or prompt"},
                "file_path":    {"type": "STRING", "description": "File path (e.g. .env, api_keys.json)"},
                "key":          {"type": "STRING", "description": "Key name for .env manipulation"},
                "value":        {"type": "STRING", "description": "Value to set securely"},
                "env_action":   {"type": "STRING", "description": "get | set | delete (for local_env action)"},
                "user_command": {"type": "STRING", "description": "User instruction for verifying explicit permission"},
                "field":        {"type": "STRING", "description": "Field name/description to check (e.g. 'password', 'api_key')"}
            },
            "required": []
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
            "Skill & Macro Memory runtime: learns, saves, and executes multi-step workspace routines and macros as single commands. "
            "Step 1: Executes full sequences of actions for routines such as 'Start Coding Mode', 'Start Gaming Mode', or 'Prepare Project Setup'. "
            "Step 2: Saves successful multi-step action sequences into Conversational Memory & local JSON storage as a reusable skill. "
            "Step 3: Directly loads and executes saved macros without needing to plan from scratch."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action": {
                    "type": "STRING",
                    "description": "execute | run_now | learn | save | create | list | delete | get | presets"
                },
                "name": {
                    "type": "STRING",
                    "description": "Routine name (e.g. 'Start Coding Mode', 'Start Gaming Mode', 'Prepare Project Setup', 'morning_music')"
                },
                "trigger_type": {
                    "type": "STRING",
                    "description": "phrase (default) | time"
                },
                "trigger_value": {
                    "type": "STRING",
                    "description": "Spoken trigger phrase (e.g. 'start coding mode', 'coding mode') or 24h time 'HH:MM'"
                },
                "steps": {
                    "type": "STRING",
                    "description": (
                        "JSON-encoded array of steps e.g. "
                        "'[{\"tool\": \"open_app\", \"args\": {\"app_name\": \"vscode\"}}, {\"tool\": \"youtube_video\", \"args\": {\"query\": \"lofi music\"}}]'. "
                        "Supports all system tools: open_app, close_app, code_helper, computer_settings, youtube_video, browser_control, dev_agent, etc."
                    )
                },
                "description": {
                    "type": "STRING",
                    "description": "Readable description of what this macro/routine achieves."
                }
            },
            "required": ["action"]
        }
    },
    {
        "name": "proactive_watcher",
        "description": (
            "Proactive Watcher & System Guard co-pilot: monitors long-running tasks and protects against critical system spikes. "
            "Step 1: Monitors terminal progress or progress bars for long processes (model training, large file download, server deployment, dataset fetching) via Screen Vision. "
            "Step 2: Proactively notifies when finished ('Boss, your task is finished') or errored ('Boss, the script stopped with an error—should I fix it?'). "
            "Step 3: Detects critical CPU/RAM spikes (>90%), identifies the heavy background process causing lag, and prompts user before terminating it."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action": {
                    "type": "STRING",
                    "description": "watch | inspect | check_spikes | terminate | status | stop"
                },
                "task_name": {
                    "type": "STRING",
                    "description": "Name or description of long-running task (e.g. 'model training', 'large file download', 'server deployment', 'dataset fetching')"
                },
                "task_type": {
                    "type": "STRING",
                    "description": "training | download | deployment | dataset | build | generic"
                },
                "screen_text": {
                    "type": "STRING",
                    "description": "Optional terminal or screen text to inspect for progress, completion, or fatal errors"
                },
                "pid": {
                    "type": "INTEGER",
                    "description": "PID of heavy background process to terminate on user instruction"
                },
                "name": {
                    "type": "STRING",
                    "description": "Name of process to terminate (e.g. 'chrome.exe', 'photoshop.exe')"
                },
                "confirmed": {
                    "type": "BOOLEAN",
                    "description": "Explicit confirmation to terminate the identified heavy process"
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
            "Controls running web browsers (Brave, Chrome, Edge) directly on desktop with zero profile lock: "
            "navigate to URL, search web, YouTube media playback (search + click first video), "
            "Gmail email drafting (creates draft modal with To/Subject/Body and pauses for user review), "
            "scroll down/up, reload/refresh page, go back/forward, toggle fullscreen, "
            "switch tabs (1-9), close active tab, close multiple tabs, open new tab with URL, reopen closed tab, and next/prev tab navigation. "
            "Always use this when user asks to control, scroll, navigate, play YouTube videos, compose emails, or manage tabs inside Brave or Chrome."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action":     {"type": "STRING", "description": "navigate | search | youtube_search | gmail_compose | scroll_down | scroll_up | reload | back | forward | fullscreen | switch_tab | close_tab | close_tabs | new_tab | reopen_tab | next_tab | prev_tab"},
                "browser":    {"type": "STRING", "description": "brave | chrome | edge (default: brave)"},
                "url":        {"type": "STRING", "description": "URL to navigate to (e.g. 'https://youtube.com', 'google.com')"},
                "query":      {"type": "STRING", "description": "Search query for search or youtube_search action"},
                "to":         {"type": "STRING", "description": "Recipient email address for gmail_compose"},
                "subject":    {"type": "STRING", "description": "Email subject line for gmail_compose"},
                "body":       {"type": "STRING", "description": "Email message body for gmail_compose"},
                "send_now":   {"type": "BOOLEAN", "description": "Whether to immediately send email (default: false, keeps at draft stage for review)"},
                "tab_number": {"type": "INTEGER", "description": "Tab number (1-9) for switch_tab"},
                "count":      {"type": "INTEGER", "description": "Number of tabs to close for close_tabs"},
                "amount":     {"type": "INTEGER", "description": "Number of page scrolls for scroll_down/scroll_up"},
                "command":    {"type": "STRING", "description": "Natural language command e.g. 'Brave e youtube open koro', 'scroll down', 'gmail e draft koro'"}
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

