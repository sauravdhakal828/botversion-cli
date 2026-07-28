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
  this.platformUrl = options.platformUrl || "https://botversion.com";
  this.debug = options.debug || false;
  this.timeout = options.timeout || 30000;

  // Batch queue for endpoint registration
  this._queue = [];
  this._flushTimer = null;
  this._flushDelay = options.flushDelay || 3000;
  var self = this;
  process.on("beforeExit", function () {
    if (self._queue.length > 0) self._flush();
  });
}

/**
 * Register multiple endpoints at once (batched)
 */
BotVersionClient.prototype.registerEndpoints = function (endpoints) {
  var self = this;

  if (!endpoints || endpoints.length === 0) return Promise.resolve();

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
      return data;
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

  self
    ._post("/api/sdk/register-endpoints", {
      workspaceKey: self.apiKey,
      endpoints: toSend,
    })
    .then(function (data) {})
    .catch(function (err) {});
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

BotVersionClient.prototype.registerRoutePatterns = function (
  patterns,
  classification,
) {
  var self = this;
  var body = {
    workspaceKey: self.apiKey,
    patterns: patterns || [],
    classification: classification || null,
  };
  if ((!patterns || patterns.length === 0) && !classification) {
    return Promise.resolve();
  }
  return self._post("/api/sdk/register-route-patterns", body);
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
          if (!responseData || responseData.trim() === "") {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({});
              return;
            } else {
              reject(
                new Error(
                  "Platform returned " + res.statusCode + ": empty response",
                ),
              );
              return;
            }
          }
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
          if (!responseData || responseData.trim() === "") {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({});
              return;
            } else {
              reject(
                new Error(
                  "Platform returned " + res.statusCode + ": empty response",
                ),
              );
              return;
            }
          }
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
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({});
          } else {
            reject(new Error("Invalid JSON response from platform"));
          }
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

module.exports = BotVersionClient;
