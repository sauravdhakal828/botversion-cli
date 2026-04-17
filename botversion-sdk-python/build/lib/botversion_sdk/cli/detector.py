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

            # ── Format 1: List format (standard pyproject.toml) ──────────────
            # dependencies = [
            #     "fastapi[standard]<1.0.0,>=0.114.2",
            # ]
            in_deps = False
            for line in content.split("\n"):
                stripped = line.strip()

                if stripped == "dependencies = [" or stripped == "dependencies=[":
                    in_deps = True
                    continue
    
                if in_deps:
                    if stripped == "]":
                        in_deps = False
                        continue
                    # Parse quoted package name — strip extras like [standard]
                    match = re.match(r'^["\']([a-zA-Z0-9_\-\.]+)', stripped)
                    if match:
                        name = match.group(1).lower().replace("-", "_")
                        packages[name] = ""

            # ── Format 2: Key-value format (Poetry) ──────────────────────────
            # [tool.poetry.dependencies]
            # fastapi = "^0.100.0"
            in_poetry_deps = False
            for line in content.split("\n"):
                stripped = line.strip()
                if stripped in ("[tool.poetry.dependencies]", "[project.dependencies]"):
                    in_poetry_deps = True
                    continue
                if stripped.startswith("[") and in_poetry_deps:
                    in_poetry_deps = False
                if in_poetry_deps and "=" in stripped:
                    parts = stripped.split("=", 1)
                    name = parts[0].strip().strip('"').lower().replace("-", "_")
                    packages[name] = parts[1].strip().strip('"')

        except Exception:
            pass

    return packages


def find_backend_root(cwd):
    """
    If requirements.txt / pyproject.toml is not in cwd,
    scan one level of subdirectories to find it.
    Returns the folder that contains it, or cwd as fallback.
    """

    def has_real_dependencies(toml_path):
        """
        Checks if a pyproject.toml actually contains dependencies
        and is not just a workspace config file.
        """
        try:
            with open(toml_path, "r", encoding="utf-8") as f:
                content = f.read()
            return "dependencies" in content and (
                "[project]" in content or
                "[tool.poetry.dependencies]" in content or
                "[tool.poetry]" in content
            )
        except Exception:
            return False

    # Check root first
    if os.path.exists(os.path.join(cwd, "requirements.txt")):
        return cwd

    if os.path.exists(os.path.join(cwd, "pyproject.toml")):
        if has_real_dependencies(os.path.join(cwd, "pyproject.toml")):
            return cwd
        # Falls through to scan subdirectories

    # Scan one level deep
    try:
        for entry in os.listdir(cwd):
            full_path = os.path.join(cwd, entry)
            if not os.path.isdir(full_path):
                continue
            # Skip obvious non-backend folders
            if entry in ("node_modules", ".git", "__pycache__", ".venv",
                         "venv", "env", "dist", "build", "frontend",
                         "client", "static", "media", "public"):
                continue
            # Check requirements.txt
            if os.path.exists(os.path.join(full_path, "requirements.txt")):
                return full_path
            # Check pyproject.toml with actual dependencies
            pyproject = os.path.join(full_path, "pyproject.toml")
            if os.path.exists(pyproject):
                if has_real_dependencies(pyproject):
                    return full_path
    except Exception:
        pass

    return cwd  # fallback — no change in behavior


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
        "wsgi.py",          # ← wsgi files first
        "asgi.py",
        "application.py",
        "run.py",
        "src/main.py",
        "src/app.py",
        "src/server.py",
        "src/wsgi.py",
        "src/asgi.py",
        # ── Common Django project folder patterns ──
        "backend/wsgi.py",
        "backend/asgi.py",
        "app/wsgi.py",
        "app/asgi.py",
        "config/wsgi.py",
        "config/asgi.py",
        "core/wsgi.py",
        "core/asgi.py",
        "project/wsgi.py",
        "project/asgi.py",
        "manage.py",
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
    # ── FastAPI ───────────────────────────────────────────────────────────────
    {
        "name": "fastapi_users",
        "packages": ["fastapi_users", "fastapi-users"],
        "supported": True,
    },
    {
        "name": "pyjwt",
        "packages": ["pyjwt", "PyJWT"],
        "supported": True,
    },
    {
        "name": "python_jose",
        "packages": ["python_jose", "python-jose"],
        "supported": True,
    },
    {
        "name": "authx",
        "packages": ["authx"],
        "supported": True,
    },
    {
        "name": "fastapi_jwt_auth",
        "packages": ["fastapi_jwt_auth", "fastapi-jwt-auth"],
        "supported": True,
    },
    {
        "name": "fastapi_security",
        "packages": ["fastapi_security", "fastapi-security"],
        "supported": True,
    },
    # ── Flask ─────────────────────────────────────────────────────────────────
    {
        "name": "flask_login",
        "packages": ["flask_login", "flask-login"],
        "supported": True,
    },
    {
        "name": "flask_jwt_extended",
        "packages": ["flask_jwt_extended", "flask-jwt-extended"],
        "supported": True,
        "get_version": lambda v: "v4" if v.startswith("4") else "v3",
    },
    {
        "name": "flask_security",
        "packages": ["flask_security", "flask-security"],
        "supported": True,
    },
    {
        "name": "flask_praetorian",
        "packages": ["flask_praetorian", "flask-praetorian"],
        "supported": True,
    },
    {
        "name": "flask_httpauth",
        "packages": ["flask_httpauth", "flask-httpauth"],
        "supported": True,
    },
    # ── Django ────────────────────────────────────────────────────────────────
    {
        "name": "django_allauth",
        "packages": ["django_allauth", "django-allauth"],
        "supported": True,
    },
    {
        "name": "djangorestframework_simplejwt",
        "packages": ["djangorestframework_simplejwt", "djangorestframework-simplejwt"],
        "supported": True,
        "get_version": lambda v: v.split(".")[0] if v else None,
    },
    {
        "name": "django_rest_framework",
        "packages": ["djangorestframework", "rest_framework"],
        "supported": True,
    },
    {
        "name": "django_oauth_toolkit",
        "packages": ["django_oauth_toolkit", "django-oauth-toolkit"],
        "supported": True,
    },
    {
        "name": "dj_rest_auth",
        "packages": ["dj_rest_auth", "dj-rest-auth"],
        "supported": True,
    },
    # ── General / Multi-framework ─────────────────────────────────────────────
    {
        "name": "authlib",
        "packages": ["authlib"],
        "supported": True,
    },
    {
        "name": "joserfc",
        "packages": ["joserfc"],
        "supported": True,
    },
    {
        "name": "passlib",
        "packages": ["passlib"],
        "supported": False,
    },
    {
        "name": "itsdangerous",
        "packages": ["itsdangerous"],
        "supported": False,
    },
]


