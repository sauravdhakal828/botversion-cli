// botversion-sdk/index.js
"use strict";

var scanner = require("./scanner");
var interceptor = require("./interceptor");
var BotVersionClient = require("./client");

var BotVersion = {
  _client: null,
  _initialized: false,

  init: function (appOrOptions, optionsArg) {
    var app = null;
    var options = {};

    if (
      appOrOptions &&
      (typeof appOrOptions === "object" ||
        typeof appOrOptions === "function") &&
      typeof appOrOptions.use === "function"
    ) {
      app = appOrOptions;
      options = optionsArg || {};
    } else {
      options = appOrOptions || {};
      app = null;
    }

    // Restore from global if module was re-imported after hot reload
    if (global._botVersionClient) {
      this._client = global._botVersionClient;
      this._options = global._botVersionOptions;
      this._initialized = true;
      // Re-attach interceptor after hot reload
      interceptor.attachNextJsInterceptor(this._client, {
        exclude: (global._botVersionOptions || {}).exclude || [],
        apiPrefix: (global._botVersionOptions || {}).apiPrefix || "/api",
        debug: (global._botVersionOptions || {}).debug || false,
      });
      return;
    }

    this._initialized = true;
    this._options = options;
    this._app = app;

    this._client = new BotVersionClient({
      apiKey: options.apiKey,
      platformUrl: options.platformUrl || "http://localhost:3000",
      debug: options.debug || false,
      timeout: options.timeout || 30000,
    });

    global._botVersionClient = this._client;
    global._botVersionOptions = options;

    var self = this;
    var debug = options.debug || false;

    // ── Runtime interceptor — Express or Next.js ─────────────────────────────
    if (app && app.use) {
      // Express
      interceptor.attachInterceptor(app, self._client, {
        exclude: options.exclude || [],
        apiPrefix: options.apiPrefix || null,
        debug: debug,
      });
    } else {
      // Next.js — patch the global fetch/http server to intercept API calls
      interceptor.attachNextJsInterceptor(self._client, {
        exclude: options.exclude || [],
        apiPrefix: options.apiPrefix || "/api",
        debug: debug,
      });
    }

    // ── Static scan ──────────────────────────────────────────────────────────
    setTimeout(function () {
      var endpoints = [];

      // Express scan
      if (app) {
        var cwd = options.cwd || process.cwd();
        endpoints = scanner.scanExpressRoutes(app, cwd);
      }

      // Next.js scan
      if (!app) {
        const fs = require("fs");
        const path = require("path");
        const cwd = process.cwd();

        const possibleAppDirs = [
          path.join(cwd, "app"),
          path.join(cwd, "src", "app"),
        ];

        const possiblePagesDirs = [
          path.join(cwd, "pages"),
          path.join(cwd, "src", "pages"),
        ];

        for (const dir of possibleAppDirs) {
          if (fs.existsSync(dir)) {
            const routes = scanner.scanNextJsAppRoutes(dir);
            endpoints = endpoints.concat(routes);
          }
        }

        for (const dir of possiblePagesDirs) {
          if (fs.existsSync(dir)) {
            const routes = scanner.scanNextJsRoutes(dir);
            endpoints = endpoints.concat(routes);
          }
        }
      }

      // Send to platform
      if (endpoints.length > 0) {
        const missing = endpoints.filter(
          (ep) =>
            !ep.requestBody && ep.method !== "GET" && ep.method !== "DELETE",
        );
        missing.forEach((ep) => {
          console.log(`[botversion:scan] MISSING: ${ep.method} ${ep.path}`);
        });
        self._client.registerEndpoints(endpoints);
      }

      var cwd = options.cwd || process.cwd();
      console.log("[botversion] Scanning frontend routes in:", cwd);

      var routePatterns = scanner.scanFrontendRoutes(cwd);
      console.log("[botversion] Frontend routes found:", routePatterns.length);
      console.log(
        "[botversion] Routes:",
        JSON.stringify(routePatterns, null, 2),
      );

      if (routePatterns.length > 0) {
        self._client
          .registerRoutePatterns(routePatterns)
          .then(function () {
            console.log("[botversion] ✅ Routes sent to platform successfully");
          })
          .catch(function (err) {
            console.log("[botversion] ❌ Failed to send routes:", err.message);
          });
      } else {
        console.log("[botversion] ⚠️ No frontend routes found — nothing sent");
      }
    }, 500);
  },

  getEndpoints: function () {
    if (!this._client) {
      return Promise.reject(
        new Error(
          "BotVersion SDK not initialized. Call BotVersion.init() first.",
        ),
      );
    }
    return this._client.getEndpoints();
  },

  registerEndpoint: function (endpoint) {
    if (!this._client) {
      return Promise.reject(new Error("BotVersion SDK not initialized."));
    }
    return this._client.registerEndpoints([endpoint]);
  },
};

// Named exports
BotVersion.init = BotVersion.init.bind(BotVersion);
BotVersion.getEndpoints = BotVersion.getEndpoints.bind(BotVersion);
BotVersion.registerEndpoint = BotVersion.registerEndpoint.bind(BotVersion);

module.exports = BotVersion;
module.exports.default = BotVersion;
module.exports.init = BotVersion.init;
module.exports.getEndpoints = BotVersion.getEndpoints;
module.exports.registerEndpoint = BotVersion.registerEndpoint;
