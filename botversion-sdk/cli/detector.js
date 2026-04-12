// botversion-sdk/cli/detector.js
"use strict";

const fs = require("fs");
const path = require("path");

// ─── SKIP DIRS (used everywhere) ─────────────────────────────────────────────

const SKIP_DIRS = [
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".cache",
  "coverage",
  ".turbo",
  "out",
  ".output",
  ".svelte-kit",
];

// ─── PACKAGE JSON ────────────────────────────────────────────────────────────

function readPackageJson(cwd) {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
}

// ─── SCAN ALL PACKAGE.JSON FILES ─────────────────────────────────────────────
// Recursively finds ALL package.json files in the project

function scanAllPackageJsons(cwd) {
  const results = []; // [{ dir, pkg }]

  function walk(currentDir, depth) {
    if (depth > 5) return;

    let entries;
    try {
      entries = fs.readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.includes(entry)) continue;

      const fullPath = path.join(currentDir, entry);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry === "package.json") {
        try {
          const pkg = JSON.parse(fs.readFileSync(fullPath, "utf8"));
          results.push({ dir: currentDir, pkg });
        } catch {
          continue;
        }
      }
    }
  }

  walk(cwd, 0);
  return results;
}

// ─── CLASSIFY PACKAGE.JSON ────────────────────────────────────────────────────

const BACKEND_PACKAGES = [
  "express",
  "fastify",
  "koa",
  "@nestjs/core",
  "@hapi/hapi",
  "restify",
  "polka",
  "micro",
];

const FULLSTACK_PACKAGES = ["next", "@sveltejs/kit"];

const FRONTEND_PACKAGES = [
  "react",
  "react-dom",
  "vue",
  "@angular/core",
  "svelte",
  "@sveltejs/kit",
  "solid-js",
  "preact",
];

function classifyPackageJson(pkg) {
  if (!pkg) return "unknown";

  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };

  const isFullstack = FULLSTACK_PACKAGES.some((p) => !!deps[p]);
  if (isFullstack) return "fullstack";

  const isBackend = BACKEND_PACKAGES.some((p) => !!deps[p]);
  const isFrontend = FRONTEND_PACKAGES.some((p) => !!deps[p]);

  if (isBackend && isFrontend) return "fullstack";
  if (isBackend) return "backend";
  if (isFrontend) return "frontend";
  return "unknown";
}

// ─── DETECT FRONTEND FRAMEWORK ───────────────────────────────────────────────

function detectFrontendFramework(pkg) {
  if (!pkg) return null;

  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };

  if (deps["next"]) return "next";
  if (deps["@sveltejs/kit"]) return "sveltekit";
  if (deps["svelte"]) return "svelte";
  if (deps["@angular/core"]) return "angular";
  if (deps["vue"]) return "vue";
  if (deps["react-dom"] || deps["react"]) {
    // Distinguish CRA vs Vite
    if (deps["vite"] || deps["@vitejs/plugin-react"]) return "react-vite";
    return "react-cra";
  }
  if (deps["solid-js"]) return "solid";
  if (deps["preact"]) return "preact";

  return null;
}

// ─── FIND MAIN FRONTEND FILE ──────────────────────────────────────────────────
// Returns { file, type } or null

