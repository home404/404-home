import OpenAI from "openai";

import {
  createClient
} from "@supabase/supabase-js";

import {
  createMcpAuth
} from "../middleware/mcp-auth.mjs";

import {
  createBedroomSummaryService
} from "../services/bedroom-summary-service.mjs";

import {
  HomeOrchestrationError
} from "../services/home-orchestration-service.mjs";


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
  const configuredUrl = normalizeBaseUrl(
    process.env.PUBLIC_BASE_URL
  );

  if (configuredUrl) {
    return configuredUrl;
  }

  const railwayDomain = normalizeBaseUrl(
    process.env.RAILWAY_PUBLIC_DOMAIN
  );

  if (railwayDomain) {
    return railwayDomain.startsWith("http")
      ? railwayDomain
      : `https://${railwayDomain}`;
  }

  const protocol =
    firstHeaderValue(
      req.headers["x-forwarded-proto"]
    ) ||
    req.protocol ||
    "http";
  const host =
    firstHeaderValue(
      req.headers["x-forwarded-host"]
    ) ||
    req.get("host");

  if (!host) {
    throw new Error(
      "无法确定卧室 API 公开地址"
    );
  }

  return `${protocol}://${host}`;
}


function getRequiredConfig() {
  const supabaseUrl = normalizeBaseUrl(
    process.env.SUPABASE_URL
  );
  const publishableKey = String(
    process.env.SUPABASE_PUBLISHABLE_KEY ?? ""
  ).trim();
  const secretKey = String(
    process.env.SUPABASE_SECRET_KEY ?? ""
  ).trim();
  const openaiApiKey = String(
    process.env.OPENAI_API_KEY ?? ""
  ).trim();

  if (!supabaseUrl) {
    throw new Error("缺少 SUPABASE_URL");
  }

  if (!publishableKey) {
    throw new Error(
      "缺少 SUPABASE_PUBLISHABLE_KEY"
    );
  }

  if (!secretKey) {
    throw new Error(
      "缺少 SUPABASE_SECRET_KEY"
    );
  }

  if (!openaiApiKey) {
    throw new Error(
      "缺少 OPENAI_API_KEY"
    );
  }

  return {
    supabaseUrl,
    publishableKey,
    secretKey,
    openaiApiKey,
    model: String(
      process.env
        .BEDROOM_SUMMARY_MODEL ??
      process.env.HEART_MODEL ??
      "gpt-5.6-sol"
    ).trim()
  };
}


async function createRequestContext(
  req,
  res
) {
  const config = getRequiredConfig();
  const auth = createMcpAuth({
    supabaseUrl: config.supabaseUrl,
    publishableKey:
      config.publishableKey,
    resourceUrl:
      `${getPublicBaseUrl(req)}/api/bedroom`
  });
  const authResult =
    await auth.authenticate(req);

  if (!authResult.ok) {
    auth.sendUnauthorized(
      res,
      authResult.reason
    );
    return null;
  }

  const serviceClient = createClient(
    config.supabaseUrl,
    config.secretKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    }
  );
  const openaiClient = new OpenAI({
    apiKey: config.openaiApiKey,
    timeout: 120_000,
    maxRetries: 1
  });

  return {
    user: authResult.user,
    service:
      createBedroomSummaryService({
        serviceClient,
        openaiClient,
        model: config.model
      })
  };
}


function sendError(res, error) {
  if (
    error instanceof
      HomeOrchestrationError
  ) {
    return res
      .status(error.status)
      .json({
        ok: false,
        error: error.code,
        message: error.message,
        details:
          error.details ?? null
      });
  }

  console.error(
    "Bedroom API failed:",
    error
  );

  return res.status(500).json({
    ok: false,
    error:
      "bedroom_api_internal_error"
  });
}


export async function createSegmentSummary(
  req,
  res
) {
  try {
    const context =
      await createRequestContext(req, res);

    if (!context) {
      return;
    }

    const conversationId =
      String(
        req.body?.conversationId ?? ""
      ).trim();

    if (!conversationId) {
      throw new HomeOrchestrationError(
        "missing_bedroom_conversation_id",
        "缺少卧室会话编号",
        400
      );
    }

    const result =
      await context.service
        .createSegmentSummary({
          userId: context.user.id,
          conversationId
        });

    res.set(
      "Cache-Control",
      "no-store"
    );

    return res.status(201).json({
      ok: true,
      ...result
    });
  } catch (error) {
    return sendError(res, error);
  }
}
