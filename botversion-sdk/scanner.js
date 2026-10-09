// botversion-sdk/scanner.js
"use strict";

/**
 * Scans an Express app object and extracts all registered routes
 */
function scanExpressRoutes(app, cwd) {
  const endpoints = [];
  const seen = new Set();

  // Build body map from ALL files upfront
  const bodyMap = cwd ? buildBodyMap(cwd) : {};

  if (app) {
    if (app.lazyrouter) app.lazyrouter();
    const router = app._router || app.router || (app.stack ? app : null);
    if (router) {
      const stack = router.stack || [];
      extractRoutes(stack, "", endpoints, seen, bodyMap);
    }
  }

  // ALSO scan all JS/TS files statically for route definitions
  if (cwd) {
    const allFiles = scanAllExpressFiles(cwd);
    for (const file of allFiles) {
      const fileEndpoints = scanExpressFileStatically(file, seen);
      endpoints.push(...fileEndpoints);
    }
  }

  return endpoints;
}

function scanExpressFileStatically(filePath, seen) {
  const fs = require("fs");
  const endpoints = [];

  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return endpoints;
  }

  // Match patterns like:
  // app.get('/path', ...)
  // router.post('/path', ...)
  // app.all('/curd.php', ...)
  const routePattern =
    /\.(get|post|put|delete|patch|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi;

  let match;
  while ((match = routePattern.exec(content)) !== null) {
    const method = match[1].toUpperCase();
    const routePath = match[2];

    // Skip middleware patterns
    if (routePath.includes("*")) continue;

    const key = method + ":" + routePath;
    if (seen.has(key)) continue;
    seen.add(key);

    const effectiveMethod = method === "ALL" ? "GET" : method;
    const needsBody = ["POST", "PUT", "PATCH"].includes(effectiveMethod);
    const bodyFields = needsBody ? extractBodyFieldsFromFile(content) : null;

    // GET inputs come from the query string; read them from this route's own code
    const queryFields =
      effectiveMethod === "GET"
        ? extractQueryFieldsFromFile(
            sliceRouteSegment(content, match.index, routePattern.source),
          )
        : null;

    const routeParamMap = buildRouteParamMap(routePath, []);

    endpoints.push({
      method: effectiveMethod,
      path: routePath,
      description: "",
      requestBody: bodyFields || queryFields,
      routeParamMap: routeParamMap,
      responseBody: extractResponseFieldsForRoute(
        content,
        match.index,
        routePattern.source,
      ),
      detectedBy: "static-scan-file",
    });
  }

  return endpoints;
}

/**
 * Recursively walks Express router stack and pulls out route layers
 *
 * Each layer in the stack is one of:
 *   - a route layer  → layer.route exists, has .path and .methods
 *   - a router layer → layer.name === 'router', has its own .handle.stack
 *   - middleware     → everything else (body-parser, cors, etc.) — skip these
 */
function extractRoutes(stack, prefix, endpoints, seen, bodyMap) {
  prefix = prefix || "";

  stack.forEach(function (layer) {
    // ── Route layer (app.get / app.post / etc.) ──────────────────────────
    if (layer.route) {
      var routePath = prefix + (layer.route.path || "");
      var methods = Object.keys(layer.route.methods).filter(function (m) {
        return layer.route.methods[m] === true;
      });

      methods.forEach(function (method) {
        method = method.toUpperCase();
        if (method === "_ALL") return;

        var key = method + ":" + routePath;
        if (seen.has(key)) return;
        seen.add(key);

        const needsBody = ["POST", "PUT", "PATCH"].includes(method);
        let requestBody = null;

        if (needsBody) {
          // Strategy 1: scan inline handler directly via fn.toString() — most accurate
          for (const handler of layer.route.stack) {
            const fn = handler.handle || handler;
            const fnStr = fn.toString();
            const fields = extractBodyFieldsFromFile(fnStr);
            if (fields) {
              requestBody = fields;
              break;
            }
          }

          // Strategy 2: fall back to bodyMap using handler name
          if (!requestBody) {
            const handlerName = extractHandlerName(layer);
            if (handlerName && bodyMap[handlerName]) {
              requestBody = bodyMap[handlerName];
            }
          }
        }

        // GET inputs come from the query string, so read them from the handler code
        if (method === "GET") {
          requestBody = extractQueryFieldsFromHandlers(layer.route.stack);
        }

        const routeParamMap = buildRouteParamMap(routePath, []);

        endpoints.push({
          method: method,
          path: routePath,
          description: "",
          requestBody: requestBody,
          responseBody: extractResponseFieldsFromHandlers(
            layer.route.stack,
            method,
          ),
          routeParamMap: routeParamMap,
          detectedBy: "static-scan",
        });
      });
      return;
    }

    // ── Nested router layer (app.use('/prefix', router)) ─────────────────
    if (layer.name === "router" && layer.handle && layer.handle.stack) {
      // Extract the mount path from the regexp
      var mountPath = prefix + regexpToPath(layer.regexp, layer.keys);
      extractRoutes(layer.handle.stack, mountPath, endpoints, seen, bodyMap);
      return;
    }

    // ── Everything else is middleware — skip ─────────────────────────────
  });
}

/**
 * Scans Next.js API routes from the pages/api directory
 */
function scanNextJsRoutes(pagesDir) {
  const fs = require("fs");
  const path = require("path");
  const endpoints = [];

  const apiDir = path.join(pagesDir, "api");

  if (!fs.existsSync(apiDir)) {
    return endpoints;
  }

  function walkDir(dir, prefix) {
    prefix = prefix || "/api";
    const files = fs.readdirSync(dir);

    files.forEach(function (file) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        walkDir(fullPath, prefix + "/" + file);
        return;
      }

      if (!/\.(js|ts)$/.test(file)) return;
      if (file.startsWith("_")) return;
      // test files and type-declaration files are never endpoints
      if (/\.(test|spec|d)\.(js|ts)$/.test(file)) return;

      const routeName = file.replace(/\.(js|ts)$/, "");
      const routePath =
        routeName === "index" ? prefix : prefix + "/" + routeName;
      const normalizedPath = routePath.replace(/\[([^\]]+)\]/g, ":$1");

      const fileContent = fs.readFileSync(fullPath, "utf8");
      // adapter files (tRPC): the real endpoints are the procedures behind them, learned from live traffic
      if (/\bcreateNextApiHandler\b|@trpc\/server\/adapters/.test(fileContent))
        return;
      const methods = detectMethodsFromFile(fullPath);

      methods.forEach(function (method) {
        // In files that handle several methods, read only this method's own code
        // (the whole file is used when the methods cannot be told apart)
        const methodCode =
          getMethodSegment(fileContent, method, methods, "pages") ||
          fileContent;
        // Body methods fall back to the whole file if their own code has no fields
        const bodyFields =
          method === "GET"
            ? null
            : extractBodyFieldsFromFile(methodCode) ||
              (method !== "DELETE"
                ? extractBodyFieldsFromFile(fileContent)
                : null);
        const queryFields = extractQueryFieldsFromFile(methodCode);

        // GET inputs come from the query string; only this method's own code is read
        const getQueryFields =
          method === "GET"
            ? removePathParamFields(
                extractQueryFieldsFromFile(
                  getMethodSegment(fileContent, "GET", methods, "pages") || "",
                ),
                normalizedPath,
              )
            : null;

        // For DELETE with no body fields, query params are the input
        const effectiveRequestBody =
          bodyFields ||
          (method === "DELETE" && queryFields ? queryFields : null) ||
          getQueryFields;

        const routeParamMap = buildRouteParamMap(normalizedPath, []);

        endpoints.push({
          method: method,
          path: normalizedPath,
          description: "",
          requestBody: effectiveRequestBody,
          responseBody: extractResponseFieldsForMethod(
            fileContent,
            method,
            methods,
            "pages",
          ),
          routeParamMap: routeParamMap,
          detectedBy: "static-scan",
        });
      });
    });
  }

  walkDir(apiDir);
  return endpoints;
}

/**
 * Reads a file and detects which HTTP methods it handles
 */
// Matches any variable that holds the request method (req.method, method, httpMethod, ...)
const METHOD_REF =
  "[\\w$.?]*[mM]ethod[\\w$]*(?:\\s*\\.\\s*toUpperCase\\s*\\(\\s*\\))?";
const HTTP_METHOD_NAMES = ["GET", "POST", "PUT", "DELETE", "PATCH"];

