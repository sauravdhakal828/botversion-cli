# botversion-sdk-python/botversion-sdk/interceptor.py
import re
import json
import threading
import zlib

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
        elif isinstance(val, dict):
            # Capture one level of nested properties so agent can reconstruct
            # the object shape — e.g. group: { teamId: null, parentId: null }
            nested_props = {}
            for nk, nv in val.items():
                if nv is None:
                    nested_props[nk] = {"type": "string"}
                else:
                    nested_props[nk] = {"type": type(nv).__name__}
            if nested_props:
                structure[key] = {"type": "object", "properties": nested_props}
            else:
                structure[key] = "object"
        else:
            structure[key] = type(val).__name__

    return structure


def body_structure_to_json_schema(body_structure):
    """
    Convert body structure dict to JSON Schema format.
    Handles both simple types (strings) and nested object descriptors.
    """
    if not body_structure:
        return None

    properties = {}
    for key, type_or_obj in body_structure.items():
        # Nested object captured with properties
        if isinstance(type_or_obj, dict) and "type" in type_or_obj:
            properties[key] = type_or_obj
        # Simple type string
        elif type_or_obj in ("[redacted]", "null"):
            properties[key] = {"type": "string"}
        else:
            properties[key] = {"type": type_or_obj}

    return {"type": "object", "properties": properties}


def unwrap_trpc_json_envelope(obj):
    """
    Unwraps a single (non-batched) tRPC/superjson envelope:
    { "json": {...realFields...} } -> {...realFields...}
    """
    if isinstance(obj, dict) and isinstance(obj.get("json"), dict):
        return obj["json"]
    return obj


def split_batch_path(raw_path):
    """
    tRPC batches multiple procedure calls into one URL, e.g.
      /api/trpc/me.get,getUserTopBanners,bookingUnconfirmedCount
    tRPC is always mounted at a fixed base containing "/trpc/". Everything
    after that marker is the comma-separated procedure list, and each
    comma-separated piece is ALREADY a complete procedure path on its own
    (it may itself contain "/" for nested routers) — it must never have
    another procedure's prefix re-attached to it.
    Returns a single-item list unchanged if the path isn't a batch.
    """
    marker = "/trpc/"
    idx = raw_path.find(marker)
    if idx == -1:
        return [raw_path]

    base = raw_path[: idx + len(marker)]
    tail = raw_path[idx + len(marker):]

    if "," not in tail:
        return [raw_path]

    procs = [p.strip() for p in tail.split(",") if p.strip()]
    return [base + p for p in procs]


def split_batch_body(body_obj):
    """
    Splits a batched tRPC request body/input — {"0": {...}, "1": {...}} —
    into a list of individual bodies, in the same order as the batch keys,
    which lines up with the order split_batch_path() returns procedure
    names in. Each slot is unwrapped from its own {"json": {...}} envelope.
    Returns a single-item list unchanged if the body isn't actually batched.
    """
    if not isinstance(body_obj, dict):
        return [body_obj]

    keys = list(body_obj.keys())
    is_batch = len(keys) > 0 and all(k.isdigit() for k in keys)

    if not is_batch:
        return [body_obj]

    ordered_keys = sorted(keys, key=lambda k: int(k))
    slots = []
    for k in ordered_keys:
        entry = body_obj[k]
        slots.append(
            unwrap_trpc_json_envelope(entry) if isinstance(entry, dict) else entry
        )
    return slots


def extract_trpc_get_input_raw(path, query_string):
    """
    tRPC GET requests send their input as a URL-encoded JSON query parameter
    called 'input'. This returns the raw decoded dict as-is — still batched
    if applicable — WITHOUT merging different procedures' fields together.
    Splitting per-procedure happens later in report_endpoint().
    Safe for all non-tRPC endpoints — returns None if not applicable.
    """
    if "/trpc/" not in path:
        return None
    if not query_string or "input=" not in query_string:
        return None

    try:
        from urllib.parse import parse_qs, unquote
        params = parse_qs(query_string)
        input_param = params.get("input", [None])[0]
        if not input_param:
            return None

        decoded = json.loads(unquote(input_param))
        if not isinstance(decoded, dict):
            return None

        return decoded

    except Exception:
        return None


def _report_single_endpoint(client, method, normalized_path, body_structure, options):
    """
    Reports exactly one already-normalized, already-split endpoint.
    Uses body-key deduplication.
    """
    endpoint_key = f"{method}:{normalized_path}"

    body_fields = sorted(body_structure.keys()) if body_structure else []
    body_key = endpoint_key + ":" + ",".join(body_fields)

    with _lock:
        if body_key in _reported:
            return
        _reported.add(body_key)

    json_schema = body_structure_to_json_schema(body_structure)

    # update_endpoint only queues the update (sending happens in the background), so it never
    # blocks the request, and the queue order matches the order of calls.
    try:
        client.update_endpoint({
            "method": method,
            "path": normalized_path,
            "request_body": json_schema,
            "detected_by": "runtime",
        })
    except Exception:
        return None


