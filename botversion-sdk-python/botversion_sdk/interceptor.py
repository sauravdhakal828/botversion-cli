# botversion-sdk-python/botversion-sdk/interceptor.py
import re
import json
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
    "/public",
    "/admin",
    "/media",
]

# Track reported endpoints — keyed by method:path:body_fields
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
        # Long alphanumeric (likely an ID)
        elif len(segment) >= 16 and re.search(r"[a-zA-Z]", segment) and re.search(r"[0-9]", segment):
            segments.append(":id")
        else:
            segments.append(segment)
    return "/".join(segments)


def build_body_structure(body):
    """
    Extract key names and value types — never actual values (security).
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


def body_structure_to_json_schema(body_structure):
    """
    Convert body structure dict to JSON Schema format.
    """
    if not body_structure:
        return None

    properties = {}
    for key, type_name in body_structure.items():
        if type_name in ("[redacted]", "null"):
            properties[key] = {"type": "string"}
        else:
            properties[key] = {"type": type_name}

    return {"type": "object", "properties": properties}


def report_endpoint(client, method, path, body_structure, options):
    """
    Report a newly discovered endpoint to the platform.
    Uses body-key deduplication.
    """
    normalized = normalize_path(path)
    endpoint_key = f"{method}:{normalized}"

    body_fields = sorted(body_structure.keys()) if body_structure else []
    body_key = endpoint_key + ":" + ",".join(body_fields)

    with _lock:
        if body_key in _reported:
            return
        _reported.add(body_key)

    json_schema = body_structure_to_json_schema(body_structure)

    # Fire and forget in a background thread — never block the request
    def _send():
        try:
            client.update_endpoint({
                "method": method,
                "path": normalized,
                "request_body": json_schema,
                "detected_by": "runtime",
            })
        except Exception:
            return None

    t = threading.Thread(target=_send, daemon=True)
    t.start()


# ── FastAPI middleware ────────────────────────────────────────────────────────

def attach_fastapi_interceptor(app, client, options):
    try:
        from starlette.middleware.base import BaseHTTPMiddleware
        from starlette.requests import Request
        import json as _json

        class BotVersionMiddleware(BaseHTTPMiddleware):
            async def dispatch(self, request: Request, call_next):
                path = request.url.path
                method = request.method.upper()

                response = await call_next(request)

                if not should_ignore(path, options.get("exclude")):
                    if not options.get("api_prefix") or path.startswith(options["api_prefix"]):
                        try:
                            body_bytes = await request.body()
                            async def receive():
                                return {"type": "http.request", "body": body_bytes}
                            request._receive = receive
                            body_data = _json.loads(body_bytes) if body_bytes else None
                            body_structure = build_body_structure(body_data)
                        except Exception:
                            body_structure = None

                        if response.status_code < 500:
                            report_endpoint(client, method, path, body_structure, options)

                return response

        app.add_middleware(BotVersionMiddleware)

    except ImportError:
        pass


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

    except ImportError:
        pass


# ── Django middleware ─────────────────────────────────────────────────────────

class BotVersionDjangoMiddleware:
    """
    Django middleware class.
    Auto-injected by botversion_sdk.init() — no manual setup needed.
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
                    body_data = json.loads(request.body) if request.body else None
                    body_structure = build_body_structure(body_data)
                except Exception:
                    body_structure = None

                if self.__class__._client:
                    report_endpoint(
                        self.__class__._client,
                        method,
                        path,
                        body_structure,
                        self.__class__._options,
                    )

        return self.get_response(request)


def attach_django_interceptor(client, options):
    """
    Injects BotVersionDjangoMiddleware into Django's MIDDLEWARE at runtime.
    """
    try:
        from django.conf import settings

        middleware_path = "botversion_sdk.interceptor.BotVersionDjangoMiddleware"

        if middleware_path not in settings.MIDDLEWARE:
            if isinstance(settings.MIDDLEWARE, tuple):
                settings.MIDDLEWARE = (middleware_path,) + settings.MIDDLEWARE
            else:
                settings.MIDDLEWARE.insert(0, middleware_path)

        BotVersionDjangoMiddleware._client = client
        BotVersionDjangoMiddleware._options = options

    except ImportError:
        pass


