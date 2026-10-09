// botversion-sdk/interceptor.js
"use strict";

const reportedEndpoints = new Set();

// ── Query-string capture (GET / DELETE) ──────────────────────────────────
// Records only the NAMES of query keys, never their values.
const seenQueryVariants = new Set();
const queryVariantCounts = {};
const MAX_QUERY_VARIANTS = 5; // different key sets remembered per endpoint
const MAX_QUERY_KEYS = 20;
const QUERY_NOISE_KEYS = new Set([
  "t",
  "ts",
  "timestamp",
  "cb",
  "cachebust",
  "nocache",
]);

function buildQueryStructure(method, rawUrl, rawPath) {
  if (method !== "GET" && method !== "DELETE") return null;
  if (String(rawPath || "").indexOf("/trpc/") !== -1) return null; // tRPC has its own input handling
  const url = String(rawUrl || "");
  const q = url.indexOf("?");
  if (q === -1) return null;
  let params;
  try {
    params = new URLSearchParams(url.slice(q + 1).split("#")[0]);
  } catch (e) {
    return null;
  }
  const structure = {};
  let count = 0;
  params.forEach(function (_value, rawKey) {
    if (count >= MAX_QUERY_KEYS) return;
    const key = rawKey.replace(/\[\]$/, "");
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) return;
    if (QUERY_NOISE_KEYS.has(key.toLowerCase()) || looksLikeIdKey(key)) return;
    if (Object.prototype.hasOwnProperty.call(structure, key)) return;
    structure[key] = "string";
    count++;
  });
  return count > 0 ? structure : null;
}

// Returns the query key names for this call, or null (also once an endpoint has too many variants)
function resolveQueryStructure(baseKey, method, rawUrl, rawPath) {
  const structure = buildQueryStructure(method, rawUrl, rawPath);
  if (!structure) return null;
  const variant = baseKey + queryKeySuffix(structure);
  if (seenQueryVariants.has(variant)) return structure;
  const used = queryVariantCounts[baseKey] || 0;
  if (used >= MAX_QUERY_VARIANTS) {
    return null;
  }
  queryVariantCounts[baseKey] = used + 1;
  seenQueryVariants.add(variant);
  return structure;
}

function queryKeySuffix(structure) {
  return structure ? ":q:" + Object.keys(structure).sort().join(",") : "";
}

function mergeQueryIntoStructure(bodyStructure, queryStructure) {
  if (!queryStructure) return bodyStructure;
  return Object.assign({}, queryStructure, bodyStructure || {});
}

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

// ── Response shape capture ───────────────────────────────────────────────
// Records only field names and types of successful JSON replies (never values)
// so the platform knows what each endpoint returns.
const reportedResponses = new Set();
// Stops watching an endpoint after a few replies that yielded no usable shape
const responseAttempts = {};
const MAX_RESPONSE_ATTEMPTS = 5;
const MAX_RESPONSE_CAPTURE_BYTES = 256 * 1024; // stop buffering bigger replies
const MAX_RESPONSE_DEPTH = 4;
const MAX_RESPONSE_FIELDS = 50;

// Keys that look like record IDs or emails are never sent as field names
// (guards against objects keyed by IDs leaking them as "fields").
function looksLikeIdKey(key) {
  return (
    /^\d+$/.test(key) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      key,
    ) ||
    /^[0-9a-f]{24}$/i.test(key) ||
    /^c[a-z0-9]{20,}$/i.test(key) ||
    (key.length >= 16 && /[a-zA-Z]/.test(key) && /[0-9]/.test(key)) ||
    key.includes("@")
  );
}

function describeResponseValue(val, depth) {
  if (val === null || val === undefined) return { type: "string" };
  if (Array.isArray(val)) {
    if (depth >= MAX_RESPONSE_DEPTH || val.length === 0) {
      return { type: "array", items: { type: "object" } };
    }
    return {
      type: "array",
      items: describeArrayItems(val.slice(0, 5), depth + 1),
    };
  }
  if (typeof val === "object") {
    const keys = Object.keys(val);
    if (depth >= MAX_RESPONSE_DEPTH || keys.some(looksLikeIdKey)) {
      return { type: "object" };
    }
    const properties = {};
    keys.slice(0, MAX_RESPONSE_FIELDS).forEach(function (k) {
      properties[k] = describeResponseValue(val[k], depth + 1);
    });
    return { type: "object", properties: properties };
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return { type: typeof val };
  }
  return { type: "string" };
}