def report_endpoint(client, method, path, body_data, query_string, options):
    """
    Splits a (possibly batched) tRPC path into one clean endpoint per real
    procedure — instead of one garbled, comma-joined path — with each
    procedure's own body fields only, never mixed with another procedure's.
    Falls back to reporting a single endpoint unchanged when the path
    isn't a batch.

    body_data — the raw parsed JSON body (or None/empty for GET requests).
    query_string — the raw query string, used to recover tRPC GET input.
    """
    split_paths = [normalize_path(p) for p in split_batch_path(path)]

    body_slots = None

    # tRPC GET requests carry their input in the query string, not the body
    if (not body_data) and query_string:
        raw_input = extract_trpc_get_input_raw(path, query_string)
        if raw_input is not None:
            body_slots = split_batch_body(raw_input)

    if body_slots is None:
        body_slots = (
            split_batch_body(body_data) if len(split_paths) > 1 else [body_data]
        )

    for i, single_path in enumerate(split_paths):
        slot_body = body_slots[i] if i < len(body_slots) else None
        body_structure = build_body_structure(slot_body)
        _report_single_endpoint(client, method, single_path, body_structure, options)


# ── FastAPI middleware ────────────────────────────────────────────────────────

def attach_fastapi_interceptor(app, client, options):
    try:
        from starlette.middleware.base import BaseHTTPMiddleware
        from starlette.requests import Request
        import json as _json

        from starlette.responses import JSONResponse

        class BotVersionMiddleware(BaseHTTPMiddleware):
            async def dispatch(self, request: Request, call_next):
                path = request.url.path
                method = request.method.upper()

                # ── Scan trigger from BotVersion dashboard ───────────────
                if path == "/__botversion/scan" and method == "POST":
                    provided_key = request.headers.get("x-botversion-scan-key", "")
                    if (
                        options.get("scan_secret")
                        and provided_key == options["scan_secret"]
                        and callable(options.get("on_scan_requested"))
                    ):
                        try:
                            result = options["on_scan_requested"]()
                            return JSONResponse(
                                {"success": True, "result": result}, status_code=200
                            )
                        except Exception as e:
                            return JSONResponse(
                                {"success": False, "error": str(e)}, status_code=500
                            )
                    return JSONResponse(
                        {"success": False, "error": "Unauthorized"}, status_code=401
                    )

                response = await call_next(request)

                if not should_ignore(path, options.get("exclude")):
                    if not options.get("api_prefix") or path.startswith(options["api_prefix"]):
                        try:
                            body_bytes = await request.body()
                            async def receive():
                                return {"type": "http.request", "body": body_bytes}
                            request._receive = receive
                            body_data = _json.loads(body_bytes) if body_bytes else None
                        except Exception:
                            body_data = None

                        if response.status_code < 500:
                            report_endpoint(client, method, path, body_data, request.url.query, options)

                return response

        app.add_middleware(BotVersionMiddleware)
        _add_asgi_response_capture(app, client, options)

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

            # ── Scan trigger from BotVersion dashboard ───────────────────
            if path == "/__botversion/scan" and method == "POST":
                provided_key = flask_request.headers.get("x-botversion-scan-key", "")
                if (
                    options.get("scan_secret")
                    and provided_key == options["scan_secret"]
                    and callable(options.get("on_scan_requested"))
                ):
                    try:
                        result = options["on_scan_requested"]()
                        return {"success": True, "result": result}, 200
                    except Exception as e:
                        return {"success": False, "error": str(e)}, 500
                return {"success": False, "error": "Unauthorized"}, 401

            if should_ignore(path, options.get("exclude")):
                return
            if options.get("api_prefix") and not path.startswith(options["api_prefix"]):
                return

            # Drops cache-validation headers so the app sends a full reply instead of an empty 304
            # (which has no body to read). Only runs while this endpoint still has no captured shape.
            try:
                if is_response_shape_needed(method, path):
                    flask_request.environ.pop("HTTP_IF_NONE_MATCH", None)
                    flask_request.environ.pop("HTTP_IF_MODIFIED_SINCE", None)
            except Exception:
                pass

            try:
                body_data = flask_request.get_json(silent=True)
            except Exception:
                body_data = None

            report_endpoint(client, method, path, body_data, flask_request.query_string.decode("utf-8"), options)

        @app.after_request
        def botversion_response_capture(response):
            # Capture the shape of the successful JSON reply (field names only)
            try:
                path = flask_request.path
                method = flask_request.method.upper()
                if should_watch_response(method, path, options):
                    body = None
                    # Streamed / file replies are skipped so we never change how the app responds
                    if not (response.direct_passthrough or response.is_streamed):
                        body = response.get_data()
                    report_response_body(
                        client, method, path, response.status_code,
                        response.headers.get("Content-Type", ""), body,
                    )
            except Exception:
                pass
            return response

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
        options = self.__class__._options

        # ── Scan trigger from BotVersion dashboard ───────────────────────
        if path == "/__botversion/scan" and method == "POST":
            provided_key = request.META.get("HTTP_X_BOTVERSION_SCAN_KEY", "")
            from django.http import JsonResponse
            if (
                options.get("scan_secret")
                and provided_key == options["scan_secret"]
                and callable(options.get("on_scan_requested"))
            ):
                try:
                    result = options["on_scan_requested"]()
                    return JsonResponse({"success": True, "result": result}, status=200)
                except Exception as e:
                    return JsonResponse({"success": False, "error": str(e)}, status=500)
            return JsonResponse({"success": False, "error": "Unauthorized"}, status=401)

        if not should_ignore(path, self.__class__._options.get("exclude")):
            if not self.__class__._options.get("api_prefix") or path.startswith(self.__class__._options["api_prefix"]):
                try:
                    body_data = json.loads(request.body) if request.body else None
                except Exception:
                    body_data = None

                if self.__class__._client:
                    report_endpoint(
                        self.__class__._client,
                        method,
                        path,
                        body_data,
                        request.META.get("QUERY_STRING", ""),
                        self.__class__._options,
                    )

        # Drops cache-validation headers so the app sends a full reply instead of an empty 304
        # (which has no body to read). Only runs while this endpoint still has no captured shape.
        try:
            if self.__class__._client and should_watch_response(method, path, options):
                request.META.pop("HTTP_IF_NONE_MATCH", None)
                request.META.pop("HTTP_IF_MODIFIED_SINCE", None)
        except Exception:
            pass

        response = self.get_response(request)

        # Capture the shape of the successful JSON reply (field names only)
        try:
            client = self.__class__._client
            if client and should_watch_response(method, path, options):
                body = None
                if not getattr(response, "streaming", False):   # skip streamed / file replies
                    body = response.content
                report_response_body(
                    client, method, path, response.status_code,
                    response.get("Content-Type", ""), body,
                )
        except Exception:
            pass

        return response


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

        from starlette.responses import JSONResponse

        class BotVersionStarletteMiddleware(BaseHTTPMiddleware):
            async def dispatch(self, request: Request, call_next):
                path = request.url.path
                method = request.method.upper()

                # ── Scan trigger from BotVersion dashboard ───────────────
                if path == "/__botversion/scan" and method == "POST":
                    provided_key = request.headers.get("x-botversion-scan-key", "")
                    if (
                        options.get("scan_secret")
                        and provided_key == options["scan_secret"]
                        and callable(options.get("on_scan_requested"))
                    ):
                        try:
                            result = options["on_scan_requested"]()
                            return JSONResponse(
                                {"success": True, "result": result}, status_code=200
                            )
                        except Exception as e:
                            return JSONResponse(
                                {"success": False, "error": str(e)}, status_code=500
                            )
                    return JSONResponse(
                        {"success": False, "error": "Unauthorized"}, status_code=401
                    )

                response = await call_next(request)

                if not should_ignore(path, options.get("exclude")):
                    if not options.get("api_prefix") or path.startswith(options["api_prefix"]):
                        try:
                            body_bytes = await request.body()
                            body_data = _json.loads(body_bytes) if body_bytes else None
                        except Exception:
                            body_data = None

                        if response.status_code < 500:
                            report_endpoint(client, method, path, body_data, request.url.query, options)

                return response

        app.add_middleware(BotVersionStarletteMiddleware)
        _add_asgi_response_capture(app, client, options)

    except ImportError:
        pass


