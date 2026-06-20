# botversion-sdk-python/botversion-sdk/scanner.py
import re
import inspect
import typing
from typing import Annotated


def scan_routes(app, framework):
    result = []
    if framework == "fastapi":
        result = scan_fastapi_routes(app)
    elif framework == "flask":
        result = scan_flask_routes(app)
    elif framework == "django":
        result = scan_django_routes()
    # ── NEW frameworks ────────────────────────────────────────────────────
    elif framework == "starlette":
        result = scan_starlette_routes(app)
    elif framework == "sanic":
        result = scan_sanic_routes(app)
    elif framework == "falcon":
        result = scan_falcon_routes(app)
    elif framework == "bottle":
        result = scan_bottle_routes(app)
    elif framework == "aiohttp":
        result = scan_aiohttp_routes(app)
    elif framework == "tornado":
        result = scan_tornado_routes(app)
    elif framework == "pyramid":
        result = scan_pyramid_routes(app)
    elif framework == "cherrypy":
        result = scan_cherrypy_routes(app)

    return result


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
            SKIP_PREFIXES = ["/admin", "/static", "/media"]
            if path in ("/docs", "/redoc", "/openapi.json"):
                continue
            if any(path.startswith(p) for p in SKIP_PREFIXES):
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

    except Exception:
        pass

    return endpoints


# ── Flask ────────────────────────────────────────────────────────────────────

def scan_flask_routes(app):
    endpoints = []
    seen = set()

    SKIP_PREFIXES = ("/swaggerui", "/static", "/_", "/admin", "/media")
    SKIP_EXACT = ("/swagger.json", "/redoc", "/openapi.json", "/docs", "/favicon.ico")

    try:
        for rule in app.url_map.iter_rules():
            # Skip Flask internal static routes
            if rule.endpoint == "static":
                continue

            # Skip common documentation/UI routes
            if any(rule.rule.startswith(p) for p in SKIP_PREFIXES):
                continue
            if rule.rule in SKIP_EXACT:
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
                    "requestBody": (
                        extract_flask_schema(handler_fn, method) or
                        extract_restx_resource_schema(app, rule, method) or
                        (build_param_schema(params) if method != "GET" and params else None)
                    ),
                    "detectedBy": "static-scan",
                })

    except Exception:
        pass

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
    except Exception:
        pass

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

        # Fallback — try calling get_serializer_class() on the view
        if not serializer_class and hasattr(view_class, "get_serializer_class"):
            try:
                serializer_class = view_class().get_serializer_class()
            except Exception:
                pass

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

        return result

    except Exception:
        pass

    # Strategy 2 — request.data / request.POST pattern
    try:
        src = None

        if hasattr(callback, "view_class"):
            method_fn = getattr(callback.view_class, method.lower(), None)
            if method_fn:
                src = inspect.getsource(method_fn)
        elif hasattr(callback, "cls"):
            method_fn = getattr(callback.cls, method.lower(), None)
            if method_fn:
                src = inspect.getsource(method_fn)
        else:
            src = inspect.getsource(callback)

        if src:
            fields = set()

            for m in re.finditer(r"request\.data(?:\.get\(|\[)\s*['\"]([a-zA-Z_][a-zA-Z0-9_]*)['\"]", src):
                fields.add(m.group(1))

            for m in re.finditer(r"request\.POST(?:\.get\(|\[)\s*['\"]([a-zA-Z_][a-zA-Z0-9_]*)['\"]", src):
                fields.add(m.group(1))

            var_match = re.search(r"(\w+)\s*=\s*request\.data", src)
            if var_match:
                var = var_match.group(1)
                for m in re.finditer(rf"{var}(?:\.get\(|\[)\s*['\"]([a-zA-Z_][a-zA-Z0-9_]*)['\"]", src):
                    fields.add(m.group(1))

            for m in re.finditer(r"validated_data(?:\.get\(|\[)\s*['\"]([a-zA-Z_][a-zA-Z0-9_]*)['\"]", src):
                fields.add(m.group(1))

            # SomeSerializer(data=request.data) — extract serializer class and inspect its fields
            for m in re.finditer(r"(\w+Serializer)\s*\(", src):
                serializer_name = m.group(1)
                try:
                    import sys
                    for module in sys.modules.values():
                        serializer_cls = getattr(module, serializer_name, None)
                        if serializer_cls and hasattr(serializer_cls, "_declared_fields"):
                            for field_name, field in serializer_cls._declared_fields.items():
                                if not getattr(field, "read_only", False):
                                    fields.add(field_name)
                            break
                        if serializer_cls and hasattr(serializer_cls, "Meta") and hasattr(getattr(serializer_cls, "Meta"), "fields"):
                            meta_fields = serializer_cls.Meta.fields
                            if isinstance(meta_fields, (list, tuple)):
                                for field_name in meta_fields:
                                    if field_name != "__all__":
                                        fields.add(field_name)
                            break
                except Exception:
                    pass

            if fields:
                properties = {f: {"type": infer_field_type(f, src), "description": f.replace("_", " ").title()} for f in fields}
                return {"type": "object", "properties": properties}

    except Exception:
        return None

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
        hints = typing.get_type_hints(view_func) if callable(view_func) else {}
    except Exception:
        pass

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
            return schema
        if pydantic_model and hasattr(pydantic_model, "schema"):
            schema = pydantic_model.schema()
            return schema

    except Exception:
        pass

    # Strategy 5 — plain request.json / request.get_json() / request.form pattern
    try:
        src = inspect.getsource(view_func)
        fields = set()

        # request.json.get('field') or request.json['field']
        for m in re.finditer(r"request\.json(?:\.get\(|)\s*['\"]([a-zA-Z_][a-zA-Z0-9_]*)['\"]", src):
            fields.add(m.group(1))

        # request.get_json().get('field') or request.get_json()['field']
        for m in re.finditer(r"request\.get_json\(\)(?:\.get\(|)\s*['\"]([a-zA-Z_][a-zA-Z0-9_]*)['\"]", src):
            fields.add(m.group(1))

        # data = request.get_json() then data['field'] or data.get('field')
        var_match = re.search(r"(\w+)\s*=\s*request\.get_json\(\)", src)
        if var_match:
            var = var_match.group(1)
            for m in re.finditer(rf"{var}(?:\.get\(|\[)\s*['\"]([a-zA-Z_][a-zA-Z0-9_]*)['\"]", src):
                fields.add(m.group(1))

        # request.form.get('field') or request.form['field']
        for m in re.finditer(r"request\.form(?:\.get\(|\[)\s*['\"]([a-zA-Z_][a-zA-Z0-9_]*)['\"]", src):
            fields.add(m.group(1))

        if fields:
            properties = {f: {"type": infer_field_type(f, src)} for f in fields}
            return {"type": "object", "properties": properties}

    except Exception:
        pass

    return None



