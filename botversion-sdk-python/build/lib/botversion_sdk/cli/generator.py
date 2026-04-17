"""
botversion-sdk-python/botversion-sdk/cli/generator.py

Generates the code snippets that get injected into the user's project.
Mirrors JS cli/generator.js
"""


# ── FastAPI code generation ───────────────────────────────────────────────────

def generate_fastapi_init(info, api_key):
    app_var = info.get("app_var_name", "app")
    auth = info.get("auth", {})
    user_context = generate_user_context(auth, "fastapi")
    needs_dotenv = not info.get("has_dotenv_loader", False)

    dotenv_import = "from dotenv import load_dotenv\nload_dotenv()\n\n" if needs_dotenv else ""

    init_block = f"""
# BotVersion AI Agent — auto-added by botversion-sdk init
@{app_var}.post("/api/botversion/chat", tags=["botversion"])
async def botversion_chat(request: Request):
    return await botversion_sdk.chat_handler("fastapi")(request)

botversion_sdk.init(
    {app_var},
    api_key=os.environ.get("BOTVERSION_API_KEY"),
    platform_url=os.environ.get("BOTVERSION_PLATFORM_URL", "https://app.botversion.com"),{user_context}
)
"""

    imports = f"{dotenv_import}import os\nimport botversion_sdk\nfrom fastapi import Request"

    return {
        "init_block": init_block.strip(),
        "imports": imports,
    }


# ── Flask code generation ─────────────────────────────────────────────────────

def generate_flask_init(info, api_key):
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
    auth = info.get("auth", {})
    user_context = generate_user_context(auth, "django")

    init_block = f"""
# BotVersion AI Agent — auto-added by botversion-sdk init
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
    return {
        "url_code": 'path("api/botversion/chat/", csrf_exempt(botversion_sdk.chat_handler("django"))),',
        "import": "from django.views.decorators.csrf import csrf_exempt",
    }


# ── Django wsgi.py / asgi.py init block ──────────────────────────────────────

def generate_django_wsgi_init(info, api_key):
    auth = info.get("auth", {})
    user_context = generate_user_context(auth, "django")

    return f"""
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
        if framework == "fastapi":
            return """
    # get_user_context=lambda request: request.state.user,"""
        elif framework == "flask":
            return """
    # get_user_context=lambda request: g.user,"""
        elif framework == "django":
            return """
    # get_user_context=lambda request: request.user,"""
        return ""

    name = auth.get("name", "")

    # ── FastAPI ───────────────────────────────────────────────────────────────
    if name == "fastapi_users":
        return """
    get_user_context=lambda request: getattr(request.state, "user", None),"""

    elif name == "pyjwt":
        if framework == "flask":
            return """
        get_user_context=lambda request: g.user,"""
        elif framework == "django":
            return """
        get_user_context=lambda request: request.user,"""
        else:
            return """
        get_user_context=lambda request: getattr(request.state, "user", None),"""

    elif name == "authx":
        return """
    get_user_context=lambda request: getattr(request.state, "user", None),"""

    elif name == "fastapi_jwt_auth":
        return """
    get_user_context=lambda request: getattr(request.state, "user", None),"""

    elif name == "fastapi_security":
        return """
    get_user_context=lambda request: getattr(request.state, "user", None),"""

    elif name == "joserfc":
        return """
    get_user_context=lambda request: getattr(request.state, "user", None),"""

    # ── Flask ─────────────────────────────────────────────────────────────────
    elif name == "flask_login":
        return """
    get_user_context=lambda request: current_user,"""

    elif name == "flask_jwt_extended":
        # get_jwt_identity() returns a plain string (e.g. "user_123"), not a dict.
        # Wrap it so _process_user_context() receives a proper dict.
        return """
    get_user_context=lambda request: {"userId": get_jwt_identity()} if get_jwt_identity() else {},"""

    elif name == "flask_security":
        return """
    get_user_context=lambda request: current_user,"""

    elif name == "flask_praetorian":
        # current_user() returns a model object — use __dict__ to convert safely.
        return """
    get_user_context=lambda request: flask_praetorian.current_user().__dict__ if flask_praetorian.current_user() else {},"""

    elif name == "flask_httpauth":
        # Detect the HTTPAuth instance variable name from the entry file.
        # Falls back to a commented placeholder if it cannot be detected.
        httpauth_var = auth.get("httpauth_var_name")
        if httpauth_var:
            return f"""
    get_user_context=lambda request: {httpauth_var}.current_user(),"""
        else:
            return """
    # get_user_context=lambda request: your_auth.current_user(),  # replace 'your_auth' with your HTTPAuth instance name"""

    # ── Django ────────────────────────────────────────────────────────────────
    elif name == "django_allauth":
        return """
    get_user_context=lambda request: request.user,"""

    elif name == "djangorestframework_simplejwt":
        return """
    get_user_context=lambda request: request.user,"""

    elif name == "django_rest_framework":
        return """
    get_user_context=lambda request: request.user,"""

    elif name == "django_oauth_toolkit":
        return """
    get_user_context=lambda request: request.user,"""

    elif name == "dj_rest_auth":
        return """
    get_user_context=lambda request: request.user,"""

    # ── General ───────────────────────────────────────────────────────────────
    elif name == "authlib":
        return """
    # get_user_context=lambda request: request.state.user,"""

    elif name == "joserfc":
        return """
    get_user_context=lambda request: request.state.user,"""

    elif name == "passlib":
        # passlib is a hashing library — it does not provide a user session object.
        return """
    # get_user_context=lambda request: request.state.user,  # passlib handles hashing only — add your own session/user logic"""

    elif name == "itsdangerous":
        # itsdangerous handles token signing only — no user session object.
        return """
    # get_user_context=lambda request: request.state.user,  # itsdangerous handles token signing only — add your own user logic"""

    else:
        if framework == "fastapi":
            return """
    # get_user_context=lambda request: request.state.user,"""
        elif framework == "flask":
            return """
    # get_user_context=lambda request: g.user,"""
        elif framework == "django":
            return """
    # get_user_context=lambda request: request.user,"""
        return ""


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
        f"""
This framework is not yet supported automatically.
Visit https://docs.botversion.com for manual setup instructions.
"""
    )


