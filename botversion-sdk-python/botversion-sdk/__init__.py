# botversion-sdk-python/botversion-sdk/__init__.py
import sys
import threading
import builtins

from .client import BotVersionClient
from .scanner import scan_routes
from .interceptor import (
    attach_fastapi_interceptor,
    attach_flask_interceptor,
    attach_django_interceptor,
    extract_default_context,
)

_initialized = False
_client = None
_options = {}
_app = None


def init(app=None, api_key=None, **options):
    """
    Initialize the BotVersion SDK.

    Works for FastAPI, Flask, and Django — auto-detects the framework.

    Usage:
        # FastAPI
        botversion_sdk.init(app, api_key="YOUR_KEY")

        # Flask
        botversion_sdk.init(app, api_key="YOUR_KEY")

        # Django — no app object needed:
        botversion_sdk.init(api_key="YOUR_KEY")

        # With all options:
        botversion_sdk.init(
            app,
            api_key="YOUR_KEY",
            platform_url="https://app.botversion.com",
            debug=True,
            exclude=["/health", "/ping"],
            api_prefix="/api",
            get_user_context=lambda req: {"userId": req.user.id},
        )
    """
    global _initialized, _client, _options, _app

    print("=== INIT CALLED ===")
    print(f"app type: {type(app)}")
    print(f"app is framework instance: {app is not None}")
    print(f"api_key provided: {bool(api_key)}")
    print(f"options: {options}")
    print("===================")

    if not api_key:
        print("[BotVersion SDK] ❌ api_key is required.")
        return

    # Restore from builtins if module was re-imported after hot reload
    if getattr(builtins, "_botversion_client", None):
        _client = builtins._botversion_client
        _options = builtins._botversion_options
        _initialized = True
        print("[BotVersion SDK] Restored from builtins — skipping re-init")
        return

    if _initialized:
        print("[BotVersion SDK] ⚠ Already initialized — skipping")
        return

    _initialized = True
    _options = dict(options)
    _options["api_key"] = api_key
    _app = app

    debug = options.get("debug", False)

    if debug:
        print("[BotVersion SDK] Initializing...")
        if app is not None:
            print(f"[BotVersion SDK] Mode: {_detect_framework(app) or 'unknown'}")
        else:
            print("[BotVersion SDK] Mode: Django (no app object)")

    # ── Auto-detect framework FIRST ──────────────────────────────────────────
    framework = _detect_framework(app)

    if not framework:
        print("[BotVersion SDK] ❌ Could not detect framework.")
        print("[BotVersion SDK] ❌ Make sure FastAPI, Flask, or Django is installed.")
        _initialized = False  # Reset so user can try again after fixing
        return

    # Only create client if framework is valid
    _client = BotVersionClient({
        "api_key": api_key,
        "platform_url": options.get("platform_url", "https://app.botversion.com"),
        "debug": debug,
        "timeout": options.get("timeout", 5),
        "flush_delay": options.get("flush_delay", 3),
    })

    # Store globally so hot-reload can restore state
    builtins._botversion_client = _client
    builtins._botversion_options = _options

    if debug:
        print(f"[BotVersion SDK] ✅ Framework detected: {framework}")

    interceptor_options = {
        "exclude": options.get("exclude", []),
        "api_prefix": options.get("api_prefix", None),
        "debug": debug,
        "get_user_context": options.get("get_user_context", None),
    }

    # ── Attach runtime interceptor ───────────────────────────────────────────
    if framework == "fastapi":
        attach_fastapi_interceptor(app, _client, interceptor_options)
    elif framework == "flask":
        attach_flask_interceptor(app, _client, interceptor_options)
    elif framework == "django":
        attach_django_interceptor(_client, interceptor_options)
    else:
        print(f"[BotVersion SDK] ❌ Unsupported framework: {framework}")
        print("[BotVersion SDK] ❌ Currently supports FastAPI, Flask, and Django only.")
        print("[BotVersion SDK] ❌ Visit https://docs.botversion.com for supported frameworks.")
        return

    if debug:
        print("[BotVersion SDK] ✅ Runtime interceptor attached")

    # ── Static scan (delayed 500ms — let app finish registering routes) ──────
    def _run_scan():
        try:
            endpoints = []

            if app is not None:
                print(f"[BotVersion SDK] Scanning {framework} routes...")
                endpoints = scan_routes(app, framework)
                print(f"[BotVersion SDK] Found {len(endpoints)} {framework} routes")

                if debug:
                    import json
                    print(f"[BotVersion SDK] Endpoints: {json.dumps(endpoints, indent=2)}")

                if len(endpoints) == 0:
                    print("[BotVersion SDK] ⚠ No endpoints found.")
                    print("[BotVersion SDK] ⚠ Make sure routes are defined BEFORE botversion_sdk.init()")

            elif framework == "django":
                print("[BotVersion SDK] Scanning Django routes...")
                endpoints = scan_routes(None, "django")
                print(f"[BotVersion SDK] Found {len(endpoints)} Django routes")

                if debug:
                    import json
                    print(f"[BotVersion SDK] Endpoints: {json.dumps(endpoints, indent=2)}")

                if len(endpoints) == 0:
                    print("[BotVersion SDK] ⚠ No Django routes found.")
                    print("[BotVersion SDK] ⚠ Make sure botversion_sdk.init() is called AFTER Django is fully loaded.")

            else:
                print("[BotVersion SDK] ❌ No routes to scan.")
                print("[BotVersion SDK] ❌ For FastAPI/Flask: pass your app — botversion_sdk.init(app, api_key='...')")
                print("[BotVersion SDK] ❌ For Django: botversion_sdk.init(api_key='...')")
                return

            if endpoints:
                print(f"[BotVersion SDK] Sending {len(endpoints)} endpoints to platform...")
                _client.register_endpoints(endpoints)
                print(f"[BotVersion SDK] ✅ Static scan complete — {len(endpoints)} endpoints registered")

        except Exception as e:
            print(f"[BotVersion SDK] ❌ Scan error: {e}")
            if debug:
                import traceback
                traceback.print_exc()

        print("[BotVersion SDK] ✅ Initialization complete")

    t = threading.Timer(0.5, _run_scan)
    t.daemon = True
    t.start()


