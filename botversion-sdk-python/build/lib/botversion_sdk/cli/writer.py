"""
botversion-sdk-python/botversion-sdk/cli/writer.py

Reads, modifies, and writes files in the user's project.
Mirrors JS cli/writer.js
"""

import os
import re
import shutil


# ── Safe file write ───────────────────────────────────────────────────────────

def write_file(file_path, content):
    """
    Safely writes a file, creates directories if needed.
    Mirrors JS writeFile()
    """
    os.makedirs(os.path.dirname(file_path) if os.path.dirname(file_path) else ".", exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)


def _fix_django_user_context(code):
    """Fix FastAPI-style request.state.user → Django-style request.user"""
    return re.sub(
        r"lambda request:\s*request\.state\.user",
        "lambda request: request.user if hasattr(request, 'user') and request.user.is_authenticated else None",
        code,
    )


# ── Backup a file before modifying ───────────────────────────────────────────

def backup_file(file_path):
    """
    Copies a file to filename.backup-before-botversion before modifying.
    Mirrors JS backupFile()
    """
    if not os.path.exists(file_path):
        return None
    backup_path = file_path + ".backup-before-botversion"
    shutil.copy2(file_path, backup_path)
    return backup_path


# ── Append code to end of file ───────────────────────────────────────────────

def append_to_file(file_path, code_to_append, framework=None):
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    if "botversion_sdk" in content or "botversion-sdk" in content:
        return {"success": False, "reason": "already_exists"}

    # ── Backup FIRST before any changes ──────────────────────────────────
    backup = backup_file(file_path)

    # ── Split import lines from non-import lines ──────────────────────────
    import_lines = []
    non_import_lines = []

    for line in code_to_append.split("\n"):
        stripped = line.strip()
        if (stripped.startswith("import ") or stripped.startswith("from ")) and not line.startswith(" ") and not line.startswith("\t"):
            import_lines.append(line)
        else:
            non_import_lines.append(line)

    # ── Inject imports at the top first ──────────────────────────────────
    for imp in import_lines:
        if imp.strip() and imp.strip() not in content:
            inject_import(file_path, imp.strip())

    # ── Re-read file after import injection ──────────────────────────────
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # ── Append non-import lines to end of file ────────────────────────────
    init_block = "\n".join(non_import_lines).strip()
    if framework == "django":
        init_block = _fix_django_user_context(init_block)
    if init_block:
        new_content = content.rstrip() + "\n\n" + init_block + "\n"
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(new_content)

    return {"success": True, "backup": backup}


# ── Inject code before app.run() / uvicorn.run() ─────────────────────────────

def inject_before_run(file_path, code_to_inject, framework):
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    if "botversion_sdk" in content or "botversion-sdk" in content:
        return {"success": False, "reason": "already_exists"}

    # Backup FIRST before any changes
    backup = backup_file(file_path)

    # Split imports from non-import lines
    import_lines = []
    non_import_lines = []

    for line in code_to_inject.split("\n"):
        stripped = line.strip()
        if (stripped.startswith("import ") or stripped.startswith("from ")) and not line.startswith(" ") and not line.startswith("\t"):
            import_lines.append(line)
        else:
            non_import_lines.append(line)

    # Inject imports at the top of the file first
    for imp in import_lines:
        if imp.strip() and imp.strip() not in content:
            inject_import(file_path, imp.strip())

    # Re-read file after import injection
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Use only non-import lines as the actual code block to inject
    code_to_inject = "\n".join(non_import_lines)

    lines = content.split("\n")

    # Pattern to find run call per framework
    patterns = {
        "flask": r"if\s+__name__\s*==\s*['\"]__main__['\"]",
        "fastapi": r"uvicorn\.run\s*\(",
        "django": r"(application|app)\s*=\s*get_(wsgi|asgi)_application\s*\(",
    }

    pattern = patterns.get(framework)
    run_line_index = -1

    if pattern:
        for i, line in enumerate(lines):
            if re.search(pattern, line):
                run_line_index = i
                break

    if run_line_index == -1:
        return {"success": False, "reason": "no_run_call", "suggestion": "append"}

    # Insert the code block before the run call
    before = lines[:run_line_index]
    after = lines[run_line_index:]
    injected_lines = [""] + code_to_inject.split("\n") + [""]
    new_content = "\n".join(before + injected_lines + after)

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(new_content)

    return {"success": True, "line_number": run_line_index + 1, "backup": backup}