// Reads which HTTP methods a pages-style route file handles, whatever the variable is called
function detectMethodsFromFile(filePath) {
  try {
    const fs = require("fs");
    const content = fs.readFileSync(filePath, "utf8");
    const detected = new Set();

    HTTP_METHOD_NAMES.forEach(function (m) {
      const patterns = [
        // method === "X"  /  method !== "X"
        new RegExp(
          METHOD_REF + "\\s*(?:===?|!==?)\\s*['\"`]" + m + "['\"`]",
          "i",
        ),
        // "X" === method
        new RegExp(
          "['\"`]" + m + "['\"`]\\s*(?:===?|!==?)\\s*" + METHOD_REF,
          "i",
        ),
        // switch (...) { case "X": }
        new RegExp("case\\s*['\"`]" + m + "['\"`]", "i"),
      ];
      if (
        patterns.some(function (p) {
          return p.test(content);
        })
      ) {
        detected.add(m);
      }
    });

    // ["GET", "POST"].includes(method)
    const includesRe = new RegExp(
      "\\[([^\\]]*)\\]\\s*\\.includes\\s*\\(\\s*" + METHOD_REF,
      "gi",
    );
    for (const found of content.matchAll(includesRe)) {
      HTTP_METHOD_NAMES.forEach(function (m) {
        if (new RegExp("['\"`]" + m + "['\"`]", "i").test(found[1])) {
          detected.add(m);
        }
      });
    }

    // no recognizable method check means the file is treated as GET-only
    if (detected.size === 0) {
      return ["GET"];
    }
    return Array.from(detected);
  } catch (e) {
    return ["GET", "POST"];
  }
}

/**
 * Extract :param names from a path like /users/:id/posts/:postId
 */
function extractPathParams(routePath) {
  const params = [];
  const matches = routePath.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g);
  if (matches) {
    matches.forEach(function (m) {
      params.push(m.replace(":", ""));
    });
  }
  return params;
}

/**
 * Build a simple schema object from param names
 */
function buildParamSchema(params) {
  const schema = {};
  params.forEach(function (p) {
    schema[p] = "string";
  });
  return schema;
}

function inferFieldType(fieldName, content) {
  const arrayPatterns = [
    new RegExp(
      `${fieldName}\\s*\\.\\s*(map|filter|forEach|push|reduce|find|some|every|includes|join|slice|splice|length)\\b`,
    ),
    new RegExp(`Array\\.isArray\\s*\\(\\s*${fieldName}\\s*\\)`),
    new RegExp(`for\\s*\\(.*of\\s+${fieldName}\\b`),
    new RegExp(`\\[\\s*\\.\\.\\.${fieldName}\\s*\\]`),
  ];
  if (arrayPatterns.some((p) => p.test(content))) return "array";

  const numberPatterns = [
    new RegExp(`${fieldName}\\s*[+\\-*/%]\\s*\\d`),
    new RegExp(`parseInt\\s*\\(\\s*${fieldName}`),
    new RegExp(`parseFloat\\s*\\(\\s*${fieldName}`),
    new RegExp(`Number\\s*\\(\\s*${fieldName}`),
  ];
  if (numberPatterns.some((p) => p.test(content))) return "number";

  const boolPatterns = [
    new RegExp(`${fieldName}\\s*===?\\s*(true|false)`),
    new RegExp(`(true|false)\\s*===?\\s*${fieldName}`),
    new RegExp(`Boolean\\s*\\(\\s*${fieldName}`),
    new RegExp(`typeof\\s+${fieldName}\\s*!==?\\s*["']boolean["']`),
    new RegExp(`typeof\\s+${fieldName}\\s*===?\\s*["']boolean["']`),
  ];
  if (boolPatterns.some((p) => p.test(content))) return "boolean";

  return "string";
}

function extractBodyFieldsFromFile(content) {
  const fields = new Set();

  // Pattern 1
  const destructureMatches = content.matchAll(
    /const\s*\{([^}]+)\}\s*=\s*req\.body/g,
  );
  for (const destructureMatch of destructureMatches) {
    destructureMatch[1].split(",").forEach(function (f) {
      const clean = f.trim().split(":")[0].trim();
      if (clean) fields.add(clean);
    });
  }

  // Pattern 2
  const dotMatches = content.matchAll(/req\.body\.([a-zA-Z_][a-zA-Z0-9_]*)/g);
  for (const match of dotMatches) {
    fields.add(match[1]);
  }

  // Pattern 3
  const bodyDotMatches = content.matchAll(/body\.([a-zA-Z_][a-zA-Z0-9_]*)/g);
  for (const match of bodyDotMatches) {
    fields.add(match[1]);
  }

  // Pattern 4 — only if variable name is clearly body-related
  const bodyVarMatch = content.match(/const\s+(\w+)\s*=\s*req\.body/);
  if (bodyVarMatch) {
    const varName = bodyVarMatch[1];
    const isSafeVarName =
      /^(body|payload|input|data|requestBody|reqBody|bodyData)$/.test(varName);
    if (isSafeVarName) {
      const varMatches = content.matchAll(
        new RegExp(`${varName}\\.([a-zA-Z_][a-zA-Z0-9_]*)`, "g"),
      );
      for (const match of varMatches) {
        fields.add(match[1]);
      }
    }
  }

  // Pattern 5 — optional chaining req.body?.name
  const optionalMatches = content.matchAll(
    /req\.body\?\.([a-zA-Z_][a-zA-Z0-9_]*)/g,
  );
  for (const match of optionalMatches) {
    fields.add(match[1]);
  }

  if (fields.size === 0) return null;

  const properties = {};
  fields.forEach(function (field) {
    const type = inferFieldType(field, content);
    properties[field] =
      type === "array"
        ? { type: "array", items: { type: "object" } }
        : { type };
  });

  return { type: "object", properties };
}

function scanNextJsAppRoutes(appDir) {
  const fs = require("fs");
  const path = require("path");
  const endpoints = [];

  const apiDir = path.join(appDir, "api");
  if (!fs.existsSync(apiDir)) {
    return endpoints;
  }

  function walkDir(dir, routePath) {
    routePath = routePath || "/api";
    const files = fs.readdirSync(dir);

    files.forEach(function (file) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        // Convert [param] → :param
        const segment = file.replace(/\[([^\]]+)\]/g, ":$1");
        walkDir(fullPath, routePath + "/" + segment);
        return;
      }

      // Only process route.ts / route.js
      if (!/^route\.(js|ts)$/.test(file)) return;

      const content = fs.readFileSync(fullPath, "utf8");
      const methods = detectAppRouterMethods(content);

      methods.forEach(function (method) {
        // In files that handle several methods, read only this method's own code
        // (the whole file is used when the methods cannot be told apart)
        const methodCode =
          getMethodSegment(content, method, methods, "app") || content;
        // Body methods fall back to the whole file if their own code has no fields
        const bodyFields =
          method === "GET"
            ? null
            : extractAppRouterBodyFields(methodCode) ||
              (method !== "DELETE"
                ? extractAppRouterBodyFields(content)
                : null);
        const queryFields = extractQueryFieldsFromFile(methodCode);

        const routeParamMap = buildRouteParamMap(routePath, []);

        endpoints.push({
          method: method,
          path: routePath,
          description: "",
          requestBody:
            bodyFields ||
            (method === "DELETE" && queryFields ? queryFields : null) ||
            (method === "GET"
              ? removePathParamFields(
                  extractQueryFieldsFromFile(
                    getMethodSegment(content, "GET", methods, "app") || "",
                  ),
                  routePath,
                )
              : null),
          responseBody: extractResponseFieldsForMethod(
            content,
            method,
            methods,
            "app",
          ),
          routeParamMap: routeParamMap,
          detectedBy: "static-scan",
        });
      });
    });
  }

  walkDir(apiDir);
  return endpoints;
}

// Reads every common way a route file exports its HTTP handlers (function, const, re-export, destructured)
function detectAppRouterMethods(content) {
  const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];
  const methods = HTTP_METHODS.filter(function (m) {
    return [
      new RegExp("export\\s+(?:async\\s+)?function\\s+" + m + "\\b"),
      new RegExp("export\\s+(?:const|let|var)\\s+" + m + "\\b"),
      new RegExp("export\\s*\\{[^}]*\\b" + m + "\\b[^}]*\\}"),
      new RegExp(
        "export\\s+(?:const|let|var)\\s*\\{[^}]*\\b" + m + "\\b[^}]*\\}",
      ),
    ].some(function (re) {
      return re.test(content);
    });
  });
  return methods.length > 0 ? methods : ["GET"];
}

function extractAppRouterBodyFields(content) {
  const fields = new Set();

  // Pattern 1: const { userId, tokens } = await request.json()
  const destructureMatches = content.matchAll(
    /const\s*\{([^}]+)\}\s*=\s*await\s+\w+\.json\(\)/g,
  );
  for (const match of destructureMatches) {
    match[1].split(",").forEach(function (f) {
      const clean = f.trim().split(":")[0].trim();
      if (clean) fields.add(clean);
    });
  }

  // Pattern 2: const body = await request.json() then body.userId
  const bodyVarMatch = content.match(
    /const\s+(\w+)\s*=\s*await\s+\w+\.json\(\)/,
  );
  if (bodyVarMatch) {
    const varName = bodyVarMatch[1];
    const varMatches = content.matchAll(
      new RegExp(`${varName}\\.([a-zA-Z_][a-zA-Z0-9_]*)`, "g"),
    );
    for (const match of varMatches) {
      fields.add(match[1]);
    }
  }

  // Pattern 3: (await request.json()).userId
  const inlineMatches = content.matchAll(
    /\(await\s+\w+\.json\(\)\)\.([a-zA-Z_][a-zA-Z0-9_]*)/g,
  );
  for (const match of inlineMatches) {
    fields.add(match[1]);
  }

  if (fields.size === 0) return null;

  const properties = {};
  fields.forEach(function (field) {
    const type = inferFieldType(field, content);
    properties[field] =
      type === "array"
        ? { type: "array", items: { type: "object" } }
        : { type };
  });

  return { type: "object", properties };
}

