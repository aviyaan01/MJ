import fnmatch
import os
import shutil
from datetime import datetime
from pathlib import Path

from utils.env import get_os

try:
    import send2trash
    _SEND2TRASH = True
except ImportError:
    _SEND2TRASH = False


_SAFE_ROOTS: list[Path] = [
    Path.home(),
]
if get_os() == "Windows":
    import string
    for drive in string.ascii_uppercase:
        d_path = Path(f"{drive}:\\")
        if d_path.exists():
            _SAFE_ROOTS.append(d_path)
else:
    _SAFE_ROOTS.append(Path("/"))

def _is_safe_path(target: Path) -> bool:
    """Check if the path is within valid accessible filesystem roots."""
    try:
        resolved = target.resolve()
        # Protect only system critical roots like Windows/System32 from destruction
        if get_os() == "Windows":
            sys_root = Path(os.environ.get("SystemRoot", "C:\\Windows")).resolve()
            if resolved == sys_root or resolved.is_relative_to(sys_root):
                return False
        return True
    except Exception:
        return True

def _get_desktop() -> Path:
    if get_os() == "Linux":
        xdg = os.environ.get("XDG_DESKTOP_DIR", "")
        if xdg and Path(xdg).exists():
            return Path(xdg)
    return Path.home() / "Desktop"

def _get_downloads() -> Path:
    if get_os() == "Linux":
        xdg = os.environ.get("XDG_DOWNLOAD_DIR", "")
        if xdg and Path(xdg).exists():
            return Path(xdg)
    return Path.home() / "Downloads"

def _get_documents() -> Path:
    if get_os() == "Linux":
        xdg = os.environ.get("XDG_DOCUMENTS_DIR", "")
        if xdg and Path(xdg).exists():
            return Path(xdg)
    return Path.home() / "Documents"

def _get_pictures() -> Path:
    if get_os() == "Linux":
        xdg = os.environ.get("XDG_PICTURES_DIR", "")
        if xdg and Path(xdg).exists():
            return Path(xdg)
    return Path.home() / "Pictures"

def _get_music() -> Path:
    if get_os() == "Linux":
        xdg = os.environ.get("XDG_MUSIC_DIR", "")
        if xdg and Path(xdg).exists():
            return Path(xdg)
    return Path.home() / "Music"

def _get_videos() -> Path:
    if get_os() == "Linux":
        xdg = os.environ.get("XDG_VIDEOS_DIR", "")
        if xdg and Path(xdg).exists():
            return Path(xdg)
    return Path.home() / "Videos"


def _resolve_path(raw: str) -> Path:
    if not raw:
        return _get_desktop()
    shortcuts: dict[str, Path] = {
        "desktop":   _get_desktop(),
        "downloads": _get_downloads(),
        "documents": _get_documents(),
        "pictures":  _get_pictures(),
        "music":     _get_music(),
        "videos":    _get_videos(),
        "home":      Path.home(),
        "projects":  Path.home() / "Desktop" / "Projects",
    }
    cleaned = raw.strip().replace('"', "").replace("'", "")
    lower = cleaned.lower()
    if lower in shortcuts:
        return shortcuts[lower]
    for prefix, dir_path in shortcuts.items():
        if lower.startswith(f"{prefix}/") or lower.startswith(f"{prefix}\\"):
            rel = cleaned[len(prefix) + 1:]
            return dir_path / rel
    p = Path(cleaned).expanduser()
    if not p.is_absolute():
        p = _get_desktop() / p
    return p.resolve()

def _format_size(b: float | int) -> str:
    size = float(b)
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"

def _safe_trash(target: Path) -> str:

    if not _SEND2TRASH:
        return (
            "send2trash is not installed. "
            "Run: pip install send2trash — "
            "Permanent deletion is disabled for safety."
        )
    send2trash.send2trash(str(target))
    return f"Moved to Trash: {target.name}"


def list_files(path: str = "desktop", show_hidden: bool = False) -> str:
    try:
        target = _resolve_path(path)
        if not _is_safe_path(target):
            return f"Access denied: {target}"
        if not target.exists():
            return f"Path not found: {target}"
        if not target.is_dir():
            return f"Not a directory: {target}"

        items = []
        for item in sorted(target.iterdir()):
            if not show_hidden and item.name.startswith("."):
                continue
            if item.is_dir():
                items.append(f"📁 {item.name}/")
            else:
                size = _format_size(item.stat().st_size)
                items.append(f"📄 {item.name} ({size})")

        if not items:
            return f"Directory is empty: {target.name}/"

        return f"Contents of {target.name}/ ({len(items)} items):\n" + "\n".join(items)

    except PermissionError:
        return f"Permission denied: {path}"
    except Exception as e:
        return f"Error listing files: {e}"


