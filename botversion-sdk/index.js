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

    if (!options.apiKey) {
      console.error("[BotVersion SDK] ❌ apiKey is required.");
      return;
    }

    // Restore from global if module was re-imported after hot reload
    if (global._botVersionClient) {
      this._client = global._botVersionClient;
      this._options = global._botVersionOptions;
      this._initialized = true;
      console.warn("[BotVersion SDK] Restored from global — skipping re-init");
      return;
    }

    if (this._initialized) {
      console.warn("[BotVersion SDK] Already initialized — skipping");
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

    if (debug) {
      console.log("[BotVersion SDK] Initializing...");
      if (app) {
        console.log("[BotVersion SDK] Mode: Express");
      } else {
        console.log("[BotVersion SDK] Mode: Next.js (file-based routing)");
      }
    }

    // ── Framework detection ──────────────────────────────────────────────────
    if (app) {
      var frameworkCheck = detectFramework(app);
      if (!frameworkCheck.supported) {
        console.error(
          "[BotVersion SDK] ❌ Unsupported framework:",
          frameworkCheck.name,
        );
        console.error(
          "[BotVersion SDK] ❌ Currently supports Express and Next.js only.",
        );
        return;
      }
      if (debug) {
        console.log(
          "[BotVersion SDK] ✅ Framework detected:",
          frameworkCheck.name,
        );
      }
    }

    // ── Runtime interceptor — Express only ───────────────────────────────────
    if (app && app.use) {
      interceptor.attachInterceptor(app, self._client, {
        exclude: options.exclude || [],
        apiPrefix: options.apiPrefix || null,
        debug: debug,
      });
      if (debug) {
        console.log("[BotVersion SDK] ✅ Runtime interceptor attached");
      }
    } else if (!app) {
      if (debug) {
        console.log(
          "[BotVersion SDK] ℹ Runtime interceptor skipped — Next.js mode uses file scanning only",
        );
      }
    }

    // ── Static scan ──────────────────────────────────────────────────────────
    setTimeout(function () {
      var endpoints = [];

      // Express scan
      // Express scan
      if (app) {
        console.log("[BotVersion SDK] Scanning Express routes...");
        var cwd = options.cwd || process.cwd();
        endpoints = scanner.scanExpressRoutes(app, cwd);
        console.log(
          "[BotVersion SDK] Found",
          endpoints.length,
          "Express routes",
        );

        if (endpoints.length === 0) {
          console.warn("[BotVersion SDK] ⚠ No endpoints found.");
          console.warn(
            "[BotVersion SDK] ⚠ Make sure routes are defined BEFORE BotVersion.init()",
          );
        }
      }

      // Next.js scan
      // Next.js scan — auto detect all possible structures
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
            console.log("[BotVersion SDK] Scanning App Router routes at:", dir);
            const routes = scanner.scanNextJsAppRoutes(dir);
            endpoints = endpoints.concat(routes);
            console.log(
              "[BotVersion SDK] Found",
              routes.length,
              "App Router routes",
            );
          }
        }

        for (const dir of possiblePagesDirs) {
          if (fs.existsSync(dir)) {
            console.log(
              "[BotVersion SDK] Scanning Pages Router routes at:",
              dir,
            );
            const routes = scanner.scanNextJsRoutes(dir);
            endpoints = endpoints.concat(routes);
            console.log(
              "[BotVersion SDK] Found",
              routes.length,
              "Pages Router routes",
            );
          }
        }
      }

      // Neither Express nor pagesDir
      // Neither Express nor Next.js routes found
      if (!app && endpoints.length === 0) {
        console.error(
          "[BotVersion SDK] ❌ No routes found. Make sure your app/api or pages/api folder exists.",
        );
        return;
      }

      // Send to platform
      if (endpoints.length > 0) {
        console.log(
          "[BotVersion SDK] Sending",
          endpoints.length,
          "endpoints to platform...",
        );
        self._client
          .registerEndpoints(endpoints)
          .then(function () {
            console.log(
              "[BotVersion SDK] ✅ Endpoints queued —",
              endpoints.length,
              "endpoints will be sent shortly",
            );
          })
          .catch(function (err) {
            console.error(
              "[BotVersion SDK] ❌ Failed to register endpoints:",
              err.message,
            );
          });
      }

      console.log("[BotVersion SDK] ✅ Initialization complete");
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

// ── Framework detection ──────────────────────────────────────────────────────
function detectFramework(app) {
  if (!app) return { supported: false, name: "unknown (no app passed)" };

  var isExpress =
    typeof app.use === "function" &&
    typeof app.get === "function" &&
    typeof app.post === "function" &&
    (app._router !== undefined ||
      app.stack !== undefined ||
      app.lazyrouter !== undefined);

  if (isExpress) return { supported: true, name: "Express" };

  if (typeof app.addHook === "function" && typeof app.route === "function") {
    return { supported: false, name: "Fastify" };
  }

  if (
    typeof app.use === "function" &&
    app.context !== undefined &&
    typeof app.get !== "function"
  ) {
    return { supported: false, name: "Koa" };
  }

  if (typeof app.route === "function" && typeof app.start === "function") {
    return { supported: false, name: "Hapi" };
  }

  return { supported: false, name: "unknown" };
}
