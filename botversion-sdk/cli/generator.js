// botversion-sdk/cli/generator.js
"use strict";

const path = require("path");
const fs = require("fs");

// ─── EXPRESS CODE GENERATION ──────────────────────────────────────────────────

function generateExpressInit(info, apiKey) {
  const { moduleSystem, isTypeScript, auth } = info;
  const isESM = moduleSystem === "esm";

  // FIX #2: Detect the actual app variable name used in the entry file
  const appVarName = info.appVarName || "app";

  const importLine = isESM
    ? `import BotVersion from 'botversion-sdk';`
    : `const BotVersion = require('botversion-sdk');`;

  const getUserContext = generateExpressUserContext(auth);

  const initBlock = `
// BotVersion AI Agent — auto-added by botversion-sdk init
${importLine}

BotVersion.init(${appVarName}, {
  apiKey: process.env.BOTVERSION_API_KEY,
});

${appVarName}.post('/api/botversion/chat', (req, res) => {
  BotVersion.chat(req, res);
});
`;

  return {
    initBlock: initBlock.trim(),
    helperCode: getUserContext.helperCode || null,
    imports: getUserContext.imports || null,
  };
}

function generateExpressUserContext(auth) {
  if (!auth || !auth.name) {
    return {
      option: `
  // getUserContext: (req) => ({ userId: req.user?.id, email: req.user?.email }),`,
      helperCode: null,
      imports: null,
    };
  }

  switch (auth.name) {
    case "passport":
      return {
        option: `
  getUserContext: (req) => ({
    userId: req.user?.id,
    email: req.user?.email,
    role: req.user?.role,
  }),`,
        helperCode: null,
        imports: null,
      };

    case "jwt":
      return {
        option: `
  getUserContext: (req) => {
    // Decoded by your JWT middleware — adjust fields as needed
    return {
      userId: req.user?.id || req.user?.sub,
      email: req.user?.email,
      role: req.user?.role,
    };
  },`,
        helperCode: null,
        imports: null,
      };

    case "express-session":
      return {
        option: `
  getUserContext: (req) => ({
    userId: req.session?.user?.id,
    email: req.session?.user?.email,
    role: req.session?.user?.role,
  }),`,
        helperCode: null,
        imports: null,
      };

    default:
      return {
        option: `
  // getUserContext: (req) => ({ userId: req.user?.id, email: req.user?.email }),`,
        helperCode: null,
        imports: null,
      };
  }
}

// ─── NEXT.JS INSTRUMENTATION FILE ────────────────────────────────────────────

function generateInstrumentationFile(info, apiKey) {
  const { next, moduleSystem } = info;

  // FIX #3: Only include pagesDir if Pages Router actually exists
  // FIX #8: Use dynamic import instead of require() to support ESM projects
  const hasPagesRouter = next?.pagesRouter;
  const hasAppRouter = next?.appRouter;

  const pagesDirLine = hasPagesRouter
    ? next?.srcDir
      ? `path.join(process.cwd(), 'src', 'pages')`
      : `path.join(process.cwd(), 'pages')`
    : null;

  const appDirLine = hasAppRouter
    ? next?.srcDir
      ? `path.join(process.cwd(), 'src', 'app')`
      : `path.join(process.cwd(), 'app')`
    : null;

  // Build pagesDir option only if Pages Router exists
  const pagesDirOption = pagesDirLine
    ? `\n      pagesDir: ${pagesDirLine},`
    : "";

  // Build appDir option only if App Router exists (for future scanner support)
  const appDirOption = appDirLine ? `\n      appDir: ${appDirLine},` : "";

  return `export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // FIX: Use dynamic import to support both CJS and ESM projects
    const { default: BotVersion } = await import('botversion-sdk');
    const { default: path } = await import('path');

    BotVersion.init({
      apiKey: process.env.BOTVERSION_API_KEY,${pagesDirOption}${appDirOption}
    });
  }
}
`;
}

// ─── NEXT.JS CHAT ROUTE — PAGES ROUTER ───────────────────────────────────────

function generateNextPagesChatRoute(info) {
  const { auth } = info;

  switch (auth.name) {
    case "next-auth":
      return generateNextAuthPagesRoute(info);
    case "clerk":
      return generateClerkPagesRoute(info);
    case "supabase":
      return generateSupabasePagesRoute(info);
    default:
      return generateAuthlessPagesRoute(info);
  }
}

