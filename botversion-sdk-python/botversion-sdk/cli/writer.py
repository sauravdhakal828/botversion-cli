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


# ── Inject code before app.run() / uvicorn.run() ─────────────────────────────

def inject_before_run(file_path, code_to_inject, framework):
    """
    Finds the server run call and injects code right before it.
    Mirrors JS injectBeforeListen()

    Flask:   app.run(
    FastAPI: uvicorn.run(
    Django:  application = get_wsgi_application()
    """
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    # Check if already initialized
    if "botversion_sdk" in content or "botversion-sdk" in content:
        return {"success": False, "reason": "already_exists"}

    lines = content.split("\n")

    # Pattern to find run call per framework
    patterns = {
        "flask": r"app\.run\s*\(",
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

    backup = backup_file(file_path)
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(new_content)

    return {"success": True, "line_number": run_line_index + 1, "backup": backup}


# ── Inject code after application = get_wsgi_application() ───────────────────

def inject_after_wsgi(file_path, code_to_inject):
    """
    For Django — injects init code AFTER application = get_wsgi_application()
    Django needs the application object to exist before SDK init.
    """
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    if "botversion_sdk" in content or "botversion-sdk" in content:
        return {"success": False, "reason": "already_exists"}

    lines = content.split("\n")
    wsgi_line_index = -1

    for i, line in enumerate(lines):
        if re.search(r"(application|app)\s*=\s*get_(wsgi|asgi)_application\s*\(", line):
            wsgi_line_index = i
            break

    if wsgi_line_index == -1:
        return {"success": False, "reason": "no_wsgi_call", "suggestion": "append"}

    # Insert AFTER the wsgi line
    before = lines[:wsgi_line_index + 1]
    after = lines[wsgi_line_index + 1:]
    injected_lines = [""] + code_to_inject.split("\n") + [""]
    new_content = "\n".join(before + injected_lines + after)

    backup = backup_file(file_path)
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(new_content)

    return {"success": True, "line_number": wsgi_line_index + 1, "backup": backup}


# ── Append code to end of file ────────────────────────────────────────────────

def append_to_file(file_path, code_to_append):
    """
    Adds code to end of file.
    Mirrors JS appendToFile()
    """
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    if "botversion_sdk" in content or "botversion-sdk" in content:
        return {"success": False, "reason": "already_exists"}

    backup_file(file_path)
    new_content = content.rstrip() + "\n\n" + code_to_append + "\n"

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(new_content)

    return {"success": True}


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
    """
    Adds an import line to the top of a Python file if not already present.
    Python-specific — no JS equivalent.
    """
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    if import_line in content:
        return {"success": False, "reason": "already_exists"}

    lines = content.split("\n")

    # Find the last import line
    last_import_index = 0
    for i, line in enumerate(lines):
        if line.startswith("import ") or line.startswith("from "):
            last_import_index = i

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
        backup_file(urls_path)
        new_content = content.rstrip() + "\n\n" + url_code + "\n"
        with open(urls_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        return {"success": True, "method": "append"}

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
        if "</body>" not in content:
            return {"success": False, "reason": "no_body_tag"}

        new_content = content.replace(
            "</body>",
            f"  {script_tag}\n</body>"
        )
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