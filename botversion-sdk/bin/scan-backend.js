#!/usr/bin/env node
"use strict";

var path = require("path");
var fs = require("fs");
var sdk = require("../index");
var BotVersionClient = require("../client");

// Auto-load env files from the customer's project, same precedence Next.js
// uses: .env first, then .env.local (which is allowed to override .env).
// dotenv.config() never overwrites a variable already set in process.env,
// so if the customer already exported the key in their shell/CI, that
// still takes priority over anything in these files.
(function loadEnvFiles() {
  var dotenv;
  try {
    dotenv = require("dotenv");
  } catch (e) {
    return; // dotenv not installed for some reason — skip silently
  }
  var cwd = process.cwd();
  [".env", ".env.local"].forEach(function (file) {
    var filePath = path.join(cwd, file);
    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath });
    }
  });
})();

var apiKey = process.env.BOTVERSION_API_KEY;
var platformUrl =
  process.env.BOTVERSION_PLATFORM_URL || "https://console.botversion.com";

if (!apiKey) {
  console.error(
    "[BotVersion] BOTVERSION_API_KEY environment variable is not set. Skipping backend endpoint scan.",
  );
  process.exit(0);
}

var cwd = process.cwd();
var client = new BotVersionClient({ apiKey: apiKey, platformUrl: platformUrl });

var detected = sdk.detectFrameworks(cwd);
var projectType = sdk.classifyInstallation(detected.backend, detected.frontend);

var shouldScanBackend =
  projectType === "fullstack" ||
  projectType === "backend-only" ||
  projectType === "mixed";

if (!shouldScanBackend) {
  process.exit(0);
}

// No live `app` instance exists at build time — pass null.
// All scanner functions read directly from the filesystem via cwd.
var endpoints = sdk.runBackendScanner(detected.backend, null, {}, cwd);

if (endpoints.length === 0) {
  process.exit(0);
}

client
  .registerEndpointsNow(endpoints)
  .then(function () {
    process.exit(0);
  })
  .catch(function (err) {
    console.error(
      "[BotVersion] Failed to report backend endpoints:",
      err.message,
    );
    process.exit(0);
  });