function generateNextAuthPagesRoute(info) {
  const { nextAuthConfig, auth, next, generateTs } = info;
  const isV5 = auth.version === "v5";

  // Compute correct relative import path for authOptions
  const chatFileDir = path.join(next.baseDir, "pages", "api", "botversion");

  let authImportPath = "../auth/[...nextauth]";
  if (nextAuthConfig) {
    const rel = path
      .relative(chatFileDir, nextAuthConfig.path)
      .replace(/\\/g, "/")
      .replace(/\.(js|ts)$/, "");
    authImportPath = rel.startsWith(".") ? rel : "./" + rel;
  }

  if (isV5) {
    return `import BotVersion from 'botversion-sdk';
import { auth } from '${authImportPath}';

export default BotVersion.nextHandler({
  apiKey: process.env.BOTVERSION_API_KEY,
  getSession: (req, res) => auth(),
});
`;
  }

  if (generateTs) {
    return `import BotVersion from 'botversion-sdk';
import { getServerSession } from 'next-auth';
import { authOptions } from '${authImportPath}';
import type { NextApiRequest, NextApiResponse } from 'next';

export default BotVersion.nextHandler({
  apiKey: process.env.BOTVERSION_API_KEY,
  getSession: async (req: NextApiRequest, res: NextApiResponse) => {
    return getServerSession(req, res, authOptions);
  },
});
`;
  }

  return `import BotVersion from 'botversion-sdk';
import { getServerSession } from 'next-auth';
import { authOptions } from '${authImportPath}';

export default BotVersion.nextHandler({
  apiKey: process.env.BOTVERSION_API_KEY,
  getSession: (req, res) => getServerSession(req, res, authOptions),
});
`;
}

function generateClerkPagesRoute(info) {
  const { auth } = info;
  const pkg = auth.package || "@clerk/nextjs";

  return `import BotVersion from 'botversion-sdk';
import { getAuth } from '${pkg}/server';

export default BotVersion.nextHandler({
  apiKey: process.env.BOTVERSION_API_KEY,
  getSession: async (req, res) => {
    const { userId } = getAuth(req);
    return { user: { id: userId } };
  },
});
`;
}

function generateSupabasePagesRoute(info) {
  return `import BotVersion from 'botversion-sdk';
import { createServerSupabaseClient } from '@supabase/auth-helpers-nextjs';

export default BotVersion.nextHandler({
  apiKey: process.env.BOTVERSION_API_KEY,
  getSession: async (req, res) => {
    const supabase = createServerSupabaseClient({ req, res });
    const { data: { session } } = await supabase.auth.getSession();
    return { user: session?.user ?? null };
  },
});
`;
}

function generateAuthlessPagesRoute(info) {
  const { auth, isTypeScript } = info;

  const comment =
    auth.name && !auth.supported
      ? `// TODO: We detected ${auth.name} but don't have automatic support yet.\n// Add your own getSession below to pass user context to the agent.\n// See: https://docs.botversion.com/auth\n`
      : "";

  if (isTypeScript) {
    return `${comment}import BotVersion from 'botversion-sdk';
import type { NextApiRequest, NextApiResponse } from 'next';

// No auth library detected — agent will work without user context
// To add user context: uncomment and implement getSession below
export default BotVersion.nextHandler({
  apiKey: process.env.BOTVERSION_API_KEY,
  // getSession: async (req: NextApiRequest, res: NextApiResponse) => {
  //   return { user: { id: 'user-id', email: 'user@example.com' } };
  // },
});
`;
  }

  return `${comment}import BotVersion from 'botversion-sdk';

// No auth library detected — agent will work without user context
// To add user context: uncomment and implement getSession below
export default BotVersion.nextHandler({
  apiKey: process.env.BOTVERSION_API_KEY,
  // getSession: async (req, res) => {
  //   return { user: { id: 'user-id', email: 'user@example.com' } };
  // },
});
`;
}

// ─── NEXT.JS CHAT ROUTE — APP ROUTER ─────────────────────────────────────────