# ── Sanic middleware ──────────────────────────────────────────────────────────

def attach_sanic_interceptor(app, client, options):
    try:
        @app.middleware("request")
        async def botversion_sanic_interceptor(request):
            path = request.path
            method = request.method.upper()

            # ── Scan trigger from BotVersion dashboard ───────────────────
            if path == "/__botversion/scan" and method == "POST":
                from sanic.response import json as sanic_json
                provided_key = request.headers.get("x-botversion-scan-key", "")
                if (
                    options.get("scan_secret")
                    and provided_key == options["scan_secret"]
                    and callable(options.get("on_scan_requested"))
                ):
                    try:
                        result = options["on_scan_requested"]()
                        return sanic_json({"success": True, "result": result}, status=200)
                    except Exception as e:
                        return sanic_json({"success": False, "error": str(e)}, status=500)
                return sanic_json({"success": False, "error": "Unauthorized"}, status=401)

            if should_ignore(path, options.get("exclude")):
                return
            if options.get("api_prefix") and not path.startswith(options["api_prefix"]):
                return

            try:
                body_data = request.json if request.body else None
            except Exception:
                body_data = None

            report_endpoint(client, method, path, body_data, request.query_string, options)

        @app.middleware("response")
        async def botversion_sanic_response_capture(request, response):
            # Capture the shape of the successful JSON reply (field names only)
            try:
                path = request.path
                method = request.method.upper()
                if should_watch_response(method, path, options):
                    raw = getattr(response, "body", None)
                    body = bytes(raw) if isinstance(raw, (bytes, bytearray)) else None
                    report_response_body(
                        client, method, path, response.status,
                        getattr(response, "content_type", "") or "", body,
                    )
            except Exception:
                pass

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

                # ── Scan trigger from BotVersion dashboard ───────────────
                if path == "/__botversion/scan" and method == "POST":
                    provided_key = req.get_header("x-botversion-scan-key") or ""
                    if (
                        options.get("scan_secret")
                        and provided_key == options["scan_secret"]
                        and callable(options.get("on_scan_requested"))
                    ):
                        try:
                            result = options["on_scan_requested"]()
                            resp.media = {"success": True, "result": result}
                            resp.status = 200
                        except Exception as e:
                            resp.media = {"success": False, "error": str(e)}
                            resp.status = 500
                    else:
                        resp.media = {"success": False, "error": "Unauthorized"}
                        resp.status = 401
                    resp.complete = True
                    return

                if should_ignore(path, options.get("exclude")):
                    return
                if options.get("api_prefix") and not path.startswith(options["api_prefix"]):
                    return

                try:
                    body_bytes = req.bounded_stream.read()
                    body_data = _json.loads(body_bytes) if body_bytes else None
                    # Put body back so the actual handler can still read it
                    import io
                    req.bounded_stream = io.BytesIO(body_bytes)
                except Exception:
                    body_data = None

                report_endpoint(client, method, path, body_data, req.query_string, options)

            def process_response(self, req, resp, resource, req_succeeded):
                # Capture the shape of the successful JSON reply (field names only)
                try:
                    path = req.path
                    method = req.method.upper()
                    if not should_watch_response(method, path, options):
                        return
                    status_code = parse_status_code(getattr(resp, "status_code", None) or resp.status)
                    media = getattr(resp, "media", None)
                    if media is not None:
                        body = media
                        content_type = getattr(resp, "content_type", None) or "application/json"
                    else:
                        text_attr = "text" if hasattr(resp, "text") else "body"
                        body = getattr(resp, text_attr, None) or getattr(resp, "data", None)
                        content_type = getattr(resp, "content_type", None) or ""
                    report_response_body(client, method, path, status_code, content_type, body)
                except Exception:
                    pass

        app.add_middleware(BotVersionFalconMiddleware())

    except Exception:
        pass


