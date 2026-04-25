"""
botversion-sdk-python/botversion-sdk/cli/writer.py

Reads, modifies, and writes files in the user's project.
Mirrors JS cli/writer.js
"""

import os
import re
import shutil
import json


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


# ── Append code to end of file ───────────────────────────────────────────────

def append_to_file(file_path, code_to_append, framework=None):
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    if "botversion_sdk.init(" in content:
        return {"success": False, "reason": "already_exists"}

    backup = backup_file(file_path)

    # Split import lines from non-import lines
    import_lines = []
    non_import_lines = []

    for line in code_to_append.split("\n"):
        stripped = line.strip()
        if (stripped.startswith("import ") or stripped.startswith("from ")) \
                and not line.startswith(" ") and not line.startswith("\t"):
            import_lines.append(line)
        else:
            non_import_lines.append(line)

    # Inject imports at the top first
    for imp in import_lines:
        if imp.strip() and imp.strip() not in content:
            inject_import(file_path, imp.strip())

    # Re-read file after import injection
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    init_block = "\n".join(non_import_lines).strip()
    if not init_block:
        return {"success": True, "backup": backup}

    # ── Check for factory function pattern ───────────────────────────────
    factory = _find_factory_function(content)

    if factory and factory["return_line"] != -1:
        # Inject INSIDE the factory function before return
        lines = content.split("\n")
        return_line = factory["return_line"]

        # Detect indentation from the return line
        indent = re.match(r'^(\s+)', lines[return_line])
        indent = indent.group(1) if indent else "    "

        # Indent the entire init block to match function body
        indented_block = "\n".join(
            indent + l if l.strip() else l
            for l in init_block.split("\n")
        )

        before = lines[:return_line]
        after = lines[return_line:]
        injected = ["", indented_block, ""]
        new_content = "\n".join(before + injected + after)

    else:
        # No factory function — append to end of file at module level
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

    if "botversion_sdk.init(" in content:
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
    """
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    if "botversion_sdk.init(" in content:
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

            # Handle opening of a multi-line docstring
            if not in_docstring and (stripped.startswith('"""') or stripped.startswith("'''")):
                quote = '"""' if stripped.startswith('"""') else "'''"
                # One-liner docstring — starts and ends on same line
                if stripped.endswith(quote) and len(stripped) > 3:
                    insert_index = i + 1
                    continue
                # Multi-line docstring opening
                in_docstring = True
                insert_index = i + 1
                continue

            # Inside a multi-line docstring — skip until closing quotes
            if in_docstring:
                if '"""' in line or "'''" in line:
                    in_docstring = False
                insert_index = i + 1
                continue

            # Skip blank lines and comments at the top
            if stripped == "" or stripped.startswith("#"):
                insert_index = i + 1
                continue

            # Hit real code — stop here
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


# ── Inject script tag into frontend file ─────────────────────────────────────