function generateNextAppChatRoute(info) {
  const { auth } = info;

  switch (auth.name) {
    case "next-auth":
      return generateNextAuthAppRoute(info);
    case "clerk":
      return generateClerkAppRoute(info);
    case "supabase":
      return generateSupabaseAppRoute(info);
    default:
      return generateAuthlessAppRoute(info);
  }
}

function generateNextAuthAppRoute(info) {
  const { auth, isTypeScript, next, nextAuthConfig } = info;
  const isV5 = auth.version === "v5";

  // FIX #5: Compute the correct relative import path instead of hardcoding @/lib/auth
  const chatFileDir = path.join(
    next.baseDir,
    "app",
    "api",
    "botversion",
    "chat",
  );

  let authImportPath = "@/lib/auth"; // fallback alias
  if (nextAuthConfig) {
    const rel = path
      .relative(chatFileDir, nextAuthConfig.path)
      .replace(/\\/g, "/")
      .replace(/\.(js|ts)$/, "");
    authImportPath = rel.startsWith(".") ? rel : "./" + rel;
  }

  const typeAnnotation = isTypeScript ? ": NextRequest" : "";
  const nextRequestImport = isTypeScript
    ? `import { NextRequest, NextResponse } from 'next/server';\n`
    : `import { NextResponse } from 'next/server';\n`;

  if (isV5) {
    return `import BotVersion from 'botversion-sdk';
import { auth } from '${authImportPath}';
${nextRequestImport}
// FIX #1: appRouterHandler is implemented here directly since App Router
// does not support the nextHandler() Pages pattern
export async function POST(req${typeAnnotation}) {
  try {
    const session = await auth();
    const body = await req.json();

    const result = await BotVersion.nextHandler({
      apiKey: process.env.BOTVERSION_API_KEY,
      getSession: async () => session,
    })({ ...req, body }, { json: (d) => d, status: () => ({ json: (d) => d }) });

    return NextResponse.json(result);
  } catch (err) {
    console.error('[BotVersion] App Router handler error:', err);
    return NextResponse.json({ error: 'Agent error' }, { status: 500 });
  }
}
`;
  }

  return `import BotVersion from 'botversion-sdk';
import { getServerSession } from 'next-auth';
import { authOptions } from '${authImportPath}';
${nextRequestImport}
export async function POST(req${typeAnnotation}) {
  try {
    const session = await getServerSession(authOptions);
    const body = await req.json();

    const userContext = {
      userId: session?.user?.id,
      email: session?.user?.email,
      name: session?.user?.name,
    };

    // Forward to BotVersion platform directly
    const response = await fetch(\`\${process.env.BOTVERSION_PLATFORM_URL || 'http://localhost:3000'}/api/chatbot/widget-chat\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatbotId: body.chatbotId,
        publicKey: body.publicKey,
        query: body.message,
        previousChats: body.conversationHistory || [],
        pageContext: body.pageContext || {},
        userContext,
      }),
    });

    const data = await response.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error('[BotVersion] App Router handler error:', err);
    return NextResponse.json({ error: 'Agent error' }, { status: 500 });
  }
}
`;
}

function generateClerkAppRoute(info) {
  const { isTypeScript } = info;
  const typeAnnotation = isTypeScript ? ": NextRequest" : "";
  const nextRequestImport = isTypeScript
    ? `import { NextRequest, NextResponse } from 'next/server';\n`
    : `import { NextResponse } from 'next/server';\n`;

  return `import BotVersion from 'botversion-sdk';
import { auth } from '@clerk/nextjs/server';
${nextRequestImport}
export async function POST(req${typeAnnotation}) {
  try {
    // FIX #6: auth() is async in Clerk v5+ — must be awaited
    const { userId } = await auth();
    const body = await req.json();

    const response = await fetch(\`\${process.env.BOTVERSION_PLATFORM_URL || 'http://localhost:3000'}/api/chatbot/widget-chat\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatbotId: body.chatbotId,
        publicKey: body.publicKey,
        query: body.message,
        previousChats: body.conversationHistory || [],
        pageContext: body.pageContext || {},
        userContext: { userId },
      }),
    });

    const data = await response.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error('[BotVersion] App Router handler error:', err);
    return NextResponse.json({ error: 'Agent error' }, { status: 500 });
  }
}
`;
}