def extract_restx_resource_schema(app, rule, method):
    """
    Handles Flask-RESTX Resource classes.
    Flask-RESTX stores schema info on the Resource class method,
    not on the Flask view function.
    """
    try:
        handler_fn = app.view_functions.get(rule.endpoint)
        if not handler_fn:
            return None

        # Flask-RESTX attaches the Resource class as view_class
        view_class = getattr(handler_fn, "view_class", None)
        if not view_class:
            return None

        # Get the actual method e.g. Register.post
        method_fn = getattr(view_class, method.lower(), None)
        if not method_fn:
            return None

        # @rest_api.expect() stores info in __apidoc__
        apidoc = getattr(method_fn, "__apidoc__", None)
        if not apidoc:
            return None

        # Flask-RESTX uses "expect" key (not "expects")
        expects = apidoc.get("expect", [])
        for expect_entry in expects:
            model = expect_entry[0] if isinstance(expect_entry, (list, tuple)) else expect_entry
            if hasattr(model, "resolved"):
                properties = {}
                required = []
                for field_name, field in model.resolved.items():
                    properties[field_name] = {
                        "type": _restx_field_to_json_type(field),
                        "description": field_name.replace("_", " ").title(),
                    }
                    if getattr(field, "required", False):
                        required.append(field_name)
                if properties:
                    result = {"type": "object", "properties": properties}
                    if required:
                        result["required"] = required
                    return result

    except Exception:
        pass
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
    
    SKIP_PREFIXES = ["/admin", "/static", "/media"]

    for pattern in patterns:
        if isinstance(pattern, URLResolver):
            sub_prefix = join_paths(prefix, _django_pattern_to_path(str(pattern.pattern)))

            if any(sub_prefix.startswith(p) for p in SKIP_PREFIXES):
                continue

            _walk_django_patterns(pattern.url_patterns, sub_prefix, endpoints, seen)

        elif isinstance(pattern, URLPattern):
            path = join_paths(prefix, _django_pattern_to_path(str(pattern.pattern)))
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


