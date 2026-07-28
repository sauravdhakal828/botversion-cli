// botversion-sdk/interceptor.js
"use strict";

const reportedEndpoints = new Set();

function structureToJsonSchema(bodyStructure) {
  if (!bodyStructure) return null;
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(bodyStructure).map(function ([key, typeOrObj]) {
        if (typeOrObj && typeof typeOrObj === "object" && typeOrObj.type) {
          return [key, typeOrObj];
        }
        return [
          key,
          {
            type:
              typeOrObj === "null" || typeOrObj === "[redacted]"
                ? "string"
                : typeOrObj,
          },
        ];
      }),
    ),
  };
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
    "/admin",
  ].concat(options.exclude || []);

  app.use(function botVersionInterceptor(req, res, next) {
    const path = req.path || req.url || "";

    // ── Scan trigger from BotVersion dashboard ───────────────────────────
    if (path === "/__botversion/scan" && req.method === "POST") {
      const providedKey = req.headers["x-botversion-scan-key"] || "";
      if (
        options.scanSecret &&
        providedKey === options.scanSecret &&
        typeof options.onScanRequested === "function"
      ) {
        Promise.resolve(options.onScanRequested())
          .then(function (result) {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ success: true, result: result || null }));
          })
          .catch(function (err) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                success: false,
                error: String((err && err.message) || err),
              }),
            );
          });
      } else {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: false, error: "Unauthorized" }));
      }
      return;
    }

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

      const jsonSchema = structureToJsonSchema(bodyStructure);

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
 * Unwraps a single (non-batched) tRPC/superjson envelope.
 * tRPC sends single calls as { json: {...realFields...} }
 * or with superjson as { json: {...realFields...}, meta: {...} }
 */
function unwrapTrpcJsonEnvelope(obj) {
  if (
    obj &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    obj.json &&
    typeof obj.json === "object" &&
    !Array.isArray(obj.json)
  ) {
    return obj.json;
  }
  return obj;
}

/**
 * Extract just the structure of a request body
 * (keys and value types — never actual values for security)
 */