function buildRouteParamMap(routePath, segments) {
  const paramMap = {};
  const parts = routePath.split("/").filter(Boolean);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    // Skip catch-all [...slug] and optional [[...slug]]
    if (/^\[?\[\.\.\./.test(part)) continue;

    // Check if this segment is a dynamic param
    // Handles both Next.js style [id] and Express style :id
    const nextParamMatch = part.match(/^\[([^\]]+)\]$/);
    const expressParamMatch = part.match(/^:([a-zA-Z_][a-zA-Z0-9_]*)$/);
    const paramMatch = nextParamMatch || expressParamMatch;
    if (!paramMatch) continue;

    const paramName = paramMatch[1];

    // If param already has a descriptive name like [projectId], use it as-is
    if (paramName !== "id" && paramName !== "slug" && paramName !== "param") {
      paramMap[paramName] = paramName;
      continue;
    }

    // If param is just [id], look at the parent folder name to figure out type
    // e.g. projects/[id] → projectId
    const parentSegment = parts[i - 1];
    if (parentSegment) {
      // Remove any dynamic brackets from parent if it's also a param
      const cleanParent = parentSegment.replace(/^\[([^\]]+)\]$/, "$1");
      // Singularize simple plural names: projects → project, users → user
      const singular = cleanParent.replace(/ies$/, "y").replace(/s$/, "");
      paramMap[paramName] = singular + "Id";
    } else {
      // No parent segment, just call it "id"
      paramMap[paramName] = "id";
    }
  }

  return paramMap;
}

function extractQueryFieldsFromFile(content) {
  const fields = new Set();
  const NAME = /^[A-Za-z_$][\w$.-]*$/;
  const addField = function (raw) {
    const name = String(raw).trim().split(":")[0].split("=")[0].trim();
    if (name && NAME.test(name)) fields.add(name);
  };

  // const { id, page = 1 } = req.query
  const destructureRe =
    /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(?:await\s+)?(?:req|request|ctx(?:\.request)?)\.query\b/g;
  for (const m of String(content).matchAll(destructureRe)) {
    m[1].split(",").forEach(addField);
  }

  // req.query.id / req.query?.id
  const dotRe =
    /(?:req|request|ctx(?:\.request)?)\.query(?:\?\.|\.)([A-Za-z_$][\w$]*)/g;
  for (const m of String(content).matchAll(dotRe)) addField(m[1]);

  // req.query["id"]
  const bracketRe =
    /(?:req|request|ctx(?:\.request)?)\.query\s*\??\.?\[\s*['"`]([^'"`]+)['"`]\s*\]/g;
  for (const m of String(content).matchAll(bracketRe)) addField(m[1]);

  // url.searchParams.get("id") / nextUrl.searchParams.get("id")
  const searchParamsRe =
    /searchParams\s*\??\.\s*(?:get|getAll|has)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  for (const m of String(content).matchAll(searchParamsRe)) addField(m[1]);

  if (fields.size === 0) return null;

  const properties = {};
  fields.forEach(function (field) {
    properties[field] = { type: "string" };
  });

  return { type: "object", properties };
}

// Drops fields that are really path params (Next.js Pages puts [id] into req.query too)
function removePathParamFields(schema, routePath) {
  if (!schema || !schema.properties) return null;
  const pathParams = new Set(extractPathParams(routePath));
  const properties = {};
  Object.keys(schema.properties).forEach(function (k) {
    if (!pathParams.has(k)) properties[k] = schema.properties[k];
  });
  return Object.keys(properties).length > 0
    ? { type: "object", properties }
    : null;
}

// Returns only the code belonging to one HTTP method in a multi-method file.
// Returns null when it cannot be told apart, so no guess is made.
function getMethodSegment(content, method, allMethods, style) {
  if (!allMethods || allMethods.length < 2) return content;
  const markers = [];
  allMethods.forEach(function (m) {
    const index = findStaticMethodMarkerIndex(content, style, m);
    if (index !== -1) markers.push({ method: m, index: index });
  });
  const own = markers.find(function (x) {
    return x.method === method;
  });
  if (!own) return null;
  if (style === "app") {
    const handlerCode = findStaticHandlerCode(content, own.index);
    if (handlerCode) return handlerCode;
  }
  markers.sort(function (a, b) {
    return a.index - b.index;
  });
  const pos = markers.indexOf(own);
  const end =
    pos + 1 < markers.length ? markers[pos + 1].index : content.length;
  return content.slice(own.index, end);
}

// The code from one route definition (app.get(...), router.get(...)) up to the next one
function sliceRouteSegment(content, startIndex, routePatternSource) {
  try {
    const re = new RegExp(routePatternSource, "gi");
    let end = content.length;
    let hit;
    while ((hit = re.exec(content)) !== null) {
      if (hit.index > startIndex) {
        end = hit.index;
        break;
      }
    }
    return content.slice(startIndex, end);
  } catch (e) {
    return "";
  }
}

// For live Express routes: reads query fields from every handler's source code
function extractQueryFieldsFromHandlers(stack) {
  try {
    const merged = {};
    for (const layer of stack) {
      const fn = layer.handle || layer;
      if (typeof fn !== "function") continue;
      const fields = extractQueryFieldsFromFile(
        Function.prototype.toString.call(fn),
      );
      if (fields) Object.assign(merged, fields.properties);
    }
    return Object.keys(merged).length > 0
      ? { type: "object", properties: merged }
      : null;
  } catch (e) {
    return null;
  }
}

/**
 * Convert Express regexp back to a mount path string
 * Used for nested routers (app.use('/api', router))
 */
function regexpToPath(regexp, keys) {
  if (!regexp) return "";

  // Express 4.x stores the original path string directly
  if (regexp.source === "^\\/?(?=\\/|$)") return "";

  try {
    var src = regexp.source;

    // Remove anchors and cleanup
    src = src
      .replace(/^\^/, "")
      .replace(/\\\//g, "/")
      .replace(/\/\?\(\?=\/\|\$\)$/, "")
      .replace(/\/\?\$?$/, "")
      .replace(/\(\?:\(\[\^\/\]\+\?\)\)/g, function (_, i) {
        return keys && keys[i] ? ":" + keys[i].name : ":param";
      });

    // Clean up any remaining regex artifacts
    src = src.replace(/\(\?:/g, "").replace(/\)/g, "");

    if (!src || src === "/") return "";
    if (!src.startsWith("/")) src = "/" + src;

    return src;
  } catch (e) {
    return "";
  }
}

function scanAllExpressFiles(cwd) {
  const fs = require("fs");
  const path = require("path");

  const SKIP_DIRS = [
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    ".cache",
    "coverage",
    "out",
  ];

  const routeFiles = [];

  function walk(dir, depth) {
    if (depth > 4) return;

    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.includes(entry)) continue;

      const fullPath = path.join(dir, entry);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (/\.(js|ts)$/.test(entry)) {
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          // Check if file contains Express route definitions
          const isExpressFile =
            content.includes("express()") ||
            content.includes("express.Router()") ||
            content.includes("Router()") ||
            // Match only route-like patterns: app.get('/...) or router.post('/...)
            /(?:app|router|server)\.(get|post|put|delete|patch|all)\s*\(\s*['"`]\//.test(
              content,
            );

          if (isExpressFile) {
            routeFiles.push(fullPath);
          }
        } catch {
          continue;
        }
      }
    }
  }

  walk(cwd, 0);
  return routeFiles;
}

function buildBodyMap(cwd) {
  const fs = require("fs");
  const path = require("path");
  const bodyMap = {}; // { functionName: { type: "object", properties: {...} } }

  const SKIP_DIRS = [
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    ".cache",
    "coverage",
    "out",
  ];

  function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.includes(entry)) continue;
      const fullPath = path.join(dir, entry);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }

      if (!/\.(js|ts)$/.test(entry)) continue;

      let content;
      try {
        content = fs.readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }

      // Skip files with no req.body at all
      // Split file into individual function chunks more reliably
      // by finding each function and extracting a reasonable chunk after it

      const fnPatterns = [
        // function loginUser(req, res) {
        /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)\s*\{/g,
        // const loginUser = async (req, res) => {
        /const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g,
        // exports.loginUser = async (req, res) => {
        /exports\.([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g,
        // export const loginUser = async (req, res) => {
        /export\s+const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g,
      ];

      // Map every function name in this file to the whole file's body fields.
      // Brace-counting is unreliable across JS/TS variations, so we use
      // file-level field extraction here. Per-function accuracy is handled
      // at runtime by Strategy 2 (fn.toString()) in extractRoutes.
      const fileFields = extractBodyFieldsFromFile(content);
      if (fileFields) {
        const fnNames = new Set();
        for (const pattern of fnPatterns) {
          pattern.lastIndex = 0; // reset regex state before each use
          let m;
          while ((m = pattern.exec(content)) !== null) fnNames.add(m[1]);
        }
        for (const name of fnNames) {
          if (!bodyMap[name]) {
            // don't overwrite a more precise entry
            bodyMap[name] = fileFields;
          }
        }
      }
    }
  }

  walk(cwd, 0);
  return bodyMap;
}

