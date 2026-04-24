// botversion-sdk/cli/writer.js

"use strict";

const fs = require("fs");
const path = require("path");

// ─── SAFE FILE WRITE ─────────────────────────────────────────────────────────

function writeFile(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

// ─── BACKUP A FILE BEFORE MODIFYING ─────────────────────────────────────────

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const backupPath = filePath + ".backup-before-botversion";
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

// ─── INJECT CODE BEFORE app.listen() ────────────────────────────────────────

function injectBeforeListen(filePath, codeToInject, appVarName) {
  appVarName = appVarName || "app";
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const listenRegex = new RegExp(`${appVarName}\\.listen\\s*\\(`);

  // Check if BotVersion already exists in file
  if (content.includes("botversion-sdk") || content.includes("BotVersion")) {
    return { success: false, reason: "already_exists" };
  }

  let listenLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (listenRegex.test(lines[i])) {
      listenLineIndex = i;
      break;
    }
  }

  if (listenLineIndex === -1) {
    return {
      success: false,
      reason: "no_listen",
      suggestion: "append",
    };
  }

  // ── NEW: Check if app.listen() is inside if (require.main === module) ──
  // If so, inject before that if block instead of inside it
  let insertIndex = listenLineIndex;

  for (let i = listenLineIndex; i >= 0; i--) {
    const trimmed = lines[i].trim();

    // Found if (require.main === module) block
    if (
      /if\s*\(\s*require\.main\s*===?\s*module\s*\)/.test(trimmed) ||
      /if\s*\(\s*module\s*===?\s*require\.main\s*\)/.test(trimmed)
    ) {
      insertIndex = i;
      // Keep walking back to check for 404/error handlers before this
      continue;
    }

    // Found a 404 handler — inject before this instead
    if (
      /app\.use\s*\(\s*\(req,\s*res\)\s*=>/.test(trimmed) ||
      /app\.use\s*\(\s*function\s*\(req,\s*res\)/.test(trimmed)
    ) {
      insertIndex = i;
      continue;
    }

    // Found a global error handler — inject before this instead
    if (
      /app\.use\s*\(\s*\(err,\s*req,\s*res,\s*next\)/.test(trimmed) ||
      /app\.use\s*\(\s*function\s*\(err,\s*req,\s*res,\s*next\)/.test(trimmed)
    ) {
      insertIndex = i;
      continue;
    }

    // Stop walking back if we hit a top-level non-empty statement
    if (
      i < listenLineIndex &&
      trimmed !== "" &&
      trimmed !== "}" &&
      trimmed !== "})" &&
      trimmed !== "});" &&
      lines[i].match(/^[^\s]/)
    ) {
      break;
    }
  }

  // Insert the code block at the correct position
  const before = lines.slice(0, insertIndex);
  const after = lines.slice(insertIndex);
  const injectedLines = ["", ...codeToInject.split("\n"), ""];
  const newContent = [...before, ...injectedLines, ...after].join("\n");

  const backup = backupFile(filePath);
  fs.writeFileSync(filePath, newContent, "utf8");

  return { success: true, lineNumber: insertIndex + 1, backup };
}

// ─── APPEND CODE TO END OF FILE ──────────────────────────────────────────────

function appendToFile(filePath, codeToAppend) {
  const content = fs.readFileSync(filePath, "utf8");

  if (content.includes("botversion-sdk") || content.includes("BotVersion")) {
    return { success: false, reason: "already_exists" };
  }

  backupFile(filePath);
  const newContent = content.trimEnd() + "\n\n" + codeToAppend + "\n";
  fs.writeFileSync(filePath, newContent, "utf8");
  return { success: true };
}

// ─── CREATE A NEW FILE (won't overwrite unless forced) ───────────────────────

function createFile(filePath, content, force) {
  if (fs.existsSync(filePath) && !force) {
    return { success: false, reason: "already_exists", path: filePath };
  }

  if (fs.existsSync(filePath) && force) {
    backupFile(filePath);
  }

  writeFile(filePath, content);
  return { success: true, path: filePath };
}

function injectBeforeExport(filePath, codeToInject, appVarName) {
  appVarName = appVarName || "app";
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  if (content.includes("botversion-sdk") || content.includes("BotVersion")) {
    return { success: false, reason: "already_exists" };
  }

  let insertIndex = -1;

  // Find module.exports = app
  let exportsLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/module\.exports\s*=\s*app/.test(lines[i])) {
      exportsLine = i;
      break;
    }
  }

  if (exportsLine !== -1) {
    // Walk backwards from module.exports to skip error handler lines
    // Skip lines that are: blank, closing braces, or known error middleware
    let i = exportsLine - 1;
    while (i >= 0) {
      const line = lines[i].trim();
      if (
        line === "" ||
        line === "})" ||
        line === "});" ||
        line === "}," ||
        line === "}" ||
        line === ");" ||
        line === "next();" ||
        /app\.use\s*\(\s*errorHandler/.test(line) ||
        /app\.use\s*\(\s*errorConverter/.test(line) ||
        /app\.use\s*\(\s*\(req,\s*res,\s*next\)/.test(line) ||
        /next\(new/.test(line) ||
        /NOT_FOUND/.test(line) ||
        /Not found/i.test(line) ||
        /\/\/ (handle|convert|send back) error/.test(lines[i]) ||
        /\/\/ send back a 404/.test(lines[i])
      ) {
        i--;
      } else {
        break;
      }
    }
    insertIndex = i + 1;
  }

  // Fallback: before app.listen()
  if (insertIndex === -1) {
    for (let i = 0; i < lines.length; i++) {
      const listenRegex = new RegExp(`${appVarName}\\.listen\\s*\\(`);
      if (listenRegex.test(lines[i])) {
        insertIndex = i;
        break;
      }
    }
  }

  // Final fallback: append to end of file
  if (insertIndex === -1) {
    const backup = backupFile(filePath);
    const newContent = content.trimEnd() + "\n\n" + codeToInject + "\n";
    fs.writeFileSync(filePath, newContent, "utf8");
    return { success: true, backup };
  }

  const before = lines.slice(0, insertIndex);
  const after = lines.slice(insertIndex);
  const injectedLines = ["", ...codeToInject.split("\n"), ""];
  const newContent = [...before, ...injectedLines, ...after].join("\n");

  const backup = backupFile(filePath);
  fs.writeFileSync(filePath, newContent, "utf8");
  return { success: true, backup };
}

// ─── WRITE SUMMARY OF ALL CHANGES ────────────────────────────────────────────

function writeSummary(changes) {
  const lines = [
    "",
    "┌─────────────────────────────────────────────┐",
    "│         BotVersion Setup Complete!          │",
    "└─────────────────────────────────────────────┘",
    "",
  ];

  if (changes.modified && changes.modified.length > 0) {
    lines.push("  Modified files:");
    changes.modified.forEach((f) => lines.push(`    [Modified]  ${f}`));
    lines.push("");
  }

  if (changes.created && changes.created.length > 0) {
    lines.push("  Created files:");
    changes.created.forEach((f) => lines.push(`    [Created]   ${f}`));
    lines.push("");
  }

  if (changes.backups && changes.backups.length > 0) {
    lines.push("  Backups created:");
    changes.backups.forEach((f) => lines.push(`    [Backup]    ${f}`));
    lines.push("");
  }

  if (changes.manual && changes.manual.length > 0) {
    lines.push("  Manual steps needed:");
    changes.manual.forEach((m) => lines.push(`    [Manual]    ${m}`));
    lines.push("");
  }

  lines.push("  Next: Restart your server and test the chat widget.");
  lines.push("  Docs: https://docs.botversion.com");
  lines.push("");

  return lines.join("\n");
}

// ─── INJECT SCRIPT TAG INTO FRONTEND FILE ────────────────────────────────────

function injectScriptTag(filePath, fileType, scriptTag, force) {
  if (!fs.existsSync(filePath)) {
    return { success: false, reason: "file_not_found" };
  }

  const content = fs.readFileSync(filePath, "utf8");

  // Already exists check
  if (content.includes("botversion-loader")) {
    if (!force) return { success: false, reason: "already_exists" };
  }

  const backup = backupFile(filePath);

  // ── HTML file — inject before </body> ──────────────────────────────────
  if (fileType === "html") {
    if (!content.includes("</body>")) {
      return { success: false, reason: "no_body_tag" };
    }

    const newContent = content.replace("</body>", `  ${scriptTag}\n</body>`);
    fs.writeFileSync(filePath, newContent, "utf8");
    return { success: true, backup };
  }

  // ── Next.js _app.js — inject Script component ──────────────────────────
  if (fileType === "next") {
    const fileName = path.basename(filePath);

    // pages/_app.js
    if (fileName.startsWith("_app")) {
      return injectIntoNextApp(filePath, content, scriptTag, backup);
    }

    // app/layout.js
    if (fileName.startsWith("layout")) {
      return injectIntoNextLayout(filePath, content, scriptTag, backup);
    }
  }

  return { success: false, reason: "unsupported_file_type" };
}

// ─── INJECT INTO NEXT.JS _app.js ─────────────────────────────────────────────

function injectIntoNextApp(filePath, content, scriptTag, backup) {
  let newContent = content;

  if (!content.includes("next/script")) {
    newContent = newContent.replace(
      /^(import .+)/m,
      `import Script from 'next/script';\n$1`,
    );
  }

  const scriptComponent = `
      <Script
        id="botversion-loader"
        src="${extractAttr(scriptTag, "src")}"
        data-api-url="${extractAttr(scriptTag, "data-api-url")}"
        data-project-id="${extractAttr(scriptTag, "data-project-id")}"
        data-public-key="${extractAttr(scriptTag, "data-public-key")}"
        strategy="afterInteractive"
      />`;

  const lines = newContent.split("\n");

  // Find ALL return statements and pick the one whose root JSX
  // is a multi-child wrapper (not a simple single-element return)
  // Strategy: find the return ( that is followed by the most lines
  // before its closing ) — that's the main render return

  let bestReturnIndex = -1;
  let bestRootJsxIndex = -1;
  let bestLineCount = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*return\s*\(/.test(lines[i])) continue;

    // Find the root JSX tag after this return
    let rootJsx = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const trimmed = lines[j].trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("<")) {
        rootJsx = j;
        break;
      }
      break; // non-empty, non-JSX line means this isn't a JSX return
    }

    if (rootJsx === -1) continue;

    // Find the closing ) of this return block
    let depth = 1;
    let closingLine = -1;
    for (let j = rootJsx; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
      }
      if (depth === 0) {
        closingLine = j;
        break;
      }
    }

    const lineCount = closingLine - i;
    if (lineCount > bestLineCount) {
      bestLineCount = lineCount;
      bestReturnIndex = i;
      bestRootJsxIndex = rootJsx;
    }
  }

  if (bestRootJsxIndex !== -1) {
    lines.splice(bestRootJsxIndex + 1, 0, scriptComponent);
    newContent = lines.join("\n");
  } else {
    // Final fallback
    newContent = newContent.replace(
      /([ \t]*<\/div>\s*\n\s*\))/,
      `${scriptComponent}\n$1`,
    );
  }

  fs.writeFileSync(filePath, newContent, "utf8");
  return { success: true, backup };
}

// ─── INJECT INTO NEXT.JS layout.js ───────────────────────────────────────────

function injectIntoNextLayout(filePath, content, scriptTag, backup) {
  let newContent = content;

  if (!content.includes("next/script")) {
    newContent = newContent.replace(
      /^(import .+)/m,
      `import Script from 'next/script';\n$1`,
    );
  }

  const scriptComponent = `
      <Script
        id="botversion-loader"
        src="${extractAttr(scriptTag, "src")}"
        data-api-url="${extractAttr(scriptTag, "data-api-url")}"
        data-project-id="${extractAttr(scriptTag, "data-project-id")}"
        data-public-key="${extractAttr(scriptTag, "data-public-key")}"
        strategy="afterInteractive"
      />`;

  // Inject before </body> in layout
  if (content.includes("</body>")) {
    newContent = newContent.replace(
      "</body>",
      `${scriptComponent}\n      </body>`,
    );
  } else {
    // Fallback — before last closing tag
    newContent = newContent.replace(
      /(<\/\w+>\s*\)[\s;]*$)/m,
      `${scriptComponent}\n      $1`,
    );
  }

  fs.writeFileSync(filePath, newContent, "utf8");
  return { success: true, backup };
}