# ── .env file generation ──────────────────────────────────────────────────────

def generate_env_line(api_key):
    """Generates the .env line for the API key."""
    return f"\n\n# BotVersion API key\nBOTVERSION_API_KEY={api_key}\n"



# ── Frontend proxy config generation ─────────────────────────────────────────

def generate_frontend_proxy(framework, backend_port=8000):
    """
    Generates the correct proxy config for each frontend framework.
    """

    if framework in ("react-vite", "vue", "svelte", "sveltekit", "solid", "preact"):
        return {
            "type": "vite",
            "file": "vite.config.js",
            "code": f"""    server: {{
    proxy: {{
      '/api/botversion/chat': {{
        target: 'http://localhost:{backend_port}',
        changeOrigin: true,
        rewrite: (path) => path + '/',
      }},
      '/api': {{
        target: 'http://localhost:{backend_port}',
        changeOrigin: true,
      }},
    }},
  }},""",
        }

    if framework == "react-cra":
        return {
            "type": "cra",
            "file": "package.json",
            "code": f"http://localhost:{backend_port}",
        }

    if framework == "next":
        return {
            "type": "next",
            "file": "next.config.js",
            "code": f"""  async rewrites() {{
    return [
      {{
        source: '/api/botversion/chat',
        destination: 'http://localhost:{backend_port}/api/botversion/chat/',
      }},
      {{
        source: '/api/:path*',
        destination: 'http://localhost:{backend_port}/api/:path*',
      }},
    ]
  }},""",
        }

    if framework == "angular":
        return {
            "type": "angular",
            "proxy_file": "proxy.conf.json",
            "code": {
                "/api/botversion/chat": {
                    "target": f"http://localhost:{backend_port}",
                    "secure": False,
                    "changeOrigin": True,
                    "pathRewrite": {"^/api/botversion/chat": "/api/botversion/chat/"},
                },
                "/api": {
                    "target": f"http://localhost:{backend_port}",
                    "secure": False,
                    "changeOrigin": True,
                },
            },
        }

    if framework == "vue":
        return {
            "type": "vue-cli",
            "file": "vue.config.js",
            "code": f"""  devServer: {{
    proxy: {{
      '/api/botversion/chat': {{
        target: 'http://localhost:{backend_port}',
        changeOrigin: true,
        pathRewrite: {{ '^/api/botversion/chat': '/api/botversion/chat/' }},
      }},
      '/api': {{
        target: 'http://localhost:{backend_port}',
        changeOrigin: true,
      }},
    }},
  }},""",
        }

    return None