# ── Starlette middleware ──────────────────────────────────────────────────────
# Starlette is the base of FastAPI — middleware works exactly the same way

def attach_starlette_interceptor(app, client, options):
    try:
        from starlette.middleware.base import BaseHTTPMiddleware
        from starlette.requests import Request
        import json as _json

        class BotVersionStarletteMiddleware(BaseHTTPMiddleware):
            async def dispatch(self, request: Request, call_next):
                path = request.url.path
                method = request.method.upper()

                response = await call_next(request)

                if not should_ignore(path, options.get("exclude")):
                    if not options.get("api_prefix") or path.startswith(options["api_prefix"]):
                        try:
                            body_bytes = await request.body()
                            body_data = _json.loads(body_bytes) if body_bytes else None
                            body_structure = build_body_structure(body_data)
                        except Exception:
                            body_structure = None

                        if response.status_code < 500:
                            report_endpoint(client, method, path, body_structure, options)

                return response

        app.add_middleware(BotVersionStarletteMiddleware)

    except ImportError:
        pass


# ── Sanic middleware ──────────────────────────────────────────────────────────

def attach_sanic_interceptor(app, client, options):
    try:
        @app.middleware("request")
        async def botversion_sanic_interceptor(request):
            path = request.path
            method = request.method.upper()

            if should_ignore(path, options.get("exclude")):
                return
            if options.get("api_prefix") and not path.startswith(options["api_prefix"]):
                return

            try:
                body_data = request.json if request.body else None
                body_structure = build_body_structure(body_data)
            except Exception:
                body_structure = None

            report_endpoint(client, method, path, body_structure, options)

    except Exception:
        pass


# ── Falcon middleware ─────────────────────────────────────────────────────────

def attach_falcon_interceptor(app, client, options):
    try:
        import json as _json

        class BotVersionFalconMiddleware:
            def process_request(self, req, resp):
                path = req.path
                method = req.method.upper()

                if should_ignore(path, options.get("exclude")):
                    return
                if options.get("api_prefix") and not path.startswith(options["api_prefix"]):
                    return

                try:
                    body_bytes = req.bounded_stream.read()
                    body_data = _json.loads(body_bytes) if body_bytes else None
                    body_structure = build_body_structure(body_data)
                    # Put body back so the actual handler can still read it
                    import io
                    req.bounded_stream = io.BytesIO(body_bytes)
                except Exception:
                    body_structure = None

                report_endpoint(client, method, path, body_structure, options)

        app.add_middleware(BotVersionFalconMiddleware())

    except Exception:
        pass


# ── Bottle middleware ─────────────────────────────────────────────────────────

def attach_bottle_interceptor(app, client, options):
    try:
        from bottle import request as bottle_request

        def botversion_bottle_interceptor():
            path = bottle_request.path
            method = bottle_request.method.upper()

            if should_ignore(path, options.get("exclude")):
                return
            if options.get("api_prefix") and not path.startswith(options["api_prefix"]):
                return

            try:
                body_data = bottle_request.json
                body_structure = build_body_structure(body_data)
            except Exception:
                body_structure = None

            report_endpoint(client, method, path, body_structure, options)

        # Install on the specific app instance, not globally
        app.add_hook("before_request", botversion_bottle_interceptor)

    except Exception:
        pass


# ── aiohttp middleware ────────────────────────────────────────────────────────

def attach_aiohttp_interceptor(app, client, options):
    try:
        from aiohttp.web import middleware
        import json as _json

        @middleware
        async def botversion_aiohttp_middleware(request, handler):
            path = request.path
            method = request.method.upper()

            response = await handler(request)

            if not should_ignore(path, options.get("exclude")):
                if not options.get("api_prefix") or path.startswith(options["api_prefix"]):
                    try:
                        body_bytes = await request.read()
                        body_data = _json.loads(body_bytes) if body_bytes else None
                        body_structure = build_body_structure(body_data)
                    except Exception:
                        body_structure = None

                    if response.status < 500:
                        report_endpoint(client, method, path, body_structure, options)

            return response

        # aiohttp requires middlewares to be added before app starts
        # We store it on the app object so __init__.py can apply it
        if not hasattr(app, "_botversion_middlewares"):
            app._botversion_middlewares = []
        app._botversion_middlewares.append(botversion_aiohttp_middleware)

        # Apply to app's middleware list
        existing = list(app._middlewares) if hasattr(app, "_middlewares") else []
        existing.insert(0, botversion_aiohttp_middleware)
        app._middlewares = tuple(existing)

    except Exception:
        pass