def infer_field_type(field_name, source_code):
    """Infer the type of a field from how it's used in source code."""
    import re

    # Check if used as array/list
    array_patterns = [
        rf"{field_name}\s*\.\s*(append|extend|pop|remove|sort|reverse|__iter__|__len__)",
        rf"for\s+\w+\s+in\s+{field_name}\b",
        rf"len\s*\(\s*{field_name}\s*\)",
        rf"isinstance\s*\(\s*{field_name}\s*,\s*(list|List)\s*\)",
        rf"\[\s*\.\.\.{field_name}\s*\]",
    ]
    if any(re.search(p, source_code) for p in array_patterns):
        return "array"

    # Check if used as number
    number_patterns = [
        rf"{field_name}\s*[+\-*/%]\s*\d",
        rf"int\s*\(\s*{field_name}\s*\)",
        rf"float\s*\(\s*{field_name}\s*\)",
        rf"isinstance\s*\(\s*{field_name}\s*,\s*(int|float)\s*\)",
        rf"not\s+isinstance\s*\(\s*{field_name}\s*,\s*(int|float)\s*\)",
        rf"type\s*\(\s*{field_name}\s*\)\s*is\s*(not\s+)?(int|float)",
    ]
    if any(re.search(p, source_code) for p in number_patterns):
        return "number"

    # Check if used as boolean
    bool_patterns = [
        rf"{field_name}\s*==\s*(True|False)",
        rf"(True|False)\s*==\s*{field_name}",
        rf"isinstance\s*\(\s*{field_name}\s*,\s*bool\s*\)",
        rf"bool\s*\(\s*{field_name}\s*\)",
        rf"type\s*\(\s*{field_name}\s*\)\s*is\s*(not\s+)?bool",
        rf"not\s+isinstance\s*\(\s*{field_name}\s*,\s*bool\s*\)",
    ]
    if any(re.search(p, source_code) for p in bool_patterns):
        return "boolean"

    return "string"



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
    if method not in ("POST", "PUT", "PATCH"):
        return None

    try:
        # path param names — we must exclude these from body
        path_param_names = set()
        if hasattr(route, "dependant") and hasattr(route.dependant, "path_params"):
            path_param_names = {f.name for f in route.dependant.path_params}

        # Strategy 1: route.dependant.body_params
        if hasattr(route, "dependant") and route.dependant.body_params:
            properties = {}
            required = []

            for field in route.dependant.body_params:
                field_name = field.name

                # Skip path params — they are NOT body fields
                if field_name in path_param_names:
                    continue

                annotation = None
                if hasattr(field, "field_info") and hasattr(field.field_info, "annotation"):
                    annotation = field.field_info.annotation
                if annotation is None and hasattr(field, "outer_type_"):
                    annotation = field.outer_type_
                if annotation is None:
                    annotation = getattr(field, "type_", None)

                if annotation and hasattr(annotation, "model_json_schema"):
                    schema = annotation.model_json_schema()
                    properties.update(schema.get("properties", {}))
                    required.extend(schema.get("required", []))
                elif annotation and hasattr(annotation, "schema"):
                    schema = annotation.schema()
                    properties.update(schema.get("properties", {}))
                    required.extend(schema.get("required", []))
                else:
                    type_map = {"int": "integer", "float": "number", "bool": "boolean", "str": "string"}
                    python_type = getattr(annotation, "__name__", "string") if annotation else "string"
                    properties[field_name] = {"type": type_map.get(python_type, "string")}
                    required.append(field_name)

            if properties:
                result = {"type": "object", "properties": properties}
                if required:
                    result["required"] = list(set(required))
                return result

        # Strategy 2: inspect type hints on endpoint function directly
        endpoint_fn = getattr(route, "endpoint", None)
        if endpoint_fn:
            hints = typing.get_type_hints(endpoint_fn)
            sig = inspect.signature(endpoint_fn)
            properties = {}
            required = []

            skip = {"request", "response", "background_tasks", "db", "session", "user", "current_user"}

            for param_name, param in sig.parameters.items():
                if param_name in skip or param_name in path_param_names:
                    continue
                annotation = hints.get(param_name)
                if annotation is None:
                    continue
                # Unwrap Annotated[Model, Body(...)] if present
                origin = getattr(annotation, "__origin__", None)
                if origin is Annotated:
                    args = annotation.__args__
                    if args:
                        annotation = args[0]
                if hasattr(annotation, "model_json_schema"):
                    schema = annotation.model_json_schema()
                    properties.update(schema.get("properties", {}))
                    required.extend(schema.get("required", []))
                elif hasattr(annotation, "schema"):
                    schema = annotation.schema()
                    properties.update(schema.get("properties", {}))
                    required.extend(schema.get("required", []))

            if properties:
                result = {"type": "object", "properties": properties}
                if required:
                    result["required"] = list(set(required))
                return result

    except Exception:
        return None

    return None


