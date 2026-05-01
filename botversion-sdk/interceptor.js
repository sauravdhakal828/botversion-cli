// botversion-sdk/interceptor.js
"use strict";

/**
 * Makes an internal HTTP request to the user's own backend.
 * Forwards cookies, auth headers, and CSRF tokens.
 */
function makeInternalRequest(method, path, body, cookies, headers, baseUrl) {
  return new Promise(function (resolve) {
    var http = require("http");
    var https = require("https");
    var url = require("url");

    baseUrl = baseUrl || "http://127.0.0.1:8000";
    var fullUrl = baseUrl + path;
    var parsedUrl = url.parse(fullUrl);
    var isHttps = parsedUrl.protocol === "https:";
    var lib = isHttps ? https : http;

    var bodyStr = body ? JSON.stringify(body) : null;

    var reqHeaders = {
      "Content-Type": "application/json",
    };

    if (bodyStr) {
      reqHeaders["Content-Length"] = String(Buffer.byteLength(bodyStr));
    }

    // Forward cookies — this is what identifies the user
    if (cookies) reqHeaders["Cookie"] = cookies;

    // Forward auth header
    var authHeader =
      headers && (headers["authorization"] || headers["Authorization"]);
    if (authHeader) reqHeaders["Authorization"] = authHeader;

    // Forward CSRF token
    var csrf =
      headers &&
      (headers["x-csrftoken"] ||
        headers["X-CSRFToken"] ||
        headers["x-xsrf-token"] ||
        headers["X-XSRF-TOKEN"]);
    if (csrf) reqHeaders["X-CSRFToken"] = csrf;

    var reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.path,
      method: method.toUpperCase(),
      headers: reqHeaders,
      timeout: 30000,
    };

    var req = lib.request(reqOptions, function (res) {
      var data = "";
      res.on("data", function (chunk) {
        data += chunk;
      });
      res.on("end", function () {
        var parsed;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          parsed = { raw: data };
        }

        // Handle redirects
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          makeInternalRequest(
            res.statusCode === 303 ? "GET" : method,
            res.headers.location,
            res.statusCode === 303 ? null : body,
            cookies,
            headers,
            baseUrl,
          ).then(resolve);
          return;
        }

        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          data: parsed,
        });
      });
    });

    req.on("error", function (err) {
      resolve({ status: 500, ok: false, data: { error: err.message } });
    });

    req.on("timeout", function () {
      req.destroy();
      resolve({ status: 500, ok: false, data: { error: "Request timed out" } });
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

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

  // Track which endpoints we have already reported
  const reportedEndpoints = new Set();

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
            if (options.debug) {
              console.warn(
                "[BotVersion SDK] Failed to report endpoint:",
                err.message,
              );
            }
          });
      });
    }

    next();
  });
  // Register executor so WebSocket can forward calls to user's backend
  client.setExecutor(function (method, path, body, cookies, headers, baseUrl) {
    return makeInternalRequest(method, path, body, cookies, headers, baseUrl);
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

module.exports = {
  attachInterceptor,
  normalizePath,
  buildBodyStructure,
};