def create_file(path: str, name: str = "", content: str = "") -> str:
    try:
        base   = _resolve_path(path)
        target = (base / name) if name else base
        if not _is_safe_path(target):
            return f"Access denied: {target}"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return f"File created: {target.name}"
    except Exception as e:
        return f"Could not create file: {e}"


def create_folder(path: str, name: str = "", open_after: bool = False) -> str:
    try:
        base   = _resolve_path(path)
        target = (base / name) if name else base
        if not _is_safe_path(target):
            return f"Access denied: {target}"
        os.makedirs(target, exist_ok=True)
        if open_after:
            try:
                if get_os() == "Windows":
                    os.startfile(str(target))
                elif get_os() == "Darwin":
                    subprocess.Popen(["open", str(target)])
                else:
                    subprocess.Popen(["xdg-open", str(target)])
            except Exception:
                pass
        return f"Folder created successfully: {target.name} (at {target})"
    except Exception as e:
        return f"Could not create folder: {e}"


def delete_file(path: str, name: str = "") -> str:
    try:
        base   = _resolve_path(path)
        target = (base / name) if name else base
        if not _is_safe_path(target):
            return f"Access denied: {target}"
        if not target.exists():
            return f"Not found: {target.name}"

        # Güvenli dizin kontrolü — kritik kullanıcı klasörlerini koru
        protected = {
            _get_desktop(), _get_downloads(), _get_documents(),
            _get_pictures(), _get_music(), _get_videos(), Path.home()
        }
        if target.resolve() in {p.resolve() for p in protected}:
            return f"Protected directory, cannot delete: {target.name}"

        return _safe_trash(target)

    except PermissionError:
        return f"Permission denied: {path}"
    except Exception as e:
        return f"Could not delete: {e}"


