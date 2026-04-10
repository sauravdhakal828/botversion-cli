// botversion-sdk/cli/generator.js

"use strict";

const path = require("path");

// ─── EXPRESS CODE GENERATION ─────────────────────────────────────────────────

function generateExpressInit(info, apiKey) {
  const { moduleSystem, isTypeScript, auth } = info;
  const isESM = moduleSystem === "esm";

  const importLine = isESM
    ? `import BotVersion from 'botversion-sdk';`
    : `const BotVersion = require('botversion-sdk');`;

  const getUserContext = generateExpressUserContext(auth);

  const initBlock = `
// BotVersion AI Agent — auto-added by botversion-sdk init
${importLine}

BotVersion.init(app, {
  apiKey: '${apiKey}',${getUserContext.option}
});

app.post('/api/botversion/chat', (req, res) => {
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

// ─── NEXT.JS LIB FILE GENERATION ─────────────────────────────────────────────
function generateInstrumentationFile(info, apiKey) {
  const pagesDir = info.next?.srcDir
    ? `path.join(process.cwd(), 'src', 'pages')`
    : `path.join(process.cwd(), 'pages')`;

  return `export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const BotVersion = require('botversion-sdk');
    const path = require('path');
    BotVersion.init({
      apiKey: process.env.BOTVERSION_API_KEY,
      pagesDir: ${pagesDir},
    });
  }
}
`;
}

// ─── NEXT.JS CHAT ROUTE — PAGES ROUTER ──────────────────────────────────────

function generateNextPagesChatRoute(info) {
  const { auth, isTypeScript, nextAuthConfig, moduleSystem } = info;
  const isESM = moduleSystem === "esm";

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

  // The chat file lives at: {base}/pages/api/botversion/chat.js
  // We need the import path relative to THAT file
  const chatFileDir = path.join(
    next.baseDir, // handles src/ automatically
    "pages",
    "api",
    "botversion",
  );

  // Determine the import path for authOptions
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

  // generateTs: user has allowJs:false — generate proper TypeScript
  if (info.generateTs) {
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

  // Plain JS — works for all standard Next.js projects
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
      ? `// TODO: We detected ${auth.name} but don't have automatic support yet.
// Add your own getSession below to pass user context to the agent.
// See: https://docs.botversion.com/auth\n`
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
  const { auth, isTypeScript } = info;

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
  const { auth, isTypeScript } = info;
  const isV5 = auth.version === "v5";

  if (isV5) {
    return `import BotVersion from 'botversion-sdk';
import { auth } from '@/auth';
import { NextRequest } from 'next/server';

export async function POST(req${isTypeScript ? ": NextRequest" : ""}) {
  const session = await auth();
  const body = await req.json();

  return BotVersion.appRouterHandler({
    body,
    userContext: {
      userId: session?.user?.id,
      email: session?.user?.email,
      name: session?.user?.name,
    },
  });
}
`;
  }

  return `import BotVersion from 'botversion-sdk';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { NextRequest } from 'next/server';

export async function POST(req${isTypeScript ? ": NextRequest" : ""}) {
  const session = await getServerSession(authOptions);
  const body = await req.json();

  return BotVersion.appRouterHandler({
    body,
    userContext: {
      userId: session?.user?.id,
      email: session?.user?.email,
      name: session?.user?.name,
    },
  });
}
`;
}

function generateClerkAppRoute(info) {
  const { auth, isTypeScript } = info;

  return `import BotVersion from 'botversion-sdk';
import { auth } from '@clerk/nextjs/server';
import { NextRequest } from 'next/server';

export async function POST(req${isTypeScript ? ": NextRequest" : ""}) {
  const { userId } = auth();
  const body = await req.json();

  return BotVersion.appRouterHandler({
    body,
    userContext: { userId },
  });
}
`;
}

function generateSupabaseAppRoute(info) {
  const { isTypeScript } = info;

  return `import BotVersion from 'botversion-sdk';
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextRequest } from 'next/server';

export async function POST(req${isTypeScript ? ": NextRequest" : ""}) {
  const supabase = createRouteHandlerClient({ cookies });
  const { data: { session } } = await supabase.auth.getSession();
  const body = await req.json();

  return BotVersion.appRouterHandler({
    body,
    userContext: {
      userId: session?.user?.id,
      email: session?.user?.email,
    },
  });
}
`;
}

function generateAuthlessAppRoute(info) {
  const { auth, isTypeScript } = info;

  const comment =
    auth.name && !auth.supported
      ? `// TODO: We detected ${auth.name} but don't have automatic support yet.
// Add your own user context below.
// See: https://docs.botversion.com/auth\n\n`
      : "";

  return `${comment}import BotVersion from 'botversion-sdk';
import { NextRequest } from 'next/server';

export async function POST(req${isTypeScript ? ": NextRequest" : ""}) {
  const body = await req.json();

  // No auth detected — agent works without user context
  // Add userContext here if needed
  return BotVersion.appRouterHandler({ body });
}
`;
}

// ─── MANUAL INSTRUCTIONS FOR UNSUPPORTED CASES ───────────────────────────────

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

function generateNextConfigPatch(cwd) {
  const fs = require("fs");
  const path = require("path");

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

  // Already has instrumentationHook
  if (configContent.includes("instrumentationHook")) {
    return { path: configPath, alreadyPatched: true };
  }

  // Add instrumentationHook: true to experimental block if exists
  if (configContent.includes("experimental")) {
    const patched = configContent.replace(
      /experimental\s*:\s*\{/,
      "experimental: {\n    instrumentationHook: true,",
    );
    return { path: configPath, content: patched, alreadyPatched: false };
  }

  // Add experimental block before the closing of config object
  const patched = configContent.replace(
    /const nextConfig\s*=\s*\{/,
    "const nextConfig = {\n  experimental: {\n    instrumentationHook: true,\n  },",
  );

  return { path: configPath, content: patched, alreadyPatched: false };
}

module.exports = {
  generateExpressInit,
  generateInstrumentationFile,
  generateNextPagesChatRoute,
  generateNextAppChatRoute,
  generateManualInstructions,
  generateNextConfigPatch,
};