// Combines the first few list items so fields missing from one item still appear
function describeArrayItems(items, depth) {
  const objs = items.filter(function (i) {
    return i && typeof i === "object" && !Array.isArray(i);
  });
  if (objs.length === 0) {
    const first = items.find(function (i) {
      return i !== null && i !== undefined;
    });
    return first === undefined
      ? { type: "object" }
      : describeResponseValue(first, depth);
  }
  const merged = {};
  objs.forEach(function (o) {
    Object.keys(o)
      .slice(0, MAX_RESPONSE_FIELDS)
      .forEach(function (k) {
        if (merged[k] === undefined || merged[k] === null) merged[k] = o[k];
      });
  });
  return describeResponseValue(merged, depth);
}

// A shape with no fields (empty list, {}) is not useful — keep waiting for a better reply
function hasResponseFields(schema) {
  if (!schema) return false;
  if (schema.type === "array") return hasResponseFields(schema.items);
  return !!(schema.properties && Object.keys(schema.properties).length > 0);
}

// tRPC wraps each result as { result: { data: { json: ... } } }; errors as { error }
function unwrapTrpcResult(entry) {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    if (entry.error && !entry.result) return undefined;
    if (
      entry.result &&
      typeof entry.result === "object" &&
      "data" in entry.result
    ) {
      const data = entry.result.data;
      return data &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        "json" in data
        ? data.json
        : data;
    }
  }
  return entry;
}

// Parses the captured reply; also handles replies compressed by the host app
function parseCapturedBody(buffer, res) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (e) {}
  try {
    const zlib = require("zlib");
    const enc = String(res.getHeader("content-encoding") || "").toLowerCase();
    const opts = { maxOutputLength: 1024 * 1024 };
    let raw = null;
    if (enc.includes("gzip")) raw = zlib.gunzipSync(buffer, opts);
    else if (enc.includes("br")) raw = zlib.brotliDecompressSync(buffer, opts);
    else if (enc.includes("deflate")) raw = zlib.inflateSync(buffer, opts);
    if (raw) return JSON.parse(raw.toString("utf8"));
  } catch (e) {}
  return undefined;
}

// Our own scan-trigger route must never be reported as one of the host's endpoints
function isBotVersionInternalPath(path) {
  return String(path || "").indexOf("/__botversion/") === 0;
}

// True while at least one endpoint behind this path still has no captured reply shape
function isResponseShapeNeeded(method, rawPath) {
  if (isBotVersionInternalPath(rawPath)) return false;
  return splitBatchPath(rawPath)
    .map(normalizePath)
    .some(function (p) {
      const k = method + ":" + p;
      return (
        !reportedResponses.has(k) &&
        (responseAttempts[k] || 0) < MAX_RESPONSE_ATTEMPTS
      );
    });
}

// Turns an already-parsed reply into field-name shapes and reports each new one
function reportResponseShape(client, method, rawPath, parsed) {
  try {
    if (!parsed || typeof parsed !== "object") return;

    const isTrpc = rawPath.includes("/trpc/");
    const paths = splitBatchPath(rawPath).map(normalizePath);

    let slots;
    if (paths.length > 1) {
      if (!isTrpc || !Array.isArray(parsed) || parsed.length !== paths.length)
        return;
      slots = parsed.map(unwrapTrpcResult);
    } else {
      slots = [isTrpc ? unwrapTrpcResult(parsed) : parsed];
    }

    paths.forEach(function (p, i) {
      const key = method + ":" + p;
      if (reportedResponses.has(key)) return;
      const slot = slots[i];
      if (!slot || typeof slot !== "object") return;

      const schema = describeResponseValue(slot, 0);
      if (!hasResponseFields(schema)) return;

      reportedResponses.add(key);
      client
        .updateEndpoint({
          method: method,
          path: p,
          requestBody: null,
          responseBody: schema,
          detectedBy: "runtime",
        })
        .catch(function () {});
    });
  } catch (e) {}
}

// For frameworks that expose the reply body before sending it (Koa, Hapi)
function reportFrameworkBody(
  client,
  method,
  rawPath,
  statusCode,
  contentType,
  body,
) {
  // Deferred so it is always sent after the endpoint's first registration
  setImmediate(function () {
    reportFrameworkBodyNow(
      client,
      method,
      rawPath,
      statusCode,
      contentType,
      body,
    );
  });
}

