"""
botversion-sdk-python/botversion-sdk/cli/detector.py

Scans the user's Python project and detects everything needed for auto-setup.
Mirrors JS cli/detector.js
"""

import os
import re
import json


# ── Read requirements / pyproject.toml ───────────────────────────────────────

def read_requirements(cwd):
    """
    Reads installed packages from requirements.txt or pyproject.toml.
    Returns a dict of { package_name: version_string }.
    Mirrors JS readPackageJson()
    """
    packages = {}

    # Try requirements.txt first
    req_path = os.path.join(cwd, "requirements.txt")
    if os.path.exists(req_path):
        try:
            with open(req_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    # Handle: package==1.0, package>=1.0, package~=1.0, package
                    match = re.match(r"^([a-zA-Z0-9_\-\.]+)\s*([><=~!].+)?$", line)
                    if match:
                        name = match.group(1).lower().replace("-", "_")
                        version = match.group(2) or ""
                        packages[name] = version
        except Exception:
            pass

    # Try pyproject.toml
    pyproject_path = os.path.join(cwd, "pyproject.toml")
    if os.path.exists(pyproject_path):
        try:
            with open(pyproject_path, "r", encoding="utf-8") as f:
                content = f.read()
            # Extract dependencies section
            in_deps = False
            for line in content.split("\n"):
                line = line.strip()
                if line in ("[tool.poetry.dependencies]", "[project.dependencies]", "[dependencies]"):
                    in_deps = True
                    continue
                if line.startswith("[") and in_deps:
                    in_deps = False
                if in_deps and "=" in line:
                    parts = line.split("=", 1)
                    name = parts[0].strip().strip('"').lower().replace("-", "_")
                    version = parts[1].strip().strip('"')
                    packages[name] = version
        except Exception:
            pass

    return packages


# ── Framework detection ───────────────────────────────────────────────────────

SUPPORTED_FRAMEWORKS = ["fastapi", "flask", "django"]
UNSUPPORTED_FRAMEWORKS = ["tornado", "aiohttp", "sanic", "starlette", "falcon"]


def detect_framework(packages):
    """
    Detects which Python web framework is being used.
    Mirrors JS detectFramework()
    """
    if not packages:
        return {"name": None, "supported": False}

    # Check unsupported first so we can warn clearly
    for fw in UNSUPPORTED_FRAMEWORKS:
        if fw in packages:
            return {"name": fw, "supported": False}

    for fw in SUPPORTED_FRAMEWORKS:
        if fw in packages:
            return {"name": fw, "supported": True}

    return {"name": None, "supported": False}


# ── Entry point detection ─────────────────────────────────────────────────────

def detect_entry_point(cwd, framework):
    """
    Finds the main server file for the project.
    Mirrors JS detectExpressEntry()
    """
    # Common candidates by framework
    candidates = [
        "main.py",
        "app.py",
        "server.py",
        "wsgi.py",
        "asgi.py",
        "application.py",
        "run.py",
        "manage.py",
        "src/main.py",
        "src/app.py",
        "src/server.py",
        "src/wsgi.py",
        "src/asgi.py",
    ]

    # Framework-specific search strings
    search_strings = {
        "fastapi": ["FastAPI()", "FastAPI(", "uvicorn.run"],
        "flask": ["Flask(__name__)", "Flask(", "app.run("],
        "django": ["django.setup()", "get_wsgi_application", "get_asgi_application", "DJANGO_SETTINGS_MODULE"],
    }

    strings_to_find = search_strings.get(framework, [])

    for candidate in candidates:
        full_path = os.path.join(cwd, candidate)
        if os.path.exists(full_path):
            try:
                with open(full_path, "r", encoding="utf-8") as f:
                    content = f.read()
                if any(s in content for s in strings_to_find):
                    return full_path
            except Exception:
                continue

    # Fallback: any .py file containing framework signature
    for search_str in strings_to_find:
        found = find_file_with_content(cwd, search_str, [".py"], max_depth=2)
        if found:
            return found

    return None


# ── Run call detection ────────────────────────────────────────────────────────

def find_run_call(file_path, framework):
    """
    Finds the line where the server is started.
    Mirrors JS findListenCall()
    Flask:   app.run(
    FastAPI: uvicorn.run(
    Django:  application = get_wsgi_application()
    """
    if not file_path or not os.path.exists(file_path):
        return None

    patterns = {
        "flask": r"app\.run\s*\(",
        "fastapi": r"uvicorn\.run\s*\(",
        "django": r"(get_wsgi_application|get_asgi_application)\s*\(",
    }

    pattern = patterns.get(framework)
    if not pattern:
        return None

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            lines = f.readlines()

        for i, line in enumerate(lines):
            if re.search(pattern, line):
                return {"line_index": i, "line_number": i + 1, "content": line.rstrip()}
    except Exception:
        pass

    return None


def find_app_var_name(file_path, framework):
    """
    Detects the variable name used for the app instance.
    e.g. my_app = Flask(__name__) → returns 'my_app'
    Mirrors JS detectAppVarName()
    """
    if not file_path or not os.path.exists(file_path):
        return "app"

    patterns = {
        "flask": r"(\w+)\s*=\s*(?:flask\.)?Flask\s*\(",
        "fastapi": r"(\w+)\s*=\s*(?:fastapi\.)?FastAPI\s*\(",
    }

    pattern = patterns.get(framework)
    if not pattern:
        return "app"

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
        match = re.search(pattern, content)
        if match:
            return match.group(1)
    except Exception:
        pass

    return "app"


# ── Auth detection ────────────────────────────────────────────────────────────

AUTH_LIBS = [
    {
        "name": "flask_login",
        "packages": ["flask_login", "flask-login"],
        "supported": True,
    },
    {
        "name": "flask_jwt_extended",
        "packages": ["flask_jwt_extended", "flask-jwt-extended"],
        "supported": True,
    },
    {
        "name": "django_allauth",
        "packages": ["django_allauth", "django-allauth"],
        "supported": True,
    },
    {
        "name": "djangorestframework_simplejwt",
        "packages": ["djangorestframework_simplejwt", "djangorestframework-simplejwt"],
        "supported": True,
    },
    {
        "name": "python_jose",
        "packages": ["python_jose", "python-jose"],
        "supported": True,
    },
    {
        "name": "authlib",
        "packages": ["authlib"],
        "supported": False,
    },
    {
        "name": "django_rest_framework",
        "packages": ["djangorestframework", "rest_framework"],
        "supported": True,
    },
    {
        "name": "fastapi_users",
        "packages": ["fastapi_users", "fastapi-users"],
        "supported": True,
    },
]


def detect_auth(packages):
    """
    Detects which Python auth library is being used.
    Mirrors JS detectAuth()
    """
    if not packages:
        return {"name": None, "supported": False}

    for lib in AUTH_LIBS:
        for pkg in lib["packages"]:
            if pkg.replace("-", "_") in packages or pkg in packages:
                return {
                    "name": lib["name"],
                    "supported": lib["supported"],
                    "package": lib["packages"][0],
                }

    return {"name": None, "supported": False}


# ── Django settings detection ─────────────────────────────────────────────────

def find_django_settings(cwd):
    """
    Finds the Django settings file.
    """
    candidates = [
        "settings.py",
        "config/settings.py",
        "config/settings/base.py",
        "config/settings/development.py",
        "core/settings.py",
        "app/settings.py",
        "src/settings.py",
        "src/config/settings.py",
    ]

    for candidate in candidates:
        full_path = os.path.join(cwd, candidate)
        if os.path.exists(full_path):
            return {"path": full_path, "relative_path": candidate}

    # Search for settings.py with Django content
    found = find_file_with_content(cwd, "INSTALLED_APPS", [".py"], max_depth=3)
    if found:
        return {
            "path": found,
            "relative_path": os.path.relpath(found, cwd),
        }

    return None


# ── Existing botversion detection ─────────────────────────────────────────────

def detect_existing_botversion(file_path):
    """
    Checks if BotVersion SDK is already initialized in a file.
    Mirrors JS detectExistingBotVersion()
    """
    if not file_path or not os.path.exists(file_path):
        return False
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
        return "botversion_sdk" in content or "botversion-sdk" in content
    except Exception:
        return False


# ── Src directory detection ───────────────────────────────────────────────────

def detect_src_dir(cwd):
    """Checks if a src/ directory exists."""
    return os.path.exists(os.path.join(cwd, "src"))


# ── Virtual environment detection ─────────────────────────────────────────────

def detect_virtualenv(cwd):
    """
    Detects which virtual environment / package manager is being used.
    Mirrors JS detectPackageManager()
    """
    if os.path.exists(os.path.join(cwd, "Pipfile")):
        return "pipenv"
    if os.path.exists(os.path.join(cwd, "poetry.lock")):
        return "poetry"
    if os.path.exists(os.path.join(cwd, "pdm.lock")):
        return "pdm"
    if os.path.exists(os.path.join(cwd, ".venv")):
        return "venv"
    if os.path.exists(os.path.join(cwd, "venv")):
        return "venv"
    return "pip"


# ── Helper: find file containing a string ─────────────────────────────────────

def find_file_with_content(directory, search_string, extensions, max_depth=2):
    """
    Recursively searches for a file containing a specific string.
    Mirrors JS findFileWithContent()
    """
    skip_dirs = {
        "__pycache__", ".git", ".venv", "venv", "env",
        "node_modules", "dist", "build", ".cache",
        "migrations", "static", "media",
    }

    def walk(current_dir, depth):
        if depth > max_depth:
            return None

        try:
            entries = os.listdir(current_dir)
        except Exception:
            return None

        for entry in entries:
            if entry in skip_dirs:
                continue

            full_path = os.path.join(current_dir, entry)

            try:
                if os.path.isdir(full_path):
                    result = walk(full_path, depth + 1)
                    if result:
                        return result
                elif any(entry.endswith(ext) for ext in extensions):
                    with open(full_path, "r", encoding="utf-8", errors="ignore") as f:
                        content = f.read()
                    if search_string in content:
                        return full_path
            except Exception:
                continue

        return None

    return walk(directory, 0)


# ── Scan all package.json files (for separate frontend folders) ───────────────

def scan_all_package_jsons(cwd):
    """
    Walks subdirectories looking for package.json files.
    Used to find separate frontend folders (e.g. client/, frontend/).
    Mirrors JS scanAllPackageJsons()
    """
    skip_dirs = {
        "node_modules", ".git", ".next", "dist", "build",
        ".cache", "__pycache__", ".venv", "venv", "env",
    }
    results = []

    def walk(current_dir, depth):
        if depth > 5:
            return
        try:
            entries = os.listdir(current_dir)
        except Exception:
            return
        for entry in entries:
            if entry in skip_dirs:
                continue
            full_path = os.path.join(current_dir, entry)
            if os.path.isdir(full_path):
                walk(full_path, depth + 1)
            elif entry == "package.json":
                try:
                    with open(full_path, "r", encoding="utf-8") as f:
                        pkg = json.load(f)
                    results.append({"dir": current_dir, "pkg": pkg})
                except Exception:
                    continue

    walk(cwd, 0)
    return results


# ── Detect frontend framework from package.json ───────────────────────────────

def detect_frontend_framework(pkg):
    """
    Looks at a package.json and returns which frontend framework is being used.
    Mirrors JS detectFrontendFramework()
    """
    if not pkg:
        return None

    deps = {}
    deps.update(pkg.get("dependencies", {}))
    deps.update(pkg.get("devDependencies", {}))

    if "next" in deps:
        return "next"
    if "@sveltejs/kit" in deps:
        return "sveltekit"
    if "svelte" in deps:
        return "svelte"
    if "@angular/core" in deps:
        return "angular"
    if "vue" in deps:
        return "vue"
    if "react-dom" in deps or "react" in deps:
        if "vite" in deps or "@vitejs/plugin-react" in deps:
            return "react-vite"
        return "react-cra"
    if "solid-js" in deps:
        return "solid"
    if "preact" in deps:
        return "preact"

    return None


# ── Find main template file (Django/Flask specific) ───────────────────────────

def find_main_template_file(cwd):
    """
    Finds the main HTML template file for Django/Flask projects.
    Looks for base.html or index.html inside templates/ folder.
    Python-specific — no JS equivalent.
    """
    candidates = [
        "templates/base.html",
        "templates/index.html",
        "templates/layout.html",
        "templates/main.html",
        "app/templates/base.html",
        "app/templates/index.html",
        "src/templates/base.html",
        "src/templates/index.html",
    ]

    for candidate in candidates:
        full_path = os.path.join(cwd, candidate)
        if os.path.exists(full_path):
            try:
                with open(full_path, "r", encoding="utf-8") as f:
                    content = f.read()
                if "<body" in content or "<html" in content:
                    return {"file": full_path, "type": "html"}
            except Exception:
                continue

    return None


# ── Find main frontend file ───────────────────────────────────────────────────

def find_main_frontend_file(directory, pkg):
    """
    Based on the frontend framework, finds the right file to inject
    the script tag into.
    Mirrors JS findMainFrontendFile()
    """
    framework = detect_frontend_framework(pkg)

    # ── Angular ───────────────────────────────────────────────────────────────
    if framework == "angular":
        candidate = os.path.join(directory, "src", "index.html")
        if os.path.exists(candidate):
            return {"file": candidate, "type": "html"}
        return None

    # ── Vite-based (React Vite, Vue, Svelte, SvelteKit, Solid, Preact) ────────
    if framework in ("react-vite", "vue", "svelte", "sveltekit", "solid", "preact"):
        root_html = os.path.join(directory, "index.html")
        if os.path.exists(root_html):
            return {"file": root_html, "type": "html"}
        public_html = os.path.join(directory, "public", "index.html")
        if os.path.exists(public_html):
            return {"file": public_html, "type": "html"}
        return None

    # ── React CRA ─────────────────────────────────────────────────────────────
    if framework == "react-cra":
        public_html = os.path.join(directory, "public", "index.html")
        if os.path.exists(public_html):
            return {"file": public_html, "type": "html"}
        root_html = os.path.join(directory, "index.html")
        if os.path.exists(root_html):
            return {"file": root_html, "type": "html"}
        return None

    # ── Unknown frontend — scan common locations ───────────────────────────────
    html_candidates = [
        "index.html",
        "public/index.html",
        "static/index.html",
        "src/index.html",
        "www/index.html",
    ]

    for candidate in html_candidates:
        full_path = os.path.join(directory, candidate)
        if os.path.exists(full_path):
            try:
                with open(full_path, "r", encoding="utf-8") as f:
                    content = f.read()
                if "<body" in content or "<html" in content:
                    return {"file": full_path, "type": "html"}
            except Exception:
                continue

    # ── Last resort — deep scan for any .html file ────────────────────────────
    found = find_html_file(directory)
    if found:
        return {"file": found, "type": "html"}

    return None


# ── Deep scan for any HTML file ───────────────────────────────────────────────

def find_html_file(directory):
    """
    Last resort — walks subdirectories looking for any .html file
    that looks like a real page (has <body> or <html> tag).
    Mirrors JS findHtmlFile()
    """
    skip_dirs = {
        "node_modules", ".git", "__pycache__",
        ".venv", "venv", "env", "dist", "build",
    }

    def walk(current_dir, depth):
        if depth > 3:
            return None
        try:
            entries = os.listdir(current_dir)
        except Exception:
            return None
        for entry in entries:
            if entry in skip_dirs:
                continue
            full_path = os.path.join(current_dir, entry)
            if os.path.isdir(full_path):
                result = walk(full_path, depth + 1)
                if result:
                    return result
            elif entry.endswith(".html"):
                try:
                    with open(full_path, "r", encoding="utf-8") as f:
                        content = f.read()
                    if "<body" in content or "<html" in content:
                        return full_path
                except Exception:
                    continue
        return None

    return walk(directory, 0)


# ── Main detect function ──────────────────────────────────────────────────────

def detect(cwd):
    """
    Master detection function — runs all detectors and returns one result dict.
    Mirrors JS detect()
    """
    packages = read_requirements(cwd)
    framework = detect_framework(packages)
    auth = detect_auth(packages)
    virtualenv = detect_virtualenv(cwd)
    has_src = detect_src_dir(cwd)

    result = {
        "cwd": cwd,
        "packages": packages,
        "framework": framework,
        "auth": auth,
        "virtualenv": virtualenv,
        "has_src": has_src,
    }

    # ── Framework-specific detection ──────────────────────────────────────────
    if framework["name"] in ("fastapi", "flask"):
        result["entry_point"] = detect_entry_point(cwd, framework["name"])
        if result["entry_point"]:
            result["run_call"] = find_run_call(result["entry_point"], framework["name"])
            result["app_var_name"] = find_app_var_name(result["entry_point"], framework["name"])

    elif framework["name"] == "django":
        result["entry_point"] = detect_entry_point(cwd, "django")
        result["django_settings"] = find_django_settings(cwd)
        result["run_call"] = None

    # ── Frontend detection ────────────────────────────────────────────────────
    frontend_dir = None
    frontend_pkg = None
    frontend_main_file = None

    # Step 1: scan for a separate frontend folder with its own package.json
    all_packages = scan_all_package_jsons(cwd)
    for item in all_packages:
        dir_ = item["dir"]
        pkg_ = item["pkg"]
        deps = {}
        deps.update(pkg_.get("dependencies", {}))
        deps.update(pkg_.get("devDependencies", {}))
        # Check if this folder is a frontend (has React, Vue, Angular etc.)
        frontend_markers = [
            "react", "react-dom", "vue", "@angular/core",
            "svelte", "solid-js", "preact", "next",
        ]
        if any(m in deps for m in frontend_markers):
            frontend_dir = dir_
            frontend_pkg = pkg_
            break

    # Step 2: if separate frontend folder found, look for the file there
    if frontend_dir and frontend_pkg:
        frontend_main_file = find_main_frontend_file(frontend_dir, frontend_pkg)

    # Step 3: if no separate frontend folder, look in the root folder itself
    # This covers: Flask/FastAPI serving static/public/index.html
    if not frontend_main_file:
        frontend_main_file = find_main_frontend_file(cwd, {})

    # Step 4: if still nothing, look for Django/Flask templates
    if not frontend_main_file:
        frontend_main_file = find_main_template_file(cwd)

    result["frontend_dir"] = frontend_dir
    result["frontend_pkg"] = frontend_pkg
    result["frontend_main_file"] = frontend_main_file

    # ── Already initialized check ─────────────────────────────────────────────
    result["already_initialized"] = detect_existing_botversion(
        result.get("entry_point")
    )

    return result