# ── Tornado interceptor ───────────────────────────────────────────────────────
# Tornado doesn't have middleware. Instead we patch the base RequestHandler
# so every handler automatically reports to BotVersion.

def attach_tornado_interceptor(app, client, options):
    try:
        import tornado.web
        import json as _json

        original_finish = tornado.web.RequestHandler.finish

        def patched_finish(self, chunk=None):
            try:
                path = self.request.path
                method = self.request.method.upper()

                if not should_ignore(path, options.get("exclude")):
                    if not options.get("api_prefix") or path.startswith(options["api_prefix"]):
                        try:
                            body_bytes = self.request.body
                            body_data = _json.loads(body_bytes) if body_bytes else None
                            body_structure = build_body_structure(body_data)
                        except Exception:
                            body_structure = None

                        if self.get_status() < 500:
                            report_endpoint(client, method, path, body_structure, options)
            except Exception:
                pass

            return original_finish(self, chunk)

        tornado.web.RequestHandler.finish = patched_finish

    except Exception:
        pass


# ── Pyramid tween ─────────────────────────────────────────────────────────────
# Pyramid uses "tweens" which are similar to middleware.

# Pyramid tween factory — must be importable at module level
# so Pyramid can find it by dotted name
_pyramid_client = None
_pyramid_options = {}

def botversion_pyramid_tween_factory(handler, registry):
    def botversion_tween(request):
        response = handler(request)
        try:
            import json as _json
            path = request.path
            method = request.method.upper()

            if _pyramid_client and not should_ignore(path, _pyramid_options.get("exclude")):
                if not _pyramid_options.get("api_prefix") or path.startswith(_pyramid_options["api_prefix"]):
                    try:
                        body_data = request.json_body if request.content_length else None
                        body_structure = build_body_structure(body_data)
                    except Exception:
                        body_structure = None

                    if response.status_int < 500:
                        report_endpoint(_pyramid_client, method, path, body_structure, _pyramid_options)
        except Exception:
            pass

        return response
    return botversion_tween


def attach_pyramid_interceptor(app, client, options):
    """
    For Pyramid, the tween must be added during config before app creation.
    We store client + options at module level so the tween factory can use them.
    Tell the user to add this to their Pyramid config:
        config.add_tween('botversion_sdk.interceptor.botversion_pyramid_tween_factory')
    """
    global _pyramid_client, _pyramid_options
    _pyramid_client = client
    _pyramid_options = options


# ── CherryPy tool ─────────────────────────────────────────────────────────────
# CherryPy uses "tools" which are hooks into the request lifecycle.

def attach_cherrypy_interceptor(app, client, options):
    try:
        import cherrypy
        import json as _json

        def botversion_cherrypy_hook():
            request = cherrypy.request
            path = request.path_info
            method = request.method.upper()

            if should_ignore(path, options.get("exclude")):
                return
            if options.get("api_prefix") and not path.startswith(options["api_prefix"]):
                return

            try:
                body_bytes = request.body.read() if request.body else None
                body_data = _json.loads(body_bytes) if body_bytes else None
                body_structure = build_body_structure(body_data)
                # Put body back so actual handler can still read it
                import io
                request.body = io.BytesIO(body_bytes or b"")
            except Exception:
                body_structure = None

            report_endpoint(client, method, path, body_structure, options)

        # Register as a CherryPy tool
        cherrypy.tools.botversion = cherrypy.Tool(
            "before_handler",
            botversion_cherrypy_hook,
        )
        cherrypy.config.update({"tools.botversion.on": True})

    except Exception:
        pass