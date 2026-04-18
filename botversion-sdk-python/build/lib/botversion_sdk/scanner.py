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
                normalized_path = normalized_path.rstrip("/") or "/"
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
                    "requestBody": extract_request_body_schema(route, method),
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
            path = normalize_flask_path(rule.rule).rstrip("/") or "/"
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
                    "requestBody": extract_flask_schema(handler_fn, method) or (build_param_schema(params) if method != "GET" and params else None),
                    "detectedBy": "static-scan",
                })

    except Exception as e:
        print(f"[BotVersion SDK] ⚠ Flask scan error: {e}")

    return endpoints


def join_paths(prefix, suffix):
    """
    Safely join two path segments without creating double slashes.
    """
    # Strip trailing slash from prefix, leading slash from suffix
    prefix = prefix.rstrip("/")
    suffix = suffix.lstrip("/")
    if not suffix:
        return prefix or "/"
    return prefix + "/" + suffix


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


def extract_drf_schema(callback, method):
    """
    Extract request body schema from a DRF serializer.
    Works with APIView, GenericAPIView, ViewSet.
    Returns a JSON schema dict or None.
    """
    if method.upper() == "GET":
        return None

    try:
        # Get the view class
        view_class = None
        if hasattr(callback, "view_class"):
            view_class = callback.view_class
        elif hasattr(callback, "cls"):
            view_class = callback.cls

        if not view_class:
            return None

        # Try to get serializer class
        serializer_class = None

        # Direct attribute
        if hasattr(view_class, "serializer_class"):
            serializer_class = view_class.serializer_class

        if not serializer_class:
            return None

        # Instantiate the serializer to inspect fields
        serializer = serializer_class()
        properties = {}
        required = []

        for field_name, field in serializer.fields.items():
            # Skip read-only fields — they don't go in request body
            if getattr(field, "read_only", False):
                continue

            # Map DRF field types to JSON schema types
            field_type = _drf_field_to_json_type(field)
            properties[field_name] = {
                "type": field_type,
                "description": field_name.replace("_", " ").title(),
            }

            # A field is required if it's not optional and has no default
            from rest_framework.fields import empty
            is_required = (
                getattr(field, "required", True) and
                not getattr(field, "allow_null", False) and
                getattr(field, "default", empty) is empty  # ← only truly required if no default set
            )
            if is_required:
                required.append(field_name)

        if not properties:
            return None

        result = {"type": "object", "properties": properties}
        if required:
            result["required"] = required

        print(f"[BotVersion SDK] ✅ DRF schema extracted for {method}: {list(properties.keys())}")
        return result

    except Exception as e:
        print(f"[BotVersion SDK] ⚠ DRF schema extraction failed: {e}")
        return None


def _drf_field_to_json_type(field):
    """Map a DRF field instance to a JSON schema type string."""
    from rest_framework import fields as drf_fields
    try:
        from rest_framework import fields as drf_fields
        if isinstance(field, (drf_fields.IntegerField,)):
            return "integer"
        if isinstance(field, (drf_fields.FloatField, drf_fields.DecimalField)):
            return "number"
        if isinstance(field, drf_fields.BooleanField):
            return "boolean"
        if isinstance(field, drf_fields.ListField):
            return "array"
    except ImportError:
        pass
    return "string"


def extract_flask_schema(view_func, method):
    """
    Extract request body schema from Flask view functions.
    Supports: Marshmallow, Flask-RESTX, Flask-Pydantic, WTForms
    """
    if method.upper() == "GET":
        return None

    try:
        # ── 1. Flask-RESTX / Flask-RESTPlus ──────────────────────────────
        # Decorators store expect/body info in __apidoc__
        apidoc = getattr(view_func, "__apidoc__", None)
        if apidoc:
            expects = apidoc.get("expects", [])
            for expect in expects:
                if hasattr(expect, "resolved"):
                    schema = expect.resolved
                    properties = {}
                    required = []
                    for field_name, field in schema.items():
                        properties[field_name] = {
                            "type": _restx_field_to_json_type(field),
                            "description": field_name.replace("_", " ").title(),
                        }
                        if field.required:
                            required.append(field_name)
                    if properties:
                        result = {"type": "object", "properties": properties}
                        if required:
                            result["required"] = required
                        print(f"[BotVersion SDK] ✅ Flask-RESTX schema extracted: {list(properties.keys())}")
                        return result

        # ── 2. Marshmallow schema ─────────────────────────────────────────
        # Some devs attach schema directly to view function
        schema = (
            getattr(view_func, "_schema", None) or
            getattr(view_func, "schema", None) or
            getattr(view_func, "_marshmallow_schema", None)
        )
        if schema is not None:
            marshmallow_result = _extract_marshmallow_schema(schema)
            if marshmallow_result:
                print(f"[BotVersion SDK] ✅ Marshmallow schema extracted from view: {list(marshmallow_result.get('properties', {}).keys())}")
                return marshmallow_result

        # ── 3. Flask-RESTX MethodView / Resource ─────────────────────────
        # Check if the view class has a schema on the method
        view_class = getattr(view_func, "view_class", None)
        if view_class:
            method_fn = getattr(view_class, method.lower(), None)
            if method_fn:
                # Check for marshmallow schema on method
                schema = (
                    getattr(method_fn, "_schema", None) or
                    getattr(method_fn, "schema", None)
                )
                if schema:
                    marshmallow_result = _extract_marshmallow_schema(schema)
                    if marshmallow_result:
                        print(f"[BotVersion SDK] ✅ Marshmallow schema extracted from method: {list(marshmallow_result.get('properties', {}).keys())}")
                        return marshmallow_result

                # Check for RESTX expect decorator
                apidoc = getattr(method_fn, "__apidoc__", None)
                if apidoc:
                    expects = apidoc.get("expects", [])
                    for expect in expects:
                        if hasattr(expect, "resolved"):
                            schema = expect.resolved
                            properties = {}
                            required = []
                            for field_name, field in schema.items():
                                properties[field_name] = {
                                    "type": _restx_field_to_json_type(field),
                                    "description": field_name.replace("_", " ").title(),
                                }
                                if field.required:
                                    required.append(field_name)
                            if properties:
                                result = {"type": "object", "properties": properties}
                                if required:
                                    result["required"] = required
                                return result

        # ── 4. Pydantic model attached to view ────────────────────────────
        pydantic_model = getattr(view_func, "_pydantic_model", None)
        if pydantic_model and hasattr(pydantic_model, "model_json_schema"):
            schema = pydantic_model.model_json_schema()
            print(f"[BotVersion SDK] ✅ Pydantic schema extracted from Flask view")
            return schema
        if pydantic_model and hasattr(pydantic_model, "schema"):
            schema = pydantic_model.schema()
            print(f"[BotVersion SDK] ✅ Pydantic v1 schema extracted from Flask view")
            return schema

    except Exception as e:
        print(f"[BotVersion SDK] ⚠ Flask schema extraction failed: {e}")

    return None


