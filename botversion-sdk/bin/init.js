#!/usr/bin/env node
// botversion-sdk/bin/init.js
"use strict";

const path = require("path");
const fs = require("fs");

const detector = require("../cli/detector");
const generator = require("../cli/generator");
const writer = require("../cli/writer");
const prompts = require("../cli/prompts");

// ─── COLORS ──────────────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
};

function log(msg) {
  console.log(msg);
}
function info(msg) {
  console.log(`${c.cyan}  ℹ${c.reset}  ${msg}`);
}
function info2(msg) {
  console.log(`${c.cyan}  ℹ${c.reset}  ${msg}`);
}
function success(msg) {
  console.log(`${c.green}  ✔${c.reset}  ${msg}`);
}
function warn(msg) {
  console.log(`${c.yellow}  ⚠${c.reset}  ${msg}`);
}
function error(msg) {
  console.log(`${c.red}  ✖${c.reset}  ${msg}`);
}
function step(msg) {
  console.log(`\n${c.bold}${c.white}  → ${msg}${c.reset}`);
}

// ─── FETCH PROJECT INFO ───────────────────────────────────────────────────────

async function fetchProjectInfo(apiKey, platformUrl) {
  const url = `${platformUrl}/api/sdk/project-info?workspaceKey=${encodeURIComponent(apiKey)}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("Invalid API key or project not found");
    }
    return await response.json();
    // returns { projectId, publicKey, apiUrl, cdnUrl }
  } catch (err) {
    throw new Error(`Could not fetch project info: ${err.message}`);
  }
}

// ─── PARSE ARGS ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { key: null, force: false, cwd: process.cwd() };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--key" && argv[i + 1]) {
      args.key = argv[i + 1];
      i++;
    } else if (argv[i] === "--force") {
      args.force = true;
    } else if (argv[i] === "--cwd" && argv[i + 1]) {
      args.cwd = path.resolve(argv[i + 1]);
      i++;
    }
  }

  return args;
}

// ─── BANNER ───────────────────────────────────────────────────────────────────

function printBanner() {
  log("");
  log(`${c.cyan}${c.bold}  ╔══════════════════════════════════════╗${c.reset}`);
  log(`${c.cyan}${c.bold}  ║       BotVersion SDK Setup CLI       ║${c.reset}`);
  log(`${c.cyan}${c.bold}  ╚══════════════════════════════════════╝${c.reset}`);
  log("");
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  printBanner();

  // ── Validate API key ───────────────────────────────────────────────────────
  if (!args.key) {
    error("API key is required.");
    log(`\n  Usage: npx botversion-sdk init --key YOUR_WORKSPACE_KEY\n`);
    log(`  Get your key from: https://app.botversion.com/settings\n`);
    process.exit(1);
  }

  const cwd = args.cwd;
  const changes = { modified: [], created: [], backups: [], manual: [] };

  // ── Fetch project info from platform ──────────────────────────────────────
  step("Fetching project info from platform...");
  let projectInfo;
  try {
    projectInfo = await fetchProjectInfo(args.key, "http://localhost:3000");
    success(`Project found — ID: ${projectInfo.projectId}`);
  } catch (err) {
    error(err.message);
    process.exit(1);
  }

  // ── Detect environment ────────────────────────────────────────────────────
  step("Scanning your project...");

  const monorepoInfo = detector.detectMonorepo(cwd);
  if (monorepoInfo.isMonorepo) {
    warn(
      "Monorepo detected — will scan all packages for frontend and backend.",
    );
  }

  const detected = detector.detect(cwd);

  // ── Check if already initialized ─────────────────────────────────────────
  if (detected.alreadyInitialized && !args.force) {
    warn("BotVersion SDK is already initialized in this project.");
    log(`\n  To reinitialize, run with --force flag:\n`);
    log(`  npx botversion-sdk init --key ${args.key} --force\n`);
    process.exit(0);
  }

  // ── Framework check ───────────────────────────────────────────────────────
  step("Detecting framework...");

  if (!detected.framework.name) {
    error("Could not detect a supported framework.");
    log(`\n  Supported: Express.js, Next.js`);
    log(`  Make sure you have them listed in package.json\n`);
    process.exit(1);
  }

  if (!detected.framework.supported) {
    warn(
      `Detected: ${detected.framework.name} (not yet supported for auto-setup)`,
    );
    log("");
    log(
      generator.generateManualInstructions(detected.framework.name, args.key),
    );
    process.exit(0);
  }

  success(`Framework: ${detected.framework.name}`);
  info(
    `Module system: ${detected.moduleSystem === "esm" ? "ES Modules" : "CommonJS"}`,
  );
  info(`Language: ${detected.isTypeScript ? "TypeScript" : "JavaScript"}`);
  info(`Package manager: ${detected.packageManager}`);

  // ─────────────────────────────────────────────────────────────────────────
  // FRAMEWORK: NEXT.JS
  // ─────────────────────────────────────────────────────────────────────────
  if (detected.framework.name === "next") {
    await setupNextJs(detected, args, changes, projectInfo);

    // ── Also check for a separate Express backend folder ──────────────────
    step("Checking for separate backend...");
    const backendDirs = ["backend", "server", "api", "services"];
    let expressBackendFound = false;

    for (const dir of backendDirs) {
      const backendPath = path.join(cwd, dir);
      if (!fs.existsSync(backendPath)) continue;

      // Check if this folder has its own package.json with express
      const backendPkg = detector.readPackageJson(backendPath);
      const backendDeps = {
        ...((backendPkg && backendPkg.dependencies) || {}),
        ...((backendPkg && backendPkg.devDependencies) || {}),
      };
      const hasExpress = !!backendDeps["express"];

      // Or check if any JS file in this folder has express routes
      const hasExpressFiles = fs.readdirSync(backendPath).some((file) => {
        if (!/\.(js|ts)$/.test(file)) return false;
        try {
          const content = fs.readFileSync(path.join(backendPath, file), "utf8");
          return (
            content.includes("express()") ||
            content.includes("express(") || // factory pattern
            /class\s+\w+\s+extends\s+express/.test(content) || // subclass
            /(?:create|make|build|setup)App\s*\(/.test(content) || // factory fn
            /(?:app|router|server)\.(get|post|put|delete|patch|all)\s*\(\s*['"`]\//.test(
              content,
            )
          );
        } catch {
          return false;
        }
      });

      if (hasExpress || hasExpressFiles) {
        expressBackendFound = true;
        warn(`Found Express backend in "${dir}/" folder.`);

        // Detect the backend separately
        const backendDetected = detector.detect(backendPath);

        if (backendDetected.entryPoint) {
          success(
            `Backend entry point: ${path.relative(cwd, backendDetected.entryPoint)}`,
          );
          await setupExpress(backendDetected, args, changes, projectInfo);
        } else {
          warn(`Could not find entry point in "${dir}/" automatically.`);
          const manualPath = await prompts.promptEntryPoint();
          const resolvedPath = path.resolve(backendPath, manualPath);
          if (fs.existsSync(resolvedPath)) {
            backendDetected.entryPoint = resolvedPath;
            await setupExpress(backendDetected, args, changes, projectInfo);
          } else {
            error(`File not found: ${resolvedPath}`);
          }
        }
        break; // only set up one backend
      }
    }

    if (!expressBackendFound) {
      info("No separate Express backend found — skipping.");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FRAMEWORK: EXPRESS ONLY
  // ─────────────────────────────────────────────────────────────────────────
  else if (detected.framework.name === "express") {
    await setupExpress(detected, args, changes, projectInfo);

    if (detected.frontendMainFile && projectInfo) {
      const scriptTag = generator.generateScriptTag(projectInfo);
      const result = writer.injectScriptTag(
        detected.frontendMainFile.file,
        detected.frontendMainFile.type,
        scriptTag,
        args.force,
      );

      if (result.success) {
        success(
          `Injected script tag into ${path.relative(detected.cwd, detected.frontendMainFile.file)}`,
        );
        changes.modified.push(
          path.relative(detected.cwd, detected.frontendMainFile.file),
        );
        if (result.backup) changes.backups.push(result.backup);
      } else if (result.reason === "already_exists") {
        warn(
          "BotVersion script tag already exists in frontend file — skipping.",
        );
      } else {
        warn(
          "Could not auto-inject script tag. Add this manually to your frontend HTML:",
        );
        console.log("\n" + scriptTag + "\n");
        changes.manual.push(
          `Add to your frontend HTML before </body>:\n\n${scriptTag}`,
        );
      }
    } else if (!detected.frontendMainFile) {
      warn("Could not find frontend main file automatically.");
      const scriptTag = generator.generateScriptTag(projectInfo);
      changes.manual.push(
        `Add to your frontend HTML before </body>:\n\n${scriptTag}`,
      );
    }
  }

  // ── Print summary ─────────────────────────────────────────────────────────
  log(writer.writeSummary(changes));
}

// ─── EXPRESS SETUP ────────────────────────────────────────────────────────────

async function setupExpress(detected, args, changes, projectInfo) {
  step("Setting up Express...");

  let entryPoint = detected.entryPoint;

  if (!entryPoint || !fs.existsSync(entryPoint)) {
    warn("Could not find your server entry point automatically.");
    const manualPath = await prompts.promptEntryPoint();
    entryPoint = path.resolve(detected.cwd, manualPath);

    if (!fs.existsSync(entryPoint)) {
      error(`File not found: ${entryPoint}`);
      process.exit(1);
    }
  }

  success(`Entry point: ${path.relative(detected.cwd, entryPoint)}`);
  let entryPointTracked = false;

  // ── Write API key to .env ──────────────────────────────────────────────
  const shouldWriteEnv = await prompts.confirm(
    "  Add BOTVERSION_API_KEY to your .env file?",
    true,
  );

  if (shouldWriteEnv) {
    const envResult = writer.writeEnvKey(
      detected.cwd,
      "BOTVERSION_API_KEY",
      args.key,
      "express",
    );
    if (envResult.success) {
      success(
        `Added BOTVERSION_API_KEY to ${path.relative(detected.cwd, envResult.path)}`,
      );
      changes.modified.push(path.relative(detected.cwd, envResult.path));
    } else if (envResult.reason === "already_exists") {
      info("BOTVERSION_API_KEY already exists in .env — skipping.");
    } else {
      warn("Could not write to .env — add this manually:");
      changes.manual.push(
        `Add to your .env file:\n\n    BOTVERSION_API_KEY=${args.key}`,
      );
    }
  } else {
    info("Skipped — add this manually to your .env file:");
    changes.manual.push(
      `Add to your .env file:\n\n    BOTVERSION_API_KEY=${args.key}`,
    );
  }

  // ── Inject CORS ──────────────────────────────────────────────────────────
  step("Configuring CORS...");

  const allowedOrigins = [];
  if (projectInfo.apiUrl) allowedOrigins.push(projectInfo.apiUrl);
  if (projectInfo.cdnUrl) allowedOrigins.push(projectInfo.cdnUrl);
  if (allowedOrigins.length === 0) allowedOrigins.push("http://localhost:3000");

  if (detector.detectCors(entryPoint, "express")) {
    info("CORS already configured — skipping.");
  } else {
    // Install cors package
    const { execSync } = require("child_process");
    const installCmd =
      detected.packageManager === "yarn"
        ? "yarn add cors"
        : detected.packageManager === "pnpm"
          ? "pnpm add cors"
          : detected.packageManager === "bun"
            ? "bun add cors"
            : "npm install cors";

    try {
      execSync(installCmd, { cwd: detected.cwd, stdio: "inherit" });
      success("cors package installed successfully");
    } catch (err) {
      warn("Could not install cors automatically.");
      changes.manual.push(`Install cors manually:\n\n    ${installCmd}`);
    }

    const corsCode = generator.generateExpressCors(
      detected.appVarName || "app",
      allowedOrigins,
    );
    const corsResult = writer.injectCors(
      entryPoint,
      corsCode,
      detected.appVarName || "app",
    );

    if (corsResult.success) {
      success(
        `Added CORS configuration to ${path.relative(detected.cwd, entryPoint)}`,
      );
      if (!entryPointTracked) {
        changes.modified.push(path.relative(detected.cwd, entryPoint));
        entryPointTracked = true;
      }
      if (corsResult.backup) changes.backups.push(corsResult.backup);
    } else if (corsResult.reason === "already_exists") {
      info("CORS already configured — skipping.");
    } else {
      warn("Could not auto-configure CORS — add manually:");
      changes.manual.push(
        generator.generateExpressCorsManualInstructions(allowedOrigins),
      );
    }
  }

  if (!detected.hasDotenv) {
    warn("dotenv not detected — installing it automatically...");

    const { execSync } = require("child_process");
    const installCmd =
      detected.packageManager === "yarn"
        ? "yarn add dotenv"
        : detected.packageManager === "pnpm"
          ? "pnpm add dotenv"
          : detected.packageManager === "bun"
            ? "bun add dotenv"
            : "npm install dotenv";

    try {
      execSync(installCmd, { cwd: detected.cwd, stdio: "inherit" });
      success("dotenv installed successfully");

      const isESM = detected.moduleSystem === "esm";
      const dotenvLine = isESM
        ? `import 'dotenv/config';`
        : `require('dotenv').config();`;

      const injectResult = writer.injectAtTop(entryPoint, dotenvLine);
      if (injectResult.success) {
        success("Added dotenv config to entry file");
        changes.modified.push(path.relative(detected.cwd, entryPoint));
        if (injectResult.backup) changes.backups.push(injectResult.backup);
      }

      detected.hasDotenv = true;
    } catch (err) {
      warn("Could not install dotenv automatically.");
      warn(`Please run manually: ${installCmd}`);
      warn("And add to top of your entry file: require('dotenv').config();");
      changes.manual.push(
        `Install dotenv: ${installCmd}\n` +
          `Add to top of ${path.relative(detected.cwd, entryPoint)}: require('dotenv').config();`,
      );
    }
  }

  const generated = generator.generateExpressInit(detected, args.key);

  // PATTERN 2: Separate app file with module.exports = app
  if (detected.appFile) {
    info(`Found app file: ${path.relative(detected.cwd, detected.appFile)}`);
    const generated2 = generator.generateExpressInit(detected, args.key);
    const result = writer.injectBeforeExport(
      detected.appFile,
      generated2.initBlock,
      detected.appVarName,
    );

    if (result.success) {
      success(
        `Injected BotVersion.init() into ${path.relative(detected.cwd, detected.appFile)}`,
      );
      changes.modified.push(path.relative(detected.cwd, detected.appFile));
    } else if (result.reason === "already_exists") {
      warn("BotVersion already found — skipping injection.");
    }
  }

  // PATTERN 1 & 3 & 4: app.listen() in entry file
  else if (
    detected.listenCall ||
    detected.listenInsideCallback ||
    detected.createServer
  ) {
    const result = writer.injectBeforeListen(
      entryPoint,
      generated.initBlock,
      detected.appVarName,
    );

    if (result.success) {
      success(`Injected BotVersion.init() before app.listen()`);
      if (!entryPointTracked) {
        changes.modified.push(path.relative(detected.cwd, entryPoint));
        entryPointTracked = true;
      }
      if (result.backup) changes.backups.push(result.backup);
    } else if (result.reason === "already_exists") {
      warn("BotVersion already found in entry point — skipping injection.");
    }
  }

  // LAST RESORT: ask the user
  else {
    warn("Could not find the right place to inject automatically.");
    const response = await prompts.promptMissingListenCall(
      path.relative(detected.cwd, entryPoint),
    );

    if (response.action === "append") {
      const result = writer.appendToFile(entryPoint, generated.initBlock);
      if (result.success) {
        success("Appended BotVersion setup to end of file.");
        changes.modified.push(path.relative(detected.cwd, entryPoint));
      }
    } else if (response.action === "manual_path") {
      const altPath = path.resolve(detected.cwd, response.filePath);
      if (fs.existsSync(altPath)) {
        const result = writer.injectBeforeListen(
          altPath,
          generated.initBlock,
          detected.appVarName,
        );
        if (result.success) {
          success(`Injected into ${response.filePath}`);
          changes.modified.push(response.filePath);
        }
      } else {
        error(`File not found: ${altPath}`);
        changes.manual.push(
          `Add this to your server file:\n${generated.initBlock}`,
        );
      }
    } else {
      changes.manual.push(
        `Add this to your server file before app.listen():\n\n${generated.initBlock}`,
      );
      warn("Skipped — see manual steps below.");
    }
  }
}

// ─── NEXT.JS SETUP ────────────────────────────────────────────────────────────

async function setupNextJs(detected, args, changes, projectInfo) {
  step("Setting up Next.js...");

  const nextInfo = detected.next;
  const baseDir = nextInfo.baseDir;

  // ── Write API key to .env ──────────────────────────────────────────────
  const shouldWriteEnv = await prompts.confirm(
    "  Add BOTVERSION_API_KEY to your .env file automatically?",
    true,
  );

  if (shouldWriteEnv) {
    const envResult = writer.writeEnvKey(
      detected.cwd,
      "BOTVERSION_API_KEY",
      args.key,
      "next",
    );
    if (envResult.success) {
      success(
        `Added BOTVERSION_API_KEY to ${path.relative(detected.cwd, envResult.path)}`,
      );
      changes.modified.push(path.relative(detected.cwd, envResult.path));
    } else if (envResult.reason === "already_exists") {
      info("BOTVERSION_API_KEY already exists in .env — skipping.");
    } else {
      warn("Could not write to .env — add this manually:");
      changes.manual.push(
        `Add to your .env file:\n\n    BOTVERSION_API_KEY=${args.key}`,
      );
    }
  } else {
    info("Skipped — add this manually to your .env file:");
    changes.manual.push(
      `Add to your .env file:\n\n    BOTVERSION_API_KEY=${args.key}`,
    );
  }

  info2(
    `Router: ${nextInfo.pagesRouter ? "Pages" : ""}${nextInfo.pagesRouter && nextInfo.appRouter ? " + " : ""}${nextInfo.appRouter ? "App" : ""}`,
  );

  // ── CORS middleware for Next.js ──────────────────────────────────────────
  step("Configuring CORS...");

  const allowedOrigins = [];
  if (projectInfo.apiUrl) allowedOrigins.push(projectInfo.apiUrl);
  if (projectInfo.cdnUrl) allowedOrigins.push(projectInfo.cdnUrl);
  if (allowedOrigins.length === 0) allowedOrigins.push("http://localhost:3000");

  const middlewareInfo = detector.detectNextJsMiddleware(detected.cwd);

  if (middlewareInfo.hasCors) {
    // Already has CORS — skip entirely
    info("CORS already configured in middleware — skipping.");
  } else if (middlewareInfo.exists) {
    // Middleware exists but no CORS — inject into it
    info(
      `Found existing middleware at ${path.relative(detected.cwd, middlewareInfo.path)} — injecting CORS...`,
    );

    const injectResult = writer.injectCorsIntoMiddleware(
      middlewareInfo.path,
      allowedOrigins,
    );

    if (injectResult.success) {
      success(
        `Injected CORS into ${path.relative(detected.cwd, middlewareInfo.path)}`,
      );
      changes.modified.push(path.relative(detected.cwd, middlewareInfo.path));
      if (injectResult.backup) changes.backups.push(injectResult.backup);
    } else if (injectResult.reason === "already_exists") {
      info("CORS already configured in middleware — skipping.");
    } else {
      warn("Could not inject CORS into existing middleware — add manually:");
      changes.manual.push(
        `Add to your middleware file (${path.relative(detected.cwd, middlewareInfo.path)}):\n\n` +
          `  response.headers.set('Access-Control-Allow-Origin', '${allowedOrigins[0]}');\n` +
          `  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');\n` +
          `  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');`,
      );
    }
  } else {
    // No middleware file — create one
    const isESM = detected.moduleSystem === "esm";
    const middlewareContent = detected.isTypeScript
      ? generator.generateNextJsMiddleware(allowedOrigins)
      : generator.generateNextJsMiddlewareJs(allowedOrigins, isESM);

    const middlewareFile = detected.hasSrc
      ? path.join(
          detected.cwd,
          "src",
          detected.isTypeScript ? "middleware.ts" : "middleware.js",
        )
      : path.join(
          detected.cwd,
          detected.isTypeScript ? "middleware.ts" : "middleware.js",
        );

    const middlewareResult = writer.createFile(
      middlewareFile,
      middlewareContent,
      args.force,
    );

    if (middlewareResult.success) {
      success(`Created ${path.relative(detected.cwd, middlewareFile)}`);
      changes.created.push(path.relative(detected.cwd, middlewareFile));
    } else {
      warn("Could not create middleware file — add CORS manually.");
      changes.manual.push(
        `Create middleware.ts in your project root with CORS config for: ${allowedOrigins.join(", ")}`,
      );
    }
  }

  // ── 1. Create instrumentation.js ──────────────────────────────────────────
  const instrExt = detected.generateTs ? ".ts" : ".js";
  const instrFile = path.join(detected.cwd, `instrumentation${instrExt}`);

  const instrContent = generator.generateInstrumentationFile(
    detected,
    args.key,
  );
  const instrResult = writer.createFile(instrFile, instrContent, args.force);

  if (instrResult.success) {
    success(`Created instrumentation${instrExt}`);
    changes.created.push(`instrumentation${instrExt}`);
  } else if (instrResult.reason === "already_exists") {
    const overwrite = await prompts.promptForce(`instrumentation${instrExt}`);
    if (overwrite) {
      writer.createFile(instrFile, instrContent, true);
      success(`Overwrote instrumentation${instrExt}`);
      changes.modified.push(`instrumentation${instrExt}`);
    } else {
      warn(`Skipped instrumentation${instrExt}`);
    }
  }

  // ── 2. Patch next.config.js ───────────────────────────────────────────────
  const configPatch = generator.generateNextConfigPatch(
    detected.cwd,
    detected.nextVersion,
  );

  if (configPatch) {
    if (configPatch.alreadyPatched) {
      info("next.config.js already has instrumentationHook — skipping.");
    } else {
      fs.writeFileSync(configPatch.path, configPatch.content, "utf8");
      success(`Updated ${path.relative(detected.cwd, configPatch.path)}`);
      changes.modified.push(path.relative(detected.cwd, configPatch.path));
    }
  } else {
    warn("Could not find next.config.js — please add this manually:");
    changes.manual.push(
      `Add to your next.config.js:\n\n  experimental: {\n    instrumentationHook: true,\n  }`,
    );
  }

  // ── 3. Inject script tag into frontend ───────────────────────────────────
  if (detected.frontendMainFile && projectInfo) {
    const scriptTag = generator.generateScriptTag(projectInfo);
    const result = writer.injectScriptTag(
      detected.frontendMainFile.file,
      detected.frontendMainFile.type,
      scriptTag,
      args.force,
    );

    if (result.success) {
      success(
        `Injected script tag into ${path.relative(detected.cwd, detected.frontendMainFile.file)}`,
      );
      changes.modified.push(
        path.relative(detected.cwd, detected.frontendMainFile.file),
      );
      if (result.backup) changes.backups.push(result.backup);
    } else if (result.reason === "already_exists") {
      warn("BotVersion script tag already exists — skipping.");
    } else {
      warn(
        "Could not auto-inject script tag. Add this manually to your frontend file:",
      );
      console.log("\n" + scriptTag + "\n");
      changes.manual.push(
        `Add to your frontend HTML before </body>:\n\n${scriptTag}`,
      );
    }
  } else if (!detected.frontendMainFile) {
    warn("Could not find frontend file automatically.");
    const scriptTag = generator.generateScriptTag(projectInfo);
    changes.manual.push(
      `Add to your frontend HTML before </body>:\n\n${scriptTag}`,
    );
  }
}

// ─── RUN ──────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(`\n${c.red}  ✖  Unexpected error:${c.reset}`, err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
