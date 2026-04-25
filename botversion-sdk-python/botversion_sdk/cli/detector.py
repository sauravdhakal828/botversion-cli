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
    if not packages:
        return {"name": None, "supported": False}

    # Check supported first (most specific)
    for fw in SUPPORTED_FRAMEWORKS:
        if fw in packages:
            return {"name": fw, "supported": True}

    # Then check unsupported
    for fw in UNSUPPORTED_FRAMEWORKS:
        if fw in packages:
            return {"name": fw, "supported": False}

    return {"name": None, "supported": False}



def score_flask_file(content, filepath):
    score = 0
    filename = os.path.basename(filepath)

    # High confidence — direct instantiation
    if re.search(r'\bFlask\s*\(', content):                                   score += 10
    # High confidence — subclass pattern (class MyApp(Flask):)
    if re.search(r'class\s+\w+\s*\(\s*Flask\s*[\),]', content):              score += 10
    # High confidence — factory function name
    if re.search(r'def\s+(create|make|build|get|setup|init)_app\s*\(', content): score += 8
    # High confidence — server started here
    if re.search(r'\bapp\.run\s*\(', content):                                score += 8
    # Medium — registers blueprints (orchestrator file)
    if re.search(r'\.register_blueprint\s*\(', content):                      score += 6
    # Medium — initializes extensions
    if re.search(r'\.(init_app)\s*\(', content):                              score += 4
    # Low — just imports flask (common in blueprint files too)
    if re.search(r'from flask import|import flask', content):                 score += 1

    # Penalties — likely a blueprint/route file
    if re.search(r'^(bp|blueprint|blp)\s*=\s*Blueprint\s*\(', content, re.MULTILINE): score -= 8
    # Penalties — test files
    if re.search(r'(test_|_test|conftest)', filename):                        score -= 10

    # Filename bonus
    if filename in ('app.py', 'wsgi.py', 'asgi.py'):                         score += 3
    if filename in ('main.py', 'server.py', 'run.py', 'application.py'):     score += 2
    if filename == '__init__.py':                                              score += 1

    return score


def score_fastapi_file(content, filepath):
    score = 0
    filename = os.path.basename(filepath)

    # High confidence — direct instantiation
    if re.search(r'\bFastAPI\s*\(', content):                                 score += 10
    # High confidence — subclass pattern
    if re.search(r'class\s+\w+\s*\(\s*FastAPI\s*[\),]', content):            score += 10
    # High confidence — factory function
    if re.search(r'def\s+(create|make|build|get|setup|init)_app\s*\(', content): score += 8
    # High confidence — server started here
    if re.search(r'\buvicorn\.run\s*\(', content):                            score += 8
    # Medium — mounts sub-applications
    if re.search(r'\.mount\s*\(', content):                                   score += 5
    # Medium — includes routers (orchestrator file)
    if re.search(r'\.include_router\s*\(', content):                          score += 6
    # Medium — adds middleware
    if re.search(r'\.add_middleware\s*\(', content):                          score += 4
    # Low — just imports fastapi
    if re.search(r'from fastapi import|import fastapi', content):             score += 1

    # Penalties — likely a router file
    if re.search(r'^router\s*=\s*APIRouter\s*\(', content, re.MULTILINE):    score -= 8
    # Penalties — test files
    if re.search(r'(test_|_test|conftest)', filename):                        score -= 10

    # Filename bonus
    if filename in ('main.py', 'app.py', 'asgi.py'):                         score += 3
    if filename in ('server.py', 'application.py'):                           score += 2
    if filename == '__init__.py':                                              score += 1

    return score


def score_django_file(content, filepath):
    score = 0
    filename = os.path.basename(filepath)

    # High confidence — WSGI/ASGI application object
    if re.search(r'get_wsgi_application\s*\(', content):                      score += 10
    if re.search(r'get_asgi_application\s*\(', content):                      score += 10
    # High confidence — sets Django settings
    if re.search(r'DJANGO_SETTINGS_MODULE', content):                         score += 8
    # High confidence — django.setup() called
    if re.search(r'django\.setup\s*\(', content):                             score += 8
    # Medium — imports Django core
    if re.search(r'from django|import django', content):                      score += 2
    # Medium — manage.py pattern
    if re.search(r'execute_from_command_line', content):                      score += 6

    # Penalties — settings files are not entry points
    if re.search(r'^INSTALLED_APPS\s*=', content, re.MULTILINE):             score -= 5
    if re.search(r'^DATABASES\s*=', content, re.MULTILINE):                  score -= 5
    # Penalties — test files
    if re.search(r'(test_|_test|conftest)', filename):                        score -= 10

    # Filename bonus
    if filename in ('wsgi.py', 'asgi.py'):                                    score += 5
    if filename == 'manage.py':                                               score += 3
    if filename == '__init__.py':                                              score += 1

    return score