function reportFrameworkBodyNow(
  client,
  method,
  rawPath,
  statusCode,
  contentType,
  body,
) {
  try {
    if (statusCode < 200 || statusCode >= 300) return;
    if (!isResponseShapeNeeded(method, rawPath)) return;

    let text;
    if (typeof body === "string" || Buffer.isBuffer(body)) {
      const ct = String(contentType || "").toLowerCase();
      if (ct && !ct.includes("json")) return;
      text = Buffer.isBuffer(body) ? body.toString("utf8") : body;
    } else if (
      body &&
      typeof body === "object" &&
      typeof body.pipe !== "function"
    ) {
      // Round-trip so we see exactly what is sent (handles toJSON, dates, class instances)
      text = JSON.stringify(body);
    } else {
      return; // streams and empty replies cannot be read
    }

    if (!text || text.length > MAX_RESPONSE_CAPTURE_BYTES) return;
    reportResponseShape(client, method, rawPath, JSON.parse(text));
  } catch (e) {}
}

// Watches one Node reply (Express and the plain http server) and, if it is a
// successful JSON reply, reports its shape. Never changes the reply and never
// throws into the host app.
function watchJsonResponse(res, client, method, rawPath, req) {
  try {
    if (
      !res ||
      typeof res.write !== "function" ||
      typeof res.once !== "function"
    )
      return;
    if (!isResponseShapeNeeded(method, rawPath)) return; // no overhead once captured

    const chunks = [];
    let size = 0;
    let skip = false;

    // Drops cache-validation headers so the app sends a full reply instead of an empty 304
    // (which has no body to read). Only runs while this endpoint still has no captured shape.
    try {
      if (req && req.headers) {
        delete req.headers["if-none-match"];
        delete req.headers["if-modified-since"];
      }
    } catch (e) {}

    function collect(chunk, encoding) {
      if (
        skip ||
        chunk === undefined ||
        chunk === null ||
        typeof chunk === "function"
      )
        return;
      try {
        if (chunks.length === 0) {
          const ct = String(res.getHeader("content-type") || "").toLowerCase();
          if (ct && !ct.includes("json")) {
            skip = true;
            return;
          }
        }
        const buf =
          typeof chunk === "string"
            ? Buffer.from(
                chunk,
                typeof encoding === "string" ? encoding : "utf8",
              )
            : Buffer.from(chunk);
        size += buf.length;
        if (size > MAX_RESPONSE_CAPTURE_BYTES) {
          skip = true;
          chunks.length = 0;
          return;
        }
        chunks.push(buf);
      } catch (e) {
        skip = true;
      }
    }

    const originalWrite = res.write;
    const originalEnd = res.end;
    res.write = function (chunk, encoding) {
      collect(chunk, encoding);
      return originalWrite.apply(this, arguments);
    };
    res.end = function (chunk, encoding) {
      collect(chunk, encoding);
      return originalEnd.apply(this, arguments);
    };

    res.once("finish", function () {
      if (res.statusCode < 200 || res.statusCode >= 300) return;

      // Counts each successful reply so endpoints with no usable shape are eventually dropped
      splitBatchPath(rawPath)
        .map(normalizePath)
        .forEach(function (p) {
          const k = method + ":" + p;
          responseAttempts[k] = (responseAttempts[k] || 0) + 1;
        });

      if (skip || chunks.length === 0) return;

      setImmediate(function () {
        try {
          const parsed = parseCapturedBody(Buffer.concat(chunks), res);
          reportResponseShape(client, method, rawPath, parsed);
        } catch (e) {}
      });
    });
  } catch (e) {}
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

    // Split batched tRPC paths into separate clean paths + matching body
    // slots, so each real procedure is registered as its own endpoint.
    const rawPaths = splitBatchPath(path);
    const bodySlots =
      rawPaths.length > 1 ? splitBatchBody(req.body) : [req.body];

    rawPaths.forEach(function (singlePath, i) {
      const normalizedPath = normalizePath(singlePath);
      const endpointKey = method + ":" + normalizedPath;
      const slotBody = bodySlots[i] || null;

      // GET/DELETE inputs live in the query string, so their names are added too
      const bodyStructure = mergeQueryIntoStructure(
        buildBodyStructure(slotBody),
        resolveQueryStructure(
          endpointKey,
          method,
          req.originalUrl || req.url || "",
          singlePath,
        ),
      );
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
              method: method,
              path: normalizedPath,
              requestBody: jsonSchema,
              detectedBy: "runtime",
            })
            .catch(function (err) {});
        });
      }
    });

    // Capture the shape of the successful JSON reply (field names only)
    watchJsonResponse(res, client, method, path, req);

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
 * tRPC batches multiple procedure calls into one URL, e.g.
 *   /api/trpc/me.get,getUserTopBanners,bookingUnconfirmedCount
 * The procedure names appear comma-separated, only in the LAST path segment.
 * This splits that into separate, clean paths — one per real procedure —
 * so each gets registered as its own endpoint instead of one garbled,
 * comma-joined path. Non-batched paths are returned unchanged as a
 * single-item array.
 */