function findMainFrontendFile(dir, pkg) {
  const framework = detectFrontendFramework(pkg);

  // ── Next.js ───────────────────────────────────────────────────────────────
  // For Next.js we inject into _app.js (Pages) or layout.js (App Router)
  if (framework === "next") {
    const candidates = [
      "pages/_app.js",
      "pages/_app.tsx",
      "pages/_app.ts",
      "src/pages/_app.js",
      "src/pages/_app.tsx",
      "src/pages/_app.ts",
      "app/layout.js",
      "app/layout.tsx",
      "src/app/layout.js",
      "src/app/layout.tsx",
    ];
    for (const candidate of candidates) {
      const fullPath = path.join(dir, candidate);
      if (fs.existsSync(fullPath)) {
        return { file: fullPath, type: "next" };
      }
    }
    return null;
  }

  // ── Angular ───────────────────────────────────────────────────────────────
  if (framework === "angular") {
    const candidate = path.join(dir, "src", "index.html");
    if (fs.existsSync(candidate)) {
      return { file: candidate, type: "html" };
    }
    return null;
  }

  // ── React Vite / Vue Vite / Svelte / SvelteKit / Solid / Preact ──────────
  // All Vite-based projects have index.html in root of the project folder
  if (
    framework === "react-vite" ||
    framework === "vue" ||
    framework === "svelte" ||
    framework === "sveltekit" ||
    framework === "solid" ||
    framework === "preact"
  ) {
    // Check root index.html first
    const rootHtml = path.join(dir, "index.html");
    if (fs.existsSync(rootHtml)) {
      return { file: rootHtml, type: "html" };
    }

    // Fallback: public/index.html
    const publicHtml = path.join(dir, "public", "index.html");
    if (fs.existsSync(publicHtml)) {
      return { file: publicHtml, type: "html" };
    }

    return null;
  }

  // ── React CRA ─────────────────────────────────────────────────────────────
  if (framework === "react-cra") {
    // CRA always puts index.html in public/
    const publicHtml = path.join(dir, "public", "index.html");
    if (fs.existsSync(publicHtml)) {
      return { file: publicHtml, type: "html" };
    }

    // Fallback: root index.html (custom CRA config)
    const rootHtml = path.join(dir, "index.html");
    if (fs.existsSync(rootHtml)) {
      return { file: rootHtml, type: "html" };
    }

    return null;
  }

  // ── Unknown frontend — scan for any index.html ────────────────────────────
  const htmlCandidates = [
    "index.html",
    "public/index.html",
    "src/index.html",
    "static/index.html",
    "www/index.html",
  ];

  for (const candidate of htmlCandidates) {
    const fullPath = path.join(dir, candidate);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, "utf8");
      // Make sure it's a real HTML file with a body tag
      if (content.includes("<body") || content.includes("<html")) {
        return { file: fullPath, type: "html" };
      }
    }
  }

  // Last resort — deep scan for any .html file
  const found = findHtmlFile(dir);
  if (found) return { file: found, type: "html" };

  return null;
}

// ─── DEEP SCAN FOR HTML FILE ─────────────────────────────────────────────────

function findHtmlFile(dir) {
  function walk(currentDir, depth) {
    if (depth > 3) return null;

    let entries;
    try {
      entries = fs.readdirSync(currentDir);
    } catch {
      return null;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.includes(entry)) continue;

      const fullPath = path.join(currentDir, entry);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        const result = walk(fullPath, depth + 1);
        if (result) return result;
      } else if (entry.endsWith(".html")) {
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          if (content.includes("<body") || content.includes("<html")) {
            return fullPath;
          }
        } catch {
          continue;
        }
      }
    }

    return null;
  }

  return walk(dir, 0);
}

// ─── MONOREPO DETECTION ──────────────────────────────────────────────────────

function detectMonorepo(cwd) {
  const rootPkg = readPackageJson(cwd);
  if (rootPkg && rootPkg.workspaces) {
    const workspaceDirs = [];
    const patterns = Array.isArray(rootPkg.workspaces)
      ? rootPkg.workspaces
      : rootPkg.workspaces.packages || [];

    patterns.forEach((pattern) => {
      const base = pattern.replace(/\/\*$/, "");
      const fullBase = path.join(cwd, base);
      if (fs.existsSync(fullBase)) {
        fs.readdirSync(fullBase).forEach((dir) => {
          const dirPath = path.join(fullBase, dir);
          if (
            fs.statSync(dirPath).isDirectory() &&
            fs.existsSync(path.join(dirPath, "package.json"))
          ) {
            workspaceDirs.push(dirPath);
          }
        });
      }
    });

    if (workspaceDirs.length > 0) {
      return { isMonorepo: true, packages: workspaceDirs };
    }
  }

  // Check for common monorepo structures
  const monorepoDirs = ["packages", "apps", "services"];
  for (const dir of monorepoDirs) {
    const dirPath = path.join(cwd, dir);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      const subDirs = fs
        .readdirSync(dirPath)
        .map((d) => path.join(dirPath, d))
        .filter(
          (d) =>
            fs.statSync(d).isDirectory() &&
            fs.existsSync(path.join(d, "package.json")),
        );
      if (subDirs.length > 0) {
        return { isMonorepo: true, packages: subDirs };
      }
    }
  }

  return { isMonorepo: false };
}

