// botversion-sdk/cli/prompts.js

"use strict";

const readline = require("readline");

// ─── BASE PROMPT HELPER ───────────────────────────────────────────────────────

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askChoice(question, choices) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log("\n" + question);
    choices.forEach((choice, i) => {
      console.log(`  ${i + 1}. ${choice.label}`);
    });
    console.log("");

    const prompt = () => {
      rl.question(`Enter number (1-${choices.length}): `, (answer) => {
        const num = parseInt(answer.trim(), 10);
        if (num >= 1 && num <= choices.length) {
          rl.close();
          resolve(choices[num - 1]);
        } else {
          console.log(
            `  Please enter a number between 1 and ${choices.length}`,
          );
          prompt();
        }
      });
    };

    prompt();
  });
}

function confirm(question, defaultYes) {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  return ask(`${question} ${hint}: `).then((answer) => {
    if (!answer) return defaultYes;
    return answer.toLowerCase().startsWith("y");
  });
}

// ─── SPECIFIC PROMPTS ─────────────────────────────────────────────────────────

async function promptMonorepoPackage(packages, cwd) {
  const path = require("path");
  const choices = packages.map((p) => ({
    label: path.relative(cwd, p),
    value: p,
  }));

  choices.push({ label: "This directory (root)", value: cwd });

  const choice = await askChoice(
    "We found multiple packages (monorepo). Which is your backend?",
    choices,
  );

  return choice.value;
}

async function promptEntryPoint() {
  console.log(
    "\n  ⚠️  We couldn't find your server entry point automatically.",
  );
  const filePath = await ask(
    "  Enter the path to your main server file (e.g. src/server.js): ",
  );
  return filePath;
}

async function promptAuthLibrary() {
  const choices = [
    {
      label: "next-auth v4",
      value: { name: "next-auth", version: "v4", supported: true },
    },
    {
      label: "next-auth v5 (Auth.js)",
      value: { name: "next-auth", version: "v5", supported: true },
    },
    { label: "Clerk", value: { name: "clerk", supported: true } },
    { label: "Supabase Auth", value: { name: "supabase", supported: true } },
    { label: "Passport.js", value: { name: "passport", supported: true } },
    { label: "JWT (jsonwebtoken)", value: { name: "jwt", supported: true } },
    {
      label: "express-session",
      value: { name: "express-session", supported: true },
    },
    { label: "Other / Custom", value: { name: "custom", supported: false } },
    { label: "No auth", value: { name: null, supported: false } },
  ];

  const choice = await askChoice(
    "We couldn't detect your auth library. Which one are you using?",
    choices,
  );

  return choice.value;
}

async function promptNextAuthConfigPath() {
  console.log(
    "\n  ⚠️  We couldn't find your authOptions location automatically.",
  );
  const filePath = await ask(
    "  Enter the path to your authOptions file (e.g. lib/auth.ts): ",
  );
  return filePath;
}

async function promptForce(conflictFile) {
  console.log(`\n  ⚠️  File already exists: ${conflictFile}`);
  return confirm("  Overwrite it? (a backup will be created)", false);
}

async function promptMissingListenCall(entryPoint) {
  console.log(`\n  ⚠️  We couldn't find app.listen() in ${entryPoint}`);
  console.log("  Options:");
  const choices = [
    { label: "Append to end of file", value: "append" },
    { label: "Enter the correct file path manually", value: "manual_path" },
    { label: "Skip — I'll add it manually", value: "skip" },
  ];

  const choice = await askChoice("How would you like to proceed?", choices);
  if (choice.value === "manual_path") {
    const filePath = await ask("  Enter file path: ");
    return { action: "manual_path", filePath };
  }

  return { action: choice.value };
}

module.exports = {
  ask,
  askChoice,
  confirm,
  promptMonorepoPackage,
  promptEntryPoint,
  promptAuthLibrary,
  promptNextAuthConfigPath,
  promptForce,
  promptMissingListenCall,
};