function extractHandlerName(layer) {
  const handlers = layer.route.stack.map((h) => h.handle || h);

  const SKIP_NAMES = new Set([
    "anonymous",
    "",
    "bound dispatch",
    "middleware",
    "protect",
    "admin",
    "auth",
    "verify",
    "validate",
    "isAuth",
    "isAdmin",
    "checkAuth",
    "authenticate",
  ]);

  // Try from last to first, skip known middleware names
  for (let i = handlers.length - 1; i >= 0; i--) {
    const fn = handlers[i];
    const name = fn.name || "";
    if (name && !SKIP_NAMES.has(name) && !name.startsWith("bound ")) {
      return name;
    }
  }
  return null;
}

function convertNextJsSegment(segment) {
  // Skip catch-all [...slug] and optional [[...slug]]
  if (/^\[?\[\.\.\./.test(segment)) return null;
  // Convert [projectId] → :projectId (Next.js / Nuxt / SvelteKit)
  if (/^\[([^\]]+)\]$/.test(segment))
    return segment.replace(/^\[([^\]]+)\]$/, ":$1");
  // Convert $projectId → :projectId (Remix)
  if (/^\$([a-zA-Z_][a-zA-Z0-9_]*)$/.test(segment))
    return segment.replace(/^\$/, ":");
  return segment;
}

function extractParamPositions(segments) {
  const paramMap = {};
  segments.forEach(function (segment, index) {
    if (segment && segment.startsWith(":")) {
      const paramName = segment.slice(1);
      paramMap[paramName] = index;
    }
  });
  return paramMap;
}

function scanConfigBasedRoutes(cwd) {
  const fs = require("fs");
  const path = require("path");
  const patterns = [];
  const seen = new Set();

  const filesToCheck = [
    // React Router
    path.join(cwd, "src", "App.jsx"),
    path.join(cwd, "src", "App.tsx"),
    path.join(cwd, "src", "App.js"),
    path.join(cwd, "src", "router.jsx"),
    path.join(cwd, "src", "router.tsx"),
    path.join(cwd, "src", "router.js"),
    path.join(cwd, "src", "routes.jsx"),
    path.join(cwd, "src", "routes.tsx"),
    path.join(cwd, "src", "routes.js"),
    path.join(cwd, "src", "Router.jsx"),
    path.join(cwd, "src", "Router.tsx"),
    // Vue Router
    path.join(cwd, "src", "router", "index.js"),
    path.join(cwd, "src", "router", "index.ts"),
    path.join(cwd, "src", "router.js"),
    path.join(cwd, "src", "router.ts"),
    // Angular
    path.join(cwd, "src", "app", "app-routing.module.ts"),
    path.join(cwd, "src", "app", "app.routes.ts"),
    // TanStack Router
    path.join(cwd, "src", "routes.tsx"),
    path.join(cwd, "src", "routeTree.gen.ts"),
    path.join(cwd, "src", "router.tsx"),
  ];

  // Also scan any file named *routes* or *router* anywhere in src/
  const srcDir = path.join(cwd, "src");
  if (fs.existsSync(srcDir)) {
    function findRouteFiles(dir, depth) {
      if (depth > 3) return;
      let entries;
      try {
        entries = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (["node_modules", ".git", "dist", "build"].includes(entry)) continue;
        const fullPath = path.join(dir, entry);
        let stat;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          findRouteFiles(fullPath, depth + 1);
        } else if (
          /\.(js|ts|jsx|tsx)$/.test(entry) &&
          /route|router/i.test(entry) &&
          !filesToCheck.includes(fullPath)
        ) {
          filesToCheck.push(fullPath);
        }
      }
    }
    findRouteFiles(srcDir, 0);
  }

  for (const filePath of filesToCheck) {
    if (!fs.existsSync(filePath)) continue;

    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    // Pattern 1 — React Router JSX: <Route path="/:projectId/dashboard" />
    const jsxRouteMatches = content.matchAll(
      /<Route[^>]+path=["']([^"']+)["']/g,
    );
    for (const match of jsxRouteMatches) {
      addConfigPattern(match[1], seen, patterns);
    }

    // Pattern 2 — React Router / Vue Router object: { path: '/:projectId/dashboard' }
    const objectRouteMatches = content.matchAll(/path\s*:\s*["']([^"']+)["']/g);
    for (const match of objectRouteMatches) {
      addConfigPattern(match[1], seen, patterns);
    }

    // Pattern 3 — Angular: { path: ':projectId/dashboard' }
    const angularRouteMatches = content.matchAll(
      /\{\s*path\s*:\s*["']([^"']+)["']/g,
    );
    for (const match of angularRouteMatches) {
      addConfigPattern(match[1], seen, patterns);
    }

    // Pattern 4 — TanStack Router: createRoute({ path: '/dashboard/:id' })
    const tanstackMatches = content.matchAll(
      /createRoute\s*\(\s*\{[^}]*path\s*:\s*["']([^"']+)["']/g,
    );
    for (const match of tanstackMatches) {
      addConfigPattern(match[1], seen, patterns);
    }

    // Pattern 5 — TanStack Router file-based: createFileRoute('/dashboard/$id')
    const tanstackFileMatches = content.matchAll(
      /createFileRoute\s*\(\s*["']([^"']+)["']/g,
    );
    for (const match of tanstackFileMatches) {
      // Convert TanStack $param to :param
      const normalized = match[1].replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, ":$1");
      addConfigPattern(normalized, seen, patterns);
    }

    // Pattern 6 — Vue Router with children
    const vueChildrenMatches = content.matchAll(
      /children\s*:\s*\[[^\]]*path\s*:\s*["']([^"']+)["']/g,
    );
    for (const match of vueChildrenMatches) {
      addConfigPattern(match[1], seen, patterns);
    }
  }

  return patterns;
}

function addConfigPattern(routePath, seen, patterns) {
  // Skip empty, wildcard and catch-all routes
  if (!routePath || routePath === "*" || routePath === "**") return;
  // Skip routes with no dynamic params
  if (!routePath.includes(":") && !routePath.includes("$")) return;

  // Normalize — ensure leading slash
  const normalized = routePath.startsWith("/") ? routePath : "/" + routePath;

  if (seen.has(normalized)) return;
  seen.add(normalized);

  // Extract params and their positions
  const segments = normalized.split("/").filter(Boolean);
  const paramMap = {};
  segments.forEach(function (segment, index) {
    if (segment.startsWith(":")) {
      paramMap[segment.slice(1)] = index;
    }
  });

  if (Object.keys(paramMap).length === 0) return;

  patterns.push({ pattern: normalized, params: paramMap });
}

function findAllFrontendDirs(cwd) {
  const fs = require("fs");
  const path = require("path");

  const FRONTEND_INDICATORS = [
    "next.config.js",
    "next.config.ts",
    "react-router.config.ts",
    "react-router.config.js",
    "vite.config.ts",
    "vite.config.js",
    "nuxt.config.ts",
    "nuxt.config.js",
    "svelte.config.js",
    "svelte.config.ts",
    "remix.config.js",
    "remix.config.ts",
    "angular.json",
    "astro.config.mjs",
    "astro.config.ts",
    "astro.config.js",
    "app.config.ts",
    "qwik.config.ts",
  ];

  const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "coverage",
  ]);

  const found = [];

  function isFrontendDir(dir) {
    // Check 1 — indicator files (most reliable)
    const hasIndicator = FRONTEND_INDICATORS.some(function (indicator) {
      try {
        return fs.existsSync(path.join(dir, indicator));
      } catch {
        return false;
      }
    });
    if (hasIndicator) return true;

    // Check 2 — fallback: check package.json for frontend frameworks
    try {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        const deps = Object.assign(
          {},
          pkg.dependencies || {},
          pkg.devDependencies || {},
        );
        const frontendPackages = [
          "react",
          "vue",
          "angular",
          "@angular/core",
          "svelte",
          "solid-js",
          "preact",
          "nuxt",
          "@remix-run/react",
          "next",
          "@sveltejs/kit",
          "astro",
          "gatsby",
          "@solidjs/start",
          "@builder.io/qwik",
          "@builder.io/qwik-city",
        ];
        if (
          frontendPackages.some(function (p) {
            return deps[p];
          })
        ) {
          return true;
        }
      }
    } catch {
      // silent fail
    }

    return false;
  }

  // Always check cwd itself first
  if (isFrontendDir(cwd)) {
    found.push(cwd);
  }

  // ── Step 1: Scan subfolders inside cwd ──────────────────────────────
  let cwdEntries;
  try {
    cwdEntries = fs.readdirSync(cwd);
  } catch {
    cwdEntries = [];
  }

  for (const entry of cwdEntries) {
    if (SKIP_DIRS.has(entry)) continue;

    const sub = path.join(cwd, entry);
    let stat;
    try {
      stat = fs.statSync(sub);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // Level 1 — direct subfolders of cwd
    if (isFrontendDir(sub) && !found.includes(sub)) {
      found.push(sub);
    }

    // Level 2 — one level deeper (e.g. packages/apps/frontend)
    let subEntries;
    try {
      subEntries = fs.readdirSync(sub);
    } catch {
      continue;
    }

    for (const subEntry of subEntries) {
      if (SKIP_DIRS.has(subEntry)) continue;
      const subSub = path.join(sub, subEntry);
      let subStat;
      try {
        subStat = fs.statSync(subSub);
      } catch {
        continue;
      }
      if (!subStat.isDirectory()) continue;
      if (isFrontendDir(subSub) && !found.includes(subSub)) {
        found.push(subSub);
      }
    }
  }

  // Note: we intentionally do NOT walk up to sibling folders (e.g. a
  // separate frontend/ folder next to backend/) anymore. That only worked
  // in local dev monorepos where both folders live on the same disk. In
  // production, frontend and backend are frequently on completely separate
  // servers, so there is nothing to find outside cwd. If this install has
  // no frontend, classification (in index.js) reports that to the
  // dashboard instead of guessing at a folder that may not exist here.

  // If nothing found, fall back to cwd
  if (found.length === 0) {
    found.push(cwd);
  }

  return found;
}