// ─── FRAMEWORK DETECTION ─────────────────────────────────────────────────────

const SUPPORTED_FRAMEWORKS = ["express", "next"];
const UNSUPPORTED_FRAMEWORKS = [
  "fastify",
  "koa",
  "@hapi/hapi",
  "nestjs",
  "@nestjs/core",
];

function detectFramework(pkg) {
  if (!pkg) return { name: null, supported: false };

  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };

  for (const fw of UNSUPPORTED_FRAMEWORKS) {
    if (deps[fw]) return { name: fw, supported: false };
  }

  for (const fw of SUPPORTED_FRAMEWORKS) {
    if (deps[fw]) return { name: fw, supported: true };
  }

  return { name: null, supported: false };
}

// ─── MODULE SYSTEM DETECTION ─────────────────────────────────────────────────

function detectModuleSystem(pkg) {
  if (pkg && pkg.type === "module") return "esm";
  return "cjs";
}

// ─── TYPESCRIPT DETECTION ────────────────────────────────────────────────────

function detectTypeScript(cwd) {
  return (
    fs.existsSync(path.join(cwd, "tsconfig.json")) ||
    fs.existsSync(path.join(cwd, "tsconfig.base.json"))
  );
}

function readTsConfig(cwd) {
  const tsconfigPath = path.join(cwd, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) return null;
  try {
    const raw = fs.readFileSync(tsconfigPath, "utf8");
    const stripped = raw
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

function shouldGenerateTs(cwd, isTypeScript) {
  if (!isTypeScript) return false;
  const tsconfig = readTsConfig(cwd);
  if (!tsconfig) return false;
  const allowJs = tsconfig.compilerOptions && tsconfig.compilerOptions.allowJs;
  return allowJs === false;
}

// ─── SRC DIRECTORY DETECTION ─────────────────────────────────────────────────

function detectSrcDir(cwd) {
  return fs.existsSync(path.join(cwd, "src"));
}

// ─── NEXT.JS ROUTER DETECTION ────────────────────────────────────────────────

function detectNextRouter(cwd) {
  const hasSrc = detectSrcDir(cwd);
  const bases = hasSrc ? [path.join(cwd, "src"), cwd] : [cwd];

  let hasPages = false;
  let hasApp = false;

  for (const base of bases) {
    if (fs.existsSync(path.join(base, "pages", "api"))) hasPages = true;
    if (fs.existsSync(path.join(base, "pages"))) hasPages = true;
    if (fs.existsSync(path.join(base, "app"))) hasApp = true;
  }

  return {
    pagesRouter: hasPages,
    appRouter: hasApp,
    srcDir: hasSrc,
    baseDir: hasSrc ? path.join(cwd, "src") : cwd,
  };
}

// ─── NEXT.JS VERSION DETECTION ───────────────────────────────────────────────

function detectNextVersion(pkg) {
  if (!pkg) return null;
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const version = deps["next"];
  if (!version) return null;
  const major = parseInt(version.replace(/[^0-9]/, ""), 10);
  return { raw: version, major };
}

// ─── EXPRESS ENTRY POINT DETECTION ───────────────────────────────────────────

function detectExpressEntry(cwd, pkg) {
  // Strategy 1: "main" field in package.json
  if (pkg && pkg.main) {
    const mainPath = path.join(cwd, pkg.main);
    if (fs.existsSync(mainPath)) return mainPath;
  }

  // Strategy 2: scripts.start / scripts.dev
  if (pkg && pkg.scripts) {
    const scripts = [pkg.scripts.start, pkg.scripts.dev, pkg.scripts.serve];
    for (const script of scripts) {
      if (!script) continue;
      const match = script.match(
        /(?:node|nodemon|ts-node|tsx)\s+([^\s]+\.(js|ts))/,
      );
      if (match) {
        const filePath = path.join(cwd, match[1]);
        if (fs.existsSync(filePath)) return filePath;
      }
    }
  }

  // Strategy 3: common file names
  const candidates = [
    "server.js",
    "server.ts",
    "index.js",
    "index.ts",
    "app.js",
    "app.ts",
    "main.js",
    "main.ts",
    "src/server.js",
    "src/server.ts",
    "src/index.js",
    "src/index.ts",
    "src/app.js",
    "src/app.ts",
    "src/main.js",
    "src/main.ts",
  ];

  for (const candidate of candidates) {
    const filePath = path.join(cwd, candidate);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8");
      if (content.includes("express") || content.includes("app.listen")) {
        return filePath;
      }
    }
  }

  // Strategy 4: any .js/.ts file containing app.listen()
  return findFileWithContent(cwd, ".listen(", [".js", ".ts"], 2);
}

// ─── app.listen() LOCATION ───────────────────────────────────────────────────

function findListenCall(filePath, appVarName) {
  appVarName = appVarName || "app";
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const regex = new RegExp(`${appVarName}\\.listen\\s*\\(`);

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      return { lineIndex: i, lineNumber: i + 1, content: lines[i] };
    }
  }
  return null;
}