# ── Bottle middleware ─────────────────────────────────────────────────────────

def attach_bottle_interceptor(app, client, options):
    try:
        from bottle import request as bottle_request, response as bottle_response, HTTPResponse

        def botversion_bottle_interceptor():
            path = bottle_request.path
            method = bottle_request.method.upper()

            # ── Scan trigger from BotVersion dashboard ────────────────────
            if path == "/__botversion/scan" and method == "POST":
                provided_key = bottle_request.headers.get("x-botversion-scan-key", "")
                if (
                    options.get("scan_secret")
                    and provided_key == options["scan_secret"]
                    and callable(options.get("on_scan_requested"))
                ):
                    try:
                        result = options["on_scan_requested"]()
                        raise HTTPResponse(
                            body=json.dumps({"success": True, "result": result}),
                            status=200,
                            headers={"Content-Type": "application/json"},
                        )
                    except HTTPResponse:
                        raise
                    except Exception as e:
                        raise HTTPResponse(
                            body=json.dumps({"success": False, "error": str(e)}),
                            status=500,
                            headers={"Content-Type": "application/json"},
                        )
                raise HTTPResponse(
                    body=json.dumps({"success": False, "error": "Unauthorized"}),
                    status=401,
                    headers={"Content-Type": "application/json"},
                )

            if should_ignore(path, options.get("exclude")):
                return
            if options.get("api_prefix") and not path.startswith(options["api_prefix"]):
                return

            try:
                body_data = bottle_request.json
            except Exception:
                body_data = None

            report_endpoint(client, method, path, body_data, bottle_request.query_string, options)

        # Install on the specific app instance, not globally
        app.add_hook("before_request", botversion_bottle_interceptor)

        # Bottle hooks can't see what a route returned, so a plugin is used to read the reply
        class BotVersionBottleResponsePlugin:
            name = "botversion_response"
            api = 2

            def apply(self, callback, route):
                def wrapper(*args, **kwargs):
                    result = callback(*args, **kwargs)
                    try:
                        path = bottle_request.path
                        method = bottle_request.method.upper()
                        if should_watch_response(method, path, options):
                            status_code = bottle_response.status_code
                            content_type = bottle_response.content_type or ""
                            body = None
                            if isinstance(result, dict):        # Bottle turns dicts into JSON itself
                                body, content_type = result, "application/json"
                            elif isinstance(result, (str, bytes)):
                                body = result
                            elif isinstance(result, HTTPResponse):
                                status_code = result.status_code
                                content_type = result.content_type or content_type
                                if isinstance(result.body, (str, bytes, dict)):
                                    body = result.body
                            report_response_body(client, method, path, status_code, content_type, body)
                    except Exception:
                        pass
                    return result
                return wrapper

        app.install(BotVersionBottleResponsePlugin())

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

            # ── Scan trigger from BotVersion dashboard ───────────────────
            if path == "/__botversion/scan" and method == "POST":
                from aiohttp import web
                provided_key = request.headers.get("x-botversion-scan-key", "")
                if (
                    options.get("scan_secret")
                    and provided_key == options["scan_secret"]
                    and callable(options.get("on_scan_requested"))
                ):
                    try:
                        result = options["on_scan_requested"]()
                        return web.json_response(
                            {"success": True, "result": result}, status=200
                        )
                    except Exception as e:
                        return web.json_response(
                            {"success": False, "error": str(e)}, status=500
                        )
                return web.json_response(
                    {"success": False, "error": "Unauthorized"}, status=401
                )

            response = await handler(request)

            if not should_ignore(path, options.get("exclude")):
                if not options.get("api_prefix") or path.startswith(options["api_prefix"]):
                    try:
                        body_bytes = await request.read()
                        body_data = _json.loads(body_bytes) if body_bytes else None
                    except Exception:
                        body_data = None

                    if response.status < 500:
                        report_endpoint(client, method, path, body_data, request.rel_url.query_string, options)

            # Capture the shape of the successful JSON reply (field names only)
            try:
                if should_watch_response(method, path, options):
                    raw = getattr(response, "body", None)
                    body = bytes(raw) if isinstance(raw, (bytes, bytearray)) else None
                    report_response_body(
                        client, method, path, response.status,
                        getattr(response, "content_type", "") or "", body,
                    )
            except Exception:
                pass

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

        # Already patched (e.g. after a hot reload) — patching again would stack wrappers
        if getattr(tornado.web.RequestHandler, "_botversion_patched", False):
            return

        original_prepare = tornado.web.RequestHandler.prepare

        def patched_prepare(self):
            try:
                path = self.request.path
                method = self.request.method.upper()

                # ── Scan trigger from BotVersion dashboard ───────────────
                if path == "/__botversion/scan" and method == "POST":
                    provided_key = self.request.headers.get("x-botversion-scan-key", "")
                    if (
                        options.get("scan_secret")
                        and provided_key == options["scan_secret"]
                        and callable(options.get("on_scan_requested"))
                    ):
                        try:
                            result = options["on_scan_requested"]()
                            self.set_status(200)
                            self.set_header("Content-Type", "application/json")
                            self.finish(_json.dumps({"success": True, "result": result}))
                        except Exception as e:
                            self.set_status(500)
                            self.set_header("Content-Type", "application/json")
                            self.finish(_json.dumps({"success": False, "error": str(e)}))
                    else:
                        self.set_status(401)
                        self.set_header("Content-Type", "application/json")
                        self.finish(_json.dumps({"success": False, "error": "Unauthorized"}))
                    return
            except Exception:
                pass
            return original_prepare(self)

        tornado.web.RequestHandler.prepare = patched_prepare

        original_write = tornado.web.RequestHandler.write

        def patched_write(self, chunk):
            # Keep a copy of what the handler writes so the reply shape can be read at finish
            try:
                if should_watch_response(self.request.method.upper(), self.request.path, options):
                    _collect_tornado_part(self, chunk)
            except Exception:
                pass
            return original_write(self, chunk)

        tornado.web.RequestHandler.write = patched_write

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
                        except Exception:
                            body_data = None

                        if self.get_status() < 500:
                            report_endpoint(client, method, path, body_data, self.request.query, options)

                # Capture the shape of the successful JSON reply (field names only)
                if should_watch_response(method, path, options):
                    _collect_tornado_part(self, chunk)
                    state = self.__dict__.get("_botversion_resp")
                    body = None
                    if state and not state["skip"]:
                        parts = state["parts"]
                        if len(parts) == 1 and isinstance(parts[0], dict):
                            body = parts[0]
                        elif parts and all(isinstance(p, bytes) for p in parts):
                            body = b"".join(parts)
                    headers = getattr(self, "_headers", None)
                    content_type = headers.get("Content-Type", "") if headers else ""
                    report_response_body(client, method, path, self.get_status(), content_type, body)
            except Exception:
                pass

            return original_finish(self, chunk)

        tornado.web.RequestHandler.finish = patched_finish
        tornado.web.RequestHandler._botversion_patched = True

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
        path = request.path
        method = request.method.upper()

        # ── Scan trigger from BotVersion dashboard ────────────────────────
        if path == "/__botversion/scan" and method == "POST":
            from pyramid.response import Response
            provided_key = request.headers.get("x-botversion-scan-key", "")
            if (
                _pyramid_options.get("scan_secret")
                and provided_key == _pyramid_options["scan_secret"]
                and callable(_pyramid_options.get("on_scan_requested"))
            ):
                try:
                    result = _pyramid_options["on_scan_requested"]()
                    return Response(json_body={"success": True, "result": result}, status=200)
                except Exception as e:
                    return Response(json_body={"success": False, "error": str(e)}, status=500)
            return Response(json_body={"success": False, "error": "Unauthorized"}, status=401)

        response = handler(request)
        try:
            import json as _json
            path = request.path
            method = request.method.upper()

            if _pyramid_client and not should_ignore(path, _pyramid_options.get("exclude")):
                if not _pyramid_options.get("api_prefix") or path.startswith(_pyramid_options["api_prefix"]):
                    try:
                        body_data = request.json_body if request.content_length else None
                    except Exception:
                        body_data = None

                    if response.status_int < 500:
                        report_endpoint(_pyramid_client, method, path, body_data, request.query_string, _pyramid_options)
        except Exception:
            pass

        # Capture the shape of the successful JSON reply (field names only)
        try:
            if _pyramid_client and should_watch_response(request.method.upper(), request.path, _pyramid_options):
                app_iter = getattr(response, "app_iter", None)
                # Only read replies that are already fully built (never force a stream to load)
                body = response.body if isinstance(app_iter, (list, tuple)) else None
                report_response_body(
                    _pyramid_client, request.method.upper(), request.path,
                    response.status_int, response.content_type or "", body,
                )
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

            # ── Scan trigger from BotVersion dashboard ────────────────────
            if path == "/__botversion/scan" and method == "POST":
                provided_key = request.headers.get("x-botversion-scan-key", "")
                if (
                    options.get("scan_secret")
                    and provided_key == options["scan_secret"]
                    and callable(options.get("on_scan_requested"))
                ):
                    try:
                        result = options["on_scan_requested"]()
                        cherrypy.response.status = 200
                        body = _json.dumps({"success": True, "result": result})
                    except Exception as e:
                        cherrypy.response.status = 500
                        body = _json.dumps({"success": False, "error": str(e)})
                else:
                    cherrypy.response.status = 401
                    body = _json.dumps({"success": False, "error": "Unauthorized"})

                cherrypy.response.headers["Content-Type"] = "application/json"
                cherrypy.response.body = body.encode("utf-8")
                cherrypy.request.handler = None
                return

            if should_ignore(path, options.get("exclude")):
                return
            if options.get("api_prefix") and not path.startswith(options["api_prefix"]):
                return

            try:
                body_bytes = request.body.read() if request.body else None
                body_data = _json.loads(body_bytes) if body_bytes else None
                # Put body back so actual handler can still read it
                import io
                request.body = io.BytesIO(body_bytes or b"")
            except Exception:
                body_data = None

            query_string = request.query_string if hasattr(request, "query_string") else ""
            report_endpoint(client, method, path, body_data, query_string, options)

        # Register as a CherryPy tool
        cherrypy.tools.botversion = cherrypy.Tool(
            "before_handler",
            botversion_cherrypy_hook,
        )
        cherrypy.config.update({"tools.botversion.on": True})

        def botversion_cherrypy_response_hook():
            # Capture the shape of the successful JSON reply (field names only)
            try:
                req = cherrypy.request
                resp = cherrypy.response
                path = req.path_info
                method = req.method.upper()
                if not should_watch_response(method, path, options):
                    return
                body = None
                if not getattr(resp, "stream", False):   # streamed replies are skipped
                    body = resp.collapse_body()
                report_response_body(
                    client, method, path, parse_status_code(resp.status),
                    resp.headers.get("Content-Type", ""), body,
                )
            except Exception:
                pass

        cherrypy.tools.botversion_response = cherrypy.Tool(
            "before_finalize",
            botversion_cherrypy_response_hook,
        )
        cherrypy.config.update({"tools.botversion_response.on": True})

    except Exception:
        pass