function scanFrontendRoutes(cwd) {
  const fs = require("fs");
  const path = require("path");
  const patterns = [];
  const seen = new Set();

  const candidateDirs = findAllFrontendDirs(cwd);

  function walkDir(dir, routeSegments) {
    if (!fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    entries.forEach(function (file) {
      const fullPath = path.join(dir, file);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        return;
      }

      if (stat.isDirectory()) {
        if (file === "api") return;
        if (file.startsWith("_")) return;
        if (/^\(.*\)$/.test(file)) {
          walkDir(fullPath, routeSegments);
          return;
        }
        const segment = convertNextJsSegment(file);
        if (!segment) return;
        walkDir(fullPath, routeSegments.concat(segment));
        return;
      }

      if (!/\.(js|ts|jsx|tsx|vue|svelte|astro)$/.test(file)) return;
      if (file.startsWith("_")) return;

      const routeName = file.replace(/\.(js|ts|jsx|tsx|vue|svelte|astro)$/, "");

      if (
        ["layout", "loading", "error", "template", "not-found"].includes(
          routeName,
        )
      )
        return;

      if (routeName.startsWith("+") && routeName !== "+page") return;

      const isRemixRoute =
        routeName.includes(".") && !routeName.startsWith("+");
      let finalSegments;

      if (isRemixRoute) {
        const remixSegments = routeName
          .split(".")
          .map((s) => convertNextJsSegment(s) || s);
        finalSegments = routeSegments.concat(remixSegments);
      } else if (
        routeName === "index" ||
        routeName === "page" ||
        routeName === "+page"
      ) {
        finalSegments = routeSegments;
      } else {
        finalSegments = routeSegments.concat(
          convertNextJsSegment(routeName) || routeName,
        );
      }

      const pattern = "/" + finalSegments.filter(Boolean).join("/");
      if (seen.has(pattern)) return;
      seen.add(pattern);

      const paramMap = extractParamPositions(finalSegments);
      if (Object.keys(paramMap).length === 0) return;

      patterns.push({ pattern, params: paramMap });
    });
  }

  for (const candidate of candidateDirs) {
    const dirsToScan = [
      // Next.js
      path.join(candidate, "pages"),
      path.join(candidate, "src", "pages"),
      path.join(candidate, "app"),
      path.join(candidate, "src", "app"),
      // React Router / Remix
      path.join(candidate, "src", "routes"),
      path.join(candidate, "routes"),
      path.join(candidate, "app", "routes"),
      // SvelteKit
      path.join(candidate, "src", "routes"),
      // Nuxt
      path.join(candidate, "pages"),
      path.join(candidate, "src", "pages"),
      // Astro
      path.join(candidate, "src", "pages"),
    ];

    dirsToScan.forEach(function (dir) {
      if (fs.existsSync(dir)) {
        walkDir(dir, []);
      }
    });

    const configPatterns = scanConfigBasedRoutes(candidate);
    configPatterns.forEach(function (p) {
      if (!seen.has(p.pattern)) {
        seen.add(p.pattern);
        patterns.push(p);
      }
    });
  }

  return patterns;
}

/**
 * Scans Fastify routes from the codebase statically
 * Handles:
 * - fastify.get('/path', handler)
 * - fastify.post('/path', handler)
 * - fastify.route({ method: 'GET', url: '/path' })
 * - fastify.register(plugin, { prefix: '/api' })
 */
function scanFastifyRoutes(cwd) {
  const fs = require("fs");
  const path = require("path");
  const endpoints = [];
  const seen = new Set();

  const SKIP_DIRS = [
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    ".cache",
    "coverage",
    "out",
  ];

  // Build body map from all files upfront
  const bodyMap = cwd ? buildBodyMap(cwd) : {};

  function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.includes(entry)) continue;
      const fullPath = path.join(dir, entry);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }

      if (!/\.(js|ts)$/.test(entry)) continue;

      let content;
      try {
        content = fs.readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }

      // Only process files that look like Fastify route files
      const isFastifyFile =
        content.includes("fastify") ||
        content.includes("Fastify") ||
        /\.(get|post|put|delete|patch|route)\s*\(/.test(content);

      if (!isFastifyFile) continue;

      // Pattern 1 — fastify.get('/path', handler)
      // Pattern 2 — fastify.post('/path', handler)
      const shorthandPattern =
        /(?:fastify|app|server|router)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi;

      let match;
      while ((match = shorthandPattern.exec(content)) !== null) {
        const method = match[1].toUpperCase();
        const routePath = match[2];
        if (routePath.includes("*")) continue;

        const key = method + ":" + routePath;
        if (seen.has(key)) continue;
        seen.add(key);

        const needsBody = ["POST", "PUT", "PATCH"].includes(method);
        const bodyFields = needsBody
          ? extractBodyFieldsFromFile(content)
          : null;
        const routeParamMap = buildRouteParamMap(routePath, []);

        endpoints.push({
          method,
          path: routePath,
          description: "",
          requestBody: bodyFields,
          routeParamMap,
          detectedBy: "static-scan-fastify",
        });
      }

      // Pattern 3 — fastify.route({ method: 'GET', url: '/path' })
      const routeObjectPattern =
        /\.route\s*\(\s*\{[^}]*method\s*:\s*['"`]([^'"`]+)['"`][^}]*url\s*:\s*['"`]([^'"`]+)['"`]/gi;

      while ((match = routeObjectPattern.exec(content)) !== null) {
        const method = match[1].toUpperCase();
        const routePath = match[2];
        if (routePath.includes("*")) continue;

        const key = method + ":" + routePath;
        if (seen.has(key)) continue;
        seen.add(key);

        const needsBody = ["POST", "PUT", "PATCH"].includes(method);
        const bodyFields = needsBody
          ? extractBodyFieldsFromFile(content)
          : null;
        const routeParamMap = buildRouteParamMap(routePath, []);

        endpoints.push({
          method,
          path: routePath,
          description: "",
          requestBody: bodyFields,
          routeParamMap,
          detectedBy: "static-scan-fastify",
        });
      }

      // Pattern 4 — fastify.route({ method: ['GET', 'POST'], url: '/path' })
      // handles array of methods
      const routeArrayPattern =
        /\.route\s*\(\s*\{[^}]*method\s*:\s*\[([^\]]+)\][^}]*url\s*:\s*['"`]([^'"`]+)['"`]/gi;

      while ((match = routeArrayPattern.exec(content)) !== null) {
        const methodsRaw = match[1];
        const routePath = match[2];
        if (routePath.includes("*")) continue;

        const methods = methodsRaw
          .split(",")
          .map((m) => m.trim().replace(/['"`]/g, "").toUpperCase())
          .filter(Boolean);

        for (const method of methods) {
          const key = method + ":" + routePath;
          if (seen.has(key)) continue;
          seen.add(key);

          const needsBody = ["POST", "PUT", "PATCH"].includes(method);
          const bodyFields = needsBody
            ? extractBodyFieldsFromFile(content)
            : null;
          const routeParamMap = buildRouteParamMap(routePath, []);

          endpoints.push({
            method,
            path: routePath,
            description: "",
            requestBody: bodyFields,
            routeParamMap,
            detectedBy: "static-scan-fastify",
          });
        }
      }
    }
  }

  walk(cwd, 0);
  return endpoints;
}

