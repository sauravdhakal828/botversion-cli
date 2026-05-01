// botversion-sdk/client.js
"use strict";

const https = require("https");
const http = require("http");
const url = require("url");

/**
 * Lightweight HTTP client — no heavy dependencies
 * Communicates with BotVersion platform API
 */
function BotVersionClient(options) {
  this.apiKey = options.apiKey;
  this.platformUrl = options.platformUrl || "http://localhost:3000";
  this.debug = options.debug || false;
  this.timeout = options.timeout || 30000;

  // Batch queue for endpoint registration
  this._queue = [];
  this._flushTimer = null;
  this._flushDelay = options.flushDelay || 3000;
  this._ws = null;
  this._executor = null;
  var self = this;
  process.on("beforeExit", function () {
    if (self._queue.length > 0) self._flush();
  });
}

/**
 * Register the executor function — called by interceptor
 * So WebSocket can forward calls to user's backend
 */
BotVersionClient.prototype.setExecutor = function (executorFn) {
  this._executor = executorFn;
  if (this.debug) {
    console.log("[BotVersion SDK] ✅ Executor registered");
  }
};

/**
 * Register multiple endpoints at once (batched)
 */
BotVersionClient.prototype.registerEndpoints = function (endpoints) {
  var self = this;

  if (!endpoints || endpoints.length === 0) return Promise.resolve();

  if (self.debug) {
    console.log(
      "[BotVersion SDK] Queuing",
      endpoints.length,
      "endpoints for registration",
    );
  }

  self._queue = self._queue.concat(endpoints);

  if (!self._flushTimer) {
    self._flushTimer = setTimeout(function () {
      self._flush();
    }, self._flushDelay);
  }

  return Promise.resolve();
};

/**
 * Register endpoints immediately — no batching
 * Used during initial scan
 */
BotVersionClient.prototype.registerEndpointsNow = function (endpoints) {
  var self = this;
  if (!endpoints || endpoints.length === 0) return Promise.resolve();

  return self
    ._post("/api/sdk/register-endpoints", {
      workspaceKey: self.apiKey,
      endpoints: endpoints,
    })
    .then(function (data) {
      if (self.debug) {
        console.log(
          "[BotVersion SDK] ✅ Registered",
          endpoints.length,
          "endpoints immediately",
        );
      }
      return data;
    })
    .catch(function (err) {
      console.warn(
        "[BotVersion SDK] ⚠ Failed to register endpoints:",
        err.message,
      );
    });
};

/**
 * Flush the queue — send all batched endpoints at once
 */
BotVersionClient.prototype._flush = function () {
  var self = this;
  self._flushTimer = null;

  if (self._queue.length === 0) return;

  var toSend = self._queue.slice();
  self._queue = [];

  if (self.debug) {
    console.log(
      "[BotVersion SDK] Flushing",
      toSend.length,
      "endpoints to platform",
    );
  }

  self
    ._post("/api/sdk/register-endpoints", {
      workspaceKey: self.apiKey,
      endpoints: toSend,
    })
    .then(function (data) {
      if (self.debug) {
        console.log(
          "[BotVersion SDK] Registered",
          data.succeeded,
          "endpoints successfully",
        );
      }
    })
    .catch(function (err) {
      if (self.debug) {
        console.warn(
          "[BotVersion SDK] Failed to register endpoints:",
          err.message,
        );
      }
    });
};

/**
 * Update a single endpoint (runtime detection)
 */
BotVersionClient.prototype.updateEndpoint = function (endpoint) {
  var self = this;

  return self._post("/api/sdk/update-endpoint", {
    workspaceKey: self.apiKey,
    method: endpoint.method,
    path: endpoint.path,
    requestBody: endpoint.requestBody || null,
    responseBody: endpoint.responseBody || null,
    detectedBy: endpoint.detectedBy || "runtime",
  });
};

BotVersionClient.prototype.registerRoutePatterns = function (patterns) {
  var self = this;
  if (!patterns || patterns.length === 0) return Promise.resolve();

  if (self.debug) {
    console.log(
      "[BotVersion SDK] Sending",
      patterns.length,
      "route patterns to platform",
    );
  }

  return self
    ._post("/api/sdk/register-route-patterns", {
      workspaceKey: self.apiKey,
      patterns: patterns,
    })
    .catch(function (err) {
      if (self.debug) {
        console.warn(
          "[BotVersion SDK] Failed to register route patterns:",
          err.message,
        );
      }
    });
};

/**
 * Get all registered endpoints for this workspace
 */
BotVersionClient.prototype.getEndpoints = function () {
  var self = this;

  return self._get(
    "/api/sdk/get-endpoints?workspaceKey=" + encodeURIComponent(self.apiKey),
  );
};

/**
 * Make a POST request to the platform
 */
