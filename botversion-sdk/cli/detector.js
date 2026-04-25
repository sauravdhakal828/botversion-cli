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

const SUPPORTED_FRAMEWORKS = ["next", "express"];
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

  // If BOTH next and express exist, always pick next
  // because express is just being used as a custom server wrapper
  if (deps["next"]) return { name: "next", supported: true };

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

// ─── SCORING FUNCTIONS ────────────────────────────────────────────────────────

function scoreExpressFile(content, filePath) {
  let score = 0;
  const filename = path.basename(filePath);
  const normalizedPath = filePath.replace(/\\/g, "/");

  // ── EXISTING POSITIVE SIGNALS ──────────────────────────────────
  if (/express\s*\(\s*\)/.test(content)) score += 10;
  if (/class\s+\w+\s+extends\s+express/.test(content)) score += 10;
  if (/(?:function|const|let|var)\s+(create|make|build|setup)App/.test(content))
    score += 8;
  if (/\.listen\s*\(/.test(content)) score += 8;
  if (/\.use\s*\(\s*['"`\/]/.test(content)) score += 5;
  if (/app\.use\s*\(/.test(content)) score += 4;
  if (
    /require\s*\(\s*['"]express['"]\s*\)|from\s+['"]express['"]/.test(content)
  )
    score += 1;

  // ── NEW POSITIVE SIGNALS — real API server ─────────────────────
  const hasApiRoutes = /\.(get|post|put|delete|patch)\s*\(\s*['"`]\//.test(
    content,
  );
  const returnsJson = /res\.json\s*\(/.test(content);
  const hasRouterFiles = /require\s*\(['"`]\.\/routes/.test(content);
  const hasControllers = /require\s*\(['"`]\.\/controllers/.test(content);

  if (hasApiRoutes) score += 6;
  if (returnsJson) score += 5;
  if (hasRouterFiles) score += 4;
  if (hasControllers) score += 3;

  // ── EXISTING PENALTIES ─────────────────────────────────────────
  if (/^(?:const|let|var)\s+router\s*=\s*express\.Router\s*\(/m.test(content))
    score -= 8;
  if (/(test_|_test|\.test\.|\.spec\.|conftest)/.test(filename)) score -= 10;
  if (/dist\/|build\//.test(filePath)) score -= 10;

  // ── NEW PENALTIES ──────────────────────────────────────────────

  // Category 1: PHP servers
  if (content.includes("php-express")) score -= 20;
  if (content.includes("phpExpress")) score -= 20;
  if (/app\.engine\s*\(\s*['"]php['"]/.test(content)) score -= 20;

  // Category 2: View-only servers (any template engine, no API)
  const hasViewEngine = /app\.set\s*\(\s*['"]view engine['"]/.test(content);
  if (hasViewEngine && !hasApiRoutes && !returnsJson) score -= 15;

  // Category 3: Static-only servers
  const hasStatic = /express\.static\s*\(/.test(content);
  const hasOnlyStatic = hasStatic && !hasApiRoutes && !returnsJson;
  if (hasOnlyStatic) score -= 15;

  // Category 4: Proxy servers
  if (
    content.includes("http-proxy-middleware") ||
    content.includes("createProxyMiddleware")
  )
    score -= 15;

  // Category 5: WebSocket-only servers
  const hasSocketIO =
    content.includes("socket.io") || content.includes("new Server(");
  if (hasSocketIO && !hasApiRoutes) score -= 15;

  // Category 6: Job/Queue servers
  if (
    (content.includes("require('bull')") ||
      content.includes('require("bull")') ||
      content.includes("bullmq") ||
      content.includes("agenda")) &&
    !hasApiRoutes
  )
    score -= 15;

  // Category 7: Webhook-only servers
  const hasWebhook = /['"`]\/webhook['"`]/.test(content);
  const onlyWebhook = hasWebhook && !hasApiRoutes;
  if (onlyWebhook) score -= 10;

  // Category 8: Dev tooling servers
  if (
    content.includes("webpack-dev-middleware") ||
    content.includes("webpackDevMiddleware") ||
    content.includes("storybook")
  )
    score -= 15;

  // Category 9: Test/mock servers (path-based)
  if (/__mocks__|fixtures\/|test\/|__tests__\//.test(normalizedPath))
    score -= 15;

  // ── FILENAME BONUSES ───────────────────────────────────────────
  if (["server.js", "server.ts", "app.js", "app.ts"].includes(filename))
    score += 3;
  if (["index.js", "index.ts", "main.js", "main.ts"].includes(filename))
    score += 2;

  return score;
}

// ─── PARSE ENTRY FROM CONFIG FILES ───────────────────────────────────────────

function parseEntryFromConfigFiles(cwd) {
  /**
   * Extracts likely entry point from Procfile or Dockerfile.
   * Covers patterns like:
   *   Procfile:   web: node server.js
   *   Procfile:   web: nodemon src/index.js
   *   Dockerfile: CMD ["node", "server.js"]
   *   Dockerfile: CMD ["nodemon", "src/index.js"]
   */

  function resolveFile(cwd, filePath) {
    const full = path.join(cwd, filePath);
    if (fs.existsSync(full)) return full;
    return null;
  }

  // ── 1. Check Procfile ─────────────────────────────────────────────────────
  const procfilePath = path.join(cwd, "Procfile");
  if (fs.existsSync(procfilePath)) {
    try {
      const lines = fs.readFileSync(procfilePath, "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim() || line.startsWith("#")) continue;

        // node/nodemon/ts-node/tsx server.js or src/index.ts
        const match = line.match(
          /(?:node|nodemon|ts-node|ts-node-dev|tsx)\s+([\w./\\-]+\.[jt]s)/,
        );
        if (match) {
          const result = resolveFile(cwd, match[1]);
          if (result) return result;
        }
      }
    } catch {}
  }

  // ── 2. Check Dockerfile ───────────────────────────────────────────────────
  const dockerfilePath = path.join(cwd, "Dockerfile");
  if (fs.existsSync(dockerfilePath)) {
    try {
      const lines = fs.readFileSync(dockerfilePath, "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim() || line.startsWith("#")) continue;

        // CMD ["node", "server.js"]
        // CMD ["nodemon", "src/index.js"]
        const cmdMatch = line.match(
          /(?:CMD|ENTRYPOINT)\s*\[.*?"(?:node|nodemon|ts-node|tsx)",\s*"([\w./\\-]+\.[jt]s)"/,
        );
        if (cmdMatch) {
          const result = resolveFile(cwd, cmdMatch[1]);
          if (result) return result;
        }

        // CMD node server.js (shell form)
        const shellMatch = line.match(
          /(?:CMD|ENTRYPOINT)\s+(?:node|nodemon|ts-node|tsx)\s+([\w./\\-]+\.[jt]s)/,
        );
        if (shellMatch) {
          const result = resolveFile(cwd, shellMatch[1]);
          if (result) return result;
        }
      }
    } catch {}
  }

  return null;
}

function detectExpressEntry(cwd, pkg) {
  const SKIP_ENTRY_DIRS = ["dist", "build", "out", ".next", "coverage"];

  function isCompiledPath(filePath) {
    const normalized = filePath.replace(/\\/g, "/");
    return SKIP_ENTRY_DIRS.some(
      (dir) =>
        normalized.includes(`/${dir}/`) ||
        normalized.endsWith(`/${dir}`) ||
        normalized.startsWith(`${dir}/`),
    );
  }

  // ── Strategy 1: package.json "main" field ─────────────────────────────────
  if (pkg && pkg.main) {
    const mainPath = path.join(cwd, pkg.main);
    if (fs.existsSync(mainPath) && !isCompiledPath(pkg.main)) {
      return mainPath;
    }
  }

  // ── Strategy 2: scripts.start / scripts.dev ───────────────────────────────
  if (pkg && pkg.scripts) {
    const scripts = [
      pkg.scripts.dev,
      pkg.scripts.serve,
      pkg.scripts["dev-server"],
      pkg.scripts.start,
    ];
    for (const script of scripts) {
      if (!script) continue;
      const match = script.match(
        /(?:node|nodemon|ts-node|ts-node-dev|tsx)\s+([^\s]+\.(js|ts))/,
      );
      if (match) {
        const scriptPath = match[1];
        if (isCompiledPath(scriptPath)) continue;
        const filePath = path.join(cwd, scriptPath);
        if (fs.existsSync(filePath)) return filePath;
      }
    }

    // Strategy 2b: compiled path fallback — find TS source equivalent
    for (const script of scripts) {
      if (!script) continue;
      const match = script.match(
        /(?:node|nodemon|ts-node|ts-node-dev|tsx)\s+([^\s]+\.(js|ts))/,
      );
      if (match) {
        const tsEquivalent = match[1]
          .replace(/^backend\/dist\//, "backend/")
          .replace(/^dist\//, "")
          .replace(/\.js$/, ".ts");
        const filePath = path.join(cwd, tsEquivalent);
        if (fs.existsSync(filePath)) return filePath;
      }
    }
  }

  // ── Strategy 3: Scoring — scan all JS/TS files ────────────────────────────
  const skipDirs = new Set([
    ...SKIP_DIRS,
    "dist",
    "build",
    "out",
    "coverage",
    "tests",
    "test",
    "__tests__",
    "scripts",
    "docs",
  ]);

  const scoredCandidates = [];

  function walk(directory, depth) {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(directory);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (skipDirs.has(entry) || entry.startsWith(".")) continue;

      const fullPath = path.join(directory, entry);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (/\.(js|ts)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          const score = scoreExpressFile(content, fullPath);
          if (score > 0) {
            scoredCandidates.push({ score, filePath: fullPath });
          }
        } catch {
          continue;
        }
      }
    }
  }

  walk(cwd, 0);

  if (scoredCandidates.length > 0) {
    scoredCandidates.sort((a, b) => b.score - a.score);
    const best = scoredCandidates[0];

    // If best score is weak, cross-check with Procfile/Dockerfile
    if (best.score <= 3) {
      const configEntry = parseEntryFromConfigFiles(cwd);
      if (configEntry) return configEntry;
    }

    return best.filePath;
  }

  // ── Strategy 4: Procfile/Dockerfile fallback ──────────────────────────────
  const configEntry = parseEntryFromConfigFiles(cwd);
  if (configEntry) return configEntry;

  // ── Strategy 5: Last resort deep scan ────────────────────────────────────
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

    // Pattern 1: const app = express()
    const match1 = content.match(
      /(?:const|let|var)\s+(\w+)\s*=\s*express\s*\(/,
    );
    if (match1) return match1[1];

    // Pattern 2: const app = require('express')()
    const match2 = content.match(
      /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]express['"]\s*\)\s*\(/,
    );
    if (match2) return match2[1];

    // Pattern 3: factory function — createApp(), makeApp() etc.
    // const app = createApp()
    const match3 = content.match(
      /(?:const|let|var)\s+(\w+)\s*=\s*(?:create|make|build|setup)App\s*\(/,
    );
    if (match3) return match3[1];

    // Pattern 4: subclass — class MyApp extends express
    // const app = new MyApp()
    const subclassNames = [
      ...content.matchAll(/class\s+(\w+)\s+extends\s+express/g),
    ].map((m) => m[1]);
    for (const name of subclassNames) {
      const subMatch = content.match(
        new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*new\\s+${name}\\s*\\(`),
      );
      if (subMatch) return subMatch[1];
    }

    // Pattern 5: const server = app.listen( → return "app"
    const match5 = content.match(
      /(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\.listen\s*\(/,
    );
    if (match5) return match5[2];

    // Pattern 6: app.listen( or server.listen(
    const match6 = content.match(
      /\b(app|server|router|handler|httpServer)\s*\.listen\s*\(/,
    );
    if (match6) return match6[1];

    return "app";
  } catch {
    return "app";
  }
}

function detectDotenv(cwd, pkg, entryPoint) {
  // Check if dotenv is in dependencies
  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };
  const hasDotenvPackage = !!deps["dotenv"];

  // Check if dotenv is actually being called in entry file
  let hasDotenvCall = false;
  if (entryPoint && fs.existsSync(entryPoint)) {
    try {
      const content = fs.readFileSync(entryPoint, "utf8");
      hasDotenvCall =
        content.includes("dotenv") ||
        content.includes("require('dotenv')") ||
        content.includes('require("dotenv")');
    } catch {}
  }

  return hasDotenvPackage || hasDotenvCall;
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
  const generateTs = shouldGenerateTs(backendDir, isTypeScript);

  // ── Find frontend main file ───────────────────────────────────────────────
  let frontendMainFile = null;
  if (frontendDir && frontendPkg) {
    frontendMainFile = findMainFrontendFile(frontendDir, frontendPkg);
  } else if (framework.name === "next") {
    frontendMainFile = findMainFrontendFile(backendDir, backendPkg);
  } else if (framework.name === "express" && !frontendDir) {
    // Express + frontend in same root folder (e.g. public/index.html)
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
  }

  if (framework.name === "express") {
    result.entryPoint = detectExpressEntry(backendDir, backendPkg);
    result.hasDotenv = detectDotenv(backendDir, backendPkg, result.entryPoint);
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

// ─── CORS DETECTION ───────────────────────────────────────────────────────────

function detectCors(filePath, framework) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, "utf8");

  if (framework === "express") {
    return (
      content.includes("cors(") ||
      content.includes("require('cors')") ||
      content.includes('require("cors")')
    );
  }
  return false;
}

// ─── NEXT.JS CORS DETECTION ───────────────────────────────────────────────────

function detectNextJsMiddleware(cwd) {
  const candidates = [
    "middleware.ts",
    "middleware.tsx",
    "middleware.js",
    "middleware.jsx",
    "middleware.mjs",
    "middleware.mts",
    "src/middleware.ts",
    "src/middleware.tsx",
    "src/middleware.js",
    "src/middleware.jsx",
    "src/middleware.mjs",
    "src/middleware.mts",
  ];

  for (const candidate of candidates) {
    const fullPath = path.join(cwd, candidate);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, "utf8");
      if (content.includes("Access-Control-Allow-Origin")) {
        return { exists: true, hasCors: true, path: fullPath, content };
      }
      return { exists: true, hasCors: false, path: fullPath, content };
    }
  }

  return { exists: false, hasCors: false, path: null, content: null };
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
  detectPackageManager,
  detectExistingBotVersion,
  findFileWithContent,
  findListenCall,
  findModuleExportsApp,
  findListenInsideCallback,
  findCreateServer,
  detectAppVarName,
  detectDotenv,
  detectCors,
  detectNextJsMiddleware,
  parseEntryFromConfigFiles,
  scoreExpressFile,
};