/**
 * Scans NestJS routes from the codebase statically
 * Handles:
 * - @Controller('/users')
 * - @Get('/path')
 * - @Post('/path')
 * - @Put('/path')
 * - @Delete('/path')
 * - @Patch('/path')
 */
function scanNestJsRoutes(cwd) {
  const fs = require("fs");
  const path = require("path");
  const endpoints = [];
  const seen = new Set();

  const SKIP_DIRS = [
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    ".cache",
    "coverage",
    "out",
  ];

  function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.includes(entry)) continue;
      const fullPath = path.join(dir, entry);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }

      if (!/\.(ts|js)$/.test(entry)) continue;

      let content;
      try {
        content = fs.readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }

      // Only process files that look like NestJS controller files
      const isNestFile =
        content.includes("@Controller") ||
        content.includes("@Get(") ||
        content.includes("@Post(") ||
        content.includes("@Put(") ||
        content.includes("@Delete(") ||
        content.includes("@Patch(");

      if (!isNestFile) continue;

      // Extract controller prefix — @Controller('/users') or @Controller('users')
      let controllerPrefix = "";
      const controllerMatch = content.match(
        /@Controller\s*\(\s*['"`]([^'"`]*)['"`]\s*\)/,
      );
      if (controllerMatch) {
        controllerPrefix = controllerMatch[1].startsWith("/")
          ? controllerMatch[1]
          : "/" + controllerMatch[1];
      }

      // Extract all method decorators
      const methodPattern =
        /@(Get|Post|Put|Delete|Patch)\s*\(\s*['"`]?([^'"`\s\)]*?)['"`]?\s*\)/gi;

      let match;
      while ((match = methodPattern.exec(content)) !== null) {
        const method = match[1].toUpperCase();
        const methodPath = match[2] || "";

        const routeFull =
          controllerPrefix +
          (methodPath
            ? methodPath.startsWith("/")
              ? methodPath
              : "/" + methodPath
            : "");

        const normalizedPath = routeFull.replace(
          /:([a-zA-Z_][a-zA-Z0-9_]*)/g,
          ":$1",
        );

        const key = method + ":" + normalizedPath;
        if (seen.has(key)) continue;
        seen.add(key);

        const needsBody = ["POST", "PUT", "PATCH"].includes(method);
        const bodyFields = needsBody
          ? extractBodyFieldsFromFile(content)
          : null;
        const routeParamMap = buildRouteParamMap(normalizedPath, []);

        endpoints.push({
          method,
          path: normalizedPath,
          description: "",
          requestBody: bodyFields,
          routeParamMap,
          detectedBy: "static-scan-nestjs",
        });
      }
    }
  }

  walk(cwd, 0);
  return endpoints;
}

/**
 * Scans Koa routes from the codebase statically
 * Handles:
 * - router.get('/path', handler)
 * - router.post('/path', handler)
 * - router.put('/path', handler)
 * - router.delete('/path', handler)
 * - router.patch('/path', handler)
 */
function scanKoaRoutes(cwd) {
  const fs = require("fs");
  const path = require("path");
  const endpoints = [];
  const seen = new Set();

  const SKIP_DIRS = [
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    ".cache",
    "coverage",
    "out",
  ];

  function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.includes(entry)) continue;
      const fullPath = path.join(dir, entry);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }

      if (!/\.(js|ts)$/.test(entry)) continue;

      let content;
      try {
        content = fs.readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }

      // Only process files that look like Koa route files
      const isKoaFile =
        content.includes("koa-router") ||
        content.includes("@koa/router") ||
        content.includes("new Router()") ||
        /router\.(get|post|put|delete|patch)\s*\(/.test(content);

      if (!isKoaFile) continue;

      const routePattern =
        /router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi;

      let match;
      while ((match = routePattern.exec(content)) !== null) {
        const method = match[1].toUpperCase();
        const routePath = match[2];
        if (routePath.includes("*")) continue;

        const key = method + ":" + routePath;
        if (seen.has(key)) continue;
        seen.add(key);

        const needsBody = ["POST", "PUT", "PATCH"].includes(method);
        const bodyFields = needsBody
          ? extractBodyFieldsFromFile(content)
          : null;
        const routeParamMap = buildRouteParamMap(routePath, []);

        endpoints.push({
          method,
          path: routePath,
          description: "",
          requestBody: bodyFields,
          routeParamMap,
          detectedBy: "static-scan-koa",
        });
      }
    }
  }

  walk(cwd, 0);
  return endpoints;
}

/**
 * Scans Hapi routes from the codebase statically
 * Handles:
 * - server.route({ method: 'GET', path: '/path', handler })
 * - server.route([{ method: 'POST', path: '/path', handler }])
 */
function scanHapiRoutes(cwd) {
  const fs = require("fs");
  const path = require("path");
  const endpoints = [];
  const seen = new Set();

  const SKIP_DIRS = [
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    ".cache",
    "coverage",
    "out",
  ];

  function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.includes(entry)) continue;
      const fullPath = path.join(dir, entry);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }

      if (!/\.(js|ts)$/.test(entry)) continue;

      let content;
      try {
        content = fs.readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }

      const isHapiFile =
        content.includes("@hapi/hapi") ||
        content.includes("require('hapi')") ||
        content.includes('require("hapi")') ||
        content.includes("server.route(");

      if (!isHapiFile) continue;

      // Pattern — method and path can be in any order inside the object
      const routePattern =
        /server\.route\s*\(\s*\{[^}]*method\s*:\s*['"`]([^'"`]+)['"`][^}]*path\s*:\s*['"`]([^'"`]+)['"`]/gi;

      let match;
      while ((match = routePattern.exec(content)) !== null) {
        const method = match[1].toUpperCase();
        const routePath = match[2];
        if (routePath.includes("*")) continue;

        const key = method + ":" + routePath;
        if (seen.has(key)) continue;
        seen.add(key);

        const needsBody = ["POST", "PUT", "PATCH"].includes(method);
        const bodyFields = needsBody
          ? extractBodyFieldsFromFile(content)
          : null;
        const routeParamMap = buildRouteParamMap(routePath, []);

        endpoints.push({
          method,
          path: routePath,
          description: "",
          requestBody: bodyFields,
          routeParamMap,
          detectedBy: "static-scan-hapi",
        });
      }
    }
  }

  walk(cwd, 0);
  return endpoints;
}

/**
 * Scans AdonisJS routes from the codebase statically
 * Handles:
 * - Route.get('/path', handler)
 * - Route.post('/path', handler)
 * - router.get('/path', handler)
 * - router.post('/path', handler)
 */
function scanAdonisRoutes(cwd) {
  const fs = require("fs");
  const path = require("path");
  const endpoints = [];
  const seen = new Set();

  const SKIP_DIRS = [
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    ".cache",
    "coverage",
    "out",
  ];

  function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.includes(entry)) continue;
      const fullPath = path.join(dir, entry);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }

      if (!/\.(js|ts)$/.test(entry)) continue;

      let content;
      try {
        content = fs.readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }

      const isAdonisFile =
        content.includes("@adonisjs") ||
        content.includes("Route.get") ||
        content.includes("Route.post") ||
        /(?:Route|router)\.(get|post|put|delete|patch)\s*\(/.test(content);

      if (!isAdonisFile) continue;

      const routePattern =
        /(?:Route|router)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi;

      let match;
      while ((match = routePattern.exec(content)) !== null) {
        const method = match[1].toUpperCase();
        const routePath = match[2];
        if (routePath.includes("*")) continue;

        const key = method + ":" + routePath;
        if (seen.has(key)) continue;
        seen.add(key);

        const needsBody = ["POST", "PUT", "PATCH"].includes(method);
        const bodyFields = needsBody
          ? extractBodyFieldsFromFile(content)
          : null;
        const routeParamMap = buildRouteParamMap(routePath, []);

        endpoints.push({
          method,
          path: routePath,
          description: "",
          requestBody: bodyFields,
          routeParamMap,
          detectedBy: "static-scan-adonis",
        });
      }
    }
  }

  walk(cwd, 0);
  return endpoints;
}

/**
 * Scans Nuxt server API routes
 * Handles file-based routing in server/api/ folder
 * e.g. server/api/users.get.ts → GET /api/users
 * e.g. server/api/users/[id].delete.ts → DELETE /api/users/:id
 */