def get_endpoints():
    """Get all registered endpoints for this workspace."""
    if not _client:
        raise RuntimeError("BotVersion SDK not initialized. Call botversion_sdk.init() first.")
    return _client.get_endpoints()


def register_endpoint(endpoint):
    """Manually register a single endpoint."""
    if not _client:
        raise RuntimeError("BotVersion SDK not initialized.")
    return _client.register_endpoints([endpoint])


# ── Chat handler ─────────────────────────────────────────────────────────────

def chat_handler(framework="fastapi"):
    """
    Returns a ready-made chat route handler for the given framework.

    FastAPI:
        @app.post("/api/chat")
        async def chat_route(request: Request):
            return await botversion_sdk.chat_handler("fastapi")(request)

    Flask:
        @app.route("/api/chat", methods=["POST"])
        def chat_route():
            return botversion_sdk.chat_handler("flask")(request)

    Django:
        # urls.py
        path("api/chat/", botversion_sdk.chat_handler("django")),
    """
    if framework == "fastapi":
        async def _fastapi_handler(request):
            return await _handle_chat_fastapi(request)
        return _fastapi_handler

    elif framework == "flask":
        def _flask_handler(request):
            return _handle_chat_flask(request)
        return _flask_handler

    elif framework == "django":
        def _django_handler(request):
            return _handle_chat_django(request)
        return _django_handler

    else:
        raise ValueError(f"[BotVersion SDK] Unsupported framework: {framework}")


