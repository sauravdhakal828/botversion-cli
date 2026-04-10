# botversion-sdk-python/interceptor.py
import re
import threading

# Paths to always ignore
IGNORE_PATHS = [
    "/health",
    "/favicon.ico",
    "/_next",
    "/static",
    "/docs",
    "/redoc",
    "/openapi.json",
]

# Track reported endpoints — shared across all frameworks
_reported = set()
_lock = threading.Lock()


def should_ignore(path, extra_ignore=None):
    ignore = IGNORE_PATHS + (extra_ignore or [])
    return any(path.startswith(p) for p in ignore)


def normalize_path(path):
    """
    Replace dynamic segments with :id
    /users/123/posts/456 → /users/:id/posts/:id
    """
    segments = []
    for segment in path.split("/"):
        if not segment:
            segments.append(segment)
            continue
        # UUID
        if re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", segment, re.I):
            segments.append(":id")
        # Numeric
        elif re.match(r"^\d+$", segment):
            segments.append(":id")
        # MongoDB ObjectId
        elif re.match(r"^[0-9a-f]{24}$", segment, re.I):
            segments.append(":id")
        # cuid
        elif re.match(r"^c[a-z0-9]{20,}$", segment, re.I):
            segments.append(":id")
        # Long alphanumeric
        elif len(segment) >= 16 and re.search(r"[a-zA-Z]", segment) and re.search(r"[0-9]", segment):
            segments.append(":id")
        else:
            segments.append(segment)
    return "/".join(segments)


def build_body_structure(body):
    """
    Extract key names and value types — never actual values
    """
    if not body or not isinstance(body, dict):
        return None

    sensitive_keys = [
        "password", "token", "secret", "apikey", "api_key",
        "creditcard", "credit_card", "ssn", "cvv", "pin",
    ]

    structure = {}
    for key, val in body.items():
        is_sensitive = any(s in key.lower() for s in sensitive_keys)
        if is_sensitive:
            structure[key] = "[redacted]"
        elif isinstance(val, list):
            structure[key] = "array"
        elif val is None:
            structure[key] = "null"
        else:
            structure[key] = type(val).__name__

    return structure


def report_endpoint(client, method, path, body_structure, options):
    normalized = normalize_path(path)
    key = f"{method}:{normalized}"

    with _lock:
        if key in _reported:
            return
        _reported.add(key)

    # Fire and forget in a background thread
    def _send():
        try:
            client.update_endpoint({
                "method": method,
                "path": normalized,
                "request_body": body_structure,
                "detected_by": "runtime",
            })
        except Exception as e:
            if options.get("debug"):
                print(f"[BotVersion SDK] ⚠ Failed to report endpoint: {e}")

    t = threading.Thread(target=_send, daemon=True)
    t.start()


# ── FastAPI middleware ────────────────────────────────────────────────────────

def attach_fastapi_interceptor(app, client, options):
    try:
        from starlette.middleware.base import BaseHTTPMiddleware
        from starlette.requests import Request

        class BotVersionMiddleware(BaseHTTPMiddleware):
            async def dispatch(self, request: Request, call_next):
                path = request.url.path
                method = request.method.upper()

                if not should_ignore(path, options.get("exclude")):
                    if not options.get("api_prefix") or path.startswith(options["api_prefix"]):
                        try:
                            body = await request.body()
                            import json
                            body_data = json.loads(body) if body else None
                            body_structure = build_body_structure(body_data)
                        except Exception:
                            body_structure = None

                        report_endpoint(client, method, path, body_structure, options)

                return await call_next(request)

        app.add_middleware(BotVersionMiddleware)

        if options.get("debug"):
            print("[BotVersion SDK] ✅ FastAPI middleware attached")

    except ImportError:
        print("[BotVersion SDK] ❌ starlette not found — cannot attach FastAPI middleware")


# ── Flask middleware ──────────────────────────────────────────────────────────

def attach_flask_interceptor(app, client, options):
    try:
        from flask import request as flask_request

        @app.before_request
        def botversion_interceptor():
            path = flask_request.path
            method = flask_request.method.upper()

            if should_ignore(path, options.get("exclude")):
                return
            if options.get("api_prefix") and not path.startswith(options["api_prefix"]):
                return

            try:
                body_structure = build_body_structure(flask_request.get_json(silent=True))
            except Exception:
                body_structure = None

            report_endpoint(client, method, path, body_structure, options)

        if options.get("debug"):
            print("[BotVersion SDK] ✅ Flask interceptor attached")

    except ImportError:
        print("[BotVersion SDK] ❌ Flask not found — cannot attach interceptor")


# ── Django middleware ─────────────────────────────────────────────────────────

class BotVersionDjangoMiddleware:
    """
    Django middleware class — add to MIDDLEWARE in settings.py
    This is instantiated automatically by botversion_sdk.init()
    """
    _client = None
    _options = {}

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        path = request.path
        method = request.method.upper()

        if not should_ignore(path, self.__class__._options.get("exclude")):
            if not self.__class__._options.get("api_prefix") or path.startswith(self.__class__._options["api_prefix"]):
                try:
                    import json
                    body_data = json.loads(request.body) if request.body else None
                    body_structure = build_body_structure(body_data)
                except Exception:
                    body_structure = None

                if self.__class__._client:
                    report_endpoint(self.__class__._client, method, path, body_structure, self.__class__._options)

        return self.get_response(request)


def attach_django_interceptor(client, options):
    """
    Injects BotVersionDjangoMiddleware into Django's MIDDLEWARE setting at runtime
    """
    try:
        from django.conf import settings

        middleware_path = "botversion_sdk.interceptor.BotVersionDjangoMiddleware"

        if middleware_path not in settings.MIDDLEWARE:
            # Django settings are typically a tuple/list — handle both
            if isinstance(settings.MIDDLEWARE, tuple):
                settings.MIDDLEWARE = (middleware_path,) + settings.MIDDLEWARE
            else:
                settings.MIDDLEWARE.insert(0, middleware_path)

        # Pass client and options to the middleware class
        BotVersionDjangoMiddleware._client = client
        BotVersionDjangoMiddleware._options = options

        if options.get("debug"):
            print("[BotVersion SDK] ✅ Django middleware attached")

    except ImportError:
        print("[BotVersion SDK] ❌ Django not found — cannot attach middleware")