function scanNuxtServerRoutes(cwd) {
  const fs = require("fs");
  const path = require("path");
  const endpoints = [];
  const seen = new Set();

  const possibleDirs = [
    path.join(cwd, "server", "api"),
    path.join(cwd, "src", "server", "api"),
  ];

  function walkDir(dir, routePath) {
    if (!fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    entries.forEach(function (file) {
      const fullPath = path.join(dir, file);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        return;
      }

      if (stat.isDirectory()) {
        const segment = file.replace(/\[([^\]]+)\]/g, ":$1");
        walkDir(fullPath, routePath + "/" + segment);
        return;
      }

      if (!/\.(js|ts)$/.test(file)) return;

      // Nuxt convention: users.get.ts or users.post.ts or just users.ts
      // Strip extension first
      let fileName = file.replace(/\.(js|ts)$/, "");

      // Check if method is embedded in filename like users.get or [id].delete
      const methodMatch = fileName.match(/\.?(get|post|put|delete|patch)$/i);
      let method = null;
      if (methodMatch) {
        method = methodMatch[1].toUpperCase();
        fileName = fileName.replace(/\.?(get|post|put|delete|patch)$/i, "");
      }

      // Convert [id] to :id
      fileName = fileName.replace(/\[([^\]]+)\]/g, ":$1");

      const finalPath =
        fileName === "index" ? routePath : routePath + "/" + fileName;

      const methods = method ? [method] : ["GET"];

      methods.forEach(function (m) {
        const key = m + ":" + finalPath;
        if (seen.has(key)) return;
        seen.add(key);

        const routeParamMap = buildRouteParamMap(finalPath, []);

        endpoints.push({
          method: m,
          path: finalPath,
          description: "",
          requestBody: null,
          routeParamMap,
          detectedBy: "static-scan-nuxt",
        });
      });
    });
  }

  for (const dir of possibleDirs) {
    walkDir(dir, "/api");
  }

  return endpoints;
}

/**
 * Scans SvelteKit server routes
 * Handles +server.js / +server.ts files in src/routes/
 * e.g. src/routes/api/users/+server.ts with export function GET() → GET /api/users
 */
function scanSvelteKitServerRoutes(cwd) {
  const fs = require("fs");
  const path = require("path");
  const endpoints = [];
  const seen = new Set();

  const possibleDirs = [
    path.join(cwd, "src", "routes"),
    path.join(cwd, "routes"),
  ];

  function walkDir(dir, routePath) {
    if (!fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    entries.forEach(function (file) {
      const fullPath = path.join(dir, file);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        return;
      }

      if (stat.isDirectory()) {
        // Convert (group) folders — these are layout groups, not route segments
        if (/^\(.*\)$/.test(file)) {
          walkDir(fullPath, routePath);
          return;
        }
        // Convert [param] to :param
        const segment = file.replace(/\[([^\]]+)\]/g, ":$1");
        walkDir(fullPath, routePath + "/" + segment);
        return;
      }

      // Only process +server.js or +server.ts files
      if (!/^\+server\.(js|ts)$/.test(file)) return;

      let content;
      try {
        content = fs.readFileSync(fullPath, "utf8");
      } catch {
        return;
      }

      // Detect exported HTTP methods
      const methods = detectAppRouterMethods(content);

      methods.forEach(function (method) {
        const key = method + ":" + routePath;
        if (seen.has(key)) return;
        seen.add(key);

        const needsBody = ["POST", "PUT", "PATCH"].includes(method);
        const bodyFields = needsBody
          ? extractBodyFieldsFromFile(content)
          : null;
        const routeParamMap = buildRouteParamMap(routePath, []);

        endpoints.push({
          method,
          path: routePath || "/",
          description: "",
          requestBody: bodyFields,
          routeParamMap,
          detectedBy: "static-scan-sveltekit",
        });
      });
    });
  }

  for (const dir of possibleDirs) {
    walkDir(dir, "");
  }

  return endpoints;
}

/**
 * Scans Remix server routes
 * Handles loader (GET) and action (POST/PUT/DELETE/PATCH) exports
 * in app/routes/ folder
 * e.g. app/routes/projects.$id.tsx with export async function loader() → GET /projects/:id
 */
function scanRemixServerRoutes(cwd) {
  const fs = require("fs");
  const path = require("path");
  const endpoints = [];
  const seen = new Set();

  const possibleDirs = [
    path.join(cwd, "app", "routes"),
    path.join(cwd, "routes"),
  ];

  function walkDir(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    entries.forEach(function (file) {
      const fullPath = path.join(dir, file);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        return;
      }

      if (stat.isDirectory()) {
        walkDir(fullPath, prefix + "/" + file);
        return;
      }

      if (!/\.(js|ts|jsx|tsx)$/.test(file)) return;

      let content;
      try {
        content = fs.readFileSync(fullPath, "utf8");
      } catch {
        return;
      }

      // Only process files that have loader or action exports
      const hasLoader = /export\s+(?:async\s+)?function\s+loader\b/.test(
        content,
      );
      const hasAction = /export\s+(?:async\s+)?function\s+action\b/.test(
        content,
      );

      if (!hasLoader && !hasAction) return;

      // Convert Remix filename convention to route path
      // projects.$id.tsx → /projects/:id
      // _index.tsx → /
      let fileName = file.replace(/\.(js|ts|jsx|tsx)$/, "");
      if (fileName === "_index") fileName = "";

      const routePath =
        (prefix + "/" + fileName)
          .replace(/\.\$/g, "/:") // .$param → /:param
          .replace(/\./g, "/") // remaining dots → slashes
          .replace(/\/+/g, "/") // clean double slashes
          .replace(/\/$/, "") || "/";

      if (hasLoader) {
        const key = "GET:" + routePath;
        if (!seen.has(key)) {
          seen.add(key);
          endpoints.push({
            method: "GET",
            path: routePath,
            description: "",
            requestBody: null,
            routeParamMap: buildRouteParamMap(routePath, []),
            detectedBy: "static-scan-remix",
          });
        }
      }

      if (hasAction) {
        // action handles POST/PUT/DELETE/PATCH — default to POST
        // try to detect specific method from content
        const actionMethods = ["POST", "PUT", "DELETE", "PATCH"].filter((m) =>
          new RegExp(`request\\.method\\s*===?\\s*['"]${m}['"]`).test(content),
        );

        const methodsToAdd =
          actionMethods.length > 0 ? actionMethods : ["POST"];

        methodsToAdd.forEach(function (method) {
          const key = method + ":" + routePath;
          if (seen.has(key)) return;
          seen.add(key);

          const bodyFields = extractBodyFieldsFromFile(content);
          endpoints.push({
            method,
            path: routePath,
            description: "",
            requestBody: bodyFields,
            routeParamMap: buildRouteParamMap(routePath, []),
            detectedBy: "static-scan-remix",
          });
        });
      }
    });
  }

  for (const dir of possibleDirs) {
    walkDir(dir, "");
  }

  return endpoints;
}

// ─── Static response-shape guessing ───────────────────────────────────────────
// Best-effort: reads field names from reply objects written out directly in the code
// (e.g. res.json({ id, name })). Replies built from variables are left empty on purpose;
// real runtime replies fill those in later and replace any guess made here.
const MAX_STATIC_RESPONSE_FIELDS = 50;
const MAX_STATIC_LITERAL_LENGTH = 6000;

const STATIC_REPLY_PATTERN =
  /\b(?:res|resp|response|reply|NextResponse|Response)\s*(?:\.\s*(?:status|code)\s*\(\s*(\d{3})\s*\))?\s*\.\s*(?:json|send)\s*\(\s*\{|\bctx\.body\s*=\s*\{|\bh\.response\s*\(\s*\{/g;

// Returns the index of the closing quote of the string starting at "start" (-1 if not found)
function skipStaticString(text, start, limit) {
  const quote = text[start];
  for (let i = start + 1; i < limit; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === quote) return i;
    if (quote === "`" && ch === "$" && text[i + 1] === "{") {
      let depth = 1;
      i += 2;
      for (; i < limit && depth > 0; i++) {
        const c = text[i];
        if (c === '"' || c === "'" || c === "`") {
          i = skipStaticString(text, i, limit);
          if (i === -1) return -1;
          continue;
        }
        if (c === "{") depth++;
        else if (c === "}") depth--;
      }
      i--;
      continue;
    }
    if (quote !== "`" && ch === "\n") return -1;
  }
  return -1;
}

// Returns the index of the "}" that closes the "{" at openIndex (null if it cannot be matched safely)
function findStaticClosingBrace(text, openIndex) {
  let depth = 0;
  const limit = Math.min(text.length, openIndex + MAX_STATIC_LITERAL_LENGTH);
  for (let i = openIndex; i < limit; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) return null;
      i = nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return null;
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipStaticString(text, i, limit);
      if (i === -1) return null;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      if (depth === 0) return ch === "}" ? i : null;
      if (depth < 0) return null;
    }
  }
  return null;
}

// Splits the inside of an object literal on top-level commas (comments removed)
function splitStaticEntries(inner) {
  const entries = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    const next = inner[i + 1];
    if (ch === "/" && next === "/") {
      const nl = inner.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = inner.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipStaticString(inner, i, inner.length);
      if (end === -1) return null;
      current += inner.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      entries.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) entries.push(current.trim());
  return entries;
}

// Reads one "key: value" or shorthand "key" entry; spreads, computed keys and methods are skipped
function parseStaticEntry(entry) {
  if (!entry || entry.startsWith("...") || entry.startsWith("[")) return null;
  let m = entry.match(
    /^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]+)$/,
  );
  if (m) return { key: m[1] || m[2] || m[3], value: m[4] };
  m = entry.match(/^([A-Za-z_$][\w$]*)$/);
  if (m) return { key: m[1], value: null };
  return null;
}

