// botversion-sdk/cli/generator.js
"use strict";

const path = require("path");
const fs = require("fs");

// ─── EXPRESS CODE GENERATION ──────────────────────────────────────────────────

function generateExpressInit(info, apiKey) {
  const { moduleSystem, isTypeScript } = info;
  const isESM = moduleSystem === "esm";

  const appVarName = info.appVarName || "app";

  const importLine = isESM
    ? `import BotVersion from 'botversion-sdk';`
    : `const BotVersion = require('botversion-sdk');`;

  const apiKeyValue = `process.env.BOTVERSION_API_KEY`;

  const initBlock = `
// BotVersion AI Agent — auto-added by botversion-sdk init
${importLine}

BotVersion.init(${appVarName}, {
  apiKey: ${apiKeyValue},
  cwd: __dirname,
});
`;

  return {
    initBlock: initBlock.trim(),
  };
}

// ─── NEXT.JS INSTRUMENTATION FILE ────────────────────────────────────────────
function generateInstrumentationFile(info, apiKey) {
  const { next, moduleSystem } = info;
  const isESM = moduleSystem === "esm";

  const hasPagesRouter = next?.pagesRouter;
  const hasAppRouter = next?.appRouter;

  // Both App Router and Pages Router use pagesDir option
  const pagesDirOption = "";

  // ESM version
  if (isESM) {
    return `export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { default: BotVersion } = await import('botversion-sdk');

    BotVersion.init({
      apiKey: process.env.BOTVERSION_API_KEY,
    });
  }
}
`;
  }

  // CommonJS version
  return `async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const BotVersion = require('botversion-sdk');

    BotVersion.init({
      apiKey: process.env.BOTVERSION_API_KEY,
    });
  }
}

module.exports = { register };
`;
}

// ─── NEXT.JS CONFIG PATCH ─────────────────────────────────────────────────────

function generateNextConfigPatch(cwd, nextVersion) {
  const candidates = ["next.config.js", "next.config.mjs", "next.config.ts"];

  let configPath = null;
  let configContent = null;

  for (const candidate of candidates) {
    const fullPath = path.join(cwd, candidate);
    if (fs.existsSync(fullPath)) {
      configPath = fullPath;
      configContent = fs.readFileSync(fullPath, "utf8");
      break;
    }
  }

  if (!configPath) return null;

  // Skip instrumentationHook for Next.js 14.1+ (enabled by default)
  if (nextVersion && nextVersion.major >= 14) {
    const rawVersion = nextVersion.raw || "";
    const match = rawVersion.match(/(\d+)\.(\d+)/);
    const minor = match ? parseInt(match[2], 10) : 0;
    if (nextVersion.major > 14 || (nextVersion.major === 14 && minor >= 1)) {
      return { path: configPath, alreadyPatched: true };
    }
  }

  if (configContent.includes("instrumentationHook")) {
    return { path: configPath, alreadyPatched: true };
  }

  let patched = configContent;

  if (configContent.includes("experimental")) {
    patched = configContent.replace(
      /experimental\s*:\s*\{/,
      "experimental: {\n    instrumentationHook: true,",
    );
  } else if (/export\s+default\s+\{/.test(configContent)) {
    patched = configContent.replace(
      /export\s+default\s+\{/,
      "export default {\n  experimental: {\n    instrumentationHook: true,\n  },",
    );
  } else if (/const\s+nextConfig\s*=\s*\{/.test(configContent)) {
    patched = configContent.replace(
      /const\s+nextConfig\s*=\s*\{/,
      "const nextConfig = {\n  experimental: {\n    instrumentationHook: true,\n  },",
    );
  } else if (/module\.exports\s*=\s*\{/.test(configContent)) {
    patched = configContent.replace(
      /module\.exports\s*=\s*\{/,
      "module.exports = {\n  experimental: {\n    instrumentationHook: true,\n  },",
    );
  } else {
    return null;
  }

  return { path: configPath, content: patched, alreadyPatched: false };
}

// ─── MANUAL INSTRUCTIONS FOR UNSUPPORTED FRAMEWORKS ──────────────────────────

function generateManualInstructions(framework, apiKey) {
  const instructions = {
    fastify: `
Fastify support is coming soon. For now, add this manually:

  const BotVersion = require('botversion-sdk');
  
  // After registering all your routes:
  BotVersion.init({ apiKey: process.env.BOTVERSION_API_KEY });
`,
    koa: `
Koa support is coming soon. For now, add this manually:
  See: https://docs.botversion.com/koa
`,
    "@nestjs/core": `
NestJS support is coming soon. For now, add this manually:
  See: https://docs.botversion.com/nestjs
`,
  };

  return (
    instructions[framework] ||
    `
This framework is not yet supported automatically.
Visit https://docs.botversion.com for manual setup instructions.
`
  );
}

// ─── SCRIPT TAG GENERATION ────────────────────────────────────────────────────

function generateScriptTag(projectInfo) {
  return `<script
  id="botversion-loader"
  src="${projectInfo.cdnUrl}"
  data-api-url="${projectInfo.apiUrl}"
  data-project-id="${projectInfo.projectId}"
  data-public-key="${projectInfo.publicKey}"
></script>`;
}

module.exports = {
  generateExpressInit,
  generateInstrumentationFile,
  generateManualInstructions,
  generateNextConfigPatch,
  generateScriptTag,
};