function findModuleExportsApp(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/module\.exports\s*=\s*app/.test(lines[i])) {
      return { lineIndex: i, lineNumber: i + 1, content: lines[i] };
    }
  }
  return null;
}

function findListenInsideCallback(filePath, appVarName) {
  appVarName = appVarName || "app";
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const regex = new RegExp(`${appVarName}\\.listen\\s*\\(`);

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      const indentation = lines[i].match(/^(\s*)/)[1].length;
      if (indentation > 0) {
        return { lineIndex: i, lineNumber: i + 1, insideCallback: true };
      }
    }
  }
  return null;
}

function findCreateServer(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/createServer\s*\(\s*app\s*\)/.test(lines[i])) {
      return { lineIndex: i, lineNumber: i + 1, content: lines[i] };
    }
  }
  return null;
}

// ─── AUTH DETECTION ──────────────────────────────────────────────────────────

const AUTH_LIBS = [
  {
    name: "next-auth",
    packages: ["next-auth"],
    detect: (deps) => !!deps["next-auth"],
    getVersion: (deps) => {
      const v = deps["next-auth"] || "";
      const major = parseInt(v.replace(/[^0-9]/, ""), 10);
      return major >= 5 ? "v5" : "v4";
    },
  },
  {
    name: "clerk",
    packages: ["@clerk/nextjs", "@clerk/clerk-sdk-node", "@clerk/express"],
    detect: (deps) =>
      !!deps["@clerk/nextjs"] ||
      !!deps["@clerk/clerk-sdk-node"] ||
      !!deps["@clerk/express"],
    getPackage: (deps) =>
      deps["@clerk/nextjs"]
        ? "@clerk/nextjs"
        : deps["@clerk/express"]
          ? "@clerk/express"
          : "@clerk/clerk-sdk-node",
  },
  {
    name: "supabase",
    packages: ["@supabase/supabase-js", "@supabase/ssr"],
    detect: (deps) =>
      !!deps["@supabase/supabase-js"] || !!deps["@supabase/ssr"],
  },
  {
    name: "passport",
    packages: ["passport"],
    detect: (deps) => !!deps["passport"],
  },
  {
    name: "lucia",
    packages: ["lucia"],
    detect: (deps) => !!deps["lucia"],
  },
  {
    name: "auth0",
    packages: ["@auth0/nextjs-auth0", "express-openid-connect"],
    detect: (deps) =>
      !!deps["@auth0/nextjs-auth0"] || !!deps["express-openid-connect"],
  },
  {
    name: "firebase",
    packages: ["firebase-admin", "firebase"],
    detect: (deps) => !!deps["firebase-admin"] || !!deps["firebase"],
  },
  {
    name: "jwt",
    packages: ["jsonwebtoken"],
    detect: (deps) => !!deps["jsonwebtoken"],
  },
  {
    name: "express-session",
    packages: ["express-session"],
    detect: (deps) => !!deps["express-session"],
  },
];

function detectAuth(pkg) {
  if (!pkg) return { name: null, supported: false };

  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };

  for (const lib of AUTH_LIBS) {
    if (lib.detect(deps)) {
      const version = lib.getVersion ? lib.getVersion(deps) : null;
      const pkg2 = lib.getPackage ? lib.getPackage(deps) : lib.packages[0];
      const supported = [
        "next-auth",
        "clerk",
        "supabase",
        "passport",
        "jwt",
        "express-session",
      ].includes(lib.name);
      return { name: lib.name, version, package: pkg2, supported };
    }
  }

  return { name: null, supported: false };
}