def parse_entry_from_config_files(cwd):
    """
    Extracts the likely entry point file from Procfile or Dockerfile.
    Returns a filepath string or None.

    Covers patterns like:
        Procfile:   web: gunicorn "mypackage:create_app()"
        Procfile:   web: uvicorn myapp.main:app --host 0.0.0.0
        Dockerfile: CMD ["uvicorn", "myapp.main:app"]
        Dockerfile: CMD ["gunicorn", "mypackage.wsgi:application"]
    """

    def module_to_filepath(cwd, module_string):
        """
        Converts a Python module string to a file path.
        e.g. "mypackage.main:app"  ->  "mypackage/main.py"
        e.g. "mypackage.wsgi"      ->  "mypackage/wsgi.py"
        e.g. "main:app"            ->  "main.py"
        """
        # Strip the :callable part  e.g. mypackage.main:app -> mypackage.main
        module = module_string.split(":")[0].strip().strip('"').strip("'")

        # Convert dots to path separators
        relative_path = module.replace(".", os.sep) + ".py"
        full_path = os.path.join(cwd, relative_path)

        if os.path.exists(full_path):
            return full_path
        return None

    # ── 1. Check Procfile ─────────────────────────────────────────────────
    procfile_path = os.path.join(cwd, "Procfile")
    if os.path.exists(procfile_path):
        try:
            with open(procfile_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue

                    # gunicorn mypackage.wsgi:application
                    # gunicorn "mypackage:create_app()"
                    gunicorn_match = re.search(
                        r'gunicorn\s+"?([a-zA-Z0-9_.]+(?::[a-zA-Z0-9_()]+)?)"?',
                        line
                    )
                    if gunicorn_match:
                        result = module_to_filepath(cwd, gunicorn_match.group(1))
                        if result:
                            return result

                    # uvicorn myapp.main:app
                    uvicorn_match = re.search(
                        r'uvicorn\s+"?([a-zA-Z0-9_.]+(?::[a-zA-Z0-9_]+)?)"?',
                        line
                    )
                    if uvicorn_match:
                        result = module_to_filepath(cwd, uvicorn_match.group(1))
                        if result:
                            return result

                    # python -m myapp or python myapp/main.py
                    python_match = re.search(
                        r'python\s+(?:-m\s+)?([a-zA-Z0-9_./]+\.py)',
                        line
                    )
                    if python_match:
                        full_path = os.path.join(cwd, python_match.group(1))
                        if os.path.exists(full_path):
                            return full_path

        except Exception:
            pass

    # ── 2. Check Dockerfile ───────────────────────────────────────────────
    dockerfile_path = os.path.join(cwd, "Dockerfile")
    if os.path.exists(dockerfile_path):
        try:
            with open(dockerfile_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue

                    # CMD ["uvicorn", "myapp.main:app", "--host", "0.0.0.0"]
                    # CMD ["gunicorn", "mypackage.wsgi:application"]
                    cmd_match = re.search(
                        r'CMD\s*\[.*?"(gunicorn|uvicorn)",\s*"([a-zA-Z0-9_.]+(?::[a-zA-Z0-9_]+)?)"',
                        line
                    )
                    if cmd_match:
                        result = module_to_filepath(cwd, cmd_match.group(2))
                        if result:
                            return result

                    # CMD ["python", "-m", "myapp"]
                    # CMD ["python", "main.py"]
                    python_cmd_match = re.search(
                        r'CMD\s*\[.*?"python[3]?",\s*(?:"-m",\s*)?"([a-zA-Z0-9_./]+)"',
                        line
                    )
                    if python_cmd_match:
                        module_or_file = python_cmd_match.group(1)
                        # Try as direct file path first
                        direct = os.path.join(cwd, module_or_file)
                        if os.path.exists(direct):
                            return direct
                        # Try as module
                        result = module_to_filepath(cwd, module_or_file)
                        if result:
                            return result

                    # ENTRYPOINT ["uvicorn", "myapp.main:app"]
                    entrypoint_match = re.search(
                        r'ENTRYPOINT\s*\[.*?"(gunicorn|uvicorn)",\s*"([a-zA-Z0-9_.]+(?::[a-zA-Z0-9_]+)?)"',
                        line
                    )
                    if entrypoint_match:
                        result = module_to_filepath(cwd, entrypoint_match.group(2))
                        if result:
                            return result

        except Exception:
            pass

    return None


# ── Entry point detection ─────────────────────────────────────────────────────

def detect_entry_point(cwd, framework):
    """
    Finds the main server file for the project.
    Uses a scoring system instead of first-match to handle
    subclasses, factories, and unconventional structures.
    """
    skip_dirs = {
        'tests', 'test', 'migrations', 'static', 'scripts',
        'docs', 'bin', '.ci', '__pycache__', 'node_modules',
        'client', 'frontend', 'dist', 'build', 'coverage',
        'htmlcov', '.git', '.venv', 'venv', 'env', 'media',
    }

    score_fn = {
        'flask':   score_flask_file,
        'fastapi': score_fastapi_file,
        'django':  score_django_file,
    }.get(framework)

    if not score_fn:
        return None

    scored_candidates = []

    def walk(directory, depth=0):
        if depth > 3:
            return
        try:
            entries = os.listdir(directory)
        except Exception:
            return

        for entry in entries:
            full_path = os.path.join(directory, entry)

            if os.path.isdir(full_path):
                if entry in skip_dirs or entry.startswith('.'):
                    continue
                walk(full_path, depth + 1)

            elif entry.endswith('.py'):
                try:
                    with open(full_path, 'r', encoding='utf-8', errors='ignore') as f:
                        content = f.read()
                    score = score_fn(content, full_path)
                    if score > 0:
                        scored_candidates.append((score, full_path))
                except Exception:
                    continue

    walk(cwd)

    if not scored_candidates:
        # Scoring found nothing — try Procfile/Dockerfile as last resort
        return parse_entry_from_config_files(cwd)

    # Return highest scoring file
    scored_candidates.sort(key=lambda x: x[0], reverse=True)
    best_score, best_file = scored_candidates[0]

    # If best score is very low (weak signal), cross-check with
    # Procfile/Dockerfile — if they point to a real file, prefer that
    if best_score <= 3:
        config_entry = parse_entry_from_config_files(cwd)
        if config_entry:
            return config_entry

    return best_file


# ── Run call detection ────────────────────────────────────────────────────────

def find_run_call(file_path, framework, app_var="app"):
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
        "flask": rf"{re.escape(app_var)}\.run\s*\(",
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

        # Try direct instantiation first
        match = re.search(pattern, content)
        if match:
            return match.group(1)

        # ── Flask only: try subclass instantiation ──────────────────────
        # e.g. class Redash(Flask): ... app = Redash()
        if framework == "flask":
            # Find all class names that subclass Flask
            subclass_names = re.findall(
                r'class\s+(\w+)\s*\(\s*Flask\s*[\),]', content
            )
            for subclass_name in subclass_names:
                sub_match = re.search(
                    rf'(\w+)\s*=\s*{re.escape(subclass_name)}\s*\(', content
                )
                if sub_match:
                    return sub_match.group(1)

    except Exception:
        pass

    return "app"


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
        return "botversion_sdk.init(" in content
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


# ── Frontend framework signatures ─────────────────────────────────────────────

FRONTEND_FRAMEWORKS = [
    {
        "name": "nextjs",
        "priority": 10,
        "signature_files": ["next.config.js", "next.config.ts", "next.config.mjs"],
        "inject_candidates": [
            "app/layout.tsx", "app/layout.jsx", "app/layout.js",   # App Router
            "pages/_app.tsx", "pages/_app.jsx", "pages/_app.js",   # Pages Router
        ],
        "inject_type": "nextjs",
    },
    {
        "name": "vite",
        "priority": 1,
        "signature_files": ["vite.config.js", "vite.config.ts", "vite.config.mjs"],
        "inject_candidates": ["index.html"],
        "inject_type": "html",
    },
    {
        "name": "cra",  # Create React App
        "priority": 5,
        "signature_files": [],  # No unique config file — detected by package.json
        "package_signatures": ["react-scripts"],
        "inject_candidates": ["public/index.html"],
        "inject_type": "html",
    },
    {
        "name": "vue",
        "priority": 5,
        "signature_files": ["vue.config.js", "vue.config.ts"],
        "inject_candidates": ["index.html", "public/index.html"],
        "inject_type": "html",
    },
    {
        "name": "nuxt",
        "priority": 10,
        "signature_files": ["nuxt.config.js", "nuxt.config.ts", "nuxt.config.mjs"],
        "inject_candidates": ["app.vue", "layouts/default.vue"],
        "inject_type": "vue",
    },
    {
        "name": "sveltekit",
        "priority": 10,
        "signature_files": ["svelte.config.js", "svelte.config.ts"],
        "inject_candidates": [
            "src/app.html",                     # Shell HTML
            "src/routes/+layout.svelte",        # Root layout
        ],
        "inject_type": "sveltekit",
    },
    {
        "name": "angular",
        "priority": 5,
        "signature_files": ["angular.json"],
        "inject_candidates": ["src/index.html"],
        "inject_type": "html",
    },
    {
        "name": "astro",
        "priority": 10,
        "signature_files": ["astro.config.mjs", "astro.config.ts", "astro.config.js"],
        "inject_candidates": [
            "src/layouts/Layout.astro",
            "src/layouts/BaseLayout.astro",
            "src/pages/index.astro",
        ],
        "inject_type": "astro",
    },
    {
        "name": "remix",
        "priority": 10,
        "signature_files": ["remix.config.js", "remix.config.ts"],
        "inject_candidates": ["app/root.tsx", "app/root.jsx", "app/root.js"],
        "inject_type": "remix",
    },
]

SKIP_DIRS_FRONTEND = {
    "node_modules", ".git", "__pycache__", ".venv", "venv", "env",
    "dist", "build", ".cache", ".next", ".nuxt", ".svelte-kit",
    "email_templates", "emails", "mailers", "static", "media",
}

# ── Detect frontend folder ────────────────────────────────────────────────────

def find_frontend_dirs(cwd):
    """
    Finds all potential frontend directories.
    Checks cwd itself, then scans one level deep.
    Returns a list of directories to check, ordered by priority.
    """
    candidates = [cwd]  # Always check root first

    try:
        for entry in sorted(os.listdir(cwd)):
            full_path = os.path.join(cwd, entry)
            if not os.path.isdir(full_path):
                continue
            if entry in SKIP_DIRS_FRONTEND:
                continue
            # Skip obvious backend-only folders
            if entry in ("fastapi_backend", "django_backend", "flask_backend",
                         "backend", "api", "server", "services"):
                continue
            # Prioritize folders with frontend-y names
            frontend_hints = ("frontend", "client", "web", "ui",
                              "nextjs", "react", "vue", "angular", "svelte")
            if any(hint in entry.lower() for hint in frontend_hints):
                candidates.insert(1, full_path)  # High priority
            else:
                candidates.append(full_path)
    except Exception:
        pass

    return candidates


def detect_frontend_framework(directory):
    """
    Detects the frontend framework in a directory by checking signature files.
    Also reads package.json to detect CRA and other JS frameworks.
    Returns the framework dict or None.
    """
    # Read package.json if present
    pkg_json = {}
    pkg_path = os.path.join(directory, "package.json")
    if os.path.exists(pkg_path):
        try:
            with open(pkg_path, "r", encoding="utf-8") as f:
                pkg_json = json.loads(f.read())
        except Exception:
            pass

    all_deps = {}
    for key in ("dependencies", "devDependencies"):
        all_deps.update(pkg_json.get(key, {}))

    # Check each framework signature
    matches = []
    for fw in FRONTEND_FRAMEWORKS:
        # Check signature files
        for sig_file in fw.get("signature_files", []):
            if os.path.exists(os.path.join(directory, sig_file)):
                matches.append(fw)
                break

        # Check package.json signatures
        for pkg_sig in fw.get("package_signatures", []):
            if pkg_sig in all_deps:
                matches.append(fw)
                break

    if matches:
        return max(matches, key=lambda fw: fw["priority"])

    # Fallback — if package.json has react/vue/angular, guess the framework
    if "next" in all_deps:
        return next(f for f in FRONTEND_FRAMEWORKS if f["name"] == "nextjs")
    if "react" in all_deps and "react-scripts" in all_deps:
        return next(f for f in FRONTEND_FRAMEWORKS if f["name"] == "cra")
    if "vue" in all_deps:
        return next(f for f in FRONTEND_FRAMEWORKS if f["name"] == "vue")
    if "@angular/core" in all_deps:
        return next(f for f in FRONTEND_FRAMEWORKS if f["name"] == "angular")
    if "@sveltejs/kit" in all_deps:
        return next(f for f in FRONTEND_FRAMEWORKS if f["name"] == "sveltekit")
    if "astro" in all_deps:
        return next(f for f in FRONTEND_FRAMEWORKS if f["name"] == "astro")

    return None


def find_frontend_inject_target(directory, framework):
    """
    Given a detected frontend framework and its directory,
    finds the exact file to inject the script tag into.
    Returns {"file": path, "type": inject_type} or None.
    """
    for candidate in framework["inject_candidates"]:
        full_path = os.path.join(directory, candidate)
        if os.path.exists(full_path):
            return {"file": full_path, "type": framework["inject_type"]}

    return None


def find_main_frontend_file(cwd, pkg):
    """
    Universal frontend file detector.
    Scans cwd and subdirectories for any frontend framework,
    then returns the exact file to inject the script tag into.
    """
    frontend_dirs = find_frontend_dirs(cwd)

    for directory in frontend_dirs:
        # Try framework detection first
        framework = detect_frontend_framework(directory)
        if framework:
            target = find_frontend_inject_target(directory, framework)
            if target:
                return target

    # Fallback — look for any index.html with a <body> tag
    html_candidates = [
        "index.html",
        "public/index.html",
        "src/index.html",
        "static/index.html",
        "www/index.html",
    ]

    for directory in frontend_dirs:
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

    # Last resort deep scan — but skip email folders
    found = find_html_file(cwd)
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

    packages = read_requirements(backend_root)
    framework = detect_framework(packages)
    virtualenv = detect_virtualenv(backend_root)
    has_src = detect_src_dir(backend_root)

    # ── If no framework found in root, scan common backend folders ────────
    if not framework["name"]:
        backend_dirs = ["backend", "api", "server", "services", "app"]
        for dir_name in backend_dirs:
            candidate_path = os.path.join(cwd, dir_name)
            if not os.path.isdir(candidate_path):
                continue
            candidate_packages = read_requirements(candidate_path)
            candidate_framework = detect_framework(candidate_packages)
            if candidate_framework["name"]:
                backend_root = candidate_path
                packages = candidate_packages
                framework = candidate_framework
                virtualenv = detect_virtualenv(candidate_path)
                has_src = detect_src_dir(candidate_path)
                break

    result = {
        "cwd": cwd,
        "backend_root": backend_root,
        "packages": packages,
        "framework": framework,
        "virtualenv": virtualenv,
        "has_src": has_src,
    }

    # ── Framework-specific detection ──────────────────────────────────────
    if framework["name"] in ("fastapi", "flask"):
        result["entry_point"] = detect_entry_point(backend_root, framework["name"])
        if result["entry_point"]:
            result["run_call"] = find_run_call(
                result["entry_point"],
                framework["name"],
                result.get("app_var_name", "app")
            )
            result["app_var_name"] = find_app_var_name(result["entry_point"], framework["name"])
        result["routes_dir"] = backend_root

    elif framework["name"] == "django":
        result["entry_point"] = detect_entry_point(backend_root, "django")
        result["django_settings"] = find_django_settings(backend_root)
        result["run_call"] = None
        # routes_dir should be backend_root so SDK can scan ALL urls.py files
        # e.g. accounts/urls.py, contacts/urls.py, leads/urls.py etc.
        result["routes_dir"] = backend_root

    # ── Frontend detection ────────────────────────────────────────────────
    frontend_main_file = None
    frontend_main_file = find_main_frontend_file(cwd, {})
    if not frontend_main_file:
        frontend_main_file = find_main_template_file(cwd)
    result["frontend_main_file"] = frontend_main_file

    # ── Already initialized check ─────────────────────────────────────────
    result["already_initialized"] = detect_existing_botversion(
        result.get("entry_point")
    )

    # ── Find pip executable ───────────────────────────────────────────────
    result["pip_info"] = find_pip_executable(cwd, backend_root, virtualenv)

    return result



def detect_cors(file_path, framework):
    """
    Checks if CORS is already configured in the entry file.
    Returns True if CORS is found, False if not.
    """
    if not file_path or not os.path.exists(file_path):
        return False

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return False

    if framework == "fastapi":
        has_import = "CORSMiddleware" in content or "fastapi.middleware.cors" in content
        has_usage = bool(re.search(r"add_middleware\s*\(\s*CORSMiddleware", content))
        return has_import and has_usage

    if framework == "flask":
        # Check for the import or actual usage on its own line
        has_import = "flask_cors" in content
        has_usage = bool(re.search(r"^\s*CORS\s*\(", content, re.MULTILINE))
        return has_import or has_usage

    if framework == "django":
        return "corsheaders" in content

    return True