# ══════════════════════════════════════════════════════════════════════════════
# Response shape capture
# Records only field names and types of successful JSON replies (never values)
# so the platform knows what each endpoint returns.
# ══════════════════════════════════════════════════════════════════════════════

_reported_responses = set()
_response_attempts = {}          # stops watching an endpoint after a few replies with no usable shape
MAX_RESPONSE_ATTEMPTS = 5
MAX_RESPONSE_CAPTURE_BYTES = 256 * 1024
MAX_RESPONSE_DEPTH = 4
MAX_RESPONSE_FIELDS = 50


def is_botversion_internal_path(path):
    # Our own scan-trigger route must never be reported as one of the host's endpoints
    return str(path or "").startswith("/__botversion/")


def parse_status_code(value):
    """Turns 200, HTTPStatus.OK, or '200 OK' into the number 200 (0 if unreadable)."""
    try:
        value = getattr(value, "value", value)
        if isinstance(value, int):
            return value
        return int(str(value).strip().split()[0])
    except Exception:
        return 0


def looks_like_id_key(key):
    # Keys that look like record IDs or emails are never sent as field names
    key = str(key)
    return bool(
        re.match(r"^\d+$", key)
        or re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", key, re.I)
        or re.match(r"^[0-9a-f]{24}$", key, re.I)
        or re.match(r"^c[a-z0-9]{20,}$", key, re.I)
        or (len(key) >= 16 and re.search(r"[a-zA-Z]", key) and re.search(r"[0-9]", key))
        or "@" in key
    )


