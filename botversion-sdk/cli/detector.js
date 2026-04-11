// botversion-sdk/cli/detector.js

"use strict";

const fs = require("fs");
const path = require("path");

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

// ─── MONOREPO DETECTION ──────────────────────────────────────────────────────

function detectMonorepo(cwd) {
  const entries = fs.readdirSync(cwd);

  // Check for workspaces in root package.json
  const rootPkg = readPackageJson(cwd);
  if (rootPkg && rootPkg.workspaces) {
    // Find all workspace package.json files
    const workspaceDirs = [];
    const patterns = Array.isArray(rootPkg.workspaces)
      ? rootPkg.workspaces
      : rootPkg.workspaces.packages || [];

    patterns.forEach((pattern) => {
      // Handle simple patterns like "packages/*"
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

  // Check unsupported first so we can warn clearly
  for (const fw of UNSUPPORTED_FRAMEWORKS) {
    if (deps[fw]) {
      return { name: fw, supported: false };
    }
  }

  for (const fw of SUPPORTED_FRAMEWORKS) {
    if (deps[fw]) {
      return { name: fw, supported: true };
    }
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
    // Strip comments — tsconfig supports JSON with comments
    const stripped = raw
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

// Decide whether to generate .ts or .js files
// - Not TypeScript → always .js
// - TypeScript + allowJs: true (Next.js default) → .js is fine
// - TypeScript + allowJs: false (manually set by user) → must use .ts
// - TypeScript + allowJs not set → Next.js default is true → .js is fine
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
    // Resolve the actual base directory
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
      // e.g. "node server.js" or "nodemon src/index.js" or "ts-node index.ts"
      const match = script.match(
        /(?:node|nodemon|ts-node|tsx)\s+([^\s]+\.(js|ts))/,
      );
      if (match) {
        const filePath = path.join(cwd, match[1]);
        if (fs.existsSync(filePath)) return filePath;
      }
    }
  }

  // Strategy 3: common file names in root and src/
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
      // Verify it actually contains express
      const content = fs.readFileSync(filePath, "utf8");
      if (content.includes("express") || content.includes("app.listen")) {
        return filePath;
      }
    }
  }

  // Strategy 4: any .js/.ts file containing app.listen()
  return findFileWithContent(cwd, "app.listen", [".js", ".ts"], 2);
}

// ─── app.listen() LOCATION ───────────────────────────────────────────────────

function findListenCall(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (/app\.listen\s*\(/.test(lines[i])) {
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

function findListenInsideCallback(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/app\.listen\s*\(/.test(lines[i])) {
      // Check if it's inside a callback (indented or preceded by .then)
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
      return {
        name: lib.name,
        version,
        package: pkg2,
        supported,
      };
    }
  }

  return { name: null, supported: false };
}

// ─── NEXT-AUTH CONFIG LOCATION ───────────────────────────────────────────────

function findNextAuthConfig(cwd) {
  // Common locations for authOptions
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
    "auth.ts", // next-auth v5
  ];

  for (const candidate of candidates) {
    const fullPath = path.join(cwd, candidate);
    if (fs.existsSync(fullPath)) {
      return { path: fullPath, relativePath: candidate };
    }
  }

  // Search for authOptions in files
  const found = findFileWithContent(cwd, "authOptions", [".js", ".ts"], 3);
  if (found) {
    return {
      path: found,
      relativePath: path.relative(cwd, found),
    };
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

    // Skip node_modules, .git, .next, dist, build
    const skipDirs = [
      "node_modules",
      ".git",
      ".next",
      "dist",
      "build",
      ".cache",
    ];

    let entries;
    try {
      entries = fs.readdirSync(currentDir);
    } catch {
      return null;
    }

    for (const entry of entries) {
      if (skipDirs.includes(entry)) continue;

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
  } catch (e) {
    return "app";
  }
}

// ─── MAIN DETECT FUNCTION ────────────────────────────────────────────────────

function detect(cwd) {
  const pkg = readPackageJson(cwd);
  const monorepo = detectMonorepo(cwd);
  const framework = detectFramework(pkg);
  const moduleSystem = detectModuleSystem(pkg);
  const isTypeScript = detectTypeScript(cwd);
  const hasSrc = detectSrcDir(cwd);
  const auth = detectAuth(pkg);
  const packageManager = detectPackageManager(cwd);

  const generateTs = shouldGenerateTs(cwd, isTypeScript);

  const result = {
    cwd,
    pkg,
    monorepo,
    framework,
    moduleSystem,
    isTypeScript,
    generateTs,
    hasSrc,
    auth,
    packageManager,
    // generateTs: true means user has allowJs:false — must use .ts
    // generateTs: false means .js files are fine (most users)
    ext: generateTs ? ".ts" : ".js",
  };

  // Framework-specific detection
  if (framework.name === "next") {
    result.next = detectNextRouter(cwd);
    result.nextVersion = detectNextVersion(pkg);
    if (auth.name === "next-auth") {
      result.nextAuthConfig = findNextAuthConfig(cwd);
    }
  }

  if (framework.name === "express") {
    result.entryPoint = detectExpressEntry(cwd, pkg);
    if (result.entryPoint) {
      result.listenCall = findListenCall(result.entryPoint);
      result.moduleExportsApp = findModuleExportsApp(result.entryPoint);
      result.listenInsideCallback = findListenInsideCallback(result.entryPoint);
      result.createServer = findCreateServer(result.entryPoint);
      result.appVarName = detectAppVarName(result.entryPoint);

      // Also check for app file separately (pattern 2)
      const appFileCandidates = [
        "src/app.js",
        "src/app.ts",
        "app.js",
        "app.ts",
      ];
      for (const candidate of appFileCandidates) {
        const fullPath = path.join(cwd, candidate);
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

  result.alreadyInitialized =
    detectExistingBotVersion(result.entryPoint) ||
    (framework.name === "next" &&
      (fs.existsSync(path.join(cwd, "instrumentation.js")) ||
        fs.existsSync(path.join(cwd, "instrumentation.ts")) ||
        fs.existsSync(path.join(cwd, "src", "instrumentation.js")) ||
        fs.existsSync(path.join(cwd, "src", "instrumentation.ts"))));

  return result;
}

module.exports = {
  detect,
  readPackageJson,
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