function splitBatchPath(rawPath) {
  // tRPC is always mounted at a fixed base containing "/trpc/" — e.g.
  // "/api/trpc/". Everything after that marker is the comma-separated
  // procedure list, and each comma-separated piece is ALREADY a complete
  // procedure path in its own right (it may contain further "/" for
  // nested routers, e.g. "me/get") — it must never have another
  // procedure's prefix re-attached to it.
  const trpcMarker = "/trpc/";
  const markerIndex = rawPath.indexOf(trpcMarker);
  if (markerIndex === -1) return [rawPath];

  const base = rawPath.slice(0, markerIndex + trpcMarker.length);
  const tail = rawPath.slice(markerIndex + trpcMarker.length);

  if (!tail.includes(",")) return [rawPath];

  return tail
    .split(",")
    .map(function (proc) {
      return proc.trim();
    })
    .filter(Boolean)
    .map(function (proc) {
      return base + proc;
    });
}

/**
 * Splits a batched tRPC request body/input — { "0": {...}, "1": {...} } —
 * into an array of individual bodies, in the same order as the batch keys,
 * which lines up with the same order splitBatchPath() returns procedure
 * names in. Each slot is unwrapped from its own { json: {...} } envelope.
 * Returns a single-item array unchanged if the body isn't actually batched,
 * so callers can always treat the result uniformly.
 */