def describe_response_value(val, depth=0):
    if val is None:
        return {"type": "string"}
    if isinstance(val, (list, tuple)):
        if depth >= MAX_RESPONSE_DEPTH or len(val) == 0:
            return {"type": "array", "items": {"type": "object"}}
        return {"type": "array", "items": _describe_array_items(list(val)[:5], depth + 1)}
    if isinstance(val, dict):
        keys = list(val.keys())
        if depth >= MAX_RESPONSE_DEPTH or any(looks_like_id_key(k) for k in keys):
            return {"type": "object"}
        properties = {}
        for k in keys[:MAX_RESPONSE_FIELDS]:
            properties[str(k)] = describe_response_value(val[k], depth + 1)
        return {"type": "object", "properties": properties}
    if isinstance(val, bool):          # must be checked before int (bool is a kind of int)
        return {"type": "boolean"}
    if isinstance(val, (int, float)):
        return {"type": "number"}
    return {"type": "string"}


def _describe_array_items(items, depth):
    # Combines the first few list items so fields missing from one item still appear
    objs = [i for i in items if isinstance(i, dict)]
    if not objs:
        first = next((i for i in items if i is not None), None)
        return {"type": "object"} if first is None else describe_response_value(first, depth)
    merged = {}
    for o in objs:
        for k in list(o.keys())[:MAX_RESPONSE_FIELDS]:
            if merged.get(k) is None:
                merged[k] = o[k]
    return describe_response_value(merged, depth)


