# botversion-sdk-python/botversion-sdk/scanner.py
import re


def scan_routes(app, framework):
    """
    Entry point — delegates to the correct scanner based on detected framework.
    Mirrors JS scanner.scanExpressRoutes() / scanNextJsRoutes()
    """
    if framework == "fastapi":
        return scan_fastapi_routes(app)
    elif framework == "flask":
        return scan_flask_routes(app)
    elif framework == "django":
        return scan_django_routes()
    return []


# ── FastAPI ──────────────────────────────────────────────────────────────────

def scan_fastapi_routes(app):
    endpoints = []
    seen = set()

    try:
        for route in app.routes:
            # Skip non-API routes (static files, docs, websockets, etc.)
            if not hasattr(route, "methods") or not route.methods:
                continue

            path = route.path
            # Skip docs/openapi
            if path in ("/docs", "/redoc", "/openapi.json"):
                continue

            methods = [m for m in route.methods if m not in ("HEAD", "OPTIONS")]

            for method in methods:
                normalized_path = re.sub(r"\{([^}]+)\}", r":\1", path)
                key = f"{method}:{normalized_path}"
                if key in seen:
                    continue
                seen.add(key)

                params = extract_path_params(normalized_path)
                handler_name = getattr(route, "name", None) or getattr(
                    getattr(route, "endpoint", None), "__name__", None
                )

                endpoints.append({
                    "method": method,
                    "path": normalized_path,
                    "description": generate_description(method, normalized_path, handler_name),
                    "requestBody": build_param_schema(params) if method != "GET" and params else None,
                    "detectedBy": "static-scan",
                })

    except Exception as e:
        print(f"[BotVersion SDK] ⚠ FastAPI scan error: {e}")

    return endpoints


# ── Flask ────────────────────────────────────────────────────────────────────

def scan_flask_routes(app):
    endpoints = []
    seen = set()

    try:
        for rule in app.url_map.iter_rules():
            # Skip static and internal Flask routes
            if rule.endpoint == "static":
                continue
            if rule.rule.startswith("/static"):
                continue

            # Normalize Flask path format <int:id> → :id
            path = normalize_flask_path(rule.rule)
            methods = [m for m in rule.methods if m not in ("HEAD", "OPTIONS")]

            for method in methods:
                key = f"{method}:{path}"
                if key in seen:
                    continue
                seen.add(key)

                params = extract_path_params(path)

                # Try to get the handler function name for description
                handler_fn = app.view_functions.get(rule.endpoint)
                handler_name = getattr(handler_fn, "__name__", rule.endpoint)

                endpoints.append({
                    "method": method,
                    "path": path,
                    "description": generate_description(method, path, handler_name),
                    "requestBody": build_param_schema(params) if method != "GET" and params else None,
                    "detectedBy": "static-scan",
                })

    except Exception as e:
        print(f"[BotVersion SDK] ⚠ Flask scan error: {e}")

    return endpoints


# ── Django ───────────────────────────────────────────────────────────────────

def scan_django_routes():
    endpoints = []
    seen = set()

    try:
        from django.urls import get_resolver
        from django.urls.resolvers import URLPattern, URLResolver

        resolver = get_resolver()
        _walk_django_patterns(resolver.url_patterns, "", endpoints, seen)
    except Exception as e:
        print(f"[BotVersion SDK] ⚠ Django scan error: {e}")

    return endpoints