# ── Starlette ─────────────────────────────────────────────────────────────────
# Starlette is what FastAPI is built on, so route scanning is almost identical

def scan_starlette_routes(app):
    endpoints = []
    seen = set()

    try:
        for route in app.routes:
            if not hasattr(route, "methods") or not route.methods:
                continue

            path = route.path
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

                handler_name = getattr(route, "name", None)
                endpoints.append({
                    "method": method,
                    "path": normalized_path,
                    "description": generate_description(method, normalized_path, handler_name),
                    "requestBody": None,
                    "detectedBy": "static-scan",
                })

    except Exception:
        pass

    return endpoints


# ── Sanic ─────────────────────────────────────────────────────────────────────
# Sanic stores routes in app.router which has a routes_all dict

def scan_sanic_routes(app):
    endpoints = []
    seen = set()

    try:
        # Sanic 21+ uses app.router.routes
        routes = getattr(app.router, "routes", None) or getattr(app.router, "routes_all", {})

        # routes can be a dict or a list depending on Sanic version
        if isinstance(routes, dict):
            routes = routes.values()

        for route in routes:
            path = getattr(route, "path", None) or getattr(route, "uri", None)
            if not path:
                continue

            # Normalize <param> or <param:type> → :param
            normalized_path = re.sub(r"<([^:>]+)(?::[^>]+)?>", r":\1", path)
            normalized_path = normalized_path.rstrip("/") or "/"

            methods = getattr(route, "methods", ["GET"])
            if not methods:
                methods = ["GET"]

            for method in methods:
                method = method.upper()
                if method in ("HEAD", "OPTIONS"):
                    continue

                key = f"{method}:{normalized_path}"
                if key in seen:
                    continue
                seen.add(key)

                handler = getattr(route, "handler", None)
                handler_name = getattr(handler, "__name__", None)

                endpoints.append({
                    "method": method,
                    "path": normalized_path,
                    "description": generate_description(method, normalized_path, handler_name),
                    "requestBody": None,
                    "detectedBy": "static-scan",
                })

    except Exception:
        pass

    return endpoints


# ── Falcon ────────────────────────────────────────────────────────────────────
# Falcon stores routes in its router. We walk the router tree to find them.

def scan_falcon_routes(app):
    endpoints = []
    seen = set()

    ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]

    try:
        # Falcon 3.x
        router = getattr(app, "_router", None)
        if router is None:
            return endpoints

        # Walk the router tree
        def walk_falcon_node(node, prefix=""):
            path = prefix + (getattr(node, "raw_segment", "") or "")
            if not path.startswith("/"):
                path = "/" + path

            resource = getattr(node, "resource", None)
            if resource is not None:
                # Check which HTTP methods the resource handles
                for method in ALL_METHODS:
                    responder_name = f"on_{method.lower()}"
                    if hasattr(resource, responder_name):
                        # Normalize {param} or {param:type} → :param
                        normalized = re.sub(r"\{([^:}]+)(?::[^}]+)?\}", r":\1", path)
                        normalized = normalized.rstrip("/") or "/"
                        key = f"{method}:{normalized}"
                        if key not in seen:
                            seen.add(key)
                            endpoints.append({
                                "method": method,
                                "path": normalized,
                                "description": generate_description(method, normalized, None),
                                "requestBody": None,
                                "detectedBy": "static-scan",
                            })

            for child in getattr(node, "children", []):
                walk_falcon_node(child, path)

        # Start walking from root node
        root = getattr(router, "_roots", None) or getattr(router, "root", None)
        if isinstance(root, list):
            for r in root:
                walk_falcon_node(r)
        elif root:
            walk_falcon_node(root)

    except Exception:
        pass

    return endpoints


# ── Bottle ────────────────────────────────────────────────────────────────────
# Bottle stores all routes in app.routes (a list of Route objects)

def scan_bottle_routes(app):
    endpoints = []
    seen = set()

    try:
        for route in app.routes:
            path = route.rule
            method = route.method.upper()

            if method in ("HEAD", "OPTIONS"):
                continue
            if path in ("/static", "/_"):
                continue

            # Normalize <param> or <param:type> → :param
            normalized_path = re.sub(r"<([^:>]+)(?::[^>]+)?>", r":\1", path)
            normalized_path = normalized_path.rstrip("/") or "/"

            key = f"{method}:{normalized_path}"
            if key in seen:
                continue
            seen.add(key)

            handler_name = getattr(route.callback, "__name__", None)

            endpoints.append({
                "method": method,
                "path": normalized_path,
                "description": generate_description(method, normalized_path, handler_name),
                "requestBody": None,
                "detectedBy": "static-scan",
            })

    except Exception:
        pass

    return endpoints


