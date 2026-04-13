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


def append_to_file(file_path, code_to_append):
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

    # Check if already initialized
    if "botversion_sdk" in content or "botversion-sdk" in content:
        return {"success": False, "reason": "already_exists"}

    # Backup FIRST before any changes
    backup = backup_file(file_path)

    # Split imports from non-import lines
    import_lines = []
    non_import_lines = []

    for line in code_to_inject.split("\n"):
        stripped = line.strip()
        # Only treat as a top-level import if it has no indentation
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
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    if "botversion_sdk" in content or "botversion-sdk" in content:
        return {"success": False, "reason": "already_exists"}

    # ── Backup FIRST before any changes ──────────────────────────────────
    backup = backup_file(file_path)

    # ── Step 1: Strip import lines from code_to_inject ────────────────────
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

    # ── Step 2: Inject the rest after get_wsgi_application() ─────────────
    lines = content.split("\n")
    wsgi_line_index = -1

    for i, line in enumerate(lines):
        if re.search(r"(application|app)\s*=\s*get_(wsgi|asgi)_application\s*\(", line):
            wsgi_line_index = i
            break

    if wsgi_line_index == -1:
        return {"success": False, "reason": "no_wsgi_call", "suggestion": "append"}

    init_block = "\n".join(non_import_lines).strip()

    before = lines[:wsgi_line_index + 1]
    after = lines[wsgi_line_index + 1:]
    injected_lines = [""] + init_block.split("\n") + [""]
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
    last_import_index = -1  # ← was 0, now -1 meaning "not found"
    for i, line in enumerate(lines):
        if line.startswith("import ") or line.startswith("from "):
            last_import_index = i

    if last_import_index == -1:
        insert_index = 0
        in_docstring = False
        for i, line in enumerate(lines):
            stripped = line.strip()
            # Track multiline docstrings
            if stripped.startswith('"""') or stripped.startswith("'''"):
                if in_docstring:
                    in_docstring = False  # closing
                    insert_index = i + 1
                    continue
                elif not stripped.endswith('"""') or len(stripped) == 3:
                    in_docstring = True  # opening
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
        # Insert after last import
        before = lines[:last_import_index + 1]
        after = lines[last_import_index + 1:]

    new_content = "\n".join(before + [import_line] + after)

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(new_content)

    return {"success": True}


# ── Inject into Django urls.py ────────────────────────────────────────────────

def inject_django_url(urls_path, url_code):
    """
    Adds the BotVersion chat URL to Django's urls.py.
    Django-specific — no JS equivalent.
    """
    try:
        with open(urls_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    if "botversion" in content:
        return {"success": False, "reason": "already_exists"}

    if "import botversion_sdk" not in content:
        inject_import(urls_path, "import botversion_sdk")
        with open(urls_path, "r", encoding="utf-8") as f:
           content = f.read()

    # Find the urlpatterns list closing bracket
    lines = content.split("\n")
    urlpatterns_end = -1

    in_urlpatterns = False
    bracket_depth = 0

    for i, line in enumerate(lines):
        if re.search(r"urlpatterns\s*=\s*\[", line):
            in_urlpatterns = True
            bracket_depth = 1
            continue
        if in_urlpatterns:
            bracket_depth += line.count("[") - line.count("]")
            if bracket_depth <= 0:
                urlpatterns_end = i
                break

    if urlpatterns_end == -1:
        # Fallback: append to end of file
        backup = backup_file(urls_path)
        new_content = content.rstrip() + "\n\n" + url_code + "\n"
        with open(urls_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        return {"success": True, "backup": backup, "method": "append"}

    # Insert before the closing bracket
    before = lines[:urlpatterns_end]
    after = lines[urlpatterns_end:]
    injected = [url_code]
    new_content = "\n".join(before + [""] + injected + [""] + after)

    backup = backup_file(urls_path)
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

    # Already exists check
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