def detect_auth(packages):
    if not packages:
        return {"name": None, "supported": False}

    for lib in AUTH_LIBS:
        for pkg in lib["packages"]:
            normalized = pkg.replace("-", "_")
            if normalized in packages or pkg in packages:
                version_str = packages.get(normalized) or packages.get(pkg) or ""
                version = None
                if lib.get("get_version") and version_str:
                    try:
                        version = lib["get_version"](version_str.lstrip("^~>=<"))
                    except Exception:
                        version = None
                return {
                    "name": lib["name"],
                    "supported": lib["supported"],
                    "package": lib["packages"][0],
                    "version": version,
                }

    return {"name": None, "supported": False}


# ── Django settings detection ─────────────────────────────────────────────────

def find_django_settings(cwd):
    """
    Finds the Django settings file.
    """
    candidates = [
        "settings.py",
        "backend/settings.py",
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



def find_httpauth_var_name(file_path):
    """
    Detects the variable name used for the HTTPAuth instance.
    e.g. token_auth = HTTPTokenAuth() -> returns 'token_auth'
    Needed by generator.py to generate correct get_user_context.
    """
    if not file_path or not os.path.exists(file_path):
        return None

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        match = re.search(
            r"(\w+)\s*=\s*(?:flask_httpauth\.)?HTTP(?:Basic|Token|Digest|Multi)?Auth\s*\(",
            content
        )
        if match:
            return match.group(1)
    except Exception:
        pass

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


# ── Find pip executable ───────────────────────────────────────────────────────

def find_pip_executable(cwd, backend_root, virtualenv):
    """
    Finds the correct pip executable to install packages into the
    right Python environment.
    Returns a dict:
    {
        "pip": ["path/to/pip"],           # the command to use
        "found_venv": True/False,          # did we find a real venv?
        "venv_path": "path/to/venv",       # where the venv is (or None)
        "method": "venv/poetry/pipenv/..." # how we found it
    }
    """
    import sys

    # ── Step 1: Look for venv inside backend_root first ───────────────────────
    venv_candidates = [
        os.path.join(backend_root, "venv"),
        os.path.join(backend_root, ".venv"),
        os.path.join(cwd, "venv"),
        os.path.join(cwd, ".venv"),
    ]

    for venv_path in venv_candidates:
        if not os.path.isdir(venv_path):
            continue

        # Windows path
        pip_win = os.path.join(venv_path, "Scripts", "pip.exe")
        # Mac/Linux path
        pip_unix = os.path.join(venv_path, "bin", "pip")

        if os.path.exists(pip_win):
            return {
                "pip": [pip_win],
                "found_venv": True,
                "venv_path": venv_path,
                "method": "venv",
            }
        if os.path.exists(pip_unix):
            return {
                "pip": [pip_unix],
                "found_venv": True,
                "venv_path": venv_path,
                "method": "venv",
            }

    # ── Step 2: Check for conda environment ───────────────────────────────────
    conda_prefix = os.environ.get("CONDA_PREFIX")
    if conda_prefix:
        pip_win = os.path.join(conda_prefix, "Scripts", "pip.exe")
        pip_unix = os.path.join(conda_prefix, "bin", "pip")

        if os.path.exists(pip_win):
            return {
                "pip": [pip_win],
                "found_venv": True,
                "venv_path": conda_prefix,
                "method": "conda",
            }
        if os.path.exists(pip_unix):
            return {
                "pip": [pip_unix],
                "found_venv": True,
                "venv_path": conda_prefix,
                "method": "conda",
            }

    # ── Step 3: Check package manager specific commands ───────────────────────
    if virtualenv == "poetry":
        return {
            "pip": ["poetry", "add"],
            "found_venv": True,
            "venv_path": None,
            "method": "poetry",
        }

    if virtualenv == "pipenv":
        return {
            "pip": ["pipenv", "install"],
            "found_venv": True,
            "venv_path": None,
            "method": "pipenv",
        }

    if virtualenv == "pdm":
        return {
            "pip": ["pdm", "add"],
            "found_venv": True,
            "venv_path": None,
            "method": "pdm",
        }

    # ── Step 4: Fall back to the same Python that is running right now ────────
    # sys.executable gives us the exact python running this CLI
    # so we use that python's pip — better than blindly calling "pip"
    return {
        "pip": [sys.executable, "-m", "pip"],
        "found_venv": False,
        "venv_path": None,
        "method": "global",
    }


# ── Main detect function ──────────────────────────────────────────────────────

def detect(cwd):
    # Find where the backend actually lives (handles frontend/backend split)
    backend_root = find_backend_root(cwd)
    
    packages = read_requirements(backend_root)  # ← backend_root
    framework = detect_framework(packages)
    auth = detect_auth(packages)
    virtualenv = detect_virtualenv(backend_root)  # ← backend_root
    has_src = detect_src_dir(backend_root)  # ← backend_root

    result = {
        "cwd": cwd,
        "backend_root": backend_root,
        "packages": packages,
        "framework": framework,
        "auth": auth,
        "virtualenv": virtualenv,
        "has_src": has_src,
    }

    # ── Framework-specific detection ──────────────────────────────────────────
    if framework["name"] in ("fastapi", "flask"):
        result["entry_point"] = detect_entry_point(backend_root, framework["name"])
        if result["entry_point"]:
            result["run_call"] = find_run_call(result["entry_point"], framework["name"])
            result["app_var_name"] = find_app_var_name(result["entry_point"], framework["name"])
            if auth.get("name") == "flask_httpauth":
                auth["httpauth_var_name"] = find_httpauth_var_name(result["entry_point"])

    elif framework["name"] == "django":
        result["entry_point"] = detect_entry_point(backend_root, "django")
        result["django_settings"] = find_django_settings(backend_root)
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

    # ── Find pip executable ───────────────────────────────────────────────────
    result["pip_info"] = find_pip_executable(cwd, backend_root, virtualenv)

    return result