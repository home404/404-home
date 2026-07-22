import {
  randomUUID
} from "node:crypto";

import {
  createClient
} from "@supabase/supabase-js";

import OpenAI from "openai";

import {
  StreamableHTTPServerTransport
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  createMcpAuth
} from "../middleware/mcp-auth.mjs";

import {
  createStudyService
} from "../services/study-service.mjs";

import {
  createHeartService
} from "../services/heart-service.mjs";

import {
  create404McpServer
} from "../mcp/404-mcp.mjs";


/* ========================================
   基础配置
======================================== */

function normalizeBaseUrl(value) {
  return String(value ?? "")
    .trim()
    .replace(/\/+$/, "");
}


function firstHeaderValue(value) {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }

  return String(value ?? "")
    .split(",")[0]
    .trim();
}


function getPublicBaseUrl(req) {
  const configuredUrl =
    normalizeBaseUrl(
      process.env.PUBLIC_BASE_URL
    );

  if (configuredUrl) {
    return configuredUrl;
  }


  const railwayDomain =
    normalizeBaseUrl(
      process.env.RAILWAY_PUBLIC_DOMAIN
    );

  if (railwayDomain) {
    return railwayDomain.startsWith("http")
      ? railwayDomain
      : `https://${railwayDomain}`;
  }


  const forwardedProtocol =
    firstHeaderValue(
      req.headers["x-forwarded-proto"]
    );

  const forwardedHost =
    firstHeaderValue(
      req.headers["x-forwarded-host"]
    );

  const protocol =
    forwardedProtocol ||
    req.protocol ||
    "http";

  const host =
    forwardedHost ||
    req.get("host");


  if (!host) {
    throw new Error(
      "无法确定 MCP 服务公开地址"
    );
  }


  return `${protocol}://${host}`;
}


function getRequestId(req) {
  const incomingId =
    firstHeaderValue(
      req.headers["x-request-id"]
    );

  if (
    incomingId &&
    incomingId.length <= 200
  ) {
    return incomingId;
  }

  return randomUUID();
}


function getRequiredConfig() {
  const supabaseUrl =
    normalizeBaseUrl(
      process.env.SUPABASE_URL
    );

  const publishableKey =
    process.env.SUPABASE_PUBLISHABLE_KEY;

  const secretKey =
    process.env.SUPABASE_SECRET_KEY;


  if (!supabaseUrl) {
    throw new Error(
      "缺少 SUPABASE_URL"
    );
  }


  if (!publishableKey) {
    throw new Error(
      "缺少 SUPABASE_PUBLISHABLE_KEY"
    );
  }


  return {
    supabaseUrl,
    publishableKey,
    secretKey
  };
}


function createAuditClient({
  supabaseUrl,
  secretKey
}) {
  if (!secretKey) {
    return null;
  }


  return createClient(
    supabaseUrl,
    secretKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    }
  );
}


function createRequestAuth(req) {
  const {
    supabaseUrl,
    publishableKey
  } = getRequiredConfig();


  const resourceUrl =
    `${getPublicBaseUrl(req)}/mcp`;


  return createMcpAuth({
    supabaseUrl,
    publishableKey,
    resourceUrl
  });
}


/* ========================================
   OAuth 受保护资源说明
======================================== */

export async function
handleProtectedResourceMetadata(
  req,
  res
) {
  try {
    const auth =
      createRequestAuth(req);


    res.set(
      "Cache-Control",
      "no-store"
    );


    return res.json(
      auth.getProtectedResourceMetadata()
    );
  } catch (error) {
    console.error(
      "MCP metadata failed:",
      error?.message ?? error
    );


    return res.status(503).json({
      ok: false,
      error:
        "mcp_metadata_unavailable"
    });
  }
}


/* ========================================
   正式 MCP 请求处理器
======================================== */

export async function
handle404McpRequest(
  req,
  res
) {
  let server = null;
  let transport = null;
  let cleaned = false;


  async function cleanup() {
    if (cleaned) {
      return;
    }

    cleaned = true;


    await Promise.allSettled([
      transport?.close?.(),
      server?.close?.()
    ]);
  }


  try {
    const requestId =
      getRequestId(req);

    const {
      supabaseUrl,
      publishableKey,
      secretKey
    } = getRequiredConfig();


    const auth =
      createMcpAuth({
        supabaseUrl,
        publishableKey,

        resourceUrl:
          `${getPublicBaseUrl(req)}/mcp`
      });


    const authResult =
      await auth.authenticate(req);


    if (!authResult.ok) {
      return auth.sendUnauthorized(
        res,
        authResult.reason
      );
    }


    /*
      无状态 Streamable HTTP 只接受 POST。
      每次请求创建独立 server 与 transport。
    */

    if (req.method !== "POST") {
      res.set("Allow", "POST");

      return res.status(405).json({
        jsonrpc: "2.0",

        error: {
          code: -32000,
          message: "Method not allowed"
        },

        id: null
      });
    }


    const auditClient =
      createAuditClient({
        supabaseUrl,
        secretKey
      });


    if (!auditClient) {
      throw new Error(
        "缺少 SUPABASE_SECRET_KEY，无法写入正式审计日志"
      );
    }


    const studyService =
      createStudyService({
        dataClient:
          authResult.dataClient,

        auditClient
      });


    const heartService =
      createHeartService({
        serviceClient:
          auditClient,

        openaiClient:
          process.env.OPENAI_API_KEY
            ? new OpenAI({
                apiKey:
                  process.env.OPENAI_API_KEY
              })
            : null
      });


    server =
      create404McpServer({
        studyService,
        heartService,

        user:
          authResult.user,

        requestId,

        clientInfo: {
          clientId:
            authResult.claims
              .clientId ?? null
        }
      });


    transport =
      new StreamableHTTPServerTransport({
        sessionIdGenerator:
          undefined,

        enableJsonResponse:
          true
      });


    res.set(
      "Cache-Control",
      "no-store"
    );

    res.set(
      "X-Request-Id",
      requestId
    );


    res.once(
      "finish",
      () => {
        void cleanup();
      }
    );


    res.once(
      "close",
      () => {
        void cleanup();
      }
    );


    await server.connect(
      transport
    );


    await transport.handleRequest(
      req,
      res,
      req.body
    );
  } catch (error) {
    console.error(
      "404 MCP request failed:",
      {
        message:
          error?.message ??
          String(error)
      }
    );


    if (!res.headersSent) {
      return res.status(500).json({
        jsonrpc: "2.0",

        error: {
          code: -32603,
          message:
            "Internal MCP server error"
        },

        id: null
      });
    }


    await cleanup();
  }
}