def _get_safe_destination(dest_dir: Path, filename: str) -> tuple[Path, bool]:
    """
    Step 2: Verify destination folder exists and handle duplicate file names safely
    without overwriting data by appending (1), (2), etc.
    Returns (safe_path, was_renamed).
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / filename
    if not target.exists():
        return target, False

    stem = Path(filename).stem
    suffix = Path(filename).suffix
    counter = 1
    while True:
        candidate = dest_dir / f"{stem} ({counter}){suffix}"
        if not candidate.exists():
            return candidate, True
        counter += 1


def organize_files(
    path: str = "downloads",
    destination: str = "",
    extension: str = "",
    pattern: str = "",
    by_type: bool = False
) -> str:
    """
    [MODULE: FILE & OS SYSTEM MANAGEMENT]
    Step 1: For file organization (e.g., moving all PDFs in Downloads to a new folder),
    DO NOT drag files one by one with the mouse. Use file_controller Python background
    operations for instant execution.
    Step 2: Verify that destination folders exist and handle duplicate file names safely.
    Step 4: Report the exact count of moved/modified files back to the user.
    """
    try:
        src_dir = _resolve_path(path)
        if not _is_safe_path(src_dir):
            return f"Access denied: {src_dir}"
        if not src_dir.exists():
            return f"Source path not found: {path}"
        if not src_dir.is_dir():
            return f"Source is not a directory: {path}"

        norm_ext = extension.strip().lower()
        if norm_ext and not norm_ext.startswith("."):
            norm_ext = f".{norm_ext}"

        # Categorize by file type if requested or when no explicit destination/extension is given
        if by_type or (not destination and not norm_ext and not pattern):
            type_map = {
                "Documents": {".pdf", ".doc", ".docx", ".txt", ".xls", ".xlsx", ".ppt", ".pptx", ".csv", ".odt", ".ods", ".odp"},
                "Images":    {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg", ".ico", ".heic"},
                "Videos":    {".mp4", ".avi", ".mkv", ".mov", ".wmv", ".flv", ".webm", ".m4v"},
                "Music":     {".mp3", ".wav", ".flac", ".aac", ".ogg", ".wma", ".m4a"},
                "Archives":  {".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz"},
                "Code":      {".py", ".js", ".ts", ".html", ".css", ".json", ".xml", ".cpp", ".java", ".cs", ".go", ".rs", ".sh"},
            }
            moved = []
            renamed_count = 0
            for item in sorted(src_dir.iterdir()):
                if item.is_dir() or item.name.startswith("."):
                    continue
                if item.name in type_map or item.name == "Others":
                    continue

                item_ext = item.suffix.lower()
                target_folder_name = "Others"
                for folder, exts in type_map.items():
                    if item_ext in exts:
                        target_folder_name = folder
                        break

                dest_dir = src_dir / target_folder_name
                safe_dst, was_renamed = _get_safe_destination(dest_dir, item.name)
                if was_renamed:
                    renamed_count += 1
                shutil.move(str(item), str(safe_dst))
                moved.append(f"{item.name} -> {target_folder_name}/{safe_dst.name}")

            report = f"Organized {src_dir.name}/: {len(moved)} file(s) moved across categories."
            if renamed_count > 0:
                report += f" ({renamed_count} duplicate file(s) safely renamed to prevent overwriting)."
            return report

        # Organize by specific destination folder and/or extension/pattern
        if not destination:
            folder_hint = norm_ext.lstrip(".") if norm_ext else "Organized"
            dest_dir = src_dir / folder_hint.upper()
        else:
            dest_dir = _resolve_path(destination)

        if not _is_safe_path(dest_dir):
            return f"Access denied (destination): {dest_dir}"

        dest_dir.mkdir(parents=True, exist_ok=True)

        matching_files: list[Path] = []
        for item in sorted(src_dir.iterdir()):
            if item.is_dir() or item.name.startswith("."):
                continue
            if norm_ext and item.suffix.lower() != norm_ext:
                continue
            if pattern:
                if not fnmatch.fnmatch(item.name.lower(), pattern.lower()):
                    continue
            matching_files.append(item)

        if not matching_files:
            filter_desc = f"with extension '{norm_ext}'" if norm_ext else (f"matching '{pattern}'" if pattern else "")
            return f"No files {filter_desc} found in {src_dir.name}/."

        moved_count = 0
        renamed_count = 0
        details = []

        for item in matching_files:
            safe_dst, was_renamed = _get_safe_destination(dest_dir, item.name)
            if was_renamed:
                renamed_count += 1
            shutil.move(str(item), str(safe_dst))
            moved_count += 1
            if len(details) < 8:
                rename_flag = " (renamed to avoid overwrite)" if was_renamed else ""
                details.append(f"  - {item.name} -> {safe_dst.name}{rename_flag}")

        msg = f"Successfully moved {moved_count} file(s) from {src_dir.name}/ to {dest_dir.name}/."
        if renamed_count > 0:
            msg += f"\nSafe collision avoidance: {renamed_count} duplicate name(s) renamed without overwriting."
        if details:
            msg += "\n" + "\n".join(details)
            if moved_count > len(details):
                msg += f"\n  ... and {moved_count - len(details)} more."

        return msg
    except Exception as e:
        return f"Could not organize files: {e}"


def move_file(path: str, name: str = "", destination: str = "", extension: str = "") -> str:
    try:
        # Check for bulk wildcard / extension move
        if (name and ("*" in name or "?" in name)) or extension:
            return organize_files(
                path=path,
                destination=destination,
                extension=extension,
                pattern=name if ("*" in name or "?" in name) else ""
            )

        base   = _resolve_path(path)
        src    = (base / name) if name else base
        dst    = _resolve_path(destination) if destination else None

        if not src.exists():
            return f"Source not found: {src.name}"
        if dst is None:
            return "No destination specified."
        if not _is_safe_path(src):
            return f"Access denied (source): {src}"
        if not _is_safe_path(dst):
            return f"Access denied (destination): {dst}"

        if dst.is_dir():
            target_dst, was_renamed = _get_safe_destination(dst, src.name)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.exists():
                target_dst, was_renamed = _get_safe_destination(dst.parent, dst.name)
            else:
                target_dst, was_renamed = dst, False

        shutil.move(str(src), str(target_dst))
        rename_note = " (renamed to avoid overwrite)" if was_renamed else ""
        return f"Moved: {src.name} -> {target_dst.parent.name}/{target_dst.name}{rename_note}"

    except Exception as e:
        return f"Could not move: {e}"


def copy_file(path: str, name: str = "", destination: str = "") -> str:
    try:
        base = _resolve_path(path)
        src  = (base / name) if name else base
        dst  = _resolve_path(destination) if destination else None

        if not src.exists():
            return f"Source not found: {src.name}"
        if dst is None:
            return "No destination specified."
        if not _is_safe_path(src):
            return f"Access denied (source): {src}"
        if not _is_safe_path(dst):
            return f"Access denied (destination): {dst}"

        if dst.is_dir():
            target_dst, was_renamed = _get_safe_destination(dst, src.name)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.exists():
                target_dst, was_renamed = _get_safe_destination(dst.parent, dst.name)
            else:
                target_dst, was_renamed = dst, False

        if src.is_dir():
            shutil.copytree(str(src), str(target_dst))
        else:
            shutil.copy2(str(src), str(target_dst))

        rename_note = " (renamed to avoid overwrite)" if was_renamed else ""
        return f"Copied: {src.name} -> {target_dst.parent.name}/{target_dst.name}{rename_note}"

    except Exception as e:
        return f"Could not copy: {e}"


def rename_file(path: str, name: str = "", new_name: str = "") -> str:
    try:
        base     = _resolve_path(path)
        target   = (base / name) if name else base
        if not _is_safe_path(target):
            return f"Access denied: {target}"
        if not target.exists():
            return f"Not found: {target.name}"
        if not new_name:
            return "No new name provided."

        new_path = target.parent / new_name
        if new_path.exists():
            return f"A file named '{new_name}' already exists here."

        target.rename(new_path)
        return f"Renamed: {target.name} → {new_name}"

    except Exception as e:
        return f"Could not rename: {e}"


def read_file(path: str, name: str = "", max_chars: int = 4000) -> str:
    try:
        base   = _resolve_path(path)
        target = (base / name) if name else base
        if not _is_safe_path(target):
            return f"Access denied: {target}"
        if not target.exists():
            return f"File not found: {target.name}"
        if not target.is_file():
            return f"Not a file: {target.name}"

        content = target.read_text(encoding="utf-8", errors="ignore")
        if len(content) > max_chars:
            content = content[:max_chars] + f"\n\n[Truncated — {len(content)} total chars]"
        return content

    except Exception as e:
        return f"Could not read file: {e}"


def write_file(path: str, name: str = "", content: str = "",
               append: bool = False) -> str:
    try:
        base   = _resolve_path(path)
        target = (base / name) if name else base
        if not _is_safe_path(target):
            return f"Access denied: {target}"
        target.parent.mkdir(parents=True, exist_ok=True)
        mode = "a" if append else "w"
        with open(target, mode, encoding="utf-8") as f:
            f.write(content)
        action = "Appended to" if append else "Written to"
        return f"{action}: {target.name}"
    except Exception as e:
        return f"Could not write file: {e}"


def find_files(name: str = "", extension: str = "",
               path: str = "home", max_results: int = 20) -> str:
    try:
        search_path = _resolve_path(path)
        if not _is_safe_path(search_path):
            return f"Access denied: {search_path}"
        if not search_path.exists():
            return f"Search path not found: {path}"

        results    = []
        dir_count  = 0
        max_dirs   = 500  # performans + güvenlik limiti

        for item in search_path.rglob("*"):
            if item.is_dir():
                dir_count += 1
                if dir_count > max_dirs:
                    break
                continue
            if not item.is_file():
                continue
            if extension and item.suffix.lower() != extension.lower():
                continue
            if name and name.lower() not in item.name.lower():
                continue
            size = _format_size(item.stat().st_size)
            results.append(f"📄 {item.name} ({size}) — {item.parent}")
            if len(results) >= max_results:
                break

        if not results:
            query = name or extension or "files"
            return f"No {query} found in {search_path.name}/"

        return f"Found {len(results)} file(s):\n" + "\n".join(results)

    except Exception as e:
        return f"Search error: {e}"


def get_largest_files(path: str = "downloads", count: int = 10) -> str:
    count = min(count, 50)  # maksimum 50
    try:
        search_path = _resolve_path(path)
        if not _is_safe_path(search_path):
            return f"Access denied: {search_path}"
        if not search_path.exists():
            return f"Path not found: {path}"

        files = []
        for item in search_path.rglob("*"):
            if item.is_file():
                try:
                    files.append((item.stat().st_size, item))
                except Exception:
                    continue

        files.sort(reverse=True)
        top = files[:count]

        if not top:
            return "No files found."

        lines = [f"Top {len(top)} largest files in {search_path.name}/:"]
        for size, f in top:
            lines.append(f"  {_format_size(size):>10}  {f.name}  ({f.parent})")

        return "\n".join(lines)

    except Exception as e:
        return f"Error: {e}"


def get_disk_usage(path: str = "home") -> str:
    try:
        target = _resolve_path(path)
        usage  = shutil.disk_usage(target)
        pct    = usage.used / usage.total * 100
        return (
            f"Disk usage ({target}):\n"
            f"  Total : {_format_size(usage.total)}\n"
            f"  Used  : {_format_size(usage.used)} ({pct:.1f}%)\n"
            f"  Free  : {_format_size(usage.free)}"
        )
    except Exception as e:
        return f"Could not get disk usage: {e}"


def organize_desktop() -> str:
    type_map = {
        "Images":    {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg", ".ico", ".heic"},
        "Documents": {".pdf", ".doc", ".docx", ".txt", ".xls", ".xlsx",
                      ".ppt", ".pptx", ".csv", ".odt", ".ods", ".odp"},
        "Videos":    {".mp4", ".avi", ".mkv", ".mov", ".wmv", ".flv", ".webm", ".m4v"},
        "Music":     {".mp3", ".wav", ".flac", ".aac", ".ogg", ".wma", ".m4a"},
        "Archives":  {".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz"},
        "Code":      {".py", ".js", ".ts", ".html", ".css", ".json", ".xml",
                      ".cpp", ".java", ".cs", ".go", ".rs", ".sh"},
    }

    desktop = _get_desktop()
    moved, skipped = [], []

    try:
        for item in desktop.iterdir():
            # Klasörlere, gizli dosyalara ve organize klasörlerine dokunma
            if item.is_dir() or item.name.startswith("."):
                continue
            if item.name in {k for k in type_map}:
                continue

            ext        = item.suffix.lower()
            target_dir = desktop / "Others"
            for folder, exts in type_map.items():
                if ext in exts:
                    target_dir = desktop / folder
                    break

            target_dir.mkdir(exist_ok=True)
            new_path = target_dir / item.name

            if new_path.exists():
                skipped.append(item.name)
                continue

            shutil.move(str(item), str(new_path))
            moved.append(f"{item.name} → {target_dir.name}/")

        result = f"Desktop organized: {len(moved)} files moved."
        if moved:
            preview = moved[:8]
            result += "\n" + "\n".join(preview)
            if len(moved) > 8:
                result += f"\n... and {len(moved) - 8} more."
        if skipped:
            result += f"\n{len(skipped)} file(s) skipped (name conflict)."
        return result

    except Exception as e:
        return f"Could not organize desktop: {e}"


def get_file_info(path: str, name: str = "") -> str:
    try:
        base   = _resolve_path(path)
        target = (base / name) if name else base
        if not _is_safe_path(target):
            return f"Access denied: {target}"
        if not target.exists():
            return f"Not found: {target.name}"

        stat = target.stat()
        info = {
            "Name":      target.name,
            "Type":      "Folder" if target.is_dir() else "File",
            "Size":      _format_size(stat.st_size),
            "Location":  str(target.parent),
            "Created":   datetime.fromtimestamp(stat.st_ctime).strftime("%Y-%m-%d %H:%M"),
            "Modified":  datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M"),
            "Extension": target.suffix or "—",
        }
        return "\n".join(f"  {k}: {v}" for k, v in info.items())

    except Exception as e:
        return f"Could not get file info: {e}"

def file_controller(
    parameters: dict = None,
    response=None,
    player=None,
    session_memory=None,
) -> str:
    params = parameters or {}
    action = params.get("action", "").lower().strip()
    path   = params.get("path", "desktop")
    name   = params.get("name", "")

    if player:
        player.write_log(f"[file] {action} {name or path}")

    try:
        if action == "list":
            return list_files(path)

        elif action == "create_file":
            return create_file(path, name=name, content=params.get("content", ""))

        elif action in ("create_folder", "mkdir", "new_folder"):
            return create_folder(path, name=name, open_after=params.get("open_after", False))

        elif action == "delete":
            return delete_file(path, name=name)

        elif action == "move":
            return move_file(
                path,
                name=name,
                destination=params.get("destination", ""),
                extension=params.get("extension", "")
            )

        elif action in ("organize", "organize_files", "bulk_move", "organize_folder"):
            return organize_files(
                path=path,
                destination=params.get("destination", ""),
                extension=params.get("extension", ""),
                pattern=params.get("pattern", name),
                by_type=params.get("by_type", False),
            )

        elif action == "copy":
            return copy_file(path, name=name, destination=params.get("destination", ""))

        elif action == "rename":
            return rename_file(path, name=name, new_name=params.get("new_name", ""))

        elif action == "read":
            return read_file(path, name=name)

        elif action == "write":
            return write_file(
                path, name=name,
                content=params.get("content", ""),
                append=params.get("append", False)
            )

        elif action == "find":
            return find_files(
                name=name or params.get("name", ""),
                extension=params.get("extension", ""),
                path=path,
                max_results=min(int(params.get("max_results", 20)), 50),
            )

        elif action == "largest":
            return get_largest_files(
                path=path,
                count=int(params.get("count", 10)),
            )

        elif action == "disk_usage":
            return get_disk_usage(path)

        elif action == "organize_desktop":
            return organize_desktop()

        elif action == "info":
            return get_file_info(path, name=name)

        else:
            return f"Unknown action: '{action}'"

    except Exception as e:
        return f"File controller error ({action}): {e}"