function splitBatchBody(bodyObj) {
  if (!bodyObj || typeof bodyObj !== "object") return [bodyObj || null];

  const keys = Object.keys(bodyObj);
  const isBatch =
    keys.length > 0 &&
    keys.every(function (k) {
      return /^\d+$/.test(k);
    });

  if (!isBatch) return [bodyObj];

  return keys
    .sort(function (a, b) {
      return Number(a) - Number(b);
    })
    .map(function (k) {
      const entry = bodyObj[k];
      return entry && typeof entry === "object"
        ? unwrapTrpcJsonEnvelope(entry)
        : entry || null;
    });
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

        const DEV_ASSET_MARKERS = [
          "/node_modules",
          "/.svelte-kit",
          "/@fs",
          "/@vite",
          "/@id",
          "/debug-cors",
          "/src/lib",
          "/src/routes",
        ];
        const STATIC_ASSET_EXT =
          /\.(svelte|vue|css|scss|map|woff2?|ttf|eot|ico|png|jpe?g|gif|svg|webp|mjs)(\?.*)?$/i;

        const shouldIgnore =
          (options.exclude || [])
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
            }) ||
          DEV_ASSET_MARKERS.some(function (m) {
            return path.includes(m);
          }) ||
          STATIC_ASSET_EXT.test(path);

        const isApiPath = path.startsWith(options.apiPrefix || "/api");

        if (!shouldIgnore && isApiPath) {
          // Capture the shape of the successful JSON reply (field names only)
          watchJsonResponse(res, client, method, path, req);
          const normalizedPath = normalizePath(path);
          const baseKey = method + ":" + normalizedPath;
          // GET/DELETE inputs live in the query string, so their names are tracked too
          const queryStructure = resolveQueryStructure(
            baseKey,
            method,
            req.url || "",
            path,
          );
          const endpointKey = baseKey + queryKeySuffix(queryStructure);

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
                // Split the (possibly batched) tRPC path into separate,
                // clean paths — one per real procedure — instead of one
                // garbled comma-joined path.
                const splitPaths = splitBatchPath(path).map(normalizePath);

                const isTrpcPath = path.includes("/trpc/");
                const hasInputParam = req.url && req.url.includes("input=");

                // ── tRPC GET input extraction ──────────────────────────────────────
                // tRPC GET requests send their input as a URL-encoded JSON query
                // parameter called "input". We only attempt this extraction when
                // the body is empty, the URL has an "input" param, and the path
                // looks like a tRPC endpoint — so regular REST query params are
                // never mistaken for a body schema.
                let bodySlots = null;

                if (
                  isTrpcPath &&
                  hasInputParam &&
                  (!bodyObj || Object.keys(bodyObj).length === 0)
                ) {
                  try {
                    const urlObj = new URL(req.url, "http://localhost");
                    const inputParam = urlObj.searchParams.get("input");

                    if (inputParam) {
                      let decoded;
                      try {
                        decoded = JSON.parse(decodeURIComponent(inputParam));
                      } catch (e) {
                        decoded = null;
                      }

                      if (
                        decoded &&
                        typeof decoded === "object" &&
                        !Array.isArray(decoded)
                      ) {
                        // Splits batched input into one slot per procedure,
                        // in path order — never merges different procedures'
                        // fields together.
                        bodySlots = splitBatchBody(decoded);
                      }
                    }
                  } catch (e) {
                    // URL parsing failed — fall through to normal body handling
                  }
                }

                // Normal (non-GET-input) body — split the same way if the
                // path turned out to be a batch.
                if (!bodySlots) {
                  bodySlots =
                    splitPaths.length > 1 ? splitBatchBody(bodyObj) : [bodyObj];
                }

                // Report each real procedure as its own endpoint, with only
                // its own fields — never another procedure's fields mixed in.
                splitPaths.forEach(function (singlePath, i) {
                  const slotBody = bodySlots[i] || null;
                  const parsedBody = structureToJsonSchema(
                    mergeQueryIntoStructure(
                      buildBodyStructure(slotBody),
                      splitPaths.length === 1 ? queryStructure : null,
                    ),
                  );
                  client
                    .updateEndpoint({
                      method: method,
                      path: singlePath,
                      requestBody: parsedBody,
                      detectedBy: "runtime",
                    })
                    .catch(function () {});
                });
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
    const baseKey = method + ":" + normalizedPath;
    // GET/DELETE inputs live in the query string, so their names are reported too
    const queryStructure = resolveQueryStructure(
      baseKey,
      method,
      request.url || "",
      path,
    );
    const endpointKey = baseKey + queryKeySuffix(queryStructure);

    if (!reportedEndpoints.has(endpointKey)) {
      reportedEndpoints.add(endpointKey);

      setImmediate(function () {
        client
          .updateEndpoint({
            method,
            path: normalizedPath,
            requestBody: queryStructure
              ? structureToJsonSchema(queryStructure)
              : null,
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

  // Capture the shape of the successful JSON reply (field names only)
  fastify.addHook("onSend", async function (request, reply, payload) {
    try {
      const path = request.url ? request.url.split("?")[0] : "";
      const method = request.method ? request.method.toUpperCase() : "";

      const shouldIgnore = ignorePaths.some(function (p) {
        return path.startsWith(p);
      });
      if (shouldIgnore) return payload;
      if (options.apiPrefix && !path.startsWith(options.apiPrefix))
        return payload;
      if (reply.statusCode < 200 || reply.statusCode >= 300) return payload;
      if (!isResponseShapeNeeded(method, path)) return payload;

      const contentType = String(
        reply.getHeader("content-type") || "",
      ).toLowerCase();
      if (contentType && !contentType.includes("json")) return payload;

      // Only fully-built replies can be read; streams are skipped
      if (typeof payload !== "string" && !Buffer.isBuffer(payload))
        return payload;
      const buffer = Buffer.from(payload);
      if (buffer.length > MAX_RESPONSE_CAPTURE_BYTES) return payload;

      const encoding = reply.getHeader("content-encoding");
      setImmediate(function () {
        const parsed = parseCapturedBody(buffer, {
          getHeader: function () {
            return encoding;
          },
        });
        reportResponseShape(client, method, path, parsed);
      });
    } catch (e) {}
    return payload;
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
    // GET/DELETE inputs live in the query string, so their names are added too
    const bodyStructure = mergeQueryIntoStructure(
      buildBodyStructure(body),
      resolveQueryStructure(
        endpointKey,
        method,
        ctx.originalUrl || ctx.url || "",
        path,
      ),
    );
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

    // Capture the shape of the successful JSON reply (field names only).
    // Kept last so it is queued after the endpoint's first registration above.
    reportFrameworkBody(client, method, path, ctx.status, ctx.type, ctx.body);
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
    // GET/DELETE inputs live in the query string, so their names are added too
    const bodyStructure = mergeQueryIntoStructure(
      buildBodyStructure(body),
      resolveQueryStructure(
        endpointKey,
        method,
        path + ((request.url && request.url.search) || ""),
        path,
      ),
    );
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

  // Capture the shape of the successful JSON reply (field names only)
  server.ext("onPreResponse", function (request, h) {
    try {
      const path = request.path || "";
      const method = request.method ? request.method.toUpperCase() : "";
      const response = request.response;

      const shouldIgnore = ignorePaths.some(function (p) {
        return path.startsWith(p);
      });
      const outsidePrefix =
        options.apiPrefix && !path.startsWith(options.apiPrefix);

      // Only plain replies (not errors, views or streams) carry a readable body
      if (
        !shouldIgnore &&
        !outsidePrefix &&
        response &&
        !response.isBoom &&
        response.variety === "plain"
      ) {
        reportFrameworkBody(
          client,
          method,
          path,
          response.statusCode,
          response.headers && response.headers["content-type"],
          response.source,
        );
      }
    } catch (e) {}
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