function injectAtTop(filePath, codeToInject) {
  const content = fs.readFileSync(filePath, "utf8");

  if (content.includes("dotenv")) {
    return { success: false, reason: "already_exists" };
  }

  const newContent = codeToInject + "\n" + content;
  backupFile(filePath);
  fs.writeFileSync(filePath, newContent, "utf8");
  return { success: true };
}

// ─── HELPER: extract attribute value from script tag string ──────────────────

function extractAttr(scriptTag, attr) {
  const match = scriptTag.match(new RegExp(`${attr}="([^"]+)"`));
  return match ? match[1] : "";
}

// ─── INJECT CORS INTO EXPRESS FILE ───────────────────────────────────────────

function injectCors(filePath, corsCode, appVarName) {
  appVarName = appVarName || "app";

  const content = fs.readFileSync(filePath, "utf8");

  // Already has CORS — skip
  if (
    content.includes("cors(") ||
    content.includes("require('cors')") ||
    content.includes('require("cors")')
  ) {
    return { success: false, reason: "already_exists" };
  }

  const backup = backupFile(filePath);
  const lines = content.split("\n");

  // Find the app = express() line and inject CORS right after it
  const appLineRegex = new RegExp(
    `(?:const|let|var)\\s+${appVarName}\\s*=\\s*(?:express\\s*\\(|require)`,
  );
  let appLineIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    if (appLineRegex.test(lines[i]) || lines[i].includes("express()")) {
      appLineIndex = i;
      break;
    }
  }

  if (appLineIndex === -1) {
    // Fallback — append to end of file
    const newContent = content.trimEnd() + "\n\n" + corsCode + "\n";
    fs.writeFileSync(filePath, newContent, "utf8");
    return { success: true, backup, method: "append" };
  }

  const before = lines.slice(0, appLineIndex + 1);
  const after = lines.slice(appLineIndex + 1);
  const injectedLines = ["", ...corsCode.split("\n"), ""];
  const newContent = [...before, ...injectedLines, ...after].join("\n");

  fs.writeFileSync(filePath, newContent, "utf8");
  return { success: true, backup, method: "inject" };
}