BotVersionClient.prototype._post = function (path, data) {
  var self = this;

  return new Promise(function (resolve, reject) {
    var body = JSON.stringify(data);
    var parsedUrl = url.parse(self.platformUrl);
    var isHttps = parsedUrl.protocol === "https:";
    var lib = isHttps ? https : http;

    var options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
        "X-BotVersion-SDK": "1.0.0",
      },
      timeout: self.timeout,
    };

    var req = lib.request(options, function (res) {
      var responseData = "";

      res.on("data", function (chunk) {
        responseData += chunk;
      });

      res.on("end", function () {
        try {
          var parsed = JSON.parse(responseData);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(
              new Error(
                "Platform returned " +
                  res.statusCode +
                  ": " +
                  (parsed.error || responseData),
              ),
            );
          }
        } catch (e) {
          reject(new Error("Invalid JSON response from platform"));
        }
      });
    });

    req.on("error", function (err) {
      reject(err);
    });

    req.on("timeout", function () {
      req.destroy();
      reject(new Error("Request timed out"));
    });

    req.write(body);
    req.end();
  });
};

/**
 * Make a GET request to the platform
 */
BotVersionClient.prototype._get = function (path) {
  var self = this;

  return new Promise(function (resolve, reject) {
    var parsedUrl = url.parse(self.platformUrl);
    var isHttps = parsedUrl.protocol === "https:";
    var lib = isHttps ? https : http;

    var options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: path,
      method: "GET",
      headers: {
        "X-BotVersion-SDK": "1.0.0",
      },
      timeout: self.timeout,
    };

    var req = lib.request(options, function (res) {
      var responseData = "";

      res.on("data", function (chunk) {
        responseData += chunk;
      });

      res.on("end", function () {
        try {
          var parsed = JSON.parse(responseData);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(
              new Error(
                "Platform returned " +
                  res.statusCode +
                  ": " +
                  (parsed.error || responseData),
              ),
            );
          }
        } catch (e) {
          reject(new Error("Invalid JSON response from platform"));
        }
      });
    });

    req.on("error", function (err) {
      reject(err);
    });

    req.on("timeout", function () {
      req.destroy();
      reject(new Error("Request timed out"));
    });

    req.end();
  });
};

/**
 * Connect to platform via WebSocket — establishes persistent connection
 * Auto-reconnects every 5 seconds if connection drops
 */
BotVersionClient.prototype.connect = function () {
  var self = this;
  // Run in next tick so it doesn't block initialization
  setImmediate(function () {
    self._wsLoop();
  });
};

BotVersionClient.prototype._wsLoop = function () {
  var self = this;

  var wsUrl = self.platformUrl
    .replace("https://", "wss://")
    .replace("http://", "ws://")
    .replace(":3000", ":3001");
  wsUrl = wsUrl + "?apiKey=" + encodeURIComponent(self.apiKey);

  var WebSocket;
  try {
    WebSocket = require("ws");
  } catch (e) {
    console.error(
      "[BotVersion SDK] ❌ 'ws' package not installed. Run: npm install ws",
    );
    return;
  }

  function attempt() {
    var ws = new WebSocket(wsUrl);
    self._ws = ws;

    ws.on("open", function () {
      if (self.debug) {
        console.log("[BotVersion SDK] ✅ WebSocket connected to platform");
      }
      // Identify this SDK to the platform
      ws.send(
        JSON.stringify({
          type: "IDENTIFY",
          apiKey: self.apiKey,
        }),
      );
    });

    ws.on("message", function (data) {
      try {
        var msg = JSON.parse(data.toString());

        if (msg.type === "EXECUTE_CALL") {
          self._handleExecuteCall(msg);
        }
      } catch (e) {
        if (self.debug) {
          console.warn("[BotVersion SDK] ⚠ Error parsing message:", e.message);
        }
      }
    });

    ws.on("error", function (err) {
      if (self.debug) {
        console.warn("[BotVersion SDK] ⚠ WebSocket error:", err.message);
      }
    });

    ws.on("close", function () {
      if (self.debug) {
        console.log(
          "[BotVersion SDK] WebSocket closed — reconnecting in 5s...",
        );
      }
      self._ws = null;
      // Auto-reconnect after 5 seconds
      setTimeout(attempt, 5000);
    });
  }

  attempt();
};

BotVersionClient.prototype._handleExecuteCall = function (data) {
  var self = this;

  var callId = data.callId;
  var method = data.method;
  var path = data.path;
  var body = data.body;
  var cookies = data.cookies || "";
  var headers = data.headers || {};
  var baseUrl = data.baseUrl || "http://127.0.0.1:3000";

  if (!self._executor) {
    self._sendCallResult(callId, {
      status: 500,
      ok: false,
      data: { error: "No executor registered" },
    });
    return;
  }

  self
    ._executor(method, path, body, cookies, headers, baseUrl)
    .then(function (result) {
      self._sendCallResult(callId, result);
    })
    .catch(function (err) {
      self._sendCallResult(callId, {
        status: 500,
        ok: false,
        data: { error: err.message },
      });
    });
};

BotVersionClient.prototype._sendCallResult = function (callId, result) {
  var self = this;
  try {
    if (self._ws && self._ws.readyState === 1) {
      // 1 = OPEN
      self._ws.send(
        JSON.stringify({
          type: "CALL_RESULT",
          callId: callId,
          result: result,
        }),
      );
    } else if (self.debug) {
      console.warn(
        "[BotVersion SDK] ⚠ WebSocket not open — could not send CALL_RESULT",
      );
    }
  } catch (e) {
    if (self.debug) {
      console.warn("[BotVersion SDK] ⚠ Failed to send CALL_RESULT:", e.message);
    }
  }
};

module.exports = BotVersionClient;