// ─── NEXT-AUTH CONFIG LOCATION ───────────────────────────────────────────────

function findNextAuthConfig(cwd) {
  const candidates = [
    "pages/api/auth/[...nextauth].js",
    "pages/api/auth/[...nextauth].ts",
    "app/api/auth/[...nextauth]/route.js",
    "app/api/auth/[...nextauth]/route.ts",
    "src/pages/api/auth/[...nextauth].js",
    "src/pages/api/auth/[...nextauth].ts",
    "src/app/api/auth/[...nextauth]/route.js",
    "src/app/api/auth/[...nextauth]/route.ts",
    "lib/auth.js",
    "lib/auth.ts",
    "lib/authOptions.js",
    "lib/authOptions.ts",
    "utils/auth.js",
    "utils/auth.ts",
    "auth.js",
    "auth.ts",
  ];

  for (const candidate of candidates) {
    const fullPath = path.join(cwd, candidate);
    if (fs.existsSync(fullPath)) {
      return { path: fullPath, relativePath: candidate };
    }
  }

  const found = findFileWithContent(cwd, "authOptions", [".js", ".ts"], 3);
  if (found) {
    return { path: found, relativePath: path.relative(cwd, found) };
  }

  return null;
}

// ─── PACKAGE MANAGER DETECTION ───────────────────────────────────────────────

function detectPackageManager(cwd) {
  if (fs.existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

// ─── EXISTING BOTVERSION DETECTION ───────────────────────────────────────────

function detectExistingBotVersion(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, "utf8");
  return content.includes("botversion-sdk") || content.includes("BotVersion");
}

// ─── HELPER: find file containing a string ───────────────────────────────────

function findFileWithContent(dir, searchString, extensions, maxDepth) {
  maxDepth = maxDepth || 2;

  function walk(currentDir, depth) {
    if (depth > maxDepth) return null;

    let entries;
    try {
      entries = fs.readdirSync(currentDir);
    } catch {
      return null;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.includes(entry)) continue;

      const fullPath = path.join(currentDir, entry);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        const result = walk(fullPath, depth + 1);
        if (result) return result;
      } else if (extensions.some((ext) => entry.endsWith(ext))) {
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          if (content.includes(searchString)) return fullPath;
        } catch {
          continue;
        }
      }
    }

    return null;
  }

  return walk(dir, 0);
}

function detectAppVarName(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const match = content.match(/(?:const|let|var)\s+(\w+)\s*=\s*express\s*\(/);
    return match ? match[1] : "app";
  } catch {
    return "app";
  }
}

// ─── MAIN DETECT FUNCTION ────────────────────────────────────────────────────