function buildBodyStructure(body) {
  if (!body || typeof body !== "object") return null;

  // Unwrap tRPC envelope
  // Case A: single tRPC call — { json: { ...realFields... } } (optionally with a "meta" sibling)
  // Case B: batched tRPC call — { "0": { json: {...} }, "1": { json: {...} } } or { "0": {...realFields...} }
  // We detect whichever shape is present and flatten it to the real fields before processing
  let keys = Object.keys(body);

  const isTrpcEnvelope =
    keys.length > 0 &&
    keys.every(function (k) {
      return (
        /^\d+$/.test(k) &&
        body[k] !== null &&
        typeof body[k] === "object" &&
        !Array.isArray(body[k])
      );
    });

  if (isTrpcEnvelope) {
    const unwrapped = {};
    keys.forEach(function (k) {
      // Each batched entry may itself be a { json: {...} } envelope
      Object.assign(unwrapped, unwrapTrpcJsonEnvelope(body[k]));
    });
    body = unwrapped;
  } else {
    // Not a numeric batch — check for the single { json: {...} } shape
    body = unwrapTrpcJsonEnvelope(body);
  }

  keys = Object.keys(body);

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
    } else if (typeof val === "object") {
      const nestedProps = {};
      Object.keys(val).forEach(function (nk) {
        nestedProps[nk] = {
          type: val[nk] === null ? "string" : typeof val[nk],
        };
      });
      structure[key] =
        Object.keys(nestedProps).length > 0
          ? { type: "object", properties: nestedProps }
          : "object";
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

        // ── Scan trigger from BotVersion dashboard ───────────────────────
        if (path === "/__botversion/scan" && method === "POST") {
          const providedKey = req.headers["x-botversion-scan-key"] || "";
          if (
            options.scanSecret &&
            providedKey === options.scanSecret &&
            typeof options.onScanRequested === "function"
          ) {
            Promise.resolve(options.onScanRequested())
              .then(function (result) {
                res.statusCode = 200;
                res.setHeader("Content-Type", "application/json");
                res.end(
                  JSON.stringify({ success: true, result: result || null }),
                );
              })
              .catch(function (err) {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
                res.end(
                  JSON.stringify({
                    success: false,
                    error: String((err && err.message) || err),
                  }),
                );
              });
          } else {
            res.statusCode = 401;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ success: false, error: "Unauthorized" }));
          }
          return; // handled directly — don't pass through to the app
        }

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
                // ── tRPC GET input extraction ──────────────────────────────────────
                // tRPC GET requests send their input as a URL-encoded JSON query
                // parameter called "input". The body is always empty for GET requests.
                // We only attempt this extraction when:
                //   1. The body is empty (GET requests have no body)
                //   2. The URL contains an "input" query parameter
                //   3. The path looks like a tRPC endpoint (/trpc/)
                // This prevents accidentally treating regular REST query params
                // (e.g. ?filter=active&limit=10) as a body schema.
                const isTrpcPath = path.includes("/trpc/");
                const hasInputParam = req.url && req.url.includes("input=");

                if (
                  isTrpcPath &&
                  hasInputParam &&
                  (!bodyObj || Object.keys(bodyObj).length === 0)
                ) {
                  try {
                    // Use URL constructor to safely parse query params
                    const urlObj = new URL(req.url, "http://localhost");
                    const inputParam = urlObj.searchParams.get("input");

                    if (inputParam) {
                      let decoded;
                      try {
                        decoded = JSON.parse(decodeURIComponent(inputParam));
                      } catch (e) {
                        // input param exists but is not valid JSON — skip
                        decoded = null;
                      }

                      if (
                        decoded &&
                        typeof decoded === "object" &&
                        !Array.isArray(decoded)
                      ) {
                        const keys = Object.keys(decoded);

                        // Format 1 — batched: { "0": { json: {...} }, "1": { json: {...} } }
                        // All keys are numeric strings
                        const isBatch =
                          keys.length > 0 && keys.every((k) => /^\d+$/.test(k));

                        if (isBatch) {
                          // Merge all batch entries into one flat object
                          // so we capture the full schema across all procedures
                          const merged = {};
                          keys.forEach((k) => {
                            const entry = decoded[k];
                            if (entry && typeof entry === "object") {
                              // Unwrap { json: {...} } envelope if present
                              const unwrapped =
                                entry.json && typeof entry.json === "object"
                                  ? entry.json
                                  : entry;
                              Object.assign(merged, unwrapped);
                            }
                          });
                          if (Object.keys(merged).length > 0) {
                            bodyObj = merged;
                          }
                        }
                        // Format 2 — single with superjson: { json: {...}, meta: {...} }
                        else if (
                          decoded.json &&
                          typeof decoded.json === "object"
                        ) {
                          bodyObj = decoded.json;
                        }
                        // Format 3 — already unwrapped: { group: {...}, limit: 10 }
                        // Only use this if it doesn't look like a tRPC envelope
                        else if (!decoded.meta && !decoded.json) {
                          bodyObj = decoded;
                        }
                      }
                    }
                  } catch (e) {
                    // URL parsing failed — fall through to normal body handling
                  }
                }

                // ── Normal body processing (unchanged) ────────────────────────────
                const parsedBody = structureToJsonSchema(
                  buildBodyStructure(bodyObj),
                );
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

/**
 * Attaches a Fastify hook that silently intercepts every request
 * and reports new endpoints to BotVersion platform.
 */
