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
    attach_starlette_interceptor,
    attach_sanic_interceptor,
    attach_falcon_interceptor,
    attach_bottle_interceptor,
    attach_aiohttp_interceptor,
    attach_tornado_interceptor,
    attach_pyramid_interceptor,
    attach_cherrypy_interceptor,
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
            # ── NEW ───────────────────────────────────────────────────────
            elif framework == "starlette":
                attach_starlette_interceptor(app, _client, interceptor_options)
            elif framework == "sanic":
                attach_sanic_interceptor(app, _client, interceptor_options)
            elif framework == "falcon":
                attach_falcon_interceptor(app, _client, interceptor_options)
            elif framework == "bottle":
                attach_bottle_interceptor(app, _client, interceptor_options)
            elif framework == "aiohttp":
                attach_aiohttp_interceptor(app, _client, interceptor_options)
            elif framework == "tornado":
                attach_tornado_interceptor(app, _client, interceptor_options)
            elif framework == "pyramid":
                attach_pyramid_interceptor(app, _client, interceptor_options)
            elif framework == "cherrypy":
                attach_cherrypy_interceptor(app, _client, interceptor_options)
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
        "platform_url": options.get("platform_url", "https://botversion.com"),
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
    # ── NEW ───────────────────────────────────────────────────────────────────
    elif framework == "starlette":
        attach_starlette_interceptor(app, _client, interceptor_options)
    elif framework == "sanic":
        attach_sanic_interceptor(app, _client, interceptor_options)
    elif framework == "falcon":
        attach_falcon_interceptor(app, _client, interceptor_options)
    elif framework == "bottle":
        attach_bottle_interceptor(app, _client, interceptor_options)
    elif framework == "aiohttp":
        attach_aiohttp_interceptor(app, _client, interceptor_options)
    elif framework == "tornado":
        attach_tornado_interceptor(app, _client, interceptor_options)
    elif framework == "pyramid":
        attach_pyramid_interceptor(app, _client, interceptor_options)
    elif framework == "cherrypy":
        attach_cherrypy_interceptor(app, _client, interceptor_options)
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

            # For any other framework with no app object, skip backend scan
            # but still continue to frontend scan below

            if endpoints:
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
        with app.app_context():
            t = threading.Thread(target=_run_scan, daemon=False)
            t.start()
            t.join(timeout=15)
            app._botversion_scanned = True

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
            t = threading.Timer(3.0, _run_scan)
            t.daemon = False
            t.start()

    elif framework in ("starlette", "sanic", "falcon", "bottle",
                       "aiohttp", "tornado", "pyramid", "cherrypy"):
        t = threading.Timer(3.0, _run_scan)
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

        # ── Existing ──────────────────────────────────────────────────────
        if "fastapi" in app_type.lower():
            return "fastapi"
        if "flask" in app_type.lower():
            return "flask"

        # ── NEW ───────────────────────────────────────────────────────────
        if "starlette" in app_type.lower():
            return "starlette"
        if "sanic" in app_type.lower():
            return "sanic"
        if "falcon" in app_type.lower():
            return "falcon"
        if "bottle" in app_type.lower():
            return "bottle"
        if "aiohttp" in app_type.lower():
            return "aiohttp"
        if "tornado" in app_type.lower():
            return "tornado"
        if "pyramid" in app_type.lower():
            return "pyramid"
        if "cherrypy" in app_type.lower():
            return "cherrypy"

    # ── No app object passed — try detecting from imported modules ────────
    if app is None:
        if "django" in sys.modules:
            try:
                from django.conf import settings
                if settings.configured:
                    return "django"
            except Exception:
                pass

    # ── Fallback — check sys.modules ──────────────────────────────────────
    if "fastapi" in sys.modules:
        return "fastapi"
    if "flask" in sys.modules:
        return "flask"
    if "django" in sys.modules:
        return "django"
    # ── NEW fallbacks ─────────────────────────────────────────────────────
    if "starlette" in sys.modules:
        return "starlette"
    if "sanic" in sys.modules:
        return "sanic"
    if "falcon" in sys.modules:
        return "falcon"
    if "bottle" in sys.modules:
        return "bottle"
    if "aiohttp" in sys.modules:
        return "aiohttp"
    if "tornado" in sys.modules:
        return "tornado"
    if "pyramid" in sys.modules:
        return "pyramid"
    if "cherrypy" in sys.modules:
        return "cherrypy"

    return None