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

  endpoints.forEach((ep) => {
    const status = ep.requestBody ? "✅" : "❌ NULL";
  });

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

    const routeParamMap = buildRouteParamMap(routePath, []);

    endpoints.push({
      method: effectiveMethod,
      path: routePath,
      description: "",
      requestBody: bodyFields,
      routeParamMap: routeParamMap,
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

        const routeParamMap = buildRouteParamMap(routePath, []);

        endpoints.push({
          method: method,
          path: routePath,
          description: "",
          requestBody: requestBody,
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

      const routeName = file.replace(/\.(js|ts)$/, "");
      const routePath =
        routeName === "index" ? prefix : prefix + "/" + routeName;
      const normalizedPath = routePath.replace(/\[([^\]]+)\]/g, ":$1");

      const methods = detectMethodsFromFile(fullPath);
      const fileContent = fs.readFileSync(fullPath, "utf8");

      methods.forEach(function (method) {
        const bodyFields =
          method !== "GET" ? extractBodyFieldsFromFile(fileContent) : null;
        const queryFields = extractQueryFieldsFromFile(fileContent);

        // For DELETE with no body fields, query params are the input
        const effectiveRequestBody =
          bodyFields ||
          (method === "DELETE" && queryFields ? queryFields : null);

        const routeParamMap = buildRouteParamMap(normalizedPath, []);

        endpoints.push({
          method: method,
          path: normalizedPath,
          description: "",
          requestBody: effectiveRequestBody,
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
function detectMethodsFromFile(filePath) {
  try {
    const fs = require("fs");
    const content = fs.readFileSync(filePath, "utf8");
    const methods = [];

    const methodPatterns = [
      { pattern: /req\.method\s*!==?\s*['"]GET['"]/i, method: "GET" },
      { pattern: /req\.method\s*!==?\s*['"]POST['"]/i, method: "POST" },
      { pattern: /req\.method\s*!==?\s*['"]PUT['"]/i, method: "PUT" },
      { pattern: /req\.method\s*!==?\s*['"]DELETE['"]/i, method: "DELETE" },
      { pattern: /req\.method\s*!==?\s*['"]PATCH['"]/i, method: "PATCH" },
      { pattern: /req\.method\s*===?\s*['"]GET['"]/i, method: "GET" },
      { pattern: /req\.method\s*===?\s*['"]POST['"]/i, method: "POST" },
      { pattern: /req\.method\s*===?\s*['"]PUT['"]/i, method: "PUT" },
      { pattern: /req\.method\s*===?\s*['"]DELETE['"]/i, method: "DELETE" },
      { pattern: /req\.method\s*===?\s*['"]PATCH['"]/i, method: "PATCH" },
      { pattern: /case\s*['"]GET['"]/i, method: "GET" },
      { pattern: /case\s*['"]POST['"]/i, method: "POST" },
      { pattern: /case\s*['"]PUT['"]/i, method: "PUT" },
      { pattern: /case\s*['"]DELETE['"]/i, method: "DELETE" },
      { pattern: /case\s*['"]PATCH['"]/i, method: "PATCH" },
    ];

    const detectedMethods = new Set();

    methodPatterns.forEach(function (mp) {
      if (mp.pattern.test(content)) {
        detectedMethods.add(mp.method);
      }
    });

    // For "!== POST" pattern, the file ONLY handles POST — not all methods
    // So if we detected via !== check, use just that method
    if (detectedMethods.size > 0) {
      detectedMethods.forEach(function (m) {
        methods.push(m);
      });
    } else {
      methods.push("GET");
    }

    return methods;
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
        const bodyFields =
          method !== "GET" ? extractAppRouterBodyFields(content) : null;
        const queryFields = extractQueryFieldsFromFile(content);

        const routeParamMap = buildRouteParamMap(routePath, []);

        endpoints.push({
          method: method,
          path: routePath,
          description: "",
          requestBody:
            bodyFields ||
            (method === "DELETE" && queryFields ? queryFields : null),
          routeParamMap: routeParamMap,
          detectedBy: "static-scan",
        });
      });
    });
  }

  walkDir(apiDir);
  return endpoints;
}

function detectAppRouterMethods(content) {
  const methods = [];
  const patterns = [
    { pattern: /export\s+async\s+function\s+GET\b/, method: "GET" },
    { pattern: /export\s+async\s+function\s+POST\b/, method: "POST" },
    { pattern: /export\s+async\s+function\s+PUT\b/, method: "PUT" },
    { pattern: /export\s+async\s+function\s+DELETE\b/, method: "DELETE" },
    { pattern: /export\s+async\s+function\s+PATCH\b/, method: "PATCH" },
    // named exports too: export { POST }
    { pattern: /export\s+function\s+GET\b/, method: "GET" },
    { pattern: /export\s+function\s+POST\b/, method: "POST" },
    { pattern: /export\s+function\s+PUT\b/, method: "PUT" },
    { pattern: /export\s+function\s+DELETE\b/, method: "DELETE" },
    { pattern: /export\s+function\s+PATCH\b/, method: "PATCH" },
  ];

  patterns.forEach(function (p) {
    if (p.pattern.test(content)) methods.push(p.method);
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

  // Pattern 1: const { id } = req.query
  const destructureMatches = content.matchAll(
    /const\s*\{([^}]+)\}\s*=\s*req\.query/g,
  );
  for (const destructureMatch of destructureMatches) {
    destructureMatch[1].split(",").forEach(function (f) {
      const clean = f.trim().split(":")[0].trim();
      if (clean) fields.add(clean);
    });
  }

  // Pattern 2: req.query.id
  const dotMatches = content.matchAll(/req\.query\.([a-zA-Z_][a-zA-Z0-9_]*)/g);
  for (const match of dotMatches) {
    fields.add(match[1]);
  }

  if (fields.size === 0) return null;

  const properties = {};
  fields.forEach(function (field) {
    properties[field] = { type: "string" };
  });

  return { type: "object", properties };
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

  // ── Step 2: Walk up exactly 1 level to find sibling folders ─────────
  // Handles the case where SDK is installed in backend/ but
  // frontend/ is a sibling folder at the same level
  const parentDir = path.dirname(cwd);
  if (parentDir !== cwd) {
    const UNSAFE_PARENTS = new Set([
      "Desktop",
      "Documents",
      "Downloads",
      "Pictures",
      "Videos",
      "Music",
      "home",
      "users",
      "Users",
      "var",
      "www",
      "srv",
      "opt",
      "tmp",
      "workspace",
      "Workspace",
      "projects",
      "Projects",
      "code",
      "Code",
      "sites",
      "Sites",
      "dev",
      "Dev",
      "work",
      "Work",
    ]);

    if (UNSAFE_PARENTS.has(path.basename(parentDir))) {
      if (found.length === 0) found.push(cwd);
      return found;
    }
    // Safety check — only scan siblings if the parent folder
    // looks like a project root (has package.json OR common project folders)
    // This prevents scanning unrelated projects on the Desktop
    const parentHasPackageJson = fs.existsSync(
      path.join(parentDir, "package.json"),
    );
    const parentHasCommonProjectFiles =
      fs.existsSync(path.join(parentDir, "docker-compose.yml")) ||
      fs.existsSync(path.join(parentDir, "docker-compose.yaml")) ||
      fs.existsSync(path.join(parentDir, ".env")) ||
      fs.existsSync(path.join(parentDir, "turbo.json")) ||
      fs.existsSync(path.join(parentDir, "pnpm-workspace.yaml"));

    // If parent has no signs of being a project root, skip sibling scanning
    if (!parentHasPackageJson && !parentHasCommonProjectFiles) {
      // skip — parent is probably just a random folder like Desktop
    } else {
      let parentEntries;
      try {
        parentEntries = fs.readdirSync(parentDir);
      } catch {
        parentEntries = [];
      }

      for (const entry of parentEntries) {
        if (SKIP_DIRS.has(entry)) continue;

        const sibling = path.join(parentDir, entry);
        if (sibling === cwd) continue; // skip cwd itself

        let stat;
        try {
          stat = fs.statSync(sibling);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;

        // Only add if it actually looks like a frontend project
        if (isFrontendDir(sibling) && !found.includes(sibling)) {
          found.push(sibling);
        }

        // Also check one level inside the sibling
        let siblingEntries;
        try {
          siblingEntries = fs.readdirSync(sibling);
        } catch {
          continue;
        }

        for (const siblingEntry of siblingEntries) {
          if (SKIP_DIRS.has(siblingEntry)) continue;
          const siblingChild = path.join(sibling, siblingEntry);
          let siblingChildStat;
          try {
            siblingChildStat = fs.statSync(siblingChild);
          } catch {
            continue;
          }
          if (!siblingChildStat.isDirectory()) continue;
          if (isFrontendDir(siblingChild) && !found.includes(siblingChild)) {
            found.push(siblingChild);
          }
        }
      }
    }
  }

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
  console.log("[botversion:scanner] Frontend candidate dirs:", candidateDirs);

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
        console.log("[botversion:scanner] Scanning dir:", dir);
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

  console.log(
    "[botversion:scanner] Total frontend patterns found:",
    patterns.length,
  );
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