function attachFastifyInterceptor(fastify, client, options) {
  options = options || {};

  const ignorePaths = [
    "/health",
    "/favicon.ico",
    "/_next",
    "/static",
    "/public",
    "/admin",
  ].concat(options.exclude || []);

  fastify.addHook("onRequest", async function (request, reply) {
    const path = request.url ? request.url.split("?")[0] : "";
    const method = request.method ? request.method.toUpperCase() : "";

    // ── Scan trigger from BotVersion dashboard ───────────────────────────
    if (path === "/__botversion/scan" && method === "POST") {
      const providedKey = request.headers["x-botversion-scan-key"] || "";
      if (
        options.scanSecret &&
        providedKey === options.scanSecret &&
        typeof options.onScanRequested === "function"
      ) {
        try {
          const result = await options.onScanRequested();
          reply.code(200).send({ success: true, result: result || null });
        } catch (err) {
          reply.code(500).send({
            success: false,
            error: String((err && err.message) || err),
          });
        }
      } else {
        reply.code(401).send({ success: false, error: "Unauthorized" });
      }
      return reply;
    }

    const shouldIgnore = ignorePaths.some(function (p) {
      return path.startsWith(p);
    });

    if (shouldIgnore) return;

    if (options.apiPrefix && !path.startsWith(options.apiPrefix)) return;

    const normalizedPath = normalizePath(path);
    const endpointKey = method + ":" + normalizedPath;

    if (!reportedEndpoints.has(endpointKey)) {
      reportedEndpoints.add(endpointKey);

      setImmediate(function () {
        client
          .updateEndpoint({
            method,
            path: normalizedPath,
            requestBody: null,
            detectedBy: "runtime-fastify",
          })
          .catch(function () {});
      });
    }
  });

  // Use onSend hook to capture body after parsing
  fastify.addHook("preHandler", async function (request, reply) {
    const path = request.url ? request.url.split("?")[0] : "";
    const method = request.method ? request.method.toUpperCase() : "";
    const normalizedPath = normalizePath(path);
    const bodyKey = method + ":" + normalizedPath + ":body";

    if (reportedEndpoints.has(bodyKey)) return;
    reportedEndpoints.add(bodyKey);

    const body = request.body;
    if (!body) return;

    const bodyStructure = buildBodyStructure(body);
    if (!bodyStructure) return;

    const jsonSchema = structureToJsonSchema(bodyStructure);

    setImmediate(function () {
      client
        .updateEndpoint({
          method,
          path: normalizedPath,
          requestBody: jsonSchema,
          detectedBy: "runtime-fastify",
        })
        .catch(function () {});
    });
  });
}

/**
 * Attaches a Koa middleware that silently intercepts every request
 * and reports new endpoints to BotVersion platform.
 */
function attachKoaInterceptor(app, client, options) {
  options = options || {};

  const ignorePaths = [
    "/health",
    "/favicon.ico",
    "/_next",
    "/static",
    "/public",
    "/admin",
  ].concat(options.exclude || []);

  // IMPORTANT: This interceptor must be added AFTER koa-bodyparser middleware
  // so that ctx.request.body is already populated when we read it.
  app.use(async function botVersionKoaInterceptor(ctx, next) {
    const path = ctx.path || "";
    const method = ctx.method ? ctx.method.toUpperCase() : "";

    // ── Scan trigger from BotVersion dashboard ───────────────────────────
    if (path === "/__botversion/scan" && method === "POST") {
      const providedKey = ctx.headers["x-botversion-scan-key"] || "";
      if (
        options.scanSecret &&
        providedKey === options.scanSecret &&
        typeof options.onScanRequested === "function"
      ) {
        try {
          const result = await options.onScanRequested();
          ctx.status = 200;
          ctx.body = { success: true, result: result || null };
        } catch (err) {
          ctx.status = 500;
          ctx.body = {
            success: false,
            error: String((err && err.message) || err),
          };
        }
      } else {
        ctx.status = 401;
        ctx.body = { success: false, error: "Unauthorized" };
      }
      return; // handled directly — don't call next()
    }

    await next();

    const shouldIgnore = ignorePaths.some(function (p) {
      return path.startsWith(p);
    });

    if (shouldIgnore) return;

    if (options.apiPrefix && !path.startsWith(options.apiPrefix)) return;

    const normalizedPath = normalizePath(path);
    const endpointKey = method + ":" + normalizedPath;

    const body = ctx.request.body;
    const bodyStructure = buildBodyStructure(body);
    const bodyKey =
      endpointKey +
      ":" +
      Object.keys(bodyStructure || {})
        .sort()
        .join(",");

    if (!reportedEndpoints.has(bodyKey)) {
      reportedEndpoints.add(bodyKey);

      const jsonSchema = structureToJsonSchema(bodyStructure);

      setImmediate(function () {
        client
          .updateEndpoint({
            method,
            path: normalizedPath,
            requestBody: jsonSchema,
            detectedBy: "runtime-koa",
          })
          .catch(function () {});
      });
    }
  });
}

/**
 * Attaches a Hapi lifecycle extension that silently intercepts every request
 * and reports new endpoints to BotVersion platform.
 */