# ── aiohttp ───────────────────────────────────────────────────────────────────
# aiohttp stores routes in app.router which has a resources() method

def scan_aiohttp_routes(app):
    endpoints = []
    seen = set()

    try:
        for resource in app.router.resources():
            path = resource.canonical
            # Normalize {param} → :param
            normalized_path = re.sub(r"\{([^:}]+)(?::[^}]+)?\}", r":\1", path)
            normalized_path = normalized_path.rstrip("/") or "/"

            # Each resource has routes with methods
            for route in resource:
                method = route.method.upper()
                if method in ("HEAD", "OPTIONS", "*"):
                    continue

                key = f"{method}:{normalized_path}"
                if key in seen:
                    continue
                seen.add(key)

                handler = route.handler
                handler_name = getattr(handler, "__name__", None)

                endpoints.append({
                    "method": method,
                    "path": normalized_path,
                    "description": generate_description(method, normalized_path, handler_name),
                    "requestBody": None,
                    "detectedBy": "static-scan",
                })

    except Exception:
        pass

    return endpoints


# ── Tornado ───────────────────────────────────────────────────────────────────
# Tornado stores URL specs in app.handlers. Each spec maps a path to a handler class.
# The handler class has methods like get(), post() etc. which we detect.

def scan_tornado_routes(app):
    endpoints = []
    seen = set()

    ALL_METHODS = ["get", "post", "put", "patch", "delete"]

    try:
        # Tornado stores handlers as a list of (host_pattern, [URLSpec, ...])
        handler_list = getattr(app, "handlers", [])

        for host_pattern, url_specs in handler_list:
            for spec in url_specs:
                # spec.regex is the compiled URL pattern
                # spec.handler_class is the RequestHandler subclass
                raw_path = spec.regex.pattern

                # Clean up regex artifacts → clean path
                path = raw_path
                path = re.sub(r"\(\?P<([^>]+)>[^)]+\)", r":\1", path)  # named groups
                path = re.sub(r"\([^)]+\)", ":param", path)  # unnamed groups
                path = re.sub(r"[\\^$?]", "", path)  # also remove ?
                path = re.sub(r"/+", "/", path)  # clean double slashes
                path = path.rstrip("/") or "/"
                if not path.startswith("/"):
                    path = "/" + path

                handler_class = spec.handler_class

                for method_name in ALL_METHODS:
                    # Skip if the handler only inherits the default 405 method
                    method_fn = getattr(handler_class, method_name, None)
                    if method_fn is None:
                        continue
                    # Check it's actually overridden (not just the base class stub)
                    if method_fn.__qualname__.startswith("RequestHandler."):
                        continue

                    method = method_name.upper()
                    key = f"{method}:{path}"
                    if key in seen:
                        continue
                    seen.add(key)

                    endpoints.append({
                        "method": method,
                        "path": path,
                        "description": generate_description(method, path, handler_class.__name__),
                        "requestBody": None,
                        "detectedBy": "static-scan",
                    })

    except Exception:
        pass

    return endpoints


# ── Pyramid ───────────────────────────────────────────────────────────────────
# Pyramid uses an introspector to find all routes and their views.

def scan_pyramid_routes(app):
    endpoints = []
    seen = set()

    ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]

    try:
        registry = getattr(app, "registry", None)
        if registry is None:
            return endpoints

        introspector = getattr(registry, "introspector", None)
        if introspector is None:
            return endpoints

        # Get all route introspectables
        for intr in introspector.get_category("routes"):
            route = intr["introspectable"]
            path = route.get("pattern", "")

            # Normalize {param} → :param
            normalized_path = re.sub(r"\{([^:}]+)(?::[^}]+)?\}", r":\1", path)
            if not normalized_path.startswith("/"):
                normalized_path = "/" + normalized_path
            normalized_path = normalized_path.rstrip("/") or "/"

            route_name = route.get("name", "")

            # Try to find request_method predicate for this route
            related = introspector.related(intr["introspectable"])
            methods_found = set()

            for rel in related:
                predicates = rel.get("predicates", "")
                for method in ALL_METHODS:
                    if method in str(predicates):
                        methods_found.add(method)

            # If no method restriction found, assume GET and POST
            if not methods_found:
                methods_found = {"GET", "POST"}

            for method in methods_found:
                key = f"{method}:{normalized_path}"
                if key in seen:
                    continue
                seen.add(key)

                endpoints.append({
                    "method": method,
                    "path": normalized_path,
                    "description": generate_description(method, normalized_path, route_name),
                    "requestBody": None,
                    "detectedBy": "static-scan",
                })

    except Exception:
        pass

    return endpoints


