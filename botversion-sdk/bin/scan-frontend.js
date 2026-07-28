#!/usr/bin/env node
"use strict";

var scanner = require("../scanner");
var BotVersionClient = require("../client");
var sdk = require("../index");

var apiKey = process.env.BOTVERSION_API_KEY;
var platformUrl =
  process.env.BOTVERSION_PLATFORM_URL || "https://botversion.com";

if (!apiKey) {
  console.error(
    "[BotVersion] BOTVERSION_API_KEY environment variable is not set. Skipping frontend route scan.",
  );
  process.exit(0);
}

var cwd = process.cwd();
var client = new BotVersionClient({ apiKey: apiKey, platformUrl: platformUrl });

var detected = sdk.detectFrameworks(cwd);
var projectType = sdk.classifyInstallation(detected.backend, detected.frontend);
var routePatterns = scanner.scanFrontendRoutes(cwd);

client
  .registerRoutePatterns(routePatterns, {
    source: "cli",
    projectType: projectType,
    detectedBackend: detected.backend,
    detectedFrontend: detected.frontend,
    sdkLanguage: "javascript",
  })
  .then(function () {
    console.log(
      "[BotVersion] Reported " +
        routePatterns.length +
        " frontend routes. projectType=" +
        projectType,
    );
    process.exit(0);
  })
  .catch(function (err) {
    console.error(
      "[BotVersion] Failed to report frontend routes:",
      err.message,
    );
    process.exit(0);
  });
