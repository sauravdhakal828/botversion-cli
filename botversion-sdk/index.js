"use strict";

var scanner = require("./scanner");
var interceptor = require("./interceptor");
var BotVersionClient = require("./client");

// ── Framework auto-detection ─────────────────────────────────────────────────
// Reads package.json from the customer's codebase and figures out
// which backend and frontend frameworks they are using.
function detectFrameworks(cwd) {
  const fs = require("fs");
  const path = require("path");

  const result = {
    backend: "unknown",
    frontend: "unknown",
  };

  let pkg = {};
  try {
    const pkgPath = path.join(cwd, "package.json");
    if (fs.existsSync(pkgPath)) {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    }
  } catch {
    return result;
  }

  const deps = Object.assign(
    {},
    pkg.dependencies || {},
    pkg.devDependencies || {},
  );

  // ── Backend detection ──────────────────────────────────────────────────────
  if (deps["@nestjs/core"]) {
    result.backend = "nestjs";
  } else if (deps["fastify"]) {
    result.backend = "fastify";
  } else if (deps["@adonisjs/core"]) {
    result.backend = "adonis";
  } else if (deps["@hapi/hapi"] || deps["hapi"]) {
    result.backend = "hapi";
  } else if (deps["koa"]) {
    result.backend = "koa";
  } else if (deps["next"]) {
    result.backend = "nextjs";
  } else if (deps["express"]) {
    result.backend = "express";
  } else if (deps["@remix-run/node"] || deps["@remix-run/serve"]) {
    result.backend = "remix";
  } else if (deps["nuxt"] || deps["nuxt3"] || deps["@nuxt/core"]) {
    result.backend = "nuxt";
  } else if (deps["@sveltejs/kit"]) {
    result.backend = "sveltekit";
  }

  // ── Frontend detection ─────────────────────────────────────────────────────
  if (deps["next"]) {
    result.frontend = "nextjs";
  } else if (deps["nuxt"] || deps["nuxt3"] || deps["@nuxt/core"]) {
    result.frontend = "nuxt";
  } else if (deps["@sveltejs/kit"]) {
    result.frontend = "sveltekit";
  } else if (deps["@remix-run/react"]) {
    result.frontend = "remix";
  } else if (deps["@tanstack/router"] || deps["@tanstack/react-router"]) {
    result.frontend = "tanstack";
  } else if (deps["vue"] && (deps["vue-router"] || deps["@nuxtjs/router"])) {
    result.frontend = "vue";
  } else if (deps["@angular/core"]) {
    result.frontend = "angular";
  } else if (deps["svelte"]) {
    result.frontend = "svelte";
  } else if (deps["react"] && deps["react-router-dom"]) {
    result.frontend = "react-router";
  } else if (deps["astro"]) {
    result.frontend = "astro";
  } else if (deps["react"]) {
    result.frontend = "react";
  }

  return result;
}

// ── Run the right backend scanner ────────────────────────────────────────────
function runBackendScanner(detectedBackend, app, options, cwd) {
  const endpoints = [];

  switch (detectedBackend) {
    case "express":
      endpoints.push(...scanner.scanExpressRoutes(app, cwd));
      break;

    case "nextjs": {
      const fs = require("fs");
      const path = require("path");

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
          endpoints.push(...scanner.scanNextJsAppRoutes(dir));
        }
      }
      for (const dir of possiblePagesDirs) {
        if (fs.existsSync(dir)) {
          endpoints.push(...scanner.scanNextJsRoutes(dir));
        }
      }
      break;
    }

    case "fastify":
      endpoints.push(...scanner.scanFastifyRoutes(cwd));
      break;

    case "nestjs":
      endpoints.push(...scanner.scanNestJsRoutes(cwd));
      break;

    case "koa":
      endpoints.push(...scanner.scanKoaRoutes(cwd));
      break;

    case "hapi":
      endpoints.push(...scanner.scanHapiRoutes(cwd));
      break;

    case "adonis":
      endpoints.push(...scanner.scanAdonisRoutes(cwd));
      break;

    case "nuxt":
      endpoints.push(...scanner.scanNuxtServerRoutes(cwd));
      break;

    case "sveltekit":
      endpoints.push(...scanner.scanSvelteKitServerRoutes(cwd));
      break;

    case "remix":
      endpoints.push(...scanner.scanRemixServerRoutes(cwd));
      break;

    default:
      // Unknown backend — try Express as best guess
      if (app) {
        endpoints.push(...scanner.scanExpressRoutes(app, cwd));
      }
      break;
  }

  return endpoints;
}

