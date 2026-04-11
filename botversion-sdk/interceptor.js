// botversion-sdk/interceptor.js
"use strict";

/**
 * Attaches a middleware to the Express app that
 * silently intercepts every request and reports
 * new endpoints to BotVersion platform
 */
function attachInterceptor(app, client, options) {
  options = options || {};
  var getUserContext = options.getUserContext || null;

  // Paths to always ignore
  const ignorePaths = [
    "/health",
    "/favicon.ico",
    "/_next",
    "/static",
    "/public",
  ].concat(options.exclude || []);

  // Track which endpoints we have already reported
  // so we don't spam the platform on every request
  const reportedEndpoints = new Set();

  app.use(function botVersionInterceptor(req, res, next) {
    // Skip ignored paths
    const path = req.path || req.url || "";
    const shouldIgnore = ignorePaths.some(function (p) {
      return path.startsWith(p);
    });

    if (shouldIgnore) {
      return next();
    }

    // Skip non-API paths if configured
    if (options.apiPrefix && !path.startsWith(options.apiPrefix)) {
      return next();
    }

    const method = req.method.toUpperCase();

    // Normalize path — replace IDs with :param
    const normalizedPath = normalizePath(path);
    const endpointKey = method + ":" + normalizedPath;

    // Only report if we haven't seen this endpoint before
    const bodyStructure = buildBodyStructure(req.body);
    console.log("[DEBUG] endpoint:", endpointKey);
    console.log("[DEBUG] bodyStructure:", JSON.stringify(bodyStructure));
    const bodyKey =
      endpointKey +
      ":" +
      Object.keys(bodyStructure || {})
        .sort()
        .join(",");

    if (!reportedEndpoints.has(bodyKey)) {
      reportedEndpoints.add(bodyKey);

      // Convert to JSON Schema format so Gemini can read field names
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
      console.log("[DEBUG] jsonSchema:", JSON.stringify(jsonSchema));

      // Report async — don't block the request
      setImmediate(function () {
        client
          .updateEndpoint({
            method: method,
            path: normalizedPath,
            requestBody: jsonSchema,
            detectedBy: "runtime",
          })
          .catch(function (err) {
            // Silent fail — never crash customer's app
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
  // Attached to app so SaaS owner can call it in their agent route
  app.executeAgentCall = function (req, call) {
    var userContext = getUserContext
      ? getUserContext(req)
      : extractDefaultContext(req);

    return client
      .agentChat({
        message: req.body.message,
        conversationHistory: req.body.conversationHistory || [],
        pageContext: req.body.pageContext || {},
        userContext: userContext,
      })
      .then(function (response) {
        // Handle plain chat/greeting responses from ai-response.js
        if (response.answer) {
          return { action: "RESPOND", message: response.answer };
        }

        // Handle agent action
        if (response.action !== "EXECUTE_CALL") return response;

        return makeLocalCall(req, response.call).then(function (result) {
          return client
            .agentToolResult(
              response.sessionToken,
              result,
              response.sessionData,
            )
            .then(function (toolResponse) {
              if (toolResponse.action === "EXECUTE_CALL") {
                return makeLocalCall(req, toolResponse.call).then(
                  function (result2) {
                    return client.agentToolResult(
                      toolResponse.sessionToken,
                      result2,
                      toolResponse.sessionData,
                    );
                  },
                );
              }
              return toolResponse;
            });
        });
      });
  };
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

      // cuid pattern (your system uses these)
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
    // Never store sensitive values
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

// Default userContext extraction — reads common patterns
// SaaS owner can override this with getUserContext option
function extractDefaultContext(req) {
  var user = req.user || (req.session && req.session.user) || {};
  return {
    userId: user.id || user.userId || user._id || null,
    email: user.email || null,
    role: user.role || user.userRole || null,
    name: user.name || user.username || null,
  };
}

// Makes the HTTP call locally on the SaaS owner's server
// forwarding the user's real auth headers
function makeLocalCall(req, call) {
  return new Promise(function (resolve) {
    var http = require("http");
    var https = require("https");

    var body = call.body ? JSON.stringify(call.body) : null;
    var isHttps = req.protocol === "https" || req.secure;
    var lib = isHttps ? https : http;

    var options = {
      hostname: "127.0.0.1",
      port: process.env.PORT || 3000,
      path: call.path,
      method: call.method,
      headers: {
        "Content-Type": "application/json",
        // Forward the user's real auth token — this is the key part
        Authorization: req.headers["authorization"] || "",
        Cookie: req.headers["cookie"] || "",
      },
    };

    if (body) options.headers["Content-Length"] = Buffer.byteLength(body);

    var apiReq = lib.request(options, function (apiRes) {
      var data = "";
      apiRes.on("data", function (chunk) {
        data += chunk;
      });
      apiRes.on("end", function () {
        try {
          resolve({ status: apiRes.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: apiRes.statusCode, data: { raw: data } });
        }
      });
    });

    apiReq.on("error", function (err) {
      resolve({ status: 500, error: err.message });
    });

    if (body) apiReq.write(body);
    apiReq.end();
  });
}