# ── Frontend user context generation ─────────────────────────────────────────

def generate_frontend_user_context(auth, frontend_framework):
    """
    Generates the correct JS snippet to inject into the developer's frontend
    so the widget receives the real logged-in user's context.

    Returns a dict:
    {
        "code": "the JS code to inject",
        "manual": True/False  — if True, we couldn't automate it fully
        "note": "optional message to show the developer"
    }
    """
    auth_name = auth.get("name") if auth else None

    # ── JWT-based auth — token is in localStorage ─────────────────────────────
    # We can decode it right in the browser — fully automatic
    JWT_AUTHS = [
        "djangorestframework_simplejwt",
        "flask_jwt_extended",
        "pyjwt",
        "python_jose",
        "authx",
        "fastapi_jwt_auth",
        "fastapi_security",
        "joserfc",
        "django_oauth_toolkit",
        "dj_rest_auth",
    ]

    # ── Session/cookie-based auth — need to fetch from an endpoint ────────────
    # We inject a fetch('/api/me') call — developer may need to create that endpoint
    SESSION_AUTHS = [
        "flask_login",
        "flask_security",
        "flask_httpauth",
        "flask_praetorian",
        "django_allauth",
        "django_rest_framework",
        "fastapi_users",
        "authlib",
        "passlib",
        "itsdangerous",
    ]

    if auth_name in JWT_AUTHS:
        # JWT token is stored in localStorage — decode the payload directly
        # This works in the browser without any extra API call
        code = """
// BotVersion — auto-added by botversion-sdk init
// Reads the logged-in user from your JWT token
(function() {
  try {
    var token = localStorage.getItem('access_token') ||
                localStorage.getItem('token') ||
                localStorage.getItem('auth_token') ||
                localStorage.getItem('jwt');
    if (token) {
      var payload = JSON.parse(atob(token.split('.')[1]));
      if (window.cw) {
        window.cw('init', {
          userContext: payload
        });
      }
    }
  } catch(e) {
    console.warn('[BotVersion] Could not read user from token:', e);
  }
})();
""".strip()

        return {
            "code": code,
            "manual": False,
            "note": (
                "We tried to read the JWT from localStorage using common key names "
                "(access_token, token, auth_token, jwt). "
                "If your app uses a different key, replace it in the injected code."
            ),
        }

    elif auth_name in SESSION_AUTHS:
        # Session-based — we fetch from /api/me
        # Developer may need to create this endpoint if it doesn't exist
        code = """
// BotVersion — auto-added by botversion-sdk init
// Fetches the logged-in user from your /api/me endpoint
(function() {
  fetch('/api/me', { credentials: 'include' })
    .then(function(res) { return res.ok ? res.json() : null; })
    .then(function(user) {
      if (user && window.cw) {
        window.cw('init', {
          userContext: user
        });
      }
    })
    .catch(function(e) {
      console.warn('[BotVersion] Could not fetch user context:', e);
    });
})();
""".strip()

        return {
            "code": code,
            "manual": True,
            "note": (
                "We injected a fetch('/api/me') call to get the logged-in user. "
                "Make sure your backend has a GET /api/me endpoint that returns "
                "the current user as JSON. If your endpoint has a different URL, "
                "update it in the injected code."
            ),
        }

    else:
        # Unknown auth — inject a placeholder the developer fills in
        code = """
// BotVersion — auto-added by botversion-sdk init
// TODO: Replace YOUR_USER_OBJECT with your actual logged-in user
// Examples:
//   userContext: currentUser
//   userContext: { userId: auth.user.id, email: auth.user.email }
if (window.cw) {
  window.cw('init', {
    userContext: YOUR_USER_OBJECT_HERE || {}
  });
}
""".strip()

        return {
            "code": code,
            "manual": True,
            "note": (
                "We could not detect your auth library automatically. "
                "Replace YOUR_USER_OBJECT_HERE with your actual logged-in user object."
            ),
        }