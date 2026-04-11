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

  // ── Detect environment ────────────────────────────────────────────────────
  step("Scanning your project...");

  // Handle monorepo
  let workingDir = cwd;
  const monorepoInfo = detector.detectMonorepo(cwd);
  if (monorepoInfo.isMonorepo) {
    warn("Monorepo detected.");
    workingDir = await prompts.promptMonorepoPackage(
      monorepoInfo.packages,
      cwd,
    );
    info(`Using package: ${path.relative(cwd, workingDir) || "root"}`);
  }

  // Run full detection
  const detected = detector.detect(workingDir);

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

  // ── Auth detection ────────────────────────────────────────────────────────
  step("Detecting auth library...");

  let auth = detected.auth;

  if (!auth.name) {
    warn("No auth library detected automatically.");
    auth = await prompts.promptAuthLibrary();
    detected.auth = auth;
  } else if (!auth.supported) {
    warn(`Detected auth: ${auth.name} (not yet supported for auto-setup)`);
    warn("Will set up without user context — you can add it manually later.");
    const proceed = await prompts.confirm("Continue without auth?", true);
    if (!proceed) process.exit(0);
    auth = { name: auth.name, supported: false };
    detected.auth = auth;
  } else {
    const versionLabel = auth.version ? ` (${auth.version})` : "";
    success(`Auth: ${auth.name}${versionLabel}`);
  }

  // ── Package manager ───────────────────────────────────────────────────────
  info(`Package manager: ${detected.packageManager}`);

  // ─────────────────────────────────────────────────────────────────────────
  // FRAMEWORK: EXPRESS
  // ─────────────────────────────────────────────────────────────────────────
  if (detected.framework.name === "express") {
    await setupExpress(detected, args, changes);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FRAMEWORK: NEXT.JS
  // ─────────────────────────────────────────────────────────────────────────
  else if (detected.framework.name === "next") {
    await setupNextJs(detected, args, changes);
  }

  // ── Write API key to .env / .env.local ────────────────────────────────────
  const envFileName =
    detected.framework.name === "next" ? ".env.local" : ".env";
  const envPath = path.join(workingDir, envFileName);
  const envLine = `BOTVERSION_API_KEY=${args.key}`;
  const envContent = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8")
    : "";

  if (!envContent.includes("BOTVERSION_API_KEY")) {
    const writeEnv = await prompts.confirm(
      `Add BOTVERSION_API_KEY to ${envFileName}?`,
      true,
    );

    if (writeEnv) {
      const envAddition = "\n\n# BotVersion API key\n" + envLine + "\n";
      fs.writeFileSync(envPath, envContent.trimEnd() + envAddition, "utf8");
      success(`Added BOTVERSION_API_KEY to ${envFileName}`);
      changes.modified.push(envFileName);
    } else {
      warn(`Skipped — add this manually to your ${envFileName}:`);
      log(`\n    # BotVersion API key`);
      log(`    BOTVERSION_API_KEY=${args.key}\n`);
      changes.manual.push(
        `Add to your ${envFileName}:\n\n    # BotVersion API key\n    BOTVERSION_API_KEY=${args.key}`,
      );
    }
  } else {
    info(`BOTVERSION_API_KEY already exists in ${envFileName} — skipping.`);
  }

  // ── Print summary ─────────────────────────────────────────────────────────
  log(writer.writeSummary(changes));
}

// ─── EXPRESS SETUP ────────────────────────────────────────────────────────────

async function setupExpress(detected, args, changes) {
  step("Setting up Express...");

  // Find entry point
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

  // Generate the init code
  const generated = generator.generateExpressInit(detected, args.key);

  // Find app.listen() and inject before it
  const listenCall = detector.findListenCall(entryPoint);

  // PATTERN 2: Separate app file with module.exports = app
  if (detected.appFile) {
    info(`Found app file: ${path.relative(detected.cwd, detected.appFile)}`);
    const generated2 = generator.generateExpressInit(detected, args.key);
    const result = writer.injectBeforeExport(
      detected.appFile,
      generated2.initBlock,
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

  // PATTERN 1 & 3 & 4: app.listen() or server.listen() in entry file
  else if (
    detected.listenCall ||
    detected.listenInsideCallback ||
    detected.createServer
  ) {
    const result = writer.injectBeforeListen(entryPoint, generated.initBlock);

    if (result.success) {
      success(`Injected BotVersion.init() before app.listen()`);
      changes.modified.push(path.relative(detected.cwd, entryPoint));
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
        const result = writer.injectBeforeListen(altPath, generated.initBlock);
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

async function setupNextJs(detected, args, changes) {
  step("Setting up Next.js...");

  const nextInfo = detected.next;
  const baseDir = nextInfo.baseDir;

  info2(
    `Router: ${nextInfo.pagesRouter ? "Pages" : ""}${nextInfo.pagesRouter && nextInfo.appRouter ? " + " : ""}${nextInfo.appRouter ? "App" : ""}`,
  );

  // ── next-auth config location ─────────────────────────────────────────────
  if (detected.auth.name === "next-auth" && !detected.nextAuthConfig) {
    warn("Could not find authOptions location automatically.");
    const configPath = await prompts.promptNextAuthConfigPath();
    detected.nextAuthConfig = {
      path: path.resolve(detected.cwd, configPath),
      relativePath: configPath,
    };
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
  const configPatch = generator.generateNextConfigPatch(detected.cwd);

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

  // ── 3. Pages Router chat route ────────────────────────────────────────────
  if (nextInfo.pagesRouter) {
    const pagesBase = path.join(baseDir, "pages");
    const chatDir = path.join(pagesBase, "api", "botversion");
    const chatFile = path.join(chatDir, `chat${instrExt}`);

    const chatContent = generator.generateNextPagesChatRoute(detected);
    const chatResult = writer.createFile(chatFile, chatContent, args.force);

    const relPath = `${nextInfo.srcDir ? "src/" : ""}pages/api/botversion/chat${instrExt}`;

    if (chatResult.success) {
      success(`Created ${relPath}`);
      changes.created.push(relPath);
    } else if (chatResult.reason === "already_exists") {
      const overwrite = await prompts.promptForce(relPath);
      if (overwrite) {
        writer.createFile(chatFile, chatContent, true);
        success(`Overwrote ${relPath}`);
        changes.modified.push(relPath);
      } else {
        warn(`Skipped ${relPath}`);
      }
    }
  }

  // ── 4. App Router chat route ──────────────────────────────────────────────
  if (nextInfo.appRouter) {
    const appBase = path.join(baseDir, "app");
    const chatDir = path.join(appBase, "api", "botversion", "chat");
    const chatFile = path.join(chatDir, `route${instrExt}`);

    const chatContent = generator.generateNextAppChatRoute(detected);
    const relPath = `${nextInfo.srcDir ? "src/" : ""}app/api/botversion/chat/route${instrExt}`;

    const chatResult = writer.createFile(chatFile, chatContent, args.force);

    if (chatResult.success) {
      success(`Created ${relPath}`);
      changes.created.push(relPath);
    } else if (chatResult.reason === "already_exists") {
      const overwrite = await prompts.promptForce(relPath);
      if (overwrite) {
        writer.createFile(chatFile, chatContent, true);
        success(`Overwrote ${relPath}`);
        changes.modified.push(relPath);
      } else {
        warn(`Skipped ${relPath}`);
      }
    }
  }
}

// ─── RUN ──────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(`\n${c.red}  ✖  Unexpected error:${c.reset}`, err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
