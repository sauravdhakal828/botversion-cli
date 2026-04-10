// botversion-sdk/index.js
"use strict";

var scanner = require("./scanner");
var interceptor = require("./interceptor");
var BotVersionClient = require("./client");

var BotVersion = {
  _client: null,
  _initialized: false,

  init: function (appOrOptions, optionsArg) {
    console.log("=== INIT CALLED ===");
    console.log("appOrOptions type:", typeof appOrOptions);
    console.log(
      "appOrOptions is express app:",
      appOrOptions && typeof appOrOptions.use === "function",
    );
    console.log("optionsArg type:", typeof optionsArg);
    console.log("optionsArg value:", JSON.stringify(optionsArg));
    console.log("===================");
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

    console.log("options received:", JSON.stringify(options));
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
        console.error(
          "[BotVersion SDK] ❌ Visit https://docs.botversion.com for supported frameworks.",
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
        getUserContext: options.getUserContext || null,
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
      if (app) {
        console.log("[BotVersion SDK] Scanning Express routes...");
        endpoints = scanner.scanExpressRoutes(app);
        console.log(
          "[BotVersion SDK] Found",
          endpoints.length,
          "Express routes",
        );
        console.log(
          "[BotVersion SDK] Endpoints:",
          JSON.stringify(endpoints, null, 2),
        );

        if (endpoints.length === 0) {
          console.warn("[BotVersion SDK] ⚠ No endpoints found.");
          console.warn(
            "[BotVersion SDK] ⚠ Make sure routes are defined BEFORE BotVersion.init()",
          );
          console.warn(
            "[BotVersion SDK] ⚠ and BotVersion.init() is called BEFORE app.listen().",
          );
        }
      }

      // Next.js scan — runs if pagesDir is provided (with or without app)
      if (options.pagesDir) {
        console.log(
          "[BotVersion SDK] Scanning Next.js API routes...",
          options.pagesDir,
        );
        var nextRoutes = scanner.scanNextJsRoutes(options.pagesDir);
        endpoints = endpoints.concat(nextRoutes);
        console.log(
          "[BotVersion SDK] Found",
          nextRoutes.length,
          "Next.js routes",
        );
        console.log(
          "[BotVersion SDK] Next.js routes:",
          JSON.stringify(nextRoutes, null, 2),
        );

        if (nextRoutes.length === 0) {
          console.warn("[BotVersion SDK] ⚠ No Next.js routes found.");
          console.warn(
            "[BotVersion SDK] ⚠ Make sure pagesDir points to your pages folder.",
          );
          console.warn(
            "[BotVersion SDK] ⚠ Example: pagesDir: path.join(process.cwd(), 'pages')",
          );
        }
      }

      // Neither Express nor pagesDir
      if (!app && !options.pagesDir) {
        console.error("[BotVersion SDK] ❌ No routes to scan.");
        console.error(
          "[BotVersion SDK] ❌ For Express: pass your app object — BotVersion.init(app, options)",
        );
        console.error(
          "[BotVersion SDK] ❌ For Next.js: pass pagesDir — BotVersion.init({ apiKey, pagesDir: path.join(process.cwd(), 'pages') })",
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
              "[BotVersion SDK] ✅ Static scan complete —",
              endpoints.length,
              "endpoints registered",
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

  chat: function (req, res) {
    if (!this._client) {
      return res.status(500).json({ error: "BotVersion SDK not initialized." });
    }

    var getUserContext = this._options && this._options.getUserContext;
    var userContext = getUserContext
      ? getUserContext(req)
      : extractDefaultContext(req);

    this._client
      .agentChat({
        message: req.body.message,
        conversationHistory: req.body.conversationHistory || [],
        pageContext: req.body.pageContext || {},
        userContext: userContext,
        workspaceKey: this._options.apiKey,
        chatbotId: req.body.chatbotId,
      })
      .then(function (response) {
        return res.status(200).json(response);
      })
      .catch(function (err) {
        console.error("[BotVersion SDK] chat error:", err);
        return res.status(500).json({ error: "Agent error" });
      });
  },
};

function extractDefaultContext(req) {
  var user = req.user || (req.session && req.session.user) || {};
  var sensitiveKeys = [
    "password",
    "passwd",
    "pwd",
    "token",
    "accesstoken",
    "refreshtoken",
    "bearertoken",
    "secret",
    "privatesecret",
    "apikey",
    "api_key",
    "privatekey",
    "private_key",
    "signingkey",
    "hash",
    "passwordhash",
    "salt",
    "cvv",
    "ssn",
    "pin",
    "creditcard",
    "credit_card",
    "cardnumber",
    "card_number",
    "otp",
    "mfa",
    "totp",
    "image",
    "avatar",
    "photo",
  ];

  // Step 1: Flatten nested objects
  function flattenObject(obj, prefix) {
    prefix = prefix || "";
    var result = {};
    Object.keys(obj).forEach(function (key) {
      var value = obj[key];
      var fullKey = prefix ? prefix + "_" + key : key;
      if (value === null || value === undefined) return;
      if (typeof value === "object" && !Array.isArray(value)) {
        var nested = flattenObject(value, fullKey);
        Object.keys(nested).forEach(function (k) {
          result[k] = nested[k];
        });
      } else if (typeof value !== "object") {
        result[fullKey] = value;
      }
    });
    return result;
  }

  var flatUser = flattenObject(user);

  // Step 2: Strip sensitive keys
  var context = {};
  Object.keys(flatUser).forEach(function (key) {
    var isSensitive = sensitiveKeys.some(function (sk) {
      return key.toLowerCase().includes(sk);
    });
    if (!isSensitive) {
      context[key] = flatUser[key];
    }
  });

  // Step 3: Smart aliasing
  var idSuffixes = ["id", "key", "code", "ref", "slug", "uuid", "num", "no"];
  var cleanPrefixes = [
    "active",
    "current",
    "selected",
    "default",
    "my",
    "the",
    "this",
  ];

  Object.keys(context).forEach(function (key) {
    var lowerKey = key.toLowerCase();
    var isIdField = idSuffixes.some(function (suffix) {
      return lowerKey.endsWith(suffix);
    });

    if (isIdField && context[key]) {
      var cleanKey = key;
      cleanPrefixes.forEach(function (prefix) {
        var regex = new RegExp("^" + prefix, "i");
        if (regex.test(cleanKey)) {
          cleanKey = cleanKey.replace(regex, "");
          cleanKey = cleanKey.charAt(0).toLowerCase() + cleanKey.slice(1);
        }
      });

      if (cleanKey !== key && !context[cleanKey]) {
        context[cleanKey] = context[key];
      }
    }
  });

  return context;
}

// Named exports for both CJS and ESM
BotVersion.init = BotVersion.init.bind(BotVersion);
BotVersion.getEndpoints = BotVersion.getEndpoints.bind(BotVersion);
BotVersion.registerEndpoint = BotVersion.registerEndpoint.bind(BotVersion);
BotVersion.chat = BotVersion.chat.bind(BotVersion);

BotVersion.nextHandler = function (options) {
  options = options || {};
  var self = this;
  var hasScanned = false;

  return async function handler(req, res) {
    // ── Initialize on first request if not already done ──
    if (!self._initialized || !self._client) {
      var apiKey = options.apiKey;
      if (!apiKey) {
        console.error(
          "[BotVersion SDK] ❌ apiKey is required in nextHandler options.",
        );
        return res
          .status(500)
          .json({ error: "BotVersion SDK not configured." });
      }

      self._client = new BotVersionClient({
        apiKey: apiKey,
        platformUrl: options.platformUrl || "http://localhost:3000",
        debug: options.debug || false,
        timeout: options.timeout || 30000,
      });

      global._botVersionClient = self._client;
      global._botVersionOptions = options;
      self._initialized = true;
      self._options = options;

      console.log("[BotVersion SDK] ✅ Initialized from nextHandler");
    }

    // Restore from global if hot reload lost the instance
    if (!self._client && global._botVersionClient) {
      self._client = global._botVersionClient;
      self._options = global._botVersionOptions;
    }

    // ── Handle the chat request ───────────────────────────────────────────
    var session = null;
    if (options.getSession) {
      session = await options.getSession(req, res);
    }

    req.user = (session && session.user) || {};

    var getUserContext =
      (self._options && self._options.getUserContext) ||
      function (req) {
        var user = req.user || {};
        var sensitiveKeys = [
          "password",
          "passwd",
          "pwd",
          "token",
          "accesstoken",
          "refreshtoken",
          "bearertoken",
          "secret",
          "privatesecret",
          "apikey",
          "api_key",
          "privatekey",
          "private_key",
          "signingkey",
          "hash",
          "passwordhash",
          "salt",
          "cvv",
          "ssn",
          "pin",
          "creditcard",
          "credit_card",
          "cardnumber",
          "card_number",
          "otp",
          "mfa",
          "totp",
          "image",
          "avatar",
          "photo",
        ];

        // Step 1: Flatten nested objects
        function flattenObject(obj, prefix) {
          prefix = prefix || "";
          var result = {};
          Object.keys(obj).forEach(function (key) {
            var value = obj[key];
            var fullKey = prefix ? prefix + "_" + key : key;
            if (value === null || value === undefined) return;
            if (typeof value === "object" && !Array.isArray(value)) {
              var nested = flattenObject(value, fullKey);
              Object.keys(nested).forEach(function (k) {
                result[k] = nested[k];
              });
            } else if (typeof value !== "object") {
              result[fullKey] = value;
            }
          });
          return result;
        }

        var flatUser = flattenObject(user);

        // Step 2: Strip sensitive keys
        var context = {};
        Object.keys(flatUser).forEach(function (key) {
          var isSensitive = sensitiveKeys.some(function (sk) {
            return key.toLowerCase().includes(sk);
          });
          if (!isSensitive) {
            context[key] = flatUser[key];
          }
        });

        // Step 3: Smart aliasing
        var idSuffixes = [
          "id",
          "key",
          "code",
          "ref",
          "slug",
          "uuid",
          "num",
          "no",
        ];
        var cleanPrefixes = [
          "active",
          "current",
          "selected",
          "default",
          "my",
          "the",
          "this",
        ];

        Object.keys(context).forEach(function (key) {
          var lowerKey = key.toLowerCase();
          var isIdField = idSuffixes.some(function (suffix) {
            return lowerKey.endsWith(suffix);
          });

          if (isIdField && context[key]) {
            var cleanKey = key;
            cleanPrefixes.forEach(function (prefix) {
              var regex = new RegExp("^" + prefix, "i");
              if (regex.test(cleanKey)) {
                cleanKey = cleanKey.replace(regex, "");
                cleanKey = cleanKey.charAt(0).toLowerCase() + cleanKey.slice(1);
              }
            });

            if (cleanKey !== key && !context[cleanKey]) {
              context[cleanKey] = context[key];
            }
          }
        });

        console.log("[BotVersion] userContext being sent:", context);
        return context;
      };

    return new Promise(function (resolve) {
      console.log("[BotVersion] req.body:", JSON.stringify(req.body));
      console.log("[BotVersion] chatbotId from body:", req.body.chatbotId);
      self._client
        .agentChat({
          message: req.body.message,
          conversationHistory: req.body.conversationHistory || [],
          pageContext: req.body.pageContext || {},
          userContext: getUserContext(req),
          chatbotId: req.body.chatbotId,
          publicKey: req.body.publicKey,
        })
        .then(function (response) {
          res.status(200).json(response);
          resolve();
        })
        .catch(function (err) {
          console.error("[BotVersion SDK] chat error:", err);
          res.status(500).json({ error: "Agent error" });
          resolve();
        });
    });
  };
};

BotVersion.nextHandler = BotVersion.nextHandler.bind(BotVersion);

module.exports = BotVersion;
module.exports.default = BotVersion;
module.exports.init = BotVersion.init;
module.exports.getEndpoints = BotVersion.getEndpoints;
module.exports.registerEndpoint = BotVersion.registerEndpoint;
module.exports.chat = BotVersion.chat;
module.exports.nextHandler = BotVersion.nextHandler;

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