function attachHapiInterceptor(server, client, options) {
  options = options || {};

  const ignorePaths = [
    "/health",
    "/favicon.ico",
    "/_next",
    "/static",
    "/public",
    "/admin",
  ].concat(options.exclude || []);

  server.ext("onPostAuth", function (request, h) {
    const path = request.path || "";
    const method = request.method ? request.method.toUpperCase() : "";

    // ── Scan trigger from BotVersion dashboard ───────────────────────────
    if (path === "/__botversion/scan" && method === "POST") {
      const providedKey =
        (request.headers && request.headers["x-botversion-scan-key"]) || "";
      if (
        options.scanSecret &&
        providedKey === options.scanSecret &&
        typeof options.onScanRequested === "function"
      ) {
        return Promise.resolve(options.onScanRequested())
          .then(function (result) {
            return h
              .response({ success: true, result: result || null })
              .code(200)
              .takeover();
          })
          .catch(function (err) {
            return h
              .response({
                success: false,
                error: String((err && err.message) || err),
              })
              .code(500)
              .takeover();
          });
      }
      return h
        .response({ success: false, error: "Unauthorized" })
        .code(401)
        .takeover();
    }

    const shouldIgnore = ignorePaths.some(function (p) {
      return path.startsWith(p);
    });

    if (shouldIgnore) return h.continue;

    if (options.apiPrefix && !path.startsWith(options.apiPrefix))
      return h.continue;

    const normalizedPath = normalizePath(path);
    const endpointKey = method + ":" + normalizedPath;

    const body = request.payload;
    const bodyStructure = buildBodyStructure(body);
    const bodyKey =
      endpointKey +
      ":" +
      Object.keys(bodyStructure || {})
        .sort()
        .join(",");

    if (!reportedEndpoints.has(bodyKey)) {
      reportedEndpoints.add(bodyKey);

      const jsonSchema = structureToJsonSchema(bodyStructure);

      setImmediate(function () {
        client
          .updateEndpoint({
            method,
            path: normalizedPath,
            requestBody: jsonSchema,
            detectedBy: "runtime-hapi",
          })
          .catch(function () {});
      });
    }

    return h.continue;
  });
}

/**
 * Attaches a NestJS interceptor by patching the underlying http server.
 * NestJS runs on top of Express or Fastify under the hood so we can
 * patch the Node http server the same way we do for Next.js.
 */
function attachNestJsInterceptor(client, options) {
  // NestJS runs on Node http server under the hood
  // So we reuse the same approach as Next.js
  attachNextJsInterceptor(client, {
    exclude: (options || {}).exclude || [],
    apiPrefix: (options || {}).apiPrefix || "/",
    debug: (options || {}).debug || false,
    scanSecret: (options || {}).scanSecret,
    onScanRequested: (options || {}).onScanRequested,
  });
}

/**
 * SvelteKit, Nuxt and Remix all run on Node http server
 * so we reuse the Next.js interceptor approach for all of them.
 */
function attachSvelteKitInterceptor(client, options) {
  attachNextJsInterceptor(client, {
    exclude: (options || {}).exclude || [],
    apiPrefix: (options || {}).apiPrefix || "/",
    debug: (options || {}).debug || false,
    scanSecret: (options || {}).scanSecret,
    onScanRequested: (options || {}).onScanRequested,
  });
}

function attachNuxtInterceptor(client, options) {
  attachNextJsInterceptor(client, {
    exclude: (options || {}).exclude || [],
    apiPrefix: (options || {}).apiPrefix || "/api",
    debug: (options || {}).debug || false,
    scanSecret: (options || {}).scanSecret,
    onScanRequested: (options || {}).onScanRequested,
  });
}

function attachRemixInterceptor(client, options) {
  attachNextJsInterceptor(client, {
    exclude: (options || {}).exclude || [],
    apiPrefix: (options || {}).apiPrefix || "/",
    debug: (options || {}).debug || false,
    scanSecret: (options || {}).scanSecret,
    onScanRequested: (options || {}).onScanRequested,
  });
}

function attachAdonisInterceptor(client, options) {
  attachNextJsInterceptor(client, {
    exclude: (options || {}).exclude || [],
    apiPrefix: (options || {}).apiPrefix || "/",
    debug: (options || {}).debug || false,
    scanSecret: (options || {}).scanSecret,
    onScanRequested: (options || {}).onScanRequested,
  });
}

module.exports = {
  attachInterceptor,
  attachNextJsInterceptor,
  attachFastifyInterceptor,
  attachKoaInterceptor,
  attachHapiInterceptor,
  attachNestJsInterceptor,
  attachSvelteKitInterceptor,
  attachNuxtInterceptor,
  attachRemixInterceptor,
  attachAdonisInterceptor,
  normalizePath,
  buildBodyStructure,
};