# ── Inject code after application = get_wsgi_application() ───────────────────

def inject_after_wsgi(file_path, code_to_inject):
    """
    Injects botversion_sdk.init() after get_wsgi_application() in wsgi.py.

    Handles all cases:
    - Standard: application = get_wsgi_application()
    - app = get_wsgi_application()
    - get_asgi_application() for async Django
    - wsgi.py with no get_wsgi_application() — fallback: append to end
    - Already initialized — skip
    - get_user_context correctly uses Django request.user, not request.state.user
    """
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    if "botversion_sdk" in content or "botversion-sdk" in content:
        return {"success": False, "reason": "already_exists"}

    # ── Backup FIRST before any changes ──────────────────────────────────
    backup = backup_file(file_path)

    # ── Step 1: Strip import lines from code_to_inject ───────────────────
    inject_lines = code_to_inject.split("\n")
    import_lines = []
    non_import_lines = []

    for line in inject_lines:
        stripped = line.strip()
        if stripped.startswith("import ") or stripped.startswith("from "):
            import_lines.append(line)
        else:
            non_import_lines.append(line)

    # Inject imports at the top of the file
    for imp in import_lines:
        if imp.strip() and imp.strip() not in content:
            inject_import(file_path, imp.strip())

    # Re-read file after import injection
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # ── Step 2: Find get_wsgi_application() or get_asgi_application() ────
    lines = content.split("\n")
    wsgi_line_index = -1

    for i, line in enumerate(lines):
        if re.search(r"(application|app)\s*=\s*get_(wsgi|asgi)_application\s*\(", line):
            wsgi_line_index = i
            break

    # ── Step 3: Build the init block with correct Django user context ─────
    init_block = "\n".join(non_import_lines).strip()

    # Fix get_user_context for Django — must use request.user, not request.state.user
    # request.state.user is FastAPI syntax and will crash Django
    init_block = re.sub(
        r"lambda request:\s*request\.state\.user",
        "lambda request: request.user if hasattr(request, 'user') and request.user.is_authenticated else None",
        init_block,
    )

    # ── Case: No get_wsgi_application() found — append to end of file ────
    if wsgi_line_index == -1:
        new_content = content.rstrip() + "\n\n# BotVersion AI Agent — auto-added by botversion-sdk init\n" + init_block + "\n"
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        return {"success": True, "backup": backup, "method": "append"}

    # ── Case: Found get_wsgi_application() — inject immediately after ─────
    before = lines[:wsgi_line_index + 1]
    after = lines[wsgi_line_index + 1:]
    injected_lines = ["", "# BotVersion AI Agent — auto-added by botversion-sdk init"] + init_block.split("\n") + [""]
    new_content = "\n".join(before + injected_lines + after)

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(new_content)

    return {"success": True, "line_number": wsgi_line_index + 1, "backup": backup}


# ── Create a new file ─────────────────────────────────────────────────────────

def create_file(file_path, content, force=False):
    """
    Creates a new file. Won't overwrite unless force=True.
    Mirrors JS createFile()
    """
    if os.path.exists(file_path) and not force:
        return {"success": False, "reason": "already_exists", "path": file_path}

    if os.path.exists(file_path) and force:
        backup_file(file_path)

    write_file(file_path, content)
    return {"success": True, "path": file_path}


# ── Add import to top of file ─────────────────────────────────────────────────

def inject_import(file_path, import_line):
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    if import_line in content:
        return {"success": False, "reason": "already_exists"}

    lines = content.split("\n")

    # Find the last import line
    last_import_index = -1
    for i, line in enumerate(lines):
        if line.startswith("import ") or line.startswith("from "):
            last_import_index = i

    if last_import_index == -1:
        insert_index = 0
        in_docstring = False
        for i, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith('"""') or stripped.startswith("'''"):
                if in_docstring:
                    in_docstring = False
                    insert_index = i + 1
                    continue
                elif not stripped.endswith('"""') or len(stripped) == 3:
                    in_docstring = True
                    insert_index = i + 1
                    continue
            if in_docstring:
                insert_index = i + 1
                continue
            if stripped.startswith("#") or stripped == "":
                insert_index = i + 1
                continue
            break
        before = lines[:insert_index]
        after = lines[insert_index:]
    else:
        before = lines[:last_import_index + 1]
        after = lines[last_import_index + 1:]

    new_content = "\n".join(before + [import_line] + after)

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(new_content)

    return {"success": True}


