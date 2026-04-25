"""
botversion-sdk-python/botversion-sdk/cli/generator.py

Generates the code snippets that get injected into the user's project.
Mirrors JS cli/generator.js
"""

import os


# ── Helper: build routes_dir expression ──────────────────────────────────────

def _build_routes_dir_expression(entry_point, backend_root):
    """
    Calculates how many os.path.dirname() calls are needed
    to go from entry_point up to backend_root, then returns
    a Python expression string that resolves to backend_root
    at runtime inside the user's project.

    Examples:
        entry_point  = /project/backend/wsgi.py
        backend_root = /project/backend/
        depth = 0 → os.path.dirname(os.path.abspath(__file__))

        entry_point  = /project/backend/crm/wsgi.py
        backend_root = /project/backend/
        depth = 1 → os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

        entry_point  = /project/backend/app/api/main.py
        backend_root = /project/backend/
        depth = 2 → os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    """
    if not entry_point or not backend_root:
        return 'os.path.dirname(os.path.abspath(__file__))'

    try:
        rel = os.path.relpath(entry_point, backend_root)
        # depth = number of directories between backend_root and entry_point
        # e.g. crm/wsgi.py → depth 1, app/api/main.py → depth 2
        depth = len(rel.split(os.sep)) - 1
    except ValueError:
        # Windows — cross-drive relpath fails
        return 'os.path.dirname(os.path.abspath(__file__))'

    # Always need at least 1 dirname to go from file → its own directory
    expression = 'os.path.abspath(__file__)'
    for _ in range(depth + 1):
        expression = f'os.path.dirname({expression})'

    return expression


# ── FastAPI code generation ───────────────────────────────────────────────────

def generate_fastapi_init(info, api_key):
    app_var = info.get("app_var_name", "app")
    needs_dotenv = not info.get("has_dotenv_loader", False)
    dotenv_import = "from dotenv import load_dotenv\nload_dotenv()\n\n" if needs_dotenv else ""

    routes_dir = _build_routes_dir_expression(
        info.get("entry_point"),
        info.get("backend_root")
    )

    init_block = f"""
# BotVersion AI Agent — auto-added by botversion-sdk init
botversion_sdk.init(
    {app_var},
    api_key=os.environ.get("BOTVERSION_API_KEY"),
    platform_url=os.environ.get("BOTVERSION_PLATFORM_URL", "https://app.botversion.com"),
    routes_dir={routes_dir},
)
"""
    imports = f"{dotenv_import}import os\nimport botversion_sdk"
    return {"init_block": init_block.strip(), "imports": imports}


# ── Flask ─────────────────────────────────────────────────────────────────────

def generate_flask_init(info, api_key):
    app_var = info.get("app_var_name", "app")

    routes_dir = _build_routes_dir_expression(
        info.get("entry_point"),
        info.get("backend_root")
    )

    init_block = f"""
# BotVersion AI Agent — auto-added by botversion-sdk init
botversion_sdk.init(
    {app_var},
    api_key=os.environ.get("BOTVERSION_API_KEY"),
    platform_url=os.environ.get("BOTVERSION_PLATFORM_URL", "https://app.botversion.com"),
    routes_dir={routes_dir},
)
"""
    return {"init_block": init_block.strip(), "imports": "import os\nimport botversion_sdk"}


# ── Django ────────────────────────────────────────────────────────────────────

def generate_django_wsgi_init(info, api_key):
    routes_dir = _build_routes_dir_expression(
        info.get("entry_point"),
        info.get("backend_root")
    )

    return f"""
import os
import botversion_sdk

botversion_sdk.init(
    api_key=os.environ.get("BOTVERSION_API_KEY"),
    platform_url=os.environ.get("BOTVERSION_PLATFORM_URL", "https://app.botversion.com"),
    routes_dir={routes_dir},
)
""".strip()


# ── Manual instructions for unsupported frameworks ────────────────────────────

def generate_manual_instructions(framework, api_key):
    instructions = {
        "tornado": f"""
Tornado support is coming soon. For now, add this manually:

    import os
    import botversion_sdk

    # After defining your handlers:
    botversion_sdk.init(api_key=os.environ.get("BOTVERSION_API_KEY"))

    # See: https://docs.botversion.com/tornado
""",
        "aiohttp": f"""
aiohttp support is coming soon. For now, add this manually:

    import os
    import botversion_sdk

    botversion_sdk.init(api_key=os.environ.get("BOTVERSION_API_KEY"))

    # See: https://docs.botversion.com/aiohttp
""",
        "sanic": f"""
Sanic support is coming soon. For now, add this manually:

    import os
    import botversion_sdk

    botversion_sdk.init(app, api_key=os.environ.get("BOTVERSION_API_KEY"))

    # See: https://docs.botversion.com/sanic
""",
    }

    return instructions.get(
        framework,
        """
This framework is not yet supported automatically.
Visit https://docs.botversion.com for manual setup instructions.
"""
    )


# ── CORS generation ───────────────────────────────────────────────────────────

def generate_fastapi_cors(app_var, allowed_origins):
    return f"""# CORS — auto-added by BotVersion init
from fastapi.middleware.cors import CORSMiddleware

{app_var}.add_middleware(
    CORSMiddleware,
    allow_origins={repr(allowed_origins)},
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)""".strip()


def generate_flask_cors(app_var, allowed_origins):
    return f"""# CORS — auto-added by BotVersion init
from flask_cors import CORS

CORS({app_var}, origins={repr(allowed_origins)})""".strip()


def generate_django_cors_settings(allowed_origins):
    return f"\n# BotVersion — only allow requests from BotVersion platform\nCORS_ALLOWED_ORIGINS = {repr(allowed_origins)}\n"


def generate_django_cors_manual_instructions():
    return (
        "Add to your settings.py:\n\n"
        "    INSTALLED_APPS += ['corsheaders']\n\n"
        "    MIDDLEWARE = ['corsheaders.middleware.CorsMiddleware'] + MIDDLEWARE\n\n"
        "    CORS_ALLOWED_ORIGINS = ['http://localhost:3000']"
    )


# ── .env file generation ──────────────────────────────────────────────────────

def generate_env_line(api_key):
    return f"\n\n# BotVersion API key\nBOTVERSION_API_KEY={api_key}\n"