function detect(cwd) {
  const pkg = readPackageJson(cwd);
  const monorepo = detectMonorepo(cwd);
  let framework = detectFramework(pkg);

  // ── If framework not found in root, scan ALL package.json files ───────────
  let backendDir = cwd;
  let frontendDir = null;
  let frontendPkg = null;

  if (!framework.name) {
    const allPackages = scanAllPackageJsons(cwd);

    for (const { dir, pkg: subPkg } of allPackages) {
      // Skip the root package.json — already checked
      if (dir === cwd) continue;

      const classification = classifyPackageJson(subPkg);

      // AFTER
      if (
        (classification === "backend" || classification === "fullstack") &&
        !framework.name
      ) {
        framework = detectFramework(subPkg);
        backendDir = dir;
      }

      if (
        (classification === "frontend" || classification === "fullstack") &&
        !frontendDir &&
        dir !== backendDir
      ) {
        frontendDir = dir;
        frontendPkg = subPkg;
      }
    }
  } else {
    // Framework found in root — scan for separate frontend folder
    const allPackages = scanAllPackageJsons(cwd);
    for (const { dir, pkg: subPkg } of allPackages) {
      if (dir === cwd) continue;
      if (dir === backendDir) continue;
      const classification = classifyPackageJson(subPkg);
      if (classification === "frontend" || classification === "fullstack") {
        frontendDir = dir;
        frontendPkg = subPkg;
        break;
      }
    }
  }

  // ── Use backendDir for all backend-specific detection ─────────────────────
  // Guard: if frontendDir ended up being the same as backendDir
  // (e.g. a fullstack Next.js folder detected as both), clear frontendDir
  // so we don't try to inject script tag into the wrong place
  if (frontendDir && frontendDir === backendDir) {
    frontendDir = null;
    frontendPkg = null;
  }
  const backendPkg = readPackageJson(backendDir) || pkg;
  const moduleSystem = detectModuleSystem(backendPkg);
  const isTypeScript = detectTypeScript(backendDir);
  const hasSrc = detectSrcDir(backendDir);
  const auth = detectAuth(backendPkg);
  const generateTs = shouldGenerateTs(backendDir, isTypeScript);

  // ── Find frontend main file ───────────────────────────────────────────────
  let frontendMainFile = null;
  if (frontendDir && frontendPkg) {
    frontendMainFile = findMainFrontendFile(frontendDir, frontendPkg);
  } else if (framework.name === "next") {
    // Next.js is fullstack — find its frontend file in backendDir
    frontendMainFile = findMainFrontendFile(backendDir, backendPkg);
  }

  const packageManager =
    detectPackageManager(backendDir) !== "npm"
      ? detectPackageManager(backendDir)
      : detectPackageManager(cwd);

  const result = {
    cwd: backendDir, // use backend dir as working dir
    rootCwd: cwd, // keep original root for reference
    pkg: backendPkg,
    monorepo,
    framework,
    moduleSystem,
    isTypeScript,
    generateTs,
    hasSrc,
    auth,
    packageManager,
    ext: generateTs ? ".ts" : ".js",
    // Frontend info
    frontendDir,
    frontendPkg,
    frontendMainFile,
  };

  // ── Framework-specific detection ──────────────────────────────────────────
  if (framework.name === "next") {
    result.next = detectNextRouter(backendDir);
    result.nextVersion = detectNextVersion(backendPkg);
    if (auth.name === "next-auth") {
      result.nextAuthConfig = findNextAuthConfig(backendDir);
    }
  }

  if (framework.name === "express") {
    result.entryPoint = detectExpressEntry(backendDir, backendPkg);
    if (result.entryPoint) {
      result.appVarName = detectAppVarName(result.entryPoint); // detect FIRST
      result.listenCall = findListenCall(result.entryPoint, result.appVarName);
      result.listenInsideCallback = findListenInsideCallback(
        result.entryPoint,
        result.appVarName,
      );
      result.moduleExportsApp = findModuleExportsApp(result.entryPoint);
      result.createServer = findCreateServer(result.entryPoint);

      const appFileCandidates = [
        "src/app.js",
        "src/app.ts",
        "app.js",
        "app.ts",
      ];
      for (const candidate of appFileCandidates) {
        const fullPath = path.join(backendDir, candidate);
        if (fs.existsSync(fullPath) && fullPath !== result.entryPoint) {
          const exportCall = findModuleExportsApp(fullPath);
          if (exportCall) {
            result.appFile = fullPath;
            result.appFileExport = exportCall;
            break;
          }
        }
      }
    }
  }

  // ── Already initialized check ─────────────────────────────────────────────
  result.alreadyInitialized =
    detectExistingBotVersion(result.entryPoint) ||
    (framework.name === "next" &&
      (fs.existsSync(path.join(backendDir, "instrumentation.js")) ||
        fs.existsSync(path.join(backendDir, "instrumentation.ts")) ||
        fs.existsSync(path.join(backendDir, "src", "instrumentation.js")) ||
        fs.existsSync(path.join(backendDir, "src", "instrumentation.ts"))));

  return result;
}

module.exports = {
  detect,
  readPackageJson,
  scanAllPackageJsons,
  classifyPackageJson,
  detectFrontendFramework,
  findMainFrontendFile,
  detectMonorepo,
  detectFramework,
  detectModuleSystem,
  detectTypeScript,
  readTsConfig,
  shouldGenerateTs,
  detectSrcDir,
  detectNextRouter,
  detectAuth,
  findNextAuthConfig,
  detectPackageManager,
  detectExistingBotVersion,
  findFileWithContent,
  findListenCall,
  findModuleExportsApp,
  findListenInsideCallback,
  findCreateServer,
  detectAppVarName,
};
