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

  let listenLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (listenRegex.test(lines[i])) {
      listenLineIndex = i;
      break;
    }
  }

  if (listenLineIndex === -1) {
    // app.listen not found — append to end of file
    return {
      success: false,
      reason: "no_listen",
      suggestion: "append",
    };
  }

  // Check if BotVersion already exists in file
  if (content.includes("botversion-sdk") || content.includes("BotVersion")) {
    return { success: false, reason: "already_exists" };
  }

  // Insert the code block before app.listen()
  const before = lines.slice(0, listenLineIndex);
  const after = lines.slice(listenLineIndex);

  const injectedLines = ["", ...codeToInject.split("\n"), ""];

  const newContent = [...before, ...injectedLines, ...after].join("\n");
  const backup = backupFile(filePath);
  fs.writeFileSync(filePath, newContent, "utf8");

  return { success: true, lineNumber: listenLineIndex + 1, backup };
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

// ─── MERGE INTO EXISTING MIDDLEWARE (Next.js) ────────────────────────────────

function mergeIntoMiddleware(middlewarePath, authName) {
  const content = fs.readFileSync(middlewarePath, "utf8");

  // If BotVersion already there, skip
  if (content.includes("botversion")) {
    return { success: false, reason: "already_exists" };
  }

  // We don't auto-modify complex middleware — too risky
  // Instead return a comment to add manually
  const comment = `
// BotVersion: No changes needed to middleware.
// Your auth (${authName}) is handled in pages/api/botversion/chat.js
`;

  return {
    success: true,
    noModification: true,
    note: comment.trim(),
  };
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
    changes.modified.forEach((f) => lines.push(`    ✏️  ${f}`));
    lines.push("");
  }

  if (changes.created && changes.created.length > 0) {
    lines.push("  Created files:");
    changes.created.forEach((f) => lines.push(`    ✅  ${f}`));
    lines.push("");
  }

  if (changes.backups && changes.backups.length > 0) {
    lines.push("  Backups created:");
    changes.backups.forEach((f) => lines.push(`    💾  ${f}`));
    lines.push("");
  }

  if (changes.manual && changes.manual.length > 0) {
    lines.push("  ⚠️  Manual steps needed:");
    changes.manual.forEach((m) => lines.push(`    → ${m}`));
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
        data-proxy-url="/api/botversion/chat"
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
        data-proxy-url="/api/botversion/chat"
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

// ─── HELPER: extract attribute value from script tag string ──────────────────

function extractAttr(scriptTag, attr) {
  const match = scriptTag.match(new RegExp(`${attr}="([^"]+)"`));
  return match ? match[1] : "";
}

module.exports = {
  writeFile,
  backupFile,
  injectBeforeListen,
  appendToFile,
  createFile,
  mergeIntoMiddleware,
  writeSummary,
  injectBeforeExport,
  injectScriptTag,
};
