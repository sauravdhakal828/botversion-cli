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
]

# Track reported endpoints — keyed by method:path:body_fields
# Same deduplication strategy as JS interceptor (bodyKey)
_reported = set()
_lock = threading.Lock()


def should_ignore(path, extra_ignore=None):
    ignore = IGNORE_PATHS + (extra_ignore or [])
    return any(path.startswith(p) for p in ignore)


def normalize_path(path):
    """
    Replace dynamic segments with :id
    /users/123/posts/456 → /users/:id/posts/:id
    Mirrors JS interceptor normalizePath()
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
    Mirrors JS interceptor buildBodyStructure()
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
    Mirrors the jsonSchema conversion in JS interceptor.
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
    Uses body-key deduplication — same strategy as JS interceptor.
    """
    normalized = normalize_path(path)
    endpoint_key = f"{method}:{normalized}"

    # Build body key — sort fields for stable deduplication
    body_fields = sorted(body_structure.keys()) if body_structure else []
    body_key = endpoint_key + ":" + ",".join(body_fields)

    print(f"[DEBUG] endpoint: {endpoint_key}")
    print(f"[DEBUG] bodyStructure: {json.dumps(body_structure)}")

    with _lock:
        if body_key in _reported:
            return
        _reported.add(body_key)

    json_schema = body_structure_to_json_schema(body_structure)
    print(f"[DEBUG] jsonSchema: {json.dumps(json_schema)}")

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
                            # Cache body so the actual route handler can still read it
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

        if options.get("debug"):
            print("[BotVersion SDK] ✅ Django middleware attached")

    except ImportError:
        print("[BotVersion SDK] ❌ Django not found — cannot attach middleware")


# ── execute_agent_call — mirrors JS interceptor.executeAgentCall ──────────────

def execute_agent_call(client, request, options, framework="fastapi"):
    """
    Executes an agent chat and handles EXECUTE_CALL actions by making
    the local API call and returning the tool result back to the agent.

    Mirrors JS app.executeAgentCall() in interceptor.js
    """
    get_user_context = options.get("get_user_context", None)
    if get_user_context:
        raw = get_user_context(request)
        user_context = _process_user_context(raw)
    else:
        user_context = extract_default_context(request, framework)

    data = _get_request_body(request, framework)

    response = client.agent_chat({
        "message": data.get("message", ""),
        "conversation_history": data.get("conversationHistory", []),
        "page_context": data.get("pageContext", {}),
        "user_context": user_context,
    })

    # Plain chat/greeting response
    if response.get("answer"):
        return {"action": "RESPOND", "message": response["answer"]}

    # Not an action call
    if response.get("action") != "EXECUTE_CALL":
        return response

    # Make the local API call and send result back
    result = _make_local_call(request, response["call"], framework)
    tool_response = client.agent_tool_result(
        response["sessionToken"],
        result,
        response.get("sessionData"),
    )

    # Handle chained tool call
    if tool_response.get("action") == "EXECUTE_CALL":
        result2 = _make_local_call(request, tool_response["call"], framework)
        return client.agent_tool_result(
            tool_response["sessionToken"],
            result2,
            tool_response.get("sessionData"),
        )

    return tool_response


def _get_request_body(request, framework):
    """Extract body dict from a request object across frameworks."""
    try:
        if framework == "flask":
            return request.get_json(silent=True) or {}
        elif framework == "django":
            return json.loads(request.body) if request.body else {}
        else:
            # FastAPI — body should already be parsed if called from a route
            if hasattr(request, "_body"):
                return json.loads(request._body) if request._body else {}
    except Exception:
        pass
    return {}

def _process_user_context(raw):
    """
    Takes whatever the user returned from get_user_context,
    runs it through the same flatten + strip sensitive + smart alias
    logic as extract_default_context.
    So even custom user context functions are safe.
    """
    if not raw:
        return {}

    # If it's not a dict, try to convert it
    if not isinstance(raw, dict):
        try:
            raw = {k: v for k, v in raw.__dict__.items() if not k.startswith("_")}
        except Exception:
            return {}

    sensitive_keys = [
        "password", "passwd", "pwd", "token", "accesstoken", "refreshtoken",
        "bearertoken", "secret", "privatesecret", "apikey", "api_key",
        "privatekey", "private_key", "signingkey", "hash", "passwordhash",
        "salt", "cvv", "ssn", "pin", "creditcard", "credit_card",
        "cardnumber", "card_number", "otp", "mfa", "totp",
        "image", "avatar", "photo",
    ]

    # Step 1: Flatten
    flat = _flatten_object(raw)

    # Step 2: Strip sensitive keys
    context = {}
    for key, val in flat.items():
        is_sensitive = any(s in key.lower() for s in sensitive_keys)
        if not is_sensitive:
            context[key] = val

    # Step 3: Smart aliasing
    id_suffixes = ["id", "key", "code", "ref", "slug", "uuid", "num", "no"]
    clean_prefixes = ["active", "current", "selected", "default", "my", "the", "this"]

    aliases = {}
    for key, val in context.items():
        lower_key = key.lower()
        is_id_field = any(lower_key.endswith(suffix) for suffix in id_suffixes)

        if is_id_field and val:
            clean_key = key
            for prefix in clean_prefixes:
                if clean_key.lower().startswith(prefix):
                    clean_key = clean_key[len(prefix):]
                    clean_key = clean_key[0].lower() + clean_key[1:] if clean_key else clean_key
                    break

            if clean_key != key and clean_key not in context:
                aliases[clean_key] = val

    context.update(aliases)
    return context

