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
    "/admin",
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
          .catch(function (err) {});
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
          .concat([
            "/health",
            "/favicon.ico",
            "/_next",
            "/static",
            "/public",
            "/admin",
          ])
          .some(function (p) {
            return path.startsWith(p);
          });

        const isApiPath = path.startsWith(options.apiPrefix || "/api");

        if (!shouldIgnore && isApiPath) {
          const normalizedPath = normalizePath(path);
          const endpointKey = method + ":" + normalizedPath;

          if (!reportedEndpoints.has(endpointKey)) {
            reportedEndpoints.add(endpointKey);

            // Skip file uploads — too large and not JSON
            const contentType = req.headers["content-type"] || "";
            if (contentType.includes("multipart/form-data")) {
              client
                .updateEndpoint({
                  method: method,
                  path: normalizedPath,
                  requestBody: null,
                  detectedBy: "runtime",
                })
                .catch(function () {});
              return originalEmit.apply(this, arguments);
            }

            // Helper to send body structure to platform
            function reportBody(bodyObj) {
              try {
                let parsedBody = null;
                const structure = buildBodyStructure(bodyObj);
                if (structure) {
                  parsedBody = {
                    type: "object",
                    properties: Object.fromEntries(
                      Object.entries(structure).map(([key, type]) => [
                        key,
                        {
                          type:
                            type === "null" || type === "[redacted]"
                              ? "string"
                              : type,
                        },
                      ]),
                    ),
                  };
                }
                client
                  .updateEndpoint({
                    method: method,
                    path: normalizedPath,
                    requestBody: parsedBody,
                    detectedBy: "runtime",
                  })
                  .catch(function () {});
              } catch (e) {}
            }

            // APP ROUTER — req.body is a Web Stream, read it early
            // and put it back as a new stream so App Router can still read it
            if (
              typeof req.body !== "undefined" &&
              req.body &&
              typeof req.body.getReader === "function"
            ) {
              try {
                const reader = req.body.getReader();
                const chunks = [];
                function readChunk() {
                  reader
                    .read()
                    .then(function (result) {
                      if (result.done) {
                        const fullBuffer = Buffer.concat(
                          chunks.map(function (c) {
                            return Buffer.from(c);
                          }),
                        );
                        // Put the body back as a new ReadableStream
                        const { ReadableStream } = require("stream/web");
                        req.body = new ReadableStream({
                          start: function (controller) {
                            controller.enqueue(fullBuffer);
                            controller.close();
                          },
                        });
                        // Parse and report
                        try {
                          const parsed = JSON.parse(fullBuffer.toString());
                          reportBody(parsed);
                        } catch (e) {}
                      } else {
                        chunks.push(result.value);
                        readChunk();
                      }
                    })
                    .catch(function () {});
                }
                readChunk();
              } catch (e) {}
              return originalEmit.apply(this, arguments);
            }

            // PAGES ROUTER — req.body is populated by Next.js after parsing
            // We intercept res.end because by then req.body is fully available
            const originalResEnd = res.end.bind(res);
            res.end = function (chunk, encoding, callback) {
              reportBody(req.body || null);
              return originalResEnd(chunk, encoding, callback);
            };
          }
        }
      }

      return originalEmit.apply(this, arguments);
    };
  } catch (err) {}
}

module.exports = {
  attachInterceptor,
  attachNextJsInterceptor,
  normalizePath,
  buildBodyStructure,
};