def has_response_fields(schema):
    # A shape with no fields (empty list, {}) is not useful — keep waiting for a better reply
    if not schema:
        return False
    if schema.get("type") == "array":
        return has_response_fields(schema.get("items"))
    return bool(schema.get("properties"))


def unwrap_trpc_result(entry):
    # tRPC wraps each result as { result: { data: { json: ... } } }; errors as { error }
    if isinstance(entry, dict):
        if entry.get("error") and not entry.get("result"):
            return None
        result = entry.get("result")
        if isinstance(result, dict) and "data" in result:
            data = result["data"]
            return data["json"] if isinstance(data, dict) and "json" in data else data
    return entry


def is_response_shape_needed(method, raw_path):
    """True while at least one endpoint behind this path still has no captured reply shape."""
    if is_botversion_internal_path(raw_path):
        return False
    paths = [normalize_path(p) for p in split_batch_path(raw_path)]
    with _lock:
        for p in paths:
            k = f"{method}:{p}"
            if k not in _reported_responses and _response_attempts.get(k, 0) < MAX_RESPONSE_ATTEMPTS:
                return True
    return False


def should_watch_response(method, path, options):
    """Same ignore / api_prefix rules as request reporting, plus 'do we still need this shape?'"""
    if should_ignore(path, options.get("exclude")):
        return False
    prefix = options.get("api_prefix")
    if prefix and not path.startswith(prefix):
        return False
    return is_response_shape_needed(method, path)


def parse_captured_body(body):
    """Accepts bytes, str, or an already-built dict/list. Also copes with gzip-compressed replies."""
    if body is None:
        return None
    if isinstance(body, (dict, list)):
        try:
            # Round-trip so we see exactly what is sent (handles dates, custom objects)
            return json.loads(json.dumps(body, default=str))
        except Exception:
            return None
    try:
        raw = body.encode("utf-8") if isinstance(body, str) else bytes(body)
        if len(raw) > MAX_RESPONSE_CAPTURE_BYTES:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            pass
        if raw[:2] == b"\x1f\x8b":   # gzip header — the host app compressed the reply
            out = zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(raw, 1024 * 1024)
            return json.loads(out.decode("utf-8"))
        if raw[:1] == b"\x78":       # deflate (zlib header) — other common compression
            out = zlib.decompressobj().decompress(raw, 1024 * 1024)
            return json.loads(out.decode("utf-8"))
        try:                         # brotli has no header marker, so it is only tried if the library is installed
            import brotli
            out = brotli.decompress(raw)
            if len(out) <= 1024 * 1024:
                return json.loads(out.decode("utf-8"))
        except Exception:
            pass
    except Exception:
        pass
    return None