async def _handle_chat_fastapi(request):
    """FastAPI async chat — mirrors JS nextHandler."""
    import json
    from starlette.responses import JSONResponse

    if not _client:
        return JSONResponse({"error": "BotVersion SDK not initialized."}, status_code=500)

    try:
        body = await request.body()
        data = json.loads(body) if body else {}
    except Exception:
        data = {}

    print(f"[BotVersion] request body: {data}")
    print(f"[BotVersion] chatbotId from body: {data.get('chatbotId')}")

    get_user_context = _options.get("get_user_context", None)
    if get_user_context:
        from .interceptor import _process_user_context
        user_context = _process_user_context(get_user_context(request))
    else:
        user_context = extract_default_context(request, "fastapi")
    print(f"[BotVersion] userContext being sent: {user_context}")

    try:
        response = await _client.agent_chat_async({
            "message": data.get("message", ""),
            "conversation_history": data.get("conversationHistory", []),
            "page_context": data.get("pageContext", {}),
            "user_context": user_context,
            "chatbot_id": data.get("chatbotId"),
            "public_key": data.get("publicKey"),
        })
        return JSONResponse(response, status_code=200)
    except Exception as e:
        print(f"[BotVersion SDK] chat error: {e}")
        return JSONResponse({"error": "Agent error"}, status_code=500)


def _handle_chat_flask(request):
    """Flask sync chat handler."""
    from flask import jsonify

    if not _client:
        return jsonify({"error": "BotVersion SDK not initialized."}), 500

    data = request.get_json(silent=True) or {}

    print(f"[BotVersion] request body: {data}")
    print(f"[BotVersion] chatbotId from body: {data.get('chatbotId')}")

    get_user_context = _options.get("get_user_context", None)
    if get_user_context:
        from .interceptor import _process_user_context
        user_context = _process_user_context(get_user_context(request))
    else:
        user_context = extract_default_context(request, "flask")
    print(f"[BotVersion] userContext being sent: {user_context}")

    try:
        response = _client.agent_chat({
            "message": data.get("message", ""),
            "conversation_history": data.get("conversationHistory", []),
            "page_context": data.get("pageContext", {}),
            "user_context": user_context,
            "chatbot_id": data.get("chatbotId"),
            "public_key": data.get("publicKey"),
        })
        return jsonify(response), 200
    except Exception as e:
        print(f"[BotVersion SDK] chat error: {e}")
        return jsonify({"error": "Agent error"}), 500


def _handle_chat_django(request):
    """Django sync chat handler."""
    import json
    from django.http import JsonResponse

    if not _client:
        return JsonResponse({"error": "BotVersion SDK not initialized."}, status=500)

    try:
        data = json.loads(request.body) if request.body else {}
    except Exception:
        data = {}

    print(f"[BotVersion] request body: {data}")
    print(f"[BotVersion] chatbotId from body: {data.get('chatbotId')}")

    get_user_context = _options.get("get_user_context", None)
    if get_user_context:
        from .interceptor import _process_user_context
        user_context = _process_user_context(get_user_context(request))
    else:
        user_context = extract_default_context(request, "django")
    print(f"[BotVersion] userContext being sent: {user_context}")

    try:
        response = _client.agent_chat({
            "message": data.get("message", ""),
            "conversation_history": data.get("conversationHistory", []),
            "page_context": data.get("pageContext", {}),
            "user_context": user_context,
            "chatbot_id": data.get("chatbotId"),
            "public_key": data.get("publicKey"),
        })
        return JsonResponse(response, status=200)
    except Exception as e:
        print(f"[BotVersion SDK] chat error: {e}")
        return JsonResponse({"error": "Agent error"}, status=500)


# ── Framework auto-detection ─────────────────────────────────────────────────

def _detect_framework(app):
    """
    Auto-detects which framework is being used.
    Checks the app object type first, then falls back to sys.modules.
    """
    if app is not None:
        app_type = type(app).__module__ + "." + type(app).__name__

        if "fastapi" in app_type.lower():
            return "fastapi"

        if "flask" in app_type.lower():
            return "flask"

    # No app passed — check if Django is running
    if app is None:
        if "django" in sys.modules:
            try:
                from django.conf import settings
                if settings.configured:
                    return "django"
            except Exception:
                pass

    # Fallback — check sys.modules for installed packages
    if "fastapi" in sys.modules:
        return "fastapi"
    if "flask" in sys.modules:
        return "flask"
    if "django" in sys.modules:
        return "django"

    return None
