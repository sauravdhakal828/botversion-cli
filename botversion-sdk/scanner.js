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

  console.log(`\n[DEBUG] ===== JS SCAN SUMMARY =====`);
  endpoints.forEach((ep) => {
    const status = ep.requestBody ? "✅" : "❌ NULL";
    console.log(
      `[DEBUG] ${status} ${ep.method.padEnd(6)} ${ep.path} → ${JSON.stringify(ep.requestBody)}`,
    );
  });
  console.log(`[DEBUG] ================================\n`);

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
  console.log(`[DEBUG] Scanning file statically: ${filePath}`);

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

    console.log(
      `[DEBUG] ${effectiveMethod} ${routePath} → bodyFields: ${JSON.stringify(bodyFields)}`,
    );

    endpoints.push({
      method: effectiveMethod,
      path: routePath,
      description: "",
      requestBody: bodyFields,
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
              console.log(
                `[DEBUG] Found body from inline handler for ${method} ${routePath}`,
              );
              break;
            }
          }

          // Strategy 2: fall back to bodyMap using handler name
          if (!requestBody) {
            const handlerName = extractHandlerName(layer);
            console.log(
              `[DEBUG] ${method} ${routePath} → handlerName: ${handlerName}`,
            );
            if (handlerName && bodyMap[handlerName]) {
              requestBody = bodyMap[handlerName];
              console.log(`[DEBUG] Found body from bodyMap for ${handlerName}`);
            }
          }
        }

        endpoints.push({
          method: method,
          path: routePath,
          description: "",
          requestBody: requestBody,
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
    console.warn("[BotVersion SDK] No pages/api directory found at:", apiDir);
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

        endpoints.push({
          method: method,
          path: normalizedPath,
          description: "",
          requestBody: effectiveRequestBody,
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
    properties[field] = { type: "string" };
  });
  console.log(
    `[DEBUG] extractBodyFieldsFromFile found fields: ${JSON.stringify([...fields])}`,
  );

  return { type: "object", properties };
}

function scanNextJsAppRoutes(appDir) {
  const fs = require("fs");
  const path = require("path");
  const endpoints = [];

  const apiDir = path.join(appDir, "api");
  if (!fs.existsSync(apiDir)) {
    console.warn("[BotVersion SDK] No app/api directory found at:", apiDir);
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

        endpoints.push({
          method: method,
          path: routePath,
          description: "",
          requestBody:
            bodyFields ||
            (method === "DELETE" && queryFields ? queryFields : null),
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
    properties[field] = { type: "string" };
  });

  return { type: "object", properties };
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
            console.log(`[DEBUG] Found route file: ${fullPath}`); // already have this
            routeFiles.push(fullPath);
          }

          // ADD THIS — log files that are being SKIPPED
          else if (/\.(js|ts)$/.test(entry)) {
            console.log(
              `[DEBUG] Skipped (not detected as route file): ${fullPath}`,
            );
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

      if (content.includes("req.body")) {
        console.log(`[DEBUG] bodyMap: found req.body in ${fullPath}`);
        console.log(
          `[DEBUG] bodyMap: fnNames found: ${JSON.stringify([
            ...(() => {
              const names = new Set();
              for (const p of fnPatterns) {
                p.lastIndex = 0;
                let m;
                while ((m = p.exec(content)) !== null) names.add(m[1]);
              }
              return names;
            })(),
          ])}`,
        );
      }

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
  console.log(`[DEBUG] bodyMap keys: ${Object.keys(bodyMap)}`);
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

module.exports = {
  scanExpressRoutes,
  scanNextJsRoutes,
  scanNextJsAppRoutes,
  extractPathParams,
};