def _send_response_update(client, method, path, schema):
    # Only queues the update; sending happens in the background, in call order
    try:
        client.update_endpoint({
            "method": method,
            "path": path,
            "request_body": None,
            "response_body": schema,
            "detected_by": "runtime",
        })
    except Exception:
        return None


def report_response_shape(client, method, raw_path, parsed):
    """Turns an already-parsed reply into field-name shapes and reports each new one."""
    try:
        if not isinstance(parsed, (dict, list)):
            return
        is_trpc = "/trpc/" in raw_path
        paths = [normalize_path(p) for p in split_batch_path(raw_path)]

        if len(paths) > 1:
            if not is_trpc or not isinstance(parsed, list) or len(parsed) != len(paths):
                return
            slots = [unwrap_trpc_result(e) for e in parsed]
        else:
            slots = [unwrap_trpc_result(parsed) if is_trpc else parsed]

        for p, slot in zip(paths, slots):
            key = f"{method}:{p}"
            with _lock:
                if key in _reported_responses:
                    continue
            if not isinstance(slot, (dict, list)):
                continue
            schema = describe_response_value(slot, 0)
            if not has_response_fields(schema):
                continue
            with _lock:
                _reported_responses.add(key)
            _send_response_update(client, method, p, schema)
    except Exception:
        return


def report_response_body(client, method, path, status_code, content_type, body):
    """
    The ONE function every framework calls once it has the app's reply.
    body may be bytes, str, a dict/list, or None (None = reply could not be read safely,
    e.g. a stream — it is skipped but still counted as an attempt).
    Never raises into the host app.
    """
    try:
        if not isinstance(status_code, int) or status_code < 200 or status_code >= 300:
            return
        paths = [normalize_path(p) for p in split_batch_path(path)]
        with _lock:
            for p in paths:
                k = f"{method}:{p}"
                _response_attempts[k] = _response_attempts.get(k, 0) + 1
        if body is None:
            return
        ct = str(content_type or "").lower()
        if ct and "json" not in ct:
            return
        report_response_shape(client, method, path, parse_captured_body(body))
    except Exception:
        return


# ── FastAPI / Starlette: reads replies as they pass by, without holding them back ─

def _add_asgi_response_capture(app, client, options):
    try:
        class BotVersionResponseCapture:
            def __init__(self, app):
                self.app = app

            async def __call__(self, scope, receive, send):
                if scope.get("type") != "http":
                    await self.app(scope, receive, send)
                    return

                path = scope.get("path", "")
                method = str(scope.get("method", "")).upper()
                try:
                    watch = should_watch_response(method, path, options)
                except Exception:
                    watch = False
                if not watch:
                    await self.app(scope, receive, send)
                    return

                # Drops cache-validation headers so the app sends a full reply instead of an empty 304
                # (which has no body to read). Only runs while this endpoint still has no captured shape.
                try:
                    scope["headers"] = [
                        (k, v) for (k, v) in (scope.get("headers") or [])
                        if k.lower() not in (b"if-none-match", b"if-modified-since")
                    ]
                except Exception:
                    pass

                state = {"status": 0, "ct": "", "chunks": [], "size": 0, "skip": False}

                async def capturing_send(message):
                    try:
                        mtype = message.get("type")
                        if mtype == "http.response.start":
                            state["status"] = message.get("status", 0)
                            for k, v in (message.get("headers") or []):
                                if k.lower() == b"content-type":
                                    state["ct"] = v.decode("latin-1")
                                    break
                            if state["ct"] and "json" not in state["ct"].lower():
                                state["skip"] = True
                        elif mtype == "http.response.body":
                            if not state["skip"]:
                                chunk = message.get("body", b"") or b""
                                state["size"] += len(chunk)
                                if state["size"] > MAX_RESPONSE_CAPTURE_BYTES:
                                    state["skip"] = True
                                    state["chunks"] = []
                                else:
                                    state["chunks"].append(chunk)
                            if not message.get("more_body", False):
                                body = None if state["skip"] else b"".join(state["chunks"])
                                report_response_body(client, method, path, state["status"], state["ct"], body)
                    except Exception:
                        pass
                    await send(message)

                await self.app(scope, receive, capturing_send)

        app.add_middleware(BotVersionResponseCapture)
    except Exception:
        pass


# ── Tornado helper ────────────────────────────────────────────────────────────

def _collect_tornado_part(handler, chunk):
    if chunk is None:
        return
    state = handler.__dict__.setdefault("_botversion_resp", {"parts": [], "size": 0, "skip": False})
    if state["skip"]:
        return
    if isinstance(chunk, dict):          # Tornado turns a dict into JSON by itself
        state["parts"].append(chunk)
        return
    if isinstance(chunk, str):
        chunk = chunk.encode("utf-8")
    if isinstance(chunk, (bytes, bytearray)):
        state["size"] += len(chunk)
        if state["size"] > MAX_RESPONSE_CAPTURE_BYTES:
            state["skip"] = True
            state["parts"] = []
        else:
            state["parts"].append(bytes(chunk))