# ── CherryPy ──────────────────────────────────────────────────────────────────
# CherryPy uses a tree-based dispatcher. Routes are methods on classes.
# We walk the mounted apps and find exposed methods.

def scan_cherrypy_routes(app):
    endpoints = []
    seen = set()

    HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]

    try:
        import cherrypy

        def walk_cherrypy_tree(obj, prefix=""):
            # Check if this object has exposed methods (HTTP handlers)
            for method_name in [m.lower() for m in HTTP_METHODS]:
                fn = getattr(obj, method_name, None)
                if fn and getattr(fn, "exposed", False):
                    method = method_name.upper()
                    path = prefix or "/"
                    key = f"{method}:{path}"
                    if key not in seen:
                        seen.add(key)
                        endpoints.append({
                            "method": method,
                            "path": path,
                            "description": generate_description(method, path, fn.__name__),
                            "requestBody": None,
                            "detectedBy": "static-scan",
                        })

            # index() is the default handler for the path (like GET /)
            index_fn = getattr(obj, "index", None)
            if index_fn and getattr(index_fn, "exposed", False):
                path = prefix or "/"
                key = f"GET:{path}"
                if key not in seen:
                    seen.add(key)
                    endpoints.append({
                        "method": "GET",
                        "path": path,
                        "description": generate_description("GET", path, "index"),
                        "requestBody": None,
                        "detectedBy": "static-scan",
                    })

            # Walk child attributes (sub-paths)
            visited = set()

            for attr_name in dir(obj):
                if attr_name.startswith("_"):
                    continue
                child = getattr(obj, attr_name, None)
                if child is None:
                    continue
                child_id = id(child)
                if child_id in visited:
                    continue
                visited.add(child_id)
                if hasattr(child, "exposed") or any(
                    hasattr(child, m.lower()) for m in HTTP_METHODS
                ):
                    walk_cherrypy_tree(child, prefix + "/" + attr_name)

        # Walk all mounted apps in cherrypy.tree
        for script_name, app_entry in cherrypy.tree.apps.items():
            root = getattr(app_entry, "root", None)
            if root:
                walk_cherrypy_tree(root, script_name)

    except Exception:
        pass

    return endpoints


def scan_frontend_routes(cwd):
    import os

    patterns = []
    seen = set()

    # Build a list of all candidate directories to scan
    # This handles: simple projects, monorepos, nested structures
    candidate_dirs = _find_all_frontend_dirs(cwd)

    for candidate in candidate_dirs:
        dirs_to_scan = [
            os.path.join(candidate, "pages"),           # Next.js, Nuxt, Gatsby, Astro
            os.path.join(candidate, "src", "pages"),    # Next.js, Nuxt, Gatsby, Astro (src layout)
            os.path.join(candidate, "app"),             # Next.js app router
            os.path.join(candidate, "src", "app"),      # Next.js app router (src layout)
            os.path.join(candidate, "src", "routes"),   # SvelteKit, Solid Start, Qwik City, Remix
            os.path.join(candidate, "routes"),          # Remix (alternate)
            os.path.join(candidate, "app", "routes"),   # Remix (app/routes)
        ]

        for base_dir in dirs_to_scan:
            if os.path.isdir(base_dir):
                _walk_frontend_dir(base_dir, [], patterns, seen)

        # Also scan config-based frameworks (React Router, Vue Router, Angular)
        config_patterns = _scan_config_based_routes(candidate)
        for p in config_patterns:
            if p["pattern"] not in seen:
                seen.add(p["pattern"])
                patterns.append(p)

    return patterns