function generateSupabaseAppRoute(info) {
  const { isTypeScript } = info;
  const typeAnnotation = isTypeScript ? ": NextRequest" : "";
  const nextRequestImport = isTypeScript
    ? `import { NextRequest, NextResponse } from 'next/server';\n`
    : `import { NextResponse } from 'next/server';\n`;

  return `import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
${nextRequestImport}
export async function POST(req${typeAnnotation}) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const { data: { session } } = await supabase.auth.getSession();
    const body = await req.json();

    const response = await fetch(\`\${process.env.BOTVERSION_PLATFORM_URL || 'http://localhost:3000'}/api/chatbot/widget-chat\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatbotId: body.chatbotId,
        publicKey: body.publicKey,
        query: body.message,
        previousChats: body.conversationHistory || [],
        pageContext: body.pageContext || {},
        userContext: {
          userId: session?.user?.id,
          email: session?.user?.email,
        },
      }),
    });

    const data = await response.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error('[BotVersion] App Router handler error:', err);
    return NextResponse.json({ error: 'Agent error' }, { status: 500 });
  }
}
`;
}

function generateAuthlessAppRoute(info) {
  const { auth, isTypeScript } = info;
  const typeAnnotation = isTypeScript ? ": NextRequest" : "";
  const nextRequestImport = isTypeScript
    ? `import { NextRequest, NextResponse } from 'next/server';\n`
    : `import { NextResponse } from 'next/server';\n`;

  const comment =
    auth.name && !auth.supported
      ? `// TODO: We detected ${auth.name} but don't have automatic support yet.\n// Add your own user context below.\n// See: https://docs.botversion.com/auth\n\n`
      : "";

  return `${comment}${nextRequestImport}
export async function POST(req${typeAnnotation}) {
  try {
    const body = await req.json();

    // No auth detected — agent works without user context
    // Add userContext here if needed:
    // const userContext = { userId: '...', email: '...' };

    const response = await fetch(\`\${process.env.BOTVERSION_PLATFORM_URL || 'http://localhost:3000'}/api/chatbot/widget-chat\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatbotId: body.chatbotId,
        publicKey: body.publicKey,
        query: body.message,
        previousChats: body.conversationHistory || [],
        pageContext: body.pageContext || {},
        userContext: {},
      }),
    });

    const data = await response.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error('[BotVersion] App Router handler error:', err);
    return NextResponse.json({ error: 'Agent error' }, { status: 500 });
  }
}
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
    // Check minor version too
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

  // Add to existing experimental block
  if (configContent.includes("experimental")) {
    patched = configContent.replace(
      /experimental\s*:\s*\{/,
      "experimental: {\n    instrumentationHook: true,",
    );

    // FIX #7: Handle next.config.mjs style — export default { ... }
  } else if (/export\s+default\s+\{/.test(configContent)) {
    patched = configContent.replace(
      /export\s+default\s+\{/,
      "export default {\n  experimental: {\n    instrumentationHook: true,\n  },",
    );

    // Handle const nextConfig = { ... } style (next.config.js)
  } else if (/const\s+nextConfig\s*=\s*\{/.test(configContent)) {
    patched = configContent.replace(
      /const\s+nextConfig\s*=\s*\{/,
      "const nextConfig = {\n  experimental: {\n    instrumentationHook: true,\n  },",
    );

    // Handle module.exports = { ... } style
  } else if (/module\.exports\s*=\s*\{/.test(configContent)) {
    patched = configContent.replace(
      /module\.exports\s*=\s*\{/,
      "module.exports = {\n  experimental: {\n    instrumentationHook: true,\n  },",
    );
  } else {
    // Cannot safely patch — return null so caller prompts manual step
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
  BotVersion.init({ apiKey: '${apiKey}' });
  
  fastify.post('/api/botversion/chat', async (request, reply) => {
    // Implement using BotVersion.agentChat() directly
    // See: https://docs.botversion.com/fastify
  });
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
  data-proxy-url="/api/botversion/chat"
></script>`;
}

module.exports = {
  generateExpressInit,
  generateInstrumentationFile,
  generateNextPagesChatRoute,
  generateNextAppChatRoute,
  generateManualInstructions,
  generateNextConfigPatch,
  generateScriptTag,
};
