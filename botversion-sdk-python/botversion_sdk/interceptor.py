# botversion-sdk-python/botversion-sdk/interceptor.py
import re
import json
import threading

def make_internal_request(method, path, body, cookies, headers, base_url="http://127.0.0.1:8000"):
    """
    Makes an internal HTTP request to the user's own backend.
    Forwards cookies so the backend identifies the user correctly.
    Works for all auth types — JWT, session, cookie-based.
    """
    import urllib.request
    import urllib.error
    import json

    # Build the full URL — calling the user's own backend internally
    url = f"{base_url}{path}"

    body_bytes = json.dumps(body).encode("utf-8") if body else None

    req = urllib.request.Request(
        url,
        data=body_bytes,
        method=method.upper(),
    )

    # Forward all original headers
    req.add_header("Content-Type", "application/json")

    # Forward cookies — this is what identifies the user
    if cookies:
        req.add_header("Cookie", cookies)

    # Forward auth header if present
    auth_header = headers.get("authorization") or headers.get("Authorization")
    if auth_header:
        req.add_header("Authorization", auth_header)

    # Forward CSRF token if present
    csrf = (
        headers.get("x-csrftoken")
        or headers.get("X-CSRFToken")
        or headers.get("x-xsrf-token")
        or headers.get("X-XSRF-TOKEN")
    )
    if csrf:
        req.add_header("X-CSRFToken", csrf)

    try:
        # Follow redirects manually — urllib does not follow redirects for POST
        max_redirects = 5
        current_req = req
        current_url = url

        for _ in range(max_redirects):
            try:
                with urllib.request.urlopen(current_req, timeout=30) as res:
                    raw = res.read().decode("utf-8")
                    try:
                        data = json.loads(raw)
                    except Exception:
                        data = {"raw": raw}
                    return {
                        "status": res.status,
                        "ok": 200 <= res.status < 300,
                        "data": data,
                    }
            except urllib.error.HTTPError as e:
                if e.code in (301, 302, 303, 307, 308):
                    redirect_url = e.headers.get("Location")
                    if not redirect_url:
                        raise

                    # Handle relative redirects
                    if redirect_url.startswith("/"):
                        from urllib.parse import urlparse
                        parsed = urlparse(current_url)
                        redirect_url = f"{parsed.scheme}://{parsed.netloc}{redirect_url}"

                    # 307 and 308 keep the original method and body
                    # 301, 302, 303 switch to GET with no body
                    if e.code in (307, 308):
                        new_req = urllib.request.Request(
                            redirect_url,
                            data=current_req.data,
                            method=current_req.get_method(),
                        )
                    else:
                        new_req = urllib.request.Request(
                            redirect_url,
                            data=None,
                            method="GET",
                        )

                    # Forward headers to redirected request
                    new_req.add_header("Content-Type", "application/json")
                    if cookies:
                        new_req.add_header("Cookie", cookies)
                    if auth_header:
                        new_req.add_header("Authorization", auth_header)
                    if csrf:
                        new_req.add_header("X-CSRFToken", csrf)

                    current_req = new_req
                    current_url = redirect_url
                else:
                    raise
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            data = json.loads(raw)
        except Exception:
            data = {"error": raw}
        return {
            "status": e.code,
            "ok": False,
            "data": data,
        }
    except Exception as e:
        return {
            "status": 500,
            "ok": False,
            "data": {"error": str(e)},
        }

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
        import json as _json

        class BotVersionMiddleware(BaseHTTPMiddleware):
            async def dispatch(self, request: Request, call_next):
                path = request.url.path
                method = request.method.upper()

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

                        report_endpoint(client, method, path, body_structure, options)

                return await call_next(request)

        app.add_middleware(BotVersionMiddleware)

        if options.get("debug"):
            print("[BotVersion SDK] ✅ FastAPI middleware attached")

        # Register executor so WebSocket can make internal calls
        client.set_executor(lambda method, path, body, cookies, headers, base_url:
            make_internal_request(method, path, body, cookies, headers, base_url)
        )

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

        client.set_executor(lambda method, path, body, cookies, headers, base_url:
            make_internal_request(method, path, body, cookies, headers, base_url)
        )

    except ImportError:
        print("[BotVersion SDK] ❌ Flask not found — cannot attach interceptor")


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

        if options.get("debug"):
            print("[BotVersion SDK] ✅ Django middleware attached")

        BotVersionDjangoMiddleware._client = client
        BotVersionDjangoMiddleware._options = options
        client.set_executor(lambda method, path, body, cookies, headers, base_url:
            make_internal_request(method, path, body, cookies, headers, base_url)
        )

    except ImportError:
        print("[BotVersion SDK] ❌ Django not found — cannot attach middleware")