def _find_all_frontend_dirs(cwd):
    """
    Automatically discover all frontend app directories.
    Handles simple projects, monorepos, and any nested structure.
    Always includes cwd itself first so simple projects keep working.
    """
    import os

    # Files that indicate a frontend app
    FRONTEND_INDICATORS = {
        "next.config.js", "next.config.ts",
        "react-router.config.ts", "react-router.config.js",
        "vite.config.ts", "vite.config.js",
        "nuxt.config.ts", "nuxt.config.js",
        "svelte.config.js", "svelte.config.ts",
        "remix.config.js", "remix.config.ts",
        "angular.json",
        "astro.config.mjs", "astro.config.ts", "astro.config.js",
        "gatsby-config.js", "gatsby-config.ts",
        "app.config.ts", "app.config.js",  # Solid Start
        "qwik.config.ts",                  # Qwik City
    }

    SKIP_DIRS = {
        "node_modules", ".git", "dist", "build",
        ".next", ".nuxt", "coverage", "__pycache__",
    }

    found = []

    def is_frontend_dir(path_to_check):
        # Check 1 — indicator files (most reliable)
        for indicator in FRONTEND_INDICATORS:
            if os.path.isfile(os.path.join(path_to_check, indicator)):
                return True
        # Check 2 — fallback: check package.json for frontend frameworks
        try:
            import json
            pkg_path = os.path.join(path_to_check, "package.json")
            if os.path.isfile(pkg_path):
                with open(pkg_path, "r", encoding="utf-8") as f:
                    pkg = json.load(f)
                deps = {}
                deps.update(pkg.get("dependencies", {}))
                deps.update(pkg.get("devDependencies", {}))
                frontend_packages = [
                    "react", "vue", "angular", "@angular/core",
                    "svelte", "solid-js", "preact", "nuxt",
                    "@remix-run/react", "next", "@sveltejs/kit",
                    "astro",
                    "gatsby",
                    "@solidjs/start",
                    "@builder.io/qwik-city",
                ]
                if any(p in deps for p in frontend_packages):
                    return True
        except Exception:
            pass
        return False

    # Always check cwd itself first
    if is_frontend_dir(cwd):
        found.append(cwd)

    # Walk up max 1 level to find monorepo root
    # then scan siblings only if parent looks like a real project root
    current = cwd
    for _ in range(1):
        parent = os.path.dirname(current)
        if parent == current:
            break  # reached filesystem root
        current = parent

        # Skip sibling scanning if parent is a known OS-level or generic folder
        UNSAFE_PARENTS = {
            "Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music",
            "home", "users", "Users", "var", "www", "srv", "opt", "tmp",
            "workspace", "Workspace", "projects", "Projects", "code", "Code",
            "sites", "Sites", "dev", "Dev", "work", "Work",
        }
        if os.path.basename(current) in UNSAFE_PARENTS:
            break

        # Only scan siblings if parent has signs of being a project root
        parent_has_package_json = os.path.isfile(os.path.join(current, "package.json"))
        parent_has_project_files = (
            os.path.isfile(os.path.join(current, "docker-compose.yml")) or
            os.path.isfile(os.path.join(current, "docker-compose.yaml")) or
            os.path.isfile(os.path.join(current, ".env")) or
            os.path.isfile(os.path.join(current, "turbo.json")) or
            os.path.isfile(os.path.join(current, "pnpm-workspace.yaml"))
        )

        if not parent_has_package_json and not parent_has_project_files:
            break  # parent is probably a random folder like Desktop, skip

        try:
            for entry in os.listdir(current):
                sub = os.path.join(current, entry)

                if not os.path.isdir(sub):
                    continue
                if entry in SKIP_DIRS:
                    continue
                if sub == cwd:
                    continue  # already added above

                # Check direct subfolder
                if is_frontend_dir(sub) and sub not in found:
                    found.append(sub)

                # Also check one level deeper (e.g. apps/web/frontend)
                try:
                    for sub_entry in os.listdir(sub):
                        sub_sub = os.path.join(sub, sub_entry)
                        if not os.path.isdir(sub_sub):
                            continue
                        if sub_entry in SKIP_DIRS:
                            continue
                        if is_frontend_dir(sub_sub) and sub_sub not in found:
                            found.append(sub_sub)
                except OSError:
                    continue

        except OSError:
            continue

    # If nothing found at all, fall back to cwd
    if not found:
        found.append(cwd)

    return found