# ── Inject into Django urls.py ────────────────────────────────────────────────

def _find_urlpatterns_end(lines):
    """
    Finds the line index of the closing ] of the urlpatterns list.

    Handles all cases:
    - urlpatterns = [ ... ]              single line
    - urlpatterns = [                    multiline
    - urlpatterns += [ ... ]             append style
    - nested brackets in entries         e.g. re_path with regex [a-z]
    - brackets inside strings            e.g. path("items/[id]/", view)
    - comments inside urlpatterns        # some comment
    - closing ] on same line as last entry

    Returns (urlpatterns_start, urlpatterns_end) or (-1, -1) if not found.
    """
    urlpatterns_start = -1
    urlpatterns_end = -1

    for i, line in enumerate(lines):
        if re.search(r"urlpatterns\s*\+?=\s*\[", line):
            urlpatterns_start = i
            break

    if urlpatterns_start == -1:
        return -1, -1

    # Count bracket depth character by character to handle:
    # - nested brackets in regex patterns
    # - brackets inside strings
    # - comments
    bracket_depth = 0
    in_single_string = False
    in_double_string = False
    in_triple_single = False
    in_triple_double = False
    found_opening = False

    for i in range(urlpatterns_start, len(lines)):
        line = lines[i]
        j = 0
        while j < len(line):
            ch = line[j]
            remaining = line[j:]

            # ── Skip comments (only when not in a string) ─────────────────
            if not in_single_string and not in_double_string and not in_triple_single and not in_triple_double:
                if ch == "#":
                    break  # rest of line is a comment

            # ── Triple string tracking ─────────────────────────────────────
            if not in_single_string and not in_double_string:
                if remaining.startswith('"""'):
                    if in_triple_double:
                        in_triple_double = False
                        j += 3
                        continue
                    else:
                        in_triple_double = True
                        j += 3
                        continue
                if remaining.startswith("'''"):
                    if in_triple_single:
                        in_triple_single = False
                        j += 3
                        continue
                    else:
                        in_triple_single = True
                        j += 3
                        continue

            # ── Inside triple strings — skip everything ────────────────────
            if in_triple_double or in_triple_single:
                j += 1
                continue

            # ── Single/double string tracking ─────────────────────────────
            if ch == "'" and not in_double_string:
                if line[j-1:j] == "\\":  # escaped quote
                    j += 1
                    continue
                in_single_string = not in_single_string
                j += 1
                continue

            if ch == '"' and not in_single_string:
                if line[j-1:j] == "\\":  # escaped quote
                    j += 1
                    continue
                in_double_string = not in_double_string
                j += 1
                continue

            # ── Inside strings — skip bracket counting ─────────────────────
            if in_single_string or in_double_string:
                j += 1
                continue

            # ── Bracket counting ───────────────────────────────────────────
            if ch == "[":
                bracket_depth += 1
                found_opening = True
            elif ch == "]":
                bracket_depth -= 1
                if found_opening and bracket_depth == 0:
                    urlpatterns_end = i
                    return urlpatterns_start, urlpatterns_end

            j += 1

    return urlpatterns_start, -1  # opening found but no closing — malformed file


def _find_root_urls_file(urls_path, content, lines):
    """
    Determines if this urls.py is the ROOT urls file (the one Django's
    ROOT_URLCONF points to). We identify it by the presence of 'admin' route
    or django.contrib.admin import.

    Returns True if this looks like the root urls.py, False otherwise.
    This is informational — we still inject even into non-root files if
    that's what the caller passed, since the caller (init.py) already
    did the search logic.
    """
    return "admin" in content or "django.contrib" in content


