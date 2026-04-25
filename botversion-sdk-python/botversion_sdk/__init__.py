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
    """
    global _initialized, _client, _options, _app

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

    # ── Auto-detect framework ─────────────────────────────────────────────────
    framework = _detect_framework(app)

    if not framework:
        print("[BotVersion SDK] ❌ Could not detect framework.")
        print("[BotVersion SDK] ❌ Make sure FastAPI, Flask, or Django is installed.")
        _initialized = False
        return

    _client = BotVersionClient({
        "api_key": api_key,
        "platform_url": options.get("platform_url", "http://localhost:3000"),
        "debug": debug,
        "timeout": options.get("timeout", 30),
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

                if len(endpoints) == 0:
                    print("[BotVersion SDK] ⚠ No Django routes found.")
                    print("[BotVersion SDK] ⚠ Make sure botversion_sdk.init() is called AFTER Django is fully loaded.")
            else:
                print("[BotVersion SDK] ❌ No routes to scan.")
                return

            if endpoints:
                print(f"[BotVersion SDK] Sending {len(endpoints)} endpoints to platform...")
                _client.register_endpoints_now(endpoints)
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


# ── Framework auto-detection ─────────────────────────────────────────────────

def _detect_framework(app):
    if app is not None:
        app_type = type(app).__module__ + "." + type(app).__name__
        if "fastapi" in app_type.lower():
            return "fastapi"
        if "flask" in app_type.lower():
            return "flask"

    if app is None:
        if "django" in sys.modules:
            try:
                from django.conf import settings
                if settings.configured:
                    return "django"
            except Exception:
                pass

    if "fastapi" in sys.modules:
        return "fastapi"
    if "flask" in sys.modules:
        return "flask"
    if "django" in sys.modules:
        return "django"

    return None