def _walk_django_patterns(patterns, prefix, endpoints, seen):
    try:
        from django.urls.resolvers import URLPattern, URLResolver
    except ImportError:
        return

    for pattern in patterns:
        if isinstance(pattern, URLResolver):
            sub_prefix = prefix + _django_pattern_to_path(str(pattern.pattern))
            _walk_django_patterns(pattern.url_patterns, sub_prefix, endpoints, seen)

        elif isinstance(pattern, URLPattern):
            path = prefix + _django_pattern_to_path(str(pattern.pattern))
            methods = _detect_django_methods(pattern.callback)
            handler_name = getattr(pattern.callback, "__name__", None)

            for method in methods:
                key = f"{method}:{path}"
                if key in seen:
                    continue
                seen.add(key)

                params = extract_path_params(path)
                endpoints.append({
                    "method": method,
                    "path": path,
                    "description": generate_description(method, path, handler_name),
                    "requestBody": build_param_schema(params) if method != "GET" and params else None,
                    "detectedBy": "static-scan",
                })


def _detect_django_methods(callback):
    """
    Detect HTTP methods from a Django view.
    Handles class-based views, DRF ViewSets/APIViews, and function-based views.
    """
    # Class-based view — has http_method_names
    if hasattr(callback, "view_class"):
        cls = callback.view_class
        all_methods = ["GET", "POST", "PUT", "PATCH", "DELETE"]
        return [m for m in all_methods if hasattr(cls, m.lower())]

    # DRF ViewSet — has actions dict
    if hasattr(callback, "actions"):
        return [m.upper() for m in callback.actions.keys()]

    # DRF APIView — has http_method_names on the cls
    if hasattr(callback, "cls"):
        cls = callback.cls
        all_methods = ["GET", "POST", "PUT", "PATCH", "DELETE"]
        return [m for m in all_methods if hasattr(cls, m.lower())]

    # Function-based view — default to GET + POST
    return ["GET", "POST"]


def _django_pattern_to_path(pattern):
    """
    Convert Django URL pattern to a clean path string.
    e.g. "api/users/(?P<id>[0-9]+)/" → "/api/users/:id"
    """
    # Remove regex named groups
    path = re.sub(r"\(\?P<([^>]+)>[^)]+\)", r":\1", pattern)
    # New-style Django path converters <int:pk> → :pk
    path = re.sub(r"<(?:[^:>]+:)?([^>]+)>", r":\1", path)
    # Remove remaining regex artifacts
    path = re.sub(r"[\\^$]", "", path)
    # Ensure leading slash
    if not path.startswith("/"):
        path = "/" + path
    # Remove trailing slash for consistency (keep root as "/")
    path = path.rstrip("/") or "/"
    return path


# ── Shared utilities ─────────────────────────────────────────────────────────

def normalize_flask_path(rule):
    """
    Convert Flask path format to standard :param format.
    /users/<int:id> → /users/:id
    /users/<string:name> → /users/:name
    /users/<id> → /users/:id
    """
    return re.sub(r"<(?:[^:>]+:)?([^>]+)>", r":\1", rule)


def extract_path_params(path):
    """Extract :param names from a path like /users/:id/posts/:postId"""
    return re.findall(r":([a-zA-Z_][a-zA-Z0-9_]*)", path)


def build_param_schema(params):
    """
    Build a simple schema from path param names.
    Mirrors JS buildParamSchema()
    """
    properties = {p: {"type": "string"} for p in params}
    return {"type": "object", "properties": properties}


def generate_description(method, path, handler_name=None):
    """
    Generate a human-readable description for an endpoint.
    Mirrors JS scanner logic.
    """
    if handler_name and handler_name not in ("anonymous", "dispatch", ""):
        # Convert snake_case → readable words
        name = re.sub(r"_", " ", handler_name)
        # Convert camelCase → readable words
        name = re.sub(r"([A-Z])", r" \1", name)
        return name.strip().title()

    segments = [s for s in path.split("/") if s and not s.startswith(":")]
    resource = segments[-1] if segments else "resource"
    resource = resource.replace("_", " ").replace("-", " ").title()

    verbs = {
        "GET": "Get",
        "POST": "Create",
        "PUT": "Update",
        "PATCH": "Partially Update",
        "DELETE": "Delete",
    }

    verb = verbs.get(method, method.title())
    return f"{verb} {resource}"