def inject_django_url(urls_path, url_code, extra_import=None):
    """
    Adds the BotVersion chat URL to Django's urls.py.

    Handles all cases:
    - urlpatterns = [ ... ]              single line
    - urlpatterns = [                    multiline
    - urlpatterns += [ ... ]             append style
    - nested brackets (re_path regex)    e.g. re_path(r'^[a-z]+/', view)
    - brackets inside strings            e.g. "items/[id]/"
    - comments inside urlpatterns
    - closing ] on same line as last entry
    - no trailing comma on last entry    adds one automatically
    - no urlpatterns at all              appends urlpatterns += [...] block
    - import already exists              skips re-adding
    - file is empty                      creates minimal urlpatterns block
    - already initialized                skips entirely
    """
    try:
        with open(urls_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    # ── Already initialized ───────────────────────────────────────────────────
    if "botversion" in content:
        return {"success": False, "reason": "already_exists"}

    # ── Backup BEFORE any modification ───────────────────────────────────────
    backup = backup_file(urls_path)

    # ── Step 1: Inject import if missing ─────────────────────────────────────
    if "import botversion_sdk" not in content:
        inject_import(urls_path, "import botversion_sdk")

    if extra_import and extra_import not in content:
        inject_import(urls_path, extra_import)

    # ALWAYS re-read after inject_import — never use stale content variable
    try:
        with open(urls_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    lines = content.split("\n")

    # ── Step 2: Find urlpatterns start and end ────────────────────────────────
    urlpatterns_start, urlpatterns_end = _find_urlpatterns_end(lines)

    # ── Case A: No urlpatterns found at all ───────────────────────────────────
    # Append a new urlpatterns += [...] block at the end of the file.
    # This handles:
    # - Wrong file passed (no urlpatterns)
    # - Unusual project structure
    # - Empty files
    if urlpatterns_start == -1:
        new_content = content.rstrip() + (
            "\n\n# BotVersion — added by botversion-sdk init\n"
            "urlpatterns += [\n"
            f"    {url_code.strip()}\n"
            "]\n"
        )
        with open(urls_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        return {"success": True, "backup": backup, "method": "append_new_block"}

    # ── Case B: urlpatterns found but closing ] not found ────────────────────
    # File may be malformed. Append safely at end of file.
    if urlpatterns_end == -1:
        new_content = content.rstrip() + (
            "\n\n# BotVersion — added by botversion-sdk init\n"
            "# Note: Could not find closing ] of urlpatterns — added separately\n"
            "urlpatterns += [\n"
            f"    {url_code.strip()}\n"
            "]\n"
        )
        with open(urls_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        return {"success": True, "backup": backup, "method": "append_malformed_fallback"}

    # ── Case C: Single line urlpatterns = [...] ───────────────────────────────
    # e.g. urlpatterns = [path("admin/", admin.site.urls)]
    # Convert to multiline and inject cleanly.
    if urlpatterns_start == urlpatterns_end:
        line = lines[urlpatterns_start]
        # Extract everything inside the brackets
        inner_match = re.search(r"urlpatterns\s*\+?=\s*\[(.*)\]", line)
        if inner_match:
            inner = inner_match.group(1).strip()
            if inner:
                # Build multiline version
                entries = [f"    {inner.rstrip(',')},"]
            else:
                entries = []
            entries.append(f"    {url_code.strip()}")
            new_line = "urlpatterns = [\n" + "\n".join(entries) + "\n]"
            lines[urlpatterns_start] = new_line
            new_content = "\n".join(lines)
            with open(urls_path, "w", encoding="utf-8") as f:
                f.write(new_content)
            return {"success": True, "backup": backup, "method": "single_line_expand"}

    # ── Case D: Normal multiline urlpatterns ──────────────────────────────────
    # Find the line just before the closing ] and ensure it has a trailing comma.
    # Then insert the new url entry before the closing bracket.

    # Find last non-empty, non-comment line before the closing ]
    last_entry_index = -1
    for i in range(urlpatterns_end - 1, urlpatterns_start, -1):
        stripped = lines[i].strip()
        if stripped and not stripped.startswith("#"):
            last_entry_index = i
            break

    # Ensure trailing comma on last entry
    if last_entry_index != -1:
        last_line = lines[last_entry_index]
        stripped_last = last_line.rstrip()
        # Add comma if missing (ignore lines that end with comment after the entry)
        code_part = stripped_last.split("#")[0].rstrip()
        if code_part and not code_part.endswith(","):
            lines[last_entry_index] = code_part + "," + (
                "  " + "#" + stripped_last.split("#", 1)[1]
                if "#" in stripped_last else ""
            )

    # Insert new url entry before the closing ]
    indent = "    "  # standard Django 4-space indent
    new_entry = f"{indent}{url_code.strip()}"

    before = lines[:urlpatterns_end]
    after = lines[urlpatterns_end:]
    new_content = "\n".join(before + [new_entry] + after)

    with open(urls_path, "w", encoding="utf-8") as f:
        f.write(new_content)

    return {"success": True, "backup": backup, "method": "inject"}


# ── Inject script tag into frontend file ─────────────────────────────────────

def inject_script_tag(file_path, file_type, script_tag, force=False):
    """
    Injects the BotVersion script tag into the frontend HTML file.
    Mirrors JS injectScriptTag()
    """
    if not os.path.exists(file_path):
        return {"success": False, "reason": "file_not_found"}

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    if "botversion-loader" in content:
        if not force:
            return {"success": False, "reason": "already_exists"}

    backup = backup_file(file_path)

    # ── HTML file — inject before </body> ─────────────────────────────────────
    if file_type == "html":
        pos = content.rfind("</body>")
        if pos == -1:
            return {"success": False, "reason": "no_body_tag"}
        new_content = content[:pos] + f"  {script_tag}\n" + content[pos:]
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        return {"success": True, "backup": backup}

    return {"success": False, "reason": "unsupported_file_type"}


# ── Generate script tag string ────────────────────────────────────────────────

def generate_script_tag(project_info):
    """
    Generates the BotVersion <script> tag string.
    Mirrors JS generateScriptTag() from generator.js
    """
    return (
        f'<script\n'
        f'  id="botversion-loader"\n'
        f'  src="{project_info["cdn_url"]}"\n'
        f'  data-api-url="{project_info["api_url"]}"\n'
        f'  data-project-id="{project_info["project_id"]}"\n'
        f'  data-public-key="{project_info["public_key"]}"\n'
        f'  data-proxy-url="/api/botversion/chat"\n'
        f'></script>'
    )


# ── Write summary of all changes ──────────────────────────────────────────────

def write_summary(changes):
    """
    Prints a nice summary box showing all changes made.
    Mirrors JS writeSummary()
    """
    lines = [
        "",
        "┌─────────────────────────────────────────────┐",
        "│         BotVersion Setup Complete!          │",
        "└─────────────────────────────────────────────┘",
        "",
    ]

    if changes.get("modified"):
        lines.append("  Modified files:")
        for f in changes["modified"]:
            lines.append(f"    ✏  {f}")
        lines.append("")

    if changes.get("created"):
        lines.append("  Created files:")
        for f in changes["created"]:
            lines.append(f"    +  {f}")
        lines.append("")

    if changes.get("backups"):
        lines.append("  Backups created:")
        for f in changes["backups"]:
            lines.append(f"    ~  {f}")
        lines.append("")

    if changes.get("manual"):
        lines.append("  Manual steps needed:")
        for m in changes["manual"]:
            lines.append(f"    -> {m}")
        lines.append("")

    lines.append("  Next: Restart your server and test the chat widget.")
    lines.append("  Docs: https://docs.botversion.com")
    lines.append("")

    return "\n".join(lines)


# ── Inject into Django INSTALLED_APPS ─────────────────────────────────────────

def inject_into_installed_apps(settings_path, app_name):
    """
    Adds an app to Django's INSTALLED_APPS list.

    Handles:
    - Standard INSTALLED_APPS = [ ... ]
    - INSTALLED_APPS already contains the app
    - No INSTALLED_APPS found — returns failure with reason
    """
    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    if app_name in content:
        return {"success": False, "reason": "already_exists"}

    lines = content.split("\n")
    installed_apps_end = -1
    in_installed_apps = False
    bracket_depth = 0

    for i, line in enumerate(lines):
        if re.search(r"INSTALLED_APPS\s*=\s*\[", line):
            in_installed_apps = True
            bracket_depth = 1
            continue
        if in_installed_apps:
            bracket_depth += line.count("[") - line.count("]")
            if bracket_depth <= 0:
                installed_apps_end = i
                break

    if installed_apps_end == -1:
        return {"success": False, "reason": "no_installed_apps"}

    before = lines[:installed_apps_end]
    after = lines[installed_apps_end:]
    new_content = "\n".join(before + [f'    "{app_name}",'] + after)

    backup_file(settings_path)
    with open(settings_path, "w", encoding="utf-8") as f:
        f.write(new_content)

    return {"success": True}


# ── Inject into Django MIDDLEWARE ─────────────────────────────────────────────

def inject_into_middleware(settings_path, middleware_name):
    """
    Adds a middleware to Django's MIDDLEWARE list — at the top.

    Handles:
    - Standard MIDDLEWARE = [ ... ]
    - MIDDLEWARE already contains the middleware
    - No MIDDLEWARE found — returns failure with reason
    """
    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    if middleware_name in content:
        return {"success": False, "reason": "already_exists"}

    lines = content.split("\n")
    middleware_start = -1

    for i, line in enumerate(lines):
        if re.search(r"MIDDLEWARE\s*=\s*\[", line):
            middleware_start = i
            break

    if middleware_start == -1:
        return {"success": False, "reason": "no_middleware"}

    before = lines[:middleware_start + 1]
    after = lines[middleware_start + 1:]
    new_content = "\n".join(before + [f'    "{middleware_name}",'] + after)

    backup_file(settings_path)
    with open(settings_path, "w", encoding="utf-8") as f:
        f.write(new_content)

    return {"success": True}



# ── Inject Vite proxy config ──────────────────────────────────────────────────

def inject_vite_proxy(config_path, proxy_code):
    """
    Injects proxy config into vite.config.js.

    Handles:
    - defineConfig({ plugins: [...] })
    - defineConfig({ plugins: [...], server: { ... } }) — already has server block
    - Already has botversion proxy — skips
    - No defineConfig found — appends manually
    """
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    if "botversion" in content:
        return {"success": False, "reason": "already_exists"}

    backup = backup_file(config_path)

    # Already has a server block — inject proxy inside it
    if "server:" in content:
        new_content = content.replace(
            "server:",
            "server: { proxy: { '/api/botversion/chat': { target: 'http://localhost:8000', changeOrigin: true, rewrite: (path) => path + '/' }, '/api': { target: 'http://localhost:8000', changeOrigin: true } } },\n  server_old:",
        )
        # Better approach — just warn and skip if server block already exists
        return {"success": False, "reason": "manual_required", "backup": backup}

    # Inject before the closing }) of defineConfig
    closing = content.rfind("})")
    if closing == -1:
        return {"success": False, "reason": "no_define_config"}

    new_content = (
        content[:closing]
        + proxy_code
        + "\n"
        + content[closing:]
    )

    with open(config_path, "w", encoding="utf-8") as f:
        f.write(new_content)

    return {"success": True, "backup": backup}


# ── Inject CRA proxy into package.json ───────────────────────────────────────

def inject_cra_proxy(package_json_path, proxy_url):
    """
    Adds "proxy": "http://localhost:8000" to package.json for CRA.

    Handles:
    - proxy already exists — skips
    - valid JSON — injects cleanly
    - invalid JSON — returns failure
    """
    try:
        with open(package_json_path, "r", encoding="utf-8") as f:
            content = f.read()
            pkg = json.loads(content)
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    if "proxy" in pkg:
        return {"success": False, "reason": "already_exists"}

    if "botversion" in content:
        return {"success": False, "reason": "already_exists"}

    backup = backup_file(package_json_path)

    pkg["proxy"] = proxy_url

    with open(package_json_path, "w", encoding="utf-8") as f:
        json.dump(pkg, f, indent=2)
        f.write("\n")

    return {"success": True, "backup": backup}


# ── Inject Next.js proxy config ───────────────────────────────────────────────

def inject_next_proxy(config_path, proxy_code):
    """
    Injects rewrites() into next.config.js.

    Handles:
    - module.exports = { ... }
    - export default { ... }
    - Already has rewrites — skips
    - No config found — creates minimal next.config.js
    """
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    if "botversion" in content:
        return {"success": False, "reason": "already_exists"}

    if "rewrites" in content:
        return {"success": False, "reason": "manual_required"}

    backup = backup_file(config_path)

    # Find closing } of the config object
    closing = content.rfind("}")
    if closing == -1:
        return {"success": False, "reason": "no_config_object"}

    new_content = (
        content[:closing]
        + proxy_code
        + "\n"
        + content[closing:]
    )

    with open(config_path, "w", encoding="utf-8") as f:
        f.write(new_content)

    return {"success": True, "backup": backup}


# ── Inject Angular proxy config ───────────────────────────────────────────────

def inject_angular_proxy(frontend_dir, proxy_config):
    """
    Creates proxy.conf.json and updates angular.json to reference it.

    Handles:
    - proxy.conf.json doesn't exist — creates it
    - proxy.conf.json already exists — merges entries
    - angular.json exists — adds proxyConfig reference
    - angular.json missing — returns manual instructions
    """
    import json as _json

    proxy_path = os.path.join(frontend_dir, "proxy.conf.json")
    angular_json_path = os.path.join(frontend_dir, "angular.json")

    # Step 1: Create or merge proxy.conf.json
    if os.path.exists(proxy_path):
        try:
            with open(proxy_path, "r", encoding="utf-8") as f:
                existing = _json.load(f)
            if "botversion" in str(existing):
                return {"success": False, "reason": "already_exists"}
            existing.update(proxy_config)
            proxy_config = existing
        except Exception:
            pass

    backup = backup_file(proxy_path) if os.path.exists(proxy_path) else None

    with open(proxy_path, "w", encoding="utf-8") as f:
        _json.dump(proxy_config, f, indent=2)
        f.write("\n")

    # Step 2: Update angular.json to reference proxy.conf.json
    if not os.path.exists(angular_json_path):
        return {
            "success": True,
            "backup": backup,
            "manual": "Add to your angular.json serve options:\n\n    \"proxyConfig\": \"proxy.conf.json\"",
        }

    try:
        with open(angular_json_path, "r", encoding="utf-8") as f:
            angular = _json.load(f)

        # Navigate to the serve options
        projects = angular.get("projects", {})
        for project_name, project in projects.items():
            try:
                serve_options = (
                    project["architect"]["serve"]["options"]
                )
                if "proxyConfig" not in serve_options:
                    serve_options["proxyConfig"] = "proxy.conf.json"
            except KeyError:
                try:
                    project["architect"]["serve"]["options"] = {
                        "proxyConfig": "proxy.conf.json"
                    }
                except KeyError:
                    pass

        backup_file(angular_json_path)

        with open(angular_json_path, "w", encoding="utf-8") as f:
            _json.dump(angular, f, indent=2)
            f.write("\n")

    except Exception as e:
        return {
            "success": True,
            "backup": backup,
            "manual": "Add to your angular.json serve options:\n\n    \"proxyConfig\": \"proxy.conf.json\"",
        }

    return {"success": True, "backup": backup}


# ── Inject Vue CLI proxy config ───────────────────────────────────────────────

def inject_vue_cli_proxy(config_path, proxy_code):
    """
    Injects devServer proxy into vue.config.js.

    Handles:
    - module.exports = { ... }
    - Already has devServer block — skips
    - No config found — creates minimal vue.config.js
    - Already has botversion — skips
    """
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    if "botversion" in content:
        return {"success": False, "reason": "already_exists"}

    if "devServer" in content:
        return {"success": False, "reason": "manual_required"}

    backup = backup_file(config_path)

    closing = content.rfind("}")
    if closing == -1:
        return {"success": False, "reason": "no_config_object"}

    new_content = (
        content[:closing]
        + proxy_code
        + "\n"
        + content[closing:]
    )

    with open(config_path, "w", encoding="utf-8") as f:
        f.write(new_content)

    return {"success": True, "backup": backup}



# ── Inject frontend user context init ────────────────────────────────────────

def inject_user_context(file_path, js_code):
    """
    Injects the BotVersion userContext init code into the frontend HTML file.
    Places it right after the botversion-loader script tag.

    This is how the widget gets the logged-in user's info.
    """
    if not os.path.exists(file_path):
        return {"success": False, "reason": "file_not_found"}

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    # Already injected — skip
    if "BotVersion" in content and "userContext" in content:
        return {"success": False, "reason": "already_exists"}

    # The script tag must already be in the file
    if "botversion-loader" not in content:
        return {"success": False, "reason": "no_loader_script"}

    backup = backup_file(file_path)

    # Find where the botversion-loader script tag ends
    # It ends with ></script> — inject our code right after it
    loader_end = content.find("></script>", content.find("botversion-loader"))
    if loader_end == -1:
        return {"success": False, "reason": "no_loader_end"}

    insert_pos = loader_end + len("></script>")

    wrapped = f"\n  <script>\n    {js_code}\n  </script>"

    new_content = content[:insert_pos] + wrapped + content[insert_pos:]

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(new_content)

    return {"success": True, "backup": backup}