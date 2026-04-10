# botversion-sdk-python/__init__.py
import sys
import threading

from .client import BotVersionClient
from .scanner import scan_routes
from .interceptor import (
    attach_fastapi_interceptor,
    attach_flask_interceptor,
    attach_django_interceptor,
)

_initialized = False
_client = None


def init(app=None, api_key=None, **options):
    """
    Initialize the BotVersion SDK.

    Works for FastAPI, Flask, and Django — auto-detects the framework.

    Usage:
        # FastAPI
        import botversion_sdk
        botversion_sdk.init(app, api_key="YOUR_KEY")

        # Flask
        import botversion_sdk
        botversion_sdk.init(app, api_key="YOUR_KEY")

        # Django — no app object needed, add to settings.py instead:
        import botversion_sdk
        botversion_sdk.init(api_key="YOUR_KEY")
    """
    global _initialized, _client

    if not api_key:
        print("[BotVersion SDK] ❌ api_key is required.")
        return

    if _initialized:
        print("[BotVersion SDK] ⚠ Already initialized — skipping")
        return

    _initialized = True
    debug = options.get("debug", False)

    if debug:
        print("[BotVersion SDK] Initializing...")

    _client = BotVersionClient({
        "api_key": api_key,
        "platform_url": options.get("platform_url", "https://app.botversion.com"),
        "debug": debug,
        "timeout": options.get("timeout", 5),
        "flush_delay": options.get("flush_delay", 3),
    })

    # ── Auto-detect framework ────────────────────────────────────────────────
    framework = _detect_framework(app)

    if not framework:
        print("[BotVersion SDK] ❌ Could not detect framework.")
        print("[BotVersion SDK] ❌ Make sure FastAPI, Flask, or Django is installed.")
        return

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

    # ── Static scan (delayed to let app finish registering routes) ───────────
    def _run_scan():
        try:
            if debug:
                print(f"[BotVersion SDK] Scanning {framework} routes...")

            endpoints = scan_routes(app, framework)

            if debug:
                print(f"[BotVersion SDK] Found {len(endpoints)} routes")

            if len(endpoints) == 0:
                print("[BotVersion SDK] ⚠ No endpoints found.")
                if framework == "fastapi":
                    print("[BotVersion SDK] ⚠ Make sure routes are defined BEFORE botversion_sdk.init()")
                elif framework == "flask":
                    print("[BotVersion SDK] ⚠ Make sure routes are defined BEFORE botversion_sdk.init()")
                elif framework == "django":
                    print("[BotVersion SDK] ⚠ Make sure botversion_sdk.init() is called AFTER Django is fully loaded.")
                return

            _client.register_endpoints(endpoints)

            if debug:
                print(f"[BotVersion SDK] ✅ Initialization complete — {len(endpoints)} endpoints queued")

        except Exception as e:
            if debug:
                print(f"[BotVersion SDK] ⚠ Scan error: {e}")

    # Run scan in background after 500ms — same as Node SDK
    t = threading.Timer(0.5, _run_scan)
    t.daemon = True
    t.start()


def get_endpoints():
    if not _client:
        raise RuntimeError("BotVersion SDK not initialized. Call botversion_sdk.init() first.")
    return _client.get_endpoints()


def register_endpoint(endpoint):
    if not _client:
        raise RuntimeError("BotVersion SDK not initialized.")
    return _client.register_endpoints([endpoint])


# ── Framework auto-detection ─────────────────────────────────────────────────

def _detect_framework(app):
    """
    Auto-detects which framework is being used.
    Checks the app object first, then falls back to checking sys.modules.
    """

    # Check app object type
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