// ── Attach the right runtime interceptor ─────────────────────────────────────
function attachRuntimeInterceptor(detectedBackend, app, client, options) {
  switch (detectedBackend) {
    case "express":
      interceptor.attachInterceptor(app, client, {
        exclude: options.exclude || [],
        apiPrefix: options.apiPrefix || null,
        debug: options.debug || false,
      });
      break;

    case "nextjs":
      interceptor.attachNextJsInterceptor(client, {
        exclude: options.exclude || [],
        apiPrefix: options.apiPrefix || "/api",
        debug: options.debug || false,
      });
      break;

    case "fastify":
      if (app) {
        interceptor.attachFastifyInterceptor(app, client, {
          exclude: options.exclude || [],
          apiPrefix: options.apiPrefix || null,
          debug: options.debug || false,
        });
      }
      break;

    case "koa":
      if (app) {
        interceptor.attachKoaInterceptor(app, client, {
          exclude: options.exclude || [],
          apiPrefix: options.apiPrefix || null,
          debug: options.debug || false,
        });
      }
      break;

    case "hapi":
      if (app) {
        interceptor.attachHapiInterceptor(app, client, {
          exclude: options.exclude || [],
          apiPrefix: options.apiPrefix || null,
          debug: options.debug || false,
        });
      }
      break;

    case "nestjs":
      interceptor.attachNestJsInterceptor(client, {
        exclude: options.exclude || [],
        apiPrefix: options.apiPrefix || "/",
        debug: options.debug || false,
      });
      break;

    case "sveltekit":
      interceptor.attachSvelteKitInterceptor(client, {
        exclude: options.exclude || [],
        apiPrefix: options.apiPrefix || "/",
        debug: options.debug || false,
      });
      break;

    case "nuxt":
      interceptor.attachNuxtInterceptor(client, {
        exclude: options.exclude || [],
        apiPrefix: options.apiPrefix || "/api",
        debug: options.debug || false,
      });
      break;

    case "remix":
      interceptor.attachRemixInterceptor(client, {
        exclude: options.exclude || [],
        apiPrefix: options.apiPrefix || "/",
        debug: options.debug || false,
      });
      break;

    case "adonis":
      interceptor.attachAdonisInterceptor(client, {
        exclude: options.exclude || [],
        apiPrefix: options.apiPrefix || "/",
        debug: options.debug || false,
      });
      break;

    default:
      // Unknown — fall back to Next.js http server patch as best guess
      interceptor.attachNextJsInterceptor(client, {
        exclude: options.exclude || [],
        apiPrefix: options.apiPrefix || "/",
        debug: options.debug || false,
      });
      break;
  }
}

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
      const savedOptions = global._botVersionOptions || {};
      const savedFramework = global._botVersionFramework || "nextjs";
      attachRuntimeInterceptor(savedFramework, app, this._client, savedOptions);
      return;
    }

    this._initialized = true;
    this._options = options;
    this._app = app;

    this._client = new BotVersionClient({
      apiKey: options.apiKey,
      platformUrl: options.platformUrl || "https://botversion.com",
      debug: options.debug || false,
      timeout: options.timeout || 30000,
    });

    global._botVersionClient = this._client;
    global._botVersionOptions = options;

    var self = this;
    var cwd = options.cwd || process.cwd();
    var debug = options.debug || false;

    // ── Auto-detect frameworks ───────────────────────────────────────────────
    var detected = detectFrameworks(cwd);

    // Allow manual override from options
    var detectedBackend = options.framework || detected.backend;
    var detectedFrontend = options.frontendFramework || detected.frontend;

    global._botVersionFramework = detectedBackend;

    if (debug) {
      // Detected: detectedBackend, detectedFrontend
    }

    // ── Attach runtime interceptor ───────────────────────────────────────────
    attachRuntimeInterceptor(detectedBackend, app, self._client, options);

    // ── Static scan ──────────────────────────────────────────────────────────
    setTimeout(function () {
      // Run backend scanner
      var endpoints = runBackendScanner(detectedBackend, app, options, cwd);

      // Send endpoints to platform
      if (endpoints.length > 0) {
        self._client.registerEndpoints(endpoints);
      }

      // Run frontend route scanner
      var routePatterns = scanner.scanFrontendRoutes(cwd);

      if (routePatterns.length > 0) {
        self._client.registerRoutePatterns(routePatterns).catch(function () {
          // silently ignore — non-critical
        });
      }
    }, 3000);
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
