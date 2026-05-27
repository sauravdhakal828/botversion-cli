# botversion-sdk-python/botversion-sdk/__init__.py
import sys
import threading
import builtins
import os

from .client import BotVersionClient
from .scanner import scan_routes, scan_frontend_routes
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

    # Restore from builtins if module was re-imported after hot reload
    if getattr(builtins, "_botversion_client", None):
        _client = builtins._botversion_client
        _options = builtins._botversion_options
        _initialized = True
        # Re-attach interceptor after hot reload
        framework = _detect_framework(app)
        if framework and _client:
            interceptor_options = {
                "exclude": _options.get("exclude", []),
                "api_prefix": _options.get("api_prefix", None),
                "debug": _options.get("debug", False),
            }
            if framework == "fastapi":
                attach_fastapi_interceptor(app, _client, interceptor_options)
            elif framework == "flask":
                attach_flask_interceptor(app, _client, interceptor_options)
            elif framework == "django":
                attach_django_interceptor(_client, interceptor_options)
        return

    _initialized = True
    _options = dict(options)
    _options["api_key"] = api_key
    _app = app

    debug = options.get("debug", False)

    # ── Auto-detect framework ─────────────────────────────────────────────────
    framework = _detect_framework(app)

    if not framework:
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
        return

    # ── Static scan (delayed 500ms — let app finish registering routes) ──────
    def _run_scan():
        try:
            endpoints = []

            if app is not None:
                endpoints = scan_routes(app, framework)

            elif framework == "django":
                endpoints = scan_routes(None, "django")

            else:
                return

            if endpoints:
                missing = [ep for ep in endpoints if ep.get("requestBody") is None and ep["method"] not in ("GET", "DELETE")]
                for ep in missing:
                    print(f"[botversion:scan] MISSING: {ep['method']} {ep['path']}")
                _client.register_endpoints_now(endpoints)

        except Exception as e:
            if debug:
                import traceback
                traceback.print_exc()

        cwd = options.get("cwd", os.getcwd())
        route_patterns = scan_frontend_routes(cwd)
        if route_patterns:
            _client.register_route_patterns(route_patterns)

    if framework == "flask":
        # Scan on startup
        with app.app_context():
            t = threading.Thread(target=_run_scan, daemon=False)
            t.start()
            t.join(timeout=15)
            app._botversion_scanned = True

        # Keep after_request as fallback for runtime detection
        @app.after_request
        def _botversion_first_scan(response):
            if not getattr(app, '_botversion_scanned', False):
                app._botversion_scanned = True
                t = threading.Thread(target=_run_scan, daemon=False)
                t.start()
                t.join(timeout=15)
            return response

    elif framework == "fastapi":
        @app.on_event("startup")
        async def _botversion_startup_scan():
            if not getattr(app, '_botversion_scanned', False):
                app._botversion_scanned = True
                t = threading.Thread(target=_run_scan, daemon=False)
                t.start()
                t.join(timeout=15)

        # Keep middleware as fallback for runtime detection
        @app.middleware("http")
        async def _botversion_first_scan(request, call_next):
            if not getattr(app, '_botversion_scanned', False):
                app._botversion_scanned = True
                t = threading.Thread(target=_run_scan, daemon=False)
                t.start()
                t.join(timeout=15)
            return await call_next(request)

    elif framework == "django":
        try:
            from django.apps import apps
            if apps.ready:
                t = threading.Thread(target=_run_scan, daemon=False)
                t.start()
                t.join(timeout=15)
        except Exception:
            t = threading.Timer(2.0, _run_scan)
            t.daemon = False
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