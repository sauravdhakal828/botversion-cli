// botversion-sdk/scanner.js
"use strict";

/**
 * Scans an Express app object and extracts all registered routes
 */
function scanExpressRoutes(app) {
  const endpoints = [];
  const seen = new Set();

  // Force Express to initialize its router if it hasn't yet
  if (app.lazyrouter) app.lazyrouter();
  const router = app._router || app.router || (app.stack ? app : null);

  if (!router) {
    console.warn(
      "[BotVersion SDK] No router found — trying app._events fallback",
    );

    if (app._events && app._events.request) {
      const handler = app._events.request;
      if (handler && handler.stack) {
        extractRoutes(handler.stack, "", endpoints, seen);
        return endpoints;
      }
    }
    return endpoints;
  }

  const stack = router.stack || [];
  extractRoutes(stack, "", endpoints, seen);
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
function extractRoutes(stack, prefix, endpoints, seen) {
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

        // Skip Express internals
        if (method === "_ALL") return;

        var key = method + ":" + routePath;
        if (seen.has(key)) return;
        seen.add(key);

        var params = extractPathParams(routePath);

        endpoints.push({
          method: method,
          path: routePath,
          description: "",
          requestBody:
            method !== "GET" && params.length > 0
              ? buildParamSchema(params)
              : null,
          detectedBy: "static-scan",
        });
      });

      return;
    }

    // ── Nested router layer (app.use('/prefix', router)) ─────────────────
    if (layer.name === "router" && layer.handle && layer.handle.stack) {
      // Extract the mount path from the regexp
      var mountPath = prefix + regexpToPath(layer.regexp, layer.keys);
      extractRoutes(layer.handle.stack, mountPath, endpoints, seen);
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

module.exports = {
  scanExpressRoutes,
  scanNextJsRoutes,
  extractPathParams,
};