def _walk_frontend_dir(directory, segments, patterns, seen):
    import os

    SKIP_DIRS = {"api", "node_modules", ".git", ".next", "dist", "build"}
    PAGE_FILES = {"page", "index", "+page"}
    SKIP_FILES = {"layout", "loading", "error", "template", "not-found"}

    try:
        entries = sorted(os.listdir(directory))
    except OSError:
        return

    for entry in entries:
        full_path = os.path.join(directory, entry)

        if os.path.isdir(full_path):
            if entry in SKIP_DIRS:
                continue
            # Route groups like (marketing) — don't add to URL
            if entry.startswith("(") and entry.endswith(")"):
                _walk_frontend_dir(full_path, segments, patterns, seen)
                continue
            segment = _convert_segment(entry)
            if segment is None:
                continue
            _walk_frontend_dir(full_path, segments + [segment], patterns, seen)

        elif os.path.isfile(full_path):
            # Only process JS/TS/Vue/Svelte/Astro files
            if not re.search(r"\.(js|ts|jsx|tsx|vue|svelte|astro)$", entry):
                continue
            if entry.startswith("_") or (entry.startswith("+") and not entry.startswith("+page")):
                continue

            route_name = re.sub(r"\.(js|ts|jsx|tsx|vue|svelte|astro)$", "", entry)

            if route_name in SKIP_FILES:
                continue

            # Remix uses dots as separators: $projectId.dashboard.tsx
            if "." in route_name and not route_name.startswith("+"):
                remix_segments = [_convert_segment(s) or s for s in route_name.split(".")]
                final_segments = segments + remix_segments
            elif route_name in PAGE_FILES:
                final_segments = segments
            else:
                converted = _convert_segment(route_name)
                final_segments = segments + [converted or route_name]

            pattern = "/" + "/".join(s for s in final_segments if s)
            if pattern in seen:
                continue
            seen.add(pattern)

            param_map = _extract_param_positions(final_segments)
            if not param_map:
                continue  # skip static routes with no dynamic params

            patterns.append({"pattern": pattern, "params": param_map})



def _convert_segment(segment):
    # Skip catch-all [...slug] and [[...slug]]
    if re.match(r"^\[?\[?\.\.\.", segment):
        return None
    # Next.js/Nuxt [id] → :id
    match = re.match(r"^\[([^\]]+)\]$", segment)
    if match:
        return ":" + match.group(1)
    # Remix $id → :id
    match = re.match(r"^\$([a-zA-Z_][a-zA-Z0-9_]*)$", segment)
    if match:
        return ":" + match.group(1)
    return segment


def _extract_param_positions(segments):
    param_map = {}
    for i, segment in enumerate(segments):
        if segment and segment.startswith(":"):
            param_map[segment[1:]] = i
    return param_map



def _scan_config_based_routes(cwd):
    import os

    patterns = []
    seen = set()

    files_to_check = [
        os.path.join(cwd, "src", "App.jsx"),
        os.path.join(cwd, "src", "App.tsx"),
        os.path.join(cwd, "src", "App.js"),
        os.path.join(cwd, "src", "router.jsx"),
        os.path.join(cwd, "src", "router.tsx"),
        os.path.join(cwd, "src", "router.js"),
        os.path.join(cwd, "src", "router.ts"),
        os.path.join(cwd, "src", "routes.jsx"),
        os.path.join(cwd, "src", "routes.tsx"),
        os.path.join(cwd, "src", "routes.js"),
        os.path.join(cwd, "src", "router", "index.js"),
        os.path.join(cwd, "src", "router", "index.ts"),
        os.path.join(cwd, "src", "app", "app-routing.module.ts"),
        os.path.join(cwd, "src", "app", "app.routes.ts"),
    ]

    for file_path in files_to_check:
        if not os.path.isfile(file_path):
            continue
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
        except OSError:
            continue

        # React Router JSX: <Route path="/:projectId/dashboard" />
        for match in re.finditer(r'<Route[^>]+path=["\']([^"\']+)["\']', content):
            _add_config_pattern(match.group(1), seen, patterns)

        # React Router / Vue Router object: { path: '/:projectId/dashboard' }
        for match in re.finditer(r'path\s*:\s*["\']([^"\']+)["\']', content):
            _add_config_pattern(match.group(1), seen, patterns)

        # Angular: { path: ':projectId/dashboard' }
        for match in re.finditer(r'\{\s*path\s*:\s*["\']([^"\']+)["\']', content):
            _add_config_pattern(match.group(1), seen, patterns)

    return patterns


def _add_config_pattern(route_path, seen, patterns):
    if not route_path or route_path in ("*", "**"):
        return
    if ":" not in route_path and "$" not in route_path:
        return  # no dynamic params, skip

    normalized = route_path if route_path.startswith("/") else "/" + route_path
    if normalized in seen:
        return
    seen.add(normalized)

    segments = [s for s in normalized.split("/") if s]
    param_map = {}
    for i, segment in enumerate(segments):
        if segment.startswith(":"):
            param_map[segment[1:]] = i

    if not param_map:
        return

    patterns.append({"pattern": normalized, "params": param_map})