// ─── WRITE API KEY TO .ENV FILE ───────────────────────────────────────────────

function writeEnvKey(cwd, key, value, framework) {
  const envCandidates =
    framework === "next"
      ? [".env.local", ".env", ".env.development", ".env.development.local"]
      : [".env", ".env.development", ".env.local"];

  let envPath = null;

  // Use existing .env file if found
  for (const candidate of envCandidates) {
    const fullPath = path.join(cwd, candidate);
    if (fs.existsSync(fullPath)) {
      envPath = fullPath;
      break;
    }
  }

  // No .env file found — create .env
  if (!envPath) {
    envPath = path.join(cwd, ".env");
    fs.writeFileSync(envPath, "", "utf8");
  }

  const content = fs.readFileSync(envPath, "utf8");

  // Key already exists — skip
  if (content.includes(key)) {
    return { success: false, reason: "already_exists", path: envPath };
  }

  // Append key to file
  const newLine =
    content === "" || content.endsWith("\n")
      ? `${key}=${value}\n`
      : `\n${key}=${value}\n`;

  fs.appendFileSync(envPath, newLine, "utf8");
  return { success: true, path: envPath };
}

// ─── INJECT CORS INTO EXISTING NEXT.JS MIDDLEWARE ────────────────────────────

function injectCorsIntoMiddleware(filePath, allowedOrigins) {
  const content = fs.readFileSync(filePath, "utf8");

  // Already has CORS — skip
  if (content.includes("Access-Control-Allow-Origin")) {
    return { success: false, reason: "already_exists" };
  }

  const backup = backupFile(filePath);
  const lines = content.split("\n");

  // Detect actual request parameter name from middleware signature
  let requestParamName = "request"; // default
  const sigMatch =
    content.match(/function\s+middleware\s*\(\s*(\w+)/) ||
    content.match(/middleware\s*=\s*(?:async\s*)?\(\s*(\w+)/) ||
    content.match(/middleware\s*=\s*(?:async\s*)?(\w+)\s*=>/);
  if (sigMatch) requestParamName = sigMatch[1];

  // Detect actual response variable name
  let responseVarName = "response"; // default
  const resMatch =
    content.match(/const\s+(\w+)\s*=\s*NextResponse\.next\(\)/) ||
    content.match(/let\s+(\w+)\s*=\s*NextResponse\.next\(\)/) ||
    content.match(/var\s+(\w+)\s*=\s*NextResponse\.next\(\)/);
  if (resMatch) responseVarName = resMatch[1];

  // The CORS headers to inject
  const corsLines = [
    ``,
    `  // CORS — auto-added by botversion-sdk`,
    `  const __bvOrigin = ${requestParamName}.headers.get('origin') || '';`,
    `  const __bvAllowed = ${JSON.stringify(allowedOrigins)};`,
    `  const __bvIsAllowed = __bvAllowed.some(o => __bvOrigin.startsWith(o));`,
  ].join("\n");

  const corsHeaders = [
    ``,
    `  // BotVersion CORS headers`,
    `  if (__bvIsAllowed) {`,
    `    ${responseVarName}.headers.set('Access-Control-Allow-Origin', __bvOrigin);`,
    `    ${responseVarName}.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');`,
    `    ${responseVarName}.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');`,
    `    ${responseVarName}.headers.set('Access-Control-Allow-Credentials', 'true');`,
    `  }`,
  ].join("\n");

  // Strategy 1: find "const response = NextResponse.next()"
  // and inject CORS checks before it, then inject headers after it
  let newContent = content;

  const nextResponseLine = lines.findIndex(
    (l) =>
      l.includes("NextResponse.next()") ||
      l.includes("NextResponse.redirect") ||
      l.includes("NextResponse.rewrite"),
  );

  if (nextResponseLine !== -1) {
    // Inject origin check before NextResponse line
    const before = lines.slice(0, nextResponseLine);
    const after = lines.slice(nextResponseLine);

    // Find return statement after NextResponse to inject headers before it
    let returnLine = -1;
    for (let i = nextResponseLine; i < lines.length; i++) {
      if (/^\s*return\s+/.test(lines[i])) {
        returnLine = i;
        break;
      }
    }

    if (returnLine !== -1) {
      const middle = lines.slice(nextResponseLine, returnLine);
      const end = lines.slice(returnLine);

      newContent = [...before, corsLines, ...middle, corsHeaders, ...end].join(
        "\n",
      );
    } else {
      // No return found — inject at end of function
      newContent = [...before, corsLines, ...after, corsHeaders].join("\n");
    }
  } else {
    // Strategy 2: No NextResponse found
    // Find the export function middleware line and inject at the start of it
    let funcBodyStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (
        /export\s+(default\s+)?function\s+middleware/.test(lines[i]) ||
        /export\s+const\s+middleware/.test(lines[i])
      ) {
        // Find opening brace
        for (let j = i; j < lines.length; j++) {
          if (lines[j].includes("{")) {
            funcBodyStart = j;
            break;
          }
        }
        break;
      }
    }

    if (funcBodyStart !== -1) {
      const before = lines.slice(0, funcBodyStart + 1);
      const after = lines.slice(funcBodyStart + 1);
      newContent = [...before, corsLines, corsHeaders, ...after].join("\n");
    } else {
      // Last resort — append to end of file
      newContent = content.trimEnd() + "\n\n" + corsLines + corsHeaders + "\n";
    }
  }

  fs.writeFileSync(filePath, newContent, "utf8");
  return { success: true, backup };
}

module.exports = {
  writeFile,
  backupFile,
  injectBeforeListen,
  appendToFile,
  createFile,
  writeSummary,
  injectBeforeExport,
  injectScriptTag,
  injectAtTop,
  injectCors,
  writeEnvKey,
  injectCorsIntoMiddleware,
};