def inject_script_tag(file_path, file_type, script_tag, force=False):
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

    # ── HTML — inject before </body> ──────────────────────────────────────────
    if file_type == "html":
        pos = content.rfind("</body>")
        if pos == -1:
            return {"success": False, "reason": "no_body_tag"}
        new_content = content[:pos] + f"  {script_tag}\n" + content[pos:]
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        return {"success": True, "backup": backup}

    # ── Next.js layout.tsx / _app.tsx ─────────────────────────────────────────
    if file_type == "nextjs":
        component_snippet = (
            "\n"
            "{/* BotVersion AI Agent — auto-added by botversion-sdk init */}\n"
            f"{script_tag.replace('<script', '<script').replace('</script>', '</script>')}\n"
        )

        # App Router: inject inside <body> tag if present, else before last </>;
        body_match = re.search(r"(<body[^>]*>)", content)
        if body_match:
            insert_pos = body_match.end()
            new_content = content[:insert_pos] + "\n      " + script_tag + "\n" + content[insert_pos:]
        else:
            # Pages Router (_app.tsx) — wrap in Script component or dangerouslySetInnerHTML
            # Simpler: add a comment + raw script via next/script
            next_script_import = 'import Script from "next/script"'
            next_script_tag = (
                f'<Script\n'
                f'  id="botversion-loader"\n'
                f'  src="{_extract_attr(script_tag, "src")}"\n'
                f'  data-api-url="{_extract_attr(script_tag, "data-api-url")}"\n'
                f'  data-project-id="{_extract_attr(script_tag, "data-project-id")}"\n'
                f'  data-public-key="{_extract_attr(script_tag, "data-public-key")}"\n'
                f'  strategy="afterInteractive"\n'
                f'/>'
            )
            # Inject import at top
            if next_script_import not in content:
                inject_import(file_path, next_script_import)
                with open(file_path, "r", encoding="utf-8") as f:
                    content = f.read()

            # Find return statement's closing tag and inject before it
            # Look for </> or </Layout> or </main> near end of return
            close_match = re.search(r"(</[a-zA-Z]+>|</>)\s*\n(\s*\))", content)
            if close_match:
                insert_pos = close_match.start()
                new_content = content[:insert_pos] + "\n      " + next_script_tag + "\n      " + content[insert_pos:]
            else:
                new_content = content.rstrip() + f"\n{next_script_tag}\n"

        with open(file_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        return {"success": True, "backup": backup}

    # ── SvelteKit src/app.html ────────────────────────────────────────────────
    if file_type == "sveltekit":
        if file_path.endswith(".html"):
            # app.html — same as HTML injection
            pos = content.rfind("</body>")
            if pos == -1:
                return {"success": False, "reason": "no_body_tag"}
            new_content = content[:pos] + f"  {script_tag}\n" + content[pos:]
        else:
            # +layout.svelte — inject in <svelte:head> or append before </slot>
            if "<svelte:head>" in content:
                insert_pos = content.index("<svelte:head>") + len("<svelte:head>")
                new_content = content[:insert_pos] + f"\n  {script_tag}\n" + content[insert_pos:]
            else:
                # Add <svelte:head> block before first <slot />
                slot_match = re.search(r"<slot\s*/?>", content)
                if slot_match:
                    new_content = content[:slot_match.start()] + f"<svelte:head>\n  {script_tag}\n</svelte:head>\n\n" + content[slot_match.start():]
                else:
                    new_content = f"<svelte:head>\n  {script_tag}\n</svelte:head>\n\n" + content

        with open(file_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        return {"success": True, "backup": backup}

    # ── Astro layout ──────────────────────────────────────────────────────────
    if file_type == "astro":
        pos = content.rfind("</body>")
        if pos != -1:
            new_content = content[:pos] + f"  {script_tag}\n" + content[pos:]
        else:
            pos = content.rfind("</head>")
            if pos != -1:
                new_content = content[:pos] + f"  {script_tag}\n" + content[pos:]
            else:
                new_content = content.rstrip() + f"\n{script_tag}\n"
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        return {"success": True, "backup": backup}

    # ── Vue / Nuxt .vue file ──────────────────────────────────────────────────
    if file_type == "vue":
        # Inject into <template> before the closing root tag
        template_match = re.search(r"</template>", content)
        if template_match:
            insert_pos = template_match.start()
            new_content = content[:insert_pos] + f"  <!-- BotVersion -->\n  {script_tag}\n" + content[insert_pos:]
        else:
            new_content = content.rstrip() + f"\n<!-- BotVersion -->\n{script_tag}\n"
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        return {"success": True, "backup": backup}

    # ── Remix root.tsx ────────────────────────────────────────────────────────
    if file_type == "remix":
        # Use next/script equivalent — inject as <script> before </body> in Links export
        # or just inject raw before the closing return tag
        close_match = re.search(r"(</[a-zA-Z]+>|</>)\s*\n(\s*\))", content)
        if close_match:
            insert_pos = close_match.start()
            new_content = content[:insert_pos] + f"\n      {script_tag}\n      " + content[insert_pos:]
        else:
            new_content = content.rstrip() + f"\n{script_tag}\n"
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        return {"success": True, "backup": backup}

    return {"success": False, "reason": "unsupported_file_type"}


def _extract_attr(script_tag, attr_name):
    """Helper to extract an attribute value from a script tag string."""
    match = re.search(rf'{attr_name}="([^"]*)"', script_tag)
    return match.group(1) if match else ""


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

    with open(settings_path, "w", encoding="utf-8") as f:
        f.write(new_content)

    return {"success": True}



def _find_factory_function(content):
    """
    Detects if the app is created inside a factory function like create_app().
    Returns the function name and its line range, or None.
    
    Handles:
    - def create_app(): ...
    - def make_app(): ...
    - def build_app(): ...
    - def get_app(): ...
    - def setup_app(): ...
    - def init_app(): ...
    - def application(): ...
    """
    lines = content.split("\n")
    
    factory_pattern = re.compile(
        r'^def\s+(create|make|build|get|setup|init|application)[\w]*\s*\('
    )
    
    for i, line in enumerate(lines):
        if not factory_pattern.search(line):
            continue
            
        # Found a factory function — find its body range
        # Find opening brace depth
        depth = 0
        func_start = i
        func_end = -1
        found_colon = False
        
        for j in range(i, len(lines)):
            if ':' in lines[j] and not found_colon:
                found_colon = True
            if not found_colon:
                continue
                
            for ch in lines[j]:
                if ch == '(':
                    depth += 1
                elif ch == ')':
                    depth -= 1
                    
            # Check indentation to find end of function
            if j > i:
                stripped = lines[j].strip()
                if stripped and not lines[j].startswith(' ') and not lines[j].startswith('\t'):
                    func_end = j - 1
                    break
                    
        if func_end == -1:
            func_end = len(lines) - 1
            
        # Check if app is created inside this function
        func_body = "\n".join(lines[func_start:func_end + 1])
        # Detect known framework classes AND any user-defined subclasses
        app_classes = re.findall(
            r'class\s+(\w+)\s*\(\s*(?:Flask|FastAPI)[\),]', content
        )
        app_class_pattern = '|'.join(['Flask', 'FastAPI'] + app_classes)
        if re.search(rf'(\w+)\s*=\s*(?:{app_class_pattern})\s*\(', func_body):
            # Find the return statement
            return_line = -1
            for j in range(func_end, func_start, -1):
                if re.search(r'^\s+return\s+\w+', lines[j]):
                    return_line = j
                    break
                    
            return {
                "func_name": re.match(r'^def\s+(\w+)', line).group(1),
                "func_start": func_start,
                "func_end": func_end,
                "return_line": return_line,
            }
    
    return None



def inject_cors(file_path, cors_code, framework):
    """
    Injects CORS configuration into the entry file.
    For FastAPI and Flask — injects after the app instance is created.
    """
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"success": False, "reason": "read_error", "error": str(e)}

    # Already has CORS — skip
    if "CORSMiddleware" in content or "flask_cors" in content or "CORS(" in content:
        return {"success": False, "reason": "already_exists"}

    backup = backup_file(file_path)

    # Split CORS code into imports and non-imports
    import_lines = []
    non_import_lines = []

    for line in cors_code.strip().split("\n"):
        stripped = line.strip()
        if (stripped.startswith("import ") or stripped.startswith("from ")) and not line.startswith(" ") and not line.startswith("\t"):
            import_lines.append(line)
        else:
            non_import_lines.append(line)

    # Inject imports at top of file
    for imp in import_lines:
        if imp.strip() and imp.strip() not in content:
            inject_import(file_path, imp.strip())

    # Re-read after import injection
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    lines = content.split("\n")

    _flask_subclass_names = re.findall(
        r'class\s+(\w+)\s*\(\s*Flask\s*[\),]', content
    )
    _flask_subclass_pattern = (
        r'(\w+)\s*=\s*(?:' + '|'.join(_flask_subclass_names) + r')\s*\('
        if _flask_subclass_names else None
    )

    patterns = {
        "fastapi": r"(\w+)\s*=\s*(?:fastapi\.)?FastAPI\s*\(",
        "flask": r"(\w+)\s*=\s*(?:flask\.)?Flask\s*\(",
    }

    # Override flask pattern if subclass detected
    if framework == "flask" and _flask_subclass_pattern:
        patterns["flask"] = _flask_subclass_pattern

    pattern = patterns.get(framework)
    app_line_index = -1

    if pattern:
        for i, line in enumerate(lines):
            if re.search(pattern, line):
                app_line_index = i
                break

    if app_line_index == -1:
        # Fallback — append to end of file
        init_block = "\n".join(non_import_lines).strip()
        new_content = content.rstrip() + "\n\n" + init_block + "\n"
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        return {"success": True, "backup": backup, "method": "append"}

    # Inject CORS code after the app instance line
    # ── Find end of app instantiation (handles multiline) ────────────────
    
    insert_index = app_line_index
    bracket_depth = 0
    found_opening = False

    for i in range(app_line_index, len(lines)):
        for ch in lines[i]:
            if ch == "(":
                bracket_depth += 1
                found_opening = True
            elif ch == ")":
                bracket_depth -= 1
        if found_opening and bracket_depth == 0:
            insert_index = i
            break

    before = lines[:insert_index + 1]
    after = lines[insert_index + 1:]
    init_block = "\n".join(non_import_lines).strip()

    # ── If inside factory function, indent to match function body ─────────
    factory = _find_factory_function(content)
    if factory and factory["func_start"] < app_line_index <= factory["func_end"]:
        # Detect indentation from the app line itself
        indent_match = re.match(r'^(\s+)', lines[app_line_index])
        indent = indent_match.group(1) if indent_match else "    "
        init_block = "\n".join(
            indent + l if l.strip() else l
            for l in init_block.split("\n")
        )

    injected_lines = ["", init_block, ""]
    new_content = "\n".join(before + injected_lines + after)

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(new_content)

    return {"success": True, "backup": backup, "method": "inject"}
