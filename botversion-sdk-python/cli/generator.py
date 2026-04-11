"""
botversion-sdk-python/cli/generator.py

Generates the code snippets that get injected into the user's project.
Mirrors JS cli/generator.js
"""


# ── FastAPI code generation ───────────────────────────────────────────────────

def generate_fastapi_init(info, api_key):
    """
    Generates the botversion_sdk.init() block for FastAPI.
    Mirrors JS generateExpressInit()
    """
    app_var = info.get("app_var_name", "app")
    auth = info.get("auth", {})

    user_context = generate_user_context(auth, "fastapi")

    init_block = f"""
# BotVersion AI Agent — auto-added by botversion-sdk init
botversion_sdk.init(
    {app_var},
    api_key=os.environ.get("BOTVERSION_API_KEY"),{user_context}
)

@{app_var}.post("/api/botversion/chat")
async def botversion_chat(request: Request):
    return await botversion_sdk.chat_handler("fastapi")(request)
"""

    return {
        "init_block": init_block.strip(),
        "imports": "import os\nimport botversion_sdk\nfrom fastapi import Request",
    }


# ── Flask code generation ─────────────────────────────────────────────────────

def generate_flask_init(info, api_key):
    """
    Generates the botversion_sdk.init() block for Flask.
    Mirrors JS generateExpressInit()
    """
    app_var = info.get("app_var_name", "app")
    auth = info.get("auth", {})

    user_context = generate_user_context(auth, "flask")

    init_block = f"""
# BotVersion AI Agent — auto-added by botversion-sdk init
botversion_sdk.init(
    {app_var},
    api_key=os.environ.get("BOTVERSION_API_KEY"),{user_context}
)

@{app_var}.route("/api/botversion/chat", methods=["POST"])
def botversion_chat():
    from flask import request
    return botversion_sdk.chat_handler("flask")(request)
"""

    return {
        "init_block": init_block.strip(),
        "imports": "import os\nimport botversion_sdk",
    }


# ── Django code generation ────────────────────────────────────────────────────

def generate_django_init(info, api_key):
    """
    Generates the botversion_sdk.init() block for Django.
    Mirrors JS generateExpressInit()
    """
    auth = info.get("auth", {})

    user_context = generate_user_context(auth, "django")

    init_block = f"""

botversion_sdk.init(
    api_key=os.environ.get("BOTVERSION_API_KEY"),{user_context}
)
"""

    return {
        "init_block": init_block.strip(),
        "imports": "import os",
    }


# ── Django urls.py chat route ─────────────────────────────────────────────────

def generate_django_chat_url():
    return '    path("api/botversion/chat/", botversion_sdk.chat_handler("django")),'


# ── Django wsgi.py / asgi.py init block ──────────────────────────────────────

def generate_django_wsgi_init(info, api_key):
    """
    Generates the init block to inject into wsgi.py or asgi.py.
    Django needs init after application = get_wsgi_application()
    """
    auth = info.get("auth", {})
    user_context = generate_user_context(auth, "django")

    return f"""
# BotVersion AI Agent — auto-added by botversion-sdk init
import os
import botversion_sdk

botversion_sdk.init(
    api_key=os.environ.get("BOTVERSION_API_KEY"),{user_context}
)
""".strip()


# ── User context generation ───────────────────────────────────────────────────

def generate_user_context(auth, framework):
    """
    Generates the get_user_context option based on detected auth library.
    Mirrors JS generateExpressUserContext()
    """
    if not auth or not auth.get("name"):
        return """
    # get_user_context=lambda request: request.state.user,  # FastAPI
    # get_user_context=lambda request: g.user,              # Flask
    # get_user_context=lambda request: request.user,        # Django"""

    name = auth.get("name", "")

    if name == "flask_login":
        return """
    get_user_context=lambda request: current_user,"""

    elif name == "flask_jwt_extended":
        return """
    get_user_context=lambda request: get_jwt_identity(),"""

    elif name == "django_allauth" or name == "django_rest_framework":
        return """
    get_user_context=lambda request: request.user,"""

    elif name == "djangorestframework_simplejwt":
        return """
    get_user_context=lambda request: request.user,"""

    elif name == "python_jose":
        return """
    # get_user_context=lambda request: decode_token(request),"""

    elif name == "fastapi_users":
        return """
    get_user_context=lambda request: request.state.user,"""

    else:
        return """
    # get_user_context=lambda request: request.state.user,"""


# ── Manual instructions for unsupported frameworks ────────────────────────────

def generate_manual_instructions(framework, api_key):
    """
    Generates manual setup instructions for unsupported frameworks.
    Mirrors JS generateManualInstructions()
    """
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
        f"""
This framework is not yet supported automatically.
Visit https://docs.botversion.com for manual setup instructions.
"""
    )


# ── .env file generation ──────────────────────────────────────────────────────

def generate_env_line(api_key):
    """Generates the .env line for the API key."""
    return f"\n\n# BotVersion API key\nBOTVERSION_API_KEY={api_key}\n"