def _make_local_call(request, call, framework):
    """
    Makes a local HTTP call on behalf of the agent,
    forwarding the user's real auth headers.
    Mirrors JS makeLocalCall()
    """
    import urllib.request as _urllib_request
    import urllib.error as _urllib_error

    method = call.get("method", "GET").upper()
    path = call.get("path", "/")
    body = call.get("body")

    body_bytes = json.dumps(body).encode("utf-8") if body else None

    # Build the full local URL
    if framework == "flask":
        from flask import request as flask_req
        host = flask_req.host
        scheme = flask_req.scheme
    elif framework == "django":
        host = request.get_host()
        scheme = "https" if request.is_secure() else "http"
    else:
        # FastAPI — read from request
        host = request.headers.get("host", "localhost")
        scheme = request.url.scheme

    url = f"{scheme}://{host}{path}"

    # Forward auth headers
    headers = {
        "Content-Type": "application/json",
        "Authorization": _get_header(request, "authorization", framework),
        "Cookie": _get_header(request, "cookie", framework),
    }
    if body_bytes:
        headers["Content-Length"] = str(len(body_bytes))

    req = _urllib_request.Request(url, data=body_bytes, method=method, headers=headers)

    try:
        with _urllib_request.urlopen(req, timeout=10) as res:
            data = res.read().decode("utf-8")
            try:
                return {"status": res.status, "data": json.loads(data)}
            except Exception:
                return {"status": res.status, "data": {"raw": data}}
    except _urllib_error.HTTPError as e:
        data = e.read().decode("utf-8")
        try:
            return {"status": e.code, "data": json.loads(data)}
        except Exception:
            return {"status": e.code, "data": {"raw": data}}
    except Exception as e:
        return {"status": 500, "error": str(e)}


def _get_header(request, header_name, framework):
    """Get a header value from a request object across frameworks."""
    try:
        if framework == "django":
            # Django uses HTTP_ prefix for headers
            key = "HTTP_" + header_name.upper().replace("-", "_")
            return request.META.get(key, "")
        else:
            # FastAPI / Flask / Starlette
            return request.headers.get(header_name, "")
    except Exception:
        return ""


# ── Default userContext extraction ────────────────────────────────────────────

def extract_default_context(request, framework="fastapi"):
    """
    Extracts safe user context from a request object.
    Mirrors JS extractDefaultContext() in index.js — includes:
    - Flattening nested user objects
    - Stripping sensitive keys
    - Smart aliasing of ID fields
    """
    user = _get_user_from_request(request, framework)

    sensitive_keys = [
        "password", "passwd", "pwd", "token", "accesstoken", "refreshtoken",
        "bearertoken", "secret", "privatesecret", "apikey", "api_key",
        "privatekey", "private_key", "signingkey", "hash", "passwordhash",
        "salt", "cvv", "ssn", "pin", "creditcard", "credit_card",
        "cardnumber", "card_number", "otp", "mfa", "totp",
        "image", "avatar", "photo",
    ]

    # Step 1: Flatten nested user dict
    flat_user = _flatten_object(user)

    # Step 2: Strip sensitive keys
    context = {}
    for key, val in flat_user.items():
        is_sensitive = any(s in key.lower() for s in sensitive_keys)
        if not is_sensitive:
            context[key] = val

    # Step 3: Smart aliasing — mirror JS logic
    id_suffixes = ["id", "key", "code", "ref", "slug", "uuid", "num", "no"]
    clean_prefixes = ["active", "current", "selected", "default", "my", "the", "this"]

    aliases = {}
    for key, val in context.items():
        lower_key = key.lower()
        is_id_field = any(lower_key.endswith(suffix) for suffix in id_suffixes)

        if is_id_field and val:
            clean_key = key
            for prefix in clean_prefixes:
                if clean_key.lower().startswith(prefix):
                    clean_key = clean_key[len(prefix):]
                    clean_key = clean_key[0].lower() + clean_key[1:] if clean_key else clean_key
                    break

            if clean_key != key and clean_key not in context:
                aliases[clean_key] = val

    context.update(aliases)
    return context


def _get_user_from_request(request, framework):
    """Extract user object from request across frameworks."""
    try:
        if framework == "django":
            user = getattr(request, "user", None)
            if user and hasattr(user, "__dict__"):
                return {
                    k: v for k, v in user.__dict__.items()
                    if not k.startswith("_")
                }
            return {}
        elif framework == "flask":
            # Flask-Login / Flask-Security
            try:
                from flask_login import current_user
                if current_user and current_user.is_authenticated:
                    if hasattr(current_user, "__dict__"):
                        return {k: v for k, v in current_user.__dict__.items() if not k.startswith("_")}
            except ImportError:
                pass
            # Fallback to g.user or session
            try:
                from flask import g, session
                return getattr(g, "user", None) or session.get("user", {})
            except Exception:
                return {}
        else:
            # FastAPI — check request.state.user
            user = getattr(getattr(request, "state", None), "user", None)
            if user:
                if isinstance(user, dict):
                    return user
                if hasattr(user, "__dict__"):
                    return {k: v for k, v in user.__dict__.items() if not k.startswith("_")}
            return {}
    except Exception:
        return {}


def _flatten_object(obj, prefix=""):
    """
    Recursively flatten a nested dict.
    Mirrors JS flattenObject() in index.js
    """
    result = {}
    if not isinstance(obj, dict):
        return result

    for key, value in obj.items():
        full_key = f"{prefix}_{key}" if prefix else key
        if value is None:
            continue
        elif isinstance(value, dict):
            nested = _flatten_object(value, full_key)
            result.update(nested)
        elif not isinstance(value, (list, dict)):
            result[full_key] = value

    return result