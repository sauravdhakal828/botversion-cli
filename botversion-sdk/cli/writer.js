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
  const backupPath = filePath + ".botversion.bak";
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

// ─── INJECT CODE BEFORE app.listen() ────────────────────────────────────────

function injectBeforeListen(filePath, codeToInject) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  // Find app.listen() line
  let listenLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/app\.listen\s*\(/.test(lines[i])) {
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
  backupFile(filePath);
  fs.writeFileSync(filePath, newContent, "utf8");

  return { success: true, lineNumber: listenLineIndex + 1 };
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

module.exports = {
  writeFile,
  backupFile,
  injectBeforeListen,
  appendToFile,
  createFile,
  mergeIntoMiddleware,
  writeSummary,
};