// Only literal values reveal their type; anything computed is marked "unknown" instead of guessed
function guessStaticValueType(valueExpr) {
  const v = String(valueExpr || "").trim();
  if (/^["'`]/.test(v)) return { type: "string" };
  if (/^-?\d+(\.\d+)?$/.test(v)) return { type: "number" };
  if (/^(true|false)$/.test(v)) return { type: "boolean" };
  if (/^\[/.test(v)) return { type: "array", items: { type: "unknown" } };
  if (/^\{/.test(v)) return { type: "object" };
  return { type: "unknown" };
}

function parseStaticObjectFields(inner) {
  const entries = splitStaticEntries(inner);
  if (!entries) return null;
  const properties = {};
  let count = 0;
  for (const entry of entries) {
    if (count >= MAX_STATIC_RESPONSE_FIELDS) break;
    const parsed = parseStaticEntry(entry);
    if (!parsed) continue;
    properties[parsed.key] =
      parsed.value === null
        ? { type: "unknown" }
        : guessStaticValueType(parsed.value);
    count++;
  }
  const keys = Object.keys(properties);
  if (keys.length === 0) return null;
  if (keys.length === 1 && keys[0] === "error") return null; // looks like an error reply
  // "_source" lets the server replace this guess with a real runtime reply later
  return { type: "object", properties, _source: "static" };
}

function extractResponseFieldsFromSegment(segment) {
  try {
    if (!segment || typeof segment !== "string") return null;
    const pattern = new RegExp(STATIC_REPLY_PATTERN.source, "g");
    let m;
    while ((m = pattern.exec(segment)) !== null) {
      const status = m[1] ? parseInt(m[1], 10) : 200;
      if (status >= 400) continue;
      const open = m.index + m[0].length - 1;
      const close = findStaticClosingBrace(segment, open);
      if (close === null) continue;
      const after = segment.slice(close + 1, close + 120);
      const afterStatus = after.match(/^\s*,\s*\{[^}]*\bstatus\s*:\s*(\d{3})/);
      if (afterStatus && parseInt(afterStatus[1], 10) >= 400) continue;
      // a status that is not a plain number (variable/expression) cannot be known to be a success
      if (!afterStatus && /^\s*,\s*\{[^}]*\bstatus\b/.test(after)) continue;
      const fields = parseStaticObjectFields(segment.slice(open + 1, close));
      if (fields) return fields;
    }
  } catch (e) {}
  return null;
}

// Marker that starts one method's code inside a file
function staticMethodMarker(style, method) {
  if (style === "app") {
    return new RegExp(
      "export\\s+(?:async\\s+)?function\\s+" +
        method +
        "\\b|export\\s+(?:const|let)\\s+" +
        method +
        "\\s*=",
    );
  }
  // handles any variable that holds the request method, not just req.method
  return new RegExp(
    "(?:" +
      METHOD_REF +
      "\\s*===?\\s*['\"]" +
      method +
      "['\"]|case\\s*['\"]" +
      method +
      "['\"])",
    "i",
  );
}

// Finds where one HTTP method's code starts in a file (-1 if it cannot be told apart).
// Reads the same method checks that detectMethodsFromFile reads, including the early-exit
// guard "if (req.method !== 'X') return ..." (code after that guard belongs to X).
function findStaticMethodMarkerIndex(content, style, method) {
  const direct = staticMethodMarker(style, method).exec(content);
  if (direct) return direct.index;
  if (style === "app") return -1;

  // handles any variable that holds the request method, not just req.method
  const guardRe = new RegExp(
    METHOD_REF + "\\s*!==?\\s*['\"]" + method + "['\"]",
    "gi",
  );
  let hit;
  while ((hit = guardRe.exec(content)) !== null) {
    // A guard listing several allowed methods is not specific to one method, so skip it
    const before = content.slice(Math.max(0, hit.index - 60), hit.index);
    const afterStart = hit.index + hit[0].length;
    const after = content.slice(afterStart, afterStart + 60);
    const listsOtherMethods =
      /[\w$.?]*method[\w$]*\s*!==?\s*['"][A-Za-z]+['"]\s*&&\s*$/i.test(
        before,
      ) ||
      /^\s*&&\s*[\w$.?]*method[\w$]*\s*!==?\s*['"][A-Za-z]+['"]/i.test(after);
    if (!listsOtherMethods) return hit.index;
  }
  return -1;
}

// For "export const GET = wrapper(handlerName)", returns the code of handlerName when it is
// declared at the top level of the same file (null when it cannot be found, e.g. imported from elsewhere).
function findStaticHandlerCode(content, markerIndex) {
  const ref =
    /^export\s+(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(?:[A-Za-z_$][\w$.]*\s*\(\s*)*([A-Za-z_$][\w$]*)\s*(?:[,);]|\n|$)/.exec(
      content.slice(markerIndex, markerIndex + 300),
    );
  if (!ref) return null;
  const name = ref[1];
  if (name === "async" || name === "function" || name === "await") return null;
  const safe = name.replace(/[$]/g, "\\$&");
  const declRe = new RegExp(
    "(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function\\s+" +
      safe +
      "\\s*[(<]|(?:^|\\n)(?:export\\s+)?(?:const|let|var)\\s+" +
      safe +
      "\\b[^=\\n]*=",
  );
  const decl = declRe.exec(content);
  if (!decl) return null;
  const bodyStart = decl.index + decl[0].length;
  // the handler's code runs until the next top-level statement
  const next =
    /\n(?:export\s|async\s+function\s|function\s|const\s|let\s|var\s|class\s|interface\s|type\s)/.exec(
      content.slice(bodyStart),
    );
  const end = next ? bodyStart + next.index : content.length;
  return content.slice(decl.index, end);
}

// For files that handle several HTTP methods: returns only the code that belongs to one method,
// or null when it cannot be told apart safely (so no guess is made)
function extractResponseFieldsForMethod(content, method, allMethods, style) {
  try {
    let segment = content;
    if (allMethods && allMethods.length > 1) {
      const markers = [];
      allMethods.forEach(function (m) {
        // Uses the same method checks as method detection, so the file is split consistently
        const index = findStaticMethodMarkerIndex(content, style, m);
        if (index !== -1) markers.push({ method: m, index: index });
      });
      const own = markers.find(function (x) {
        return x.method === method;
      });
      if (!own) return null;
      // handler declared elsewhere in the same file and exported through a wrapper
      if (style === "app") {
        const handlerCode = findStaticHandlerCode(content, own.index);
        if (handlerCode) return extractResponseFieldsFromSegment(handlerCode);
      }
      markers.sort(function (a, b) {
        return a.index - b.index;
      });
      const pos = markers.indexOf(own);
      const end =
        pos + 1 < markers.length ? markers[pos + 1].index : content.length;
      segment = content.slice(own.index, end);
    }
    return extractResponseFieldsFromSegment(segment);
  } catch (e) {
    return null;
  }
}

// For route definitions in one file (app.get(...), router.post(...)): the code from this route
// definition up to the next one
function extractResponseFieldsForRoute(
  content,
  startIndex,
  routePatternSource,
) {
  try {
    const re = new RegExp(routePatternSource, "gi");
    let end = content.length;
    let hit;
    while ((hit = re.exec(content)) !== null) {
      if (hit.index > startIndex) {
        end = hit.index;
        break;
      }
    }
    return extractResponseFieldsFromSegment(content.slice(startIndex, end));
  } catch (e) {
    return null;
  }
}

// For live Express route handlers: reads the handler source, last handler first
function extractResponseFieldsFromHandlers(stack, method) {
  try {
    for (let i = stack.length - 1; i >= 0; i--) {
      const layer = stack[i];
      if (layer.method && String(layer.method).toUpperCase() !== method)
        continue;
      const fn = layer.handle || layer;
      if (typeof fn !== "function") continue;
      const src = Function.prototype.toString.call(fn);
      const fields = extractResponseFieldsFromSegment(src);
      if (fields) return fields;
    }
  } catch (e) {}
  return null;
}

module.exports = {
  scanExpressRoutes,
  scanNextJsRoutes,
  scanNextJsAppRoutes,
  extractPathParams,
  scanFrontendRoutes,
  scanFastifyRoutes,
  scanNestJsRoutes,
  scanKoaRoutes,
  scanHapiRoutes,
  scanAdonisRoutes,
  scanNuxtServerRoutes,
  scanSvelteKitServerRoutes,
  scanRemixServerRoutes,
};
