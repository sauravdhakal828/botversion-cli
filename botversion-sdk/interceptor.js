// botversion-sdk/interceptor.js
"use strict";

const reportedEndpoints = new Set();

/**
 * Attaches a middleware to the Express app that
 * silently intercepts every request and reports
 * new endpoints to BotVersion platform.
 * Auth and user context are handled client-side — not here.
 */
function attachInterceptor(app, client, options) {
  options = options || {};

  const ignorePaths = [
    "/health",
    "/favicon.ico",
    "/_next",
    "/static",
    "/public",
  ].concat(options.exclude || []);

  app.use(function botVersionInterceptor(req, res, next) {
    const path = req.path || req.url || "";
    const shouldIgnore = ignorePaths.some(function (p) {
      return path.startsWith(p);
    });

    if (shouldIgnore) {
      return next();
    }

    if (options.apiPrefix && !path.startsWith(options.apiPrefix)) {
      return next();
    }

    const method = req.method.toUpperCase();
    const normalizedPath = normalizePath(path);
    const endpointKey = method + ":" + normalizedPath;

    const bodyStructure = buildBodyStructure(req.body);
    const bodyKey =
      endpointKey +
      ":" +
      Object.keys(bodyStructure || {})
        .sort()
        .join(",");

    if (!reportedEndpoints.has(bodyKey)) {
      reportedEndpoints.add(bodyKey);

      const jsonSchema = bodyStructure
        ? {
            type: "object",
            properties: Object.fromEntries(
              Object.entries(bodyStructure).map(function ([key, type]) {
                return [
                  key,
                  {
                    type:
                      type === "null" || type === "[redacted]"
                        ? "string"
                        : type,
                  },
                ];
              }),
            ),
          }
        : null;

      // Report async — never block the request
      setImmediate(function () {
        client
          .updateEndpoint({
            method: method,
            path: normalizedPath,
            requestBody: jsonSchema,
            detectedBy: "runtime",
          })
          .catch(function (err) {
            console.error("[botversion] update_endpoint failed:", err.message);
          });
      });
    }

    next();
  });
}

/**
 * Normalize a path by replacing dynamic segments with :param
 * Example: /api/projects/123/tasks/456 → /api/projects/:id/tasks/:id
 */
function normalizePath(path) {
  return path
    .split("/")
    .map(function (segment) {
      if (!segment) return segment;

      // UUID pattern
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          segment,
        )
      )
        return ":id";

      // Numeric ID
      if (/^\d+$/.test(segment)) return ":id";

      // cuid pattern
      if (/^c[a-z0-9]{20,}$/i.test(segment)) return ":id";

      // MongoDB ObjectId
      if (/^[0-9a-f]{24}$/i.test(segment)) return ":id";

      // Long alphanumeric (likely an ID)
      if (
        segment.length >= 16 &&
        /[a-zA-Z]/.test(segment) &&
        /[0-9]/.test(segment)
      )
        return ":id";

      return segment;
    })
    .join("/");
}

/**
 * Extract just the structure of a request body
 * (keys and value types — never actual values for security)
 */
function buildBodyStructure(body) {
  if (!body || typeof body !== "object") return null;

  const structure = {};

  Object.keys(body).forEach(function (key) {
    const sensitiveKeys = [
      "password",
      "token",
      "secret",
      "apiKey",
      "api_key",
      "creditCard",
      "credit_card",
      "ssn",
      "cvv",
      "pin",
    ];

    const isSensitive = sensitiveKeys.some(function (sk) {
      return key.toLowerCase().includes(sk.toLowerCase());
    });

    if (isSensitive) {
      structure[key] = "[redacted]";
      return;
    }

    const val = body[key];
    if (Array.isArray(val)) {
      structure[key] = "array";
    } else if (val === null) {
      structure[key] = "null";
    } else {
      structure[key] = typeof val;
    }
  });

  return structure;
}

function attachNextJsInterceptor(client, options) {
  try {
    const http = require("http");
    const originalEmit = http.Server.prototype.emit;

    http.Server.prototype.emit = function (event, req, res) {
      if (event === "request") {
        const path = req.url ? req.url.split("?")[0] : "";
        const method = req.method ? req.method.toUpperCase() : "";

        const shouldIgnore = (options.exclude || [])
          .concat(["/health", "/favicon.ico", "/_next", "/static", "/public"])
          .some(function (p) {
            return path.startsWith(p);
          });

        const isApiPath = path.startsWith(options.apiPrefix || "/api");

        if (!shouldIgnore && isApiPath) {
          const normalizedPath = normalizePath(path);
          const endpointKey = method + ":" + normalizedPath;

          if (!reportedEndpoints.has(endpointKey)) {
            reportedEndpoints.add(endpointKey);

            setImmediate(function () {
              client
                .updateEndpoint({
                  method: method,
                  path: normalizedPath,
                  detectedBy: "runtime",
                })
                .catch(function (err) {
                  console.error("[botversion] update failed:", err.message);
                });
            });
          }
        }
      }

      return originalEmit.apply(this, arguments);
    };
  } catch (err) {
    console.error(
      "[botversion] failed to attach Next.js interceptor:",
      err.message,
    );
  }
}

module.exports = {
  attachInterceptor,
  attachNextJsInterceptor,
  normalizePath,
  buildBodyStructure,
};