def _extract_marshmallow_schema(schema):
    """
    Extract JSON schema properties from a Marshmallow schema instance or class.
    """
    try:
        import marshmallow

        # Instantiate if it's a class
        if isinstance(schema, type):
            schema = schema()

        if not isinstance(schema, marshmallow.Schema):
            return None

        properties = {}
        required = []

        for field_name, field in schema.fields.items():
            # Skip dump_only fields (read-only)
            if getattr(field, "dump_only", False):
                continue

            field_type = _marshmallow_field_to_json_type(field)
            properties[field_name] = {
                "type": field_type,
                "description": field_name.replace("_", " ").title(),
            }

            if getattr(field, "required", False):
                required.append(field_name)

        if not properties:
            return None

        result = {"type": "object", "properties": properties}
        if required:
            result["required"] = required
        return result

    except ImportError:
        return None
    except Exception as e:
        print(f"[BotVersion SDK] ⚠ Marshmallow extraction failed: {e}")
        return None


def _marshmallow_field_to_json_type(field):
    """Map Marshmallow field types to JSON schema types."""
    try:
        import marshmallow.fields as ma_fields
        if isinstance(field, ma_fields.Integer):
            return "integer"
        if isinstance(field, (ma_fields.Float, ma_fields.Decimal)):
            return "number"
        if isinstance(field, ma_fields.Boolean):
            return "boolean"
        if isinstance(field, (ma_fields.List, ma_fields.Tuple)):
            return "array"
        if isinstance(field, ma_fields.Dict):
            return "object"
    except ImportError:
        pass
    return "string"


def _restx_field_to_json_type(field):
    """Map Flask-RESTX field types to JSON schema types."""
    type_name = type(field).__name__.lower()
    if "integer" in type_name:
        return "integer"
    if "float" in type_name:
        return "number"
    if "boolean" in type_name:
        return "boolean"
    if "list" in type_name:
        return "array"
    return "string"


def _walk_django_patterns(patterns, prefix, endpoints, seen):
    try:
        from django.urls.resolvers import URLPattern, URLResolver
    except ImportError:
        return

    for pattern in patterns:
        if isinstance(pattern, URLResolver):
            sub_prefix = join_paths(prefix, _django_pattern_to_path(str(pattern.pattern)))
            print(f"[BotVersion SDK] 📁 resolver: '{str(pattern.pattern)}' → prefix: '{sub_prefix}'")
            _walk_django_patterns(pattern.url_patterns, sub_prefix, endpoints, seen)

        elif isinstance(pattern, URLPattern):
            path = join_paths(prefix, _django_pattern_to_path(str(pattern.pattern)))
            print(f"[BotVersion SDK] 🔍 endpoint: '{str(pattern.pattern)}' → path: '{path}'")
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
                    "requestBody": extract_drf_schema(pattern.callback, method) or (build_param_schema(params) if method != "GET" and params else None),
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
    if path != "/" and not path.endswith("/"):
        path = path + "/"
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



def extract_request_body_schema(route, method):
    if method == "GET":
        return None

    try:
        if hasattr(route, "dependant") and route.dependant.body_params:
            properties = {}
            required = []

            for field in route.dependant.body_params:
                field_name = field.name

                # Try multiple ways to get the annotation
                annotation = None

                # FastAPI/Pydantic v2
                if hasattr(field, "field_info") and hasattr(field.field_info, "annotation"):
                    annotation = field.field_info.annotation

                # Pydantic v1 style
                if annotation is None and hasattr(field, "outer_type_"):
                    annotation = field.outer_type_

                # Fallback
                if annotation is None:
                    annotation = getattr(field, "type_", None)

                print(f"[BotVersion SDK] Field: {field_name}, annotation: {annotation}")

                if annotation and hasattr(annotation, "model_json_schema"):
                    # Pydantic v2 — inline the model's fields directly
                    schema = annotation.model_json_schema()
                    properties.update(schema.get("properties", {}))
                    required.extend(schema.get("required", []))
                elif annotation and hasattr(annotation, "schema"):
                    # Pydantic v1 — inline the model's fields directly
                    schema = annotation.schema()
                    properties.update(schema.get("properties", {}))
                    required.extend(schema.get("required", []))
                else:
                    # Scalar param — keep as-is
                    properties[field_name] = {"type": "string"}
                    required.append(field_name)

            if properties:
                result = {"type": "object", "properties": properties}
                if required:
                    result["required"] = required
                return result

    except Exception as e:
        print(f"[BotVersion SDK] ⚠ Body schema extraction failed: {e}")

    return None