import {
  randomUUID
} from "node:crypto";

import OpenAI from "openai";
import fetch from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";

import {
  createClient
} from "@supabase/supabase-js";

import {
  createMcpAuth
} from "../middleware/mcp-auth.mjs";

import {
  createHeartService,
  HeartServiceError
} from "../services/heart-service.mjs";


const HEART_OPENAI_TIMEOUT_MS = 90_000;

let heartOpenAIClient = null;

function getHeartOpenAIClient() {
  const apiKey = String(
    process.env.OPENAI_API_KEY ?? ""
  ).trim();

  if (!apiKey) {
    return null;
  }

  if (heartOpenAIClient) {
    return heartOpenAIClient;
  }

  const proxyUrl = String(
    process.env.HEART_SOCKS_PROXY_URL ?? ""
  ).trim();

  if (!proxyUrl) {
    heartOpenAIClient = new OpenAI({
      apiKey,
      timeout: HEART_OPENAI_TIMEOUT_MS,
      maxRetries: 1
    });

    return heartOpenAIClient;
  }

  const agent =
    new SocksProxyAgent(proxyUrl);

  const proxyFetch = (
    url,
    init = {}
  ) => {
    return fetch(url, {
      ...init,
      agent
    });
  };

  heartOpenAIClient = new OpenAI({
    apiKey,
    fetch: proxyFetch,
    timeout: HEART_OPENAI_TIMEOUT_MS,
    maxRetries: 1
  });

  return heartOpenAIClient;
}

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
      "无法确定小心脏 API 公开地址"
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

  if (!secretKey) {
    throw new Error(
      "缺少 SUPABASE_SECRET_KEY"
    );
  }

  return {
    supabaseUrl,
    publishableKey,
    secretKey
  };
}


function createServiceClient({
  supabaseUrl,
  secretKey
}) {
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


function sendError(
  res,
  error
) {
  if (error instanceof HeartServiceError) {
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
    "Heart API failed:",
    error
  );

  return res.status(500).json({
    ok: false,
    error:
      "heart_api_internal_error"
  });
}


async function createHeartRequestContext(
  req,
  res
) {
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
        `${getPublicBaseUrl(req)}/api/heart`
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

  const serviceClient =
    createServiceClient({
      supabaseUrl,
      secretKey
    });

  const heartService =
    createHeartService({
      serviceClient,
      openaiClient: getHeartOpenAIClient()
    });

  return {
    user:
      authResult.user,
    requestId:
      getRequestId(req),
    heartService
  };
}


export async function getHeartStatus(
  req,
  res
) {
  try {
    const context =
      await createHeartRequestContext(
        req,
        res
      );

    if (!context) {
      return;
    }

    const result =
      await context.heartService
        .getHomeStatus({
          userId:
            context.user.id
        });

    res.set(
      "Cache-Control",
      "no-store"
    );

    return res.json({
      ok: true,
      ...result
    });
  } catch (error) {
    return sendError(
      res,
      error
    );
  }
}




export async function getHeartPreferences(
  req,
  res
) {
  try {
    const context =
      await createHeartRequestContext(
        req,
        res
      );

    if (!context) {
      return;
    }

    const result =
      await context.heartService
        .getHeartPreferences({
          userId:
            context.user.id
        });

    res.set(
      "Cache-Control",
      "no-store"
    );

    return res.json({
      ok: true,
      ...result
    });
  } catch (error) {
    return sendError(
      res,
      error
    );
  }
}


export async function patchHeartPreferences(
  req,
  res
) {
  try {
    const context =
      await createHeartRequestContext(
        req,
        res
      );

    if (!context) {
      return;
    }

    const allowedFields = [
      "autoHeartbeatEnabled",
      "timezone",
      "quietHoursEnabled",
      "quietStart",
      "quietEnd",
      "intervalMinMinutes",
      "intervalMaxMinutes",
      "postChatGraceMinutes"
    ];

    const patch = {};

    for (const field of allowedFields) {
      if (
        Object.prototype.hasOwnProperty.call(
          req.body ?? {},
          field
        )
      ) {
        patch[field] = req.body[field];
      }
    }

    if (!Object.keys(patch).length) {
      throw new HeartServiceError(
        "empty_heart_preferences_patch",
        "没有收到可保存的作息设置",
        400
      );
    }

    const result =
      await context.heartService
        .updateHeartPreferences({
          userId:
            context.user.id,
          patch,
          source:
            "web"
        });

    res.set(
      "Cache-Control",
      "no-store"
    );

    return res.json({
      ok: true,
      ...result
    });
  } catch (error) {
    return sendError(
      res,
      error
    );
  }
}


export async function getHeartBrief(
  req,
  res
) {
  try {
    const context =
      await createHeartRequestContext(
        req,
        res
      );

    if (!context) {
      return;
    }

    const limit =
      Number(req.query.limit ?? 30);

    const markRead =
      String(
        req.query.markRead ??
        "false"
      ).toLowerCase() === "true";

    const result =
      await context.heartService
        .getHomeBrief({
          userId:
            context.user.id,
          limit,
          consumer:
            "home_web",
          markRead
        });

    res.set(
      "Cache-Control",
      "no-store"
    );

    return res.json({
      ok: true,
      count:
        result.events.length,
      events:
        result.events,
      markedRead:
        result.markedRead
    });
  } catch (error) {
    return sendError(
      res,
      error
    );
  }
}


export async function startFreeActivity(
  req,
  res
) {
  try {
    const context =
      await createHeartRequestContext(
        req,
        res
      );

    if (!context) {
      return;
    }

    const granted =
      await context.heartService
        .grantFreeActivity({
          userId:
            context.user.id,
          durationMinutes:
            req.body?.durationMinutes ??
            180,
          note:
            req.body?.note ?? null,
          maxModelCalls:
            req.body?.maxModelCalls ??
            null,
          maxCostUsd:
            req.body?.maxCostUsd ??
            null,
          source:
            "web"
        });

    const firstWake =
      await context.heartService
        .runOnce({
          userId:
            context.user.id,
          runMode:
            "free_activity",
          wakeKind:
            "manual",
          source:
            "web",
          activityPassId:
            granted.pass.id
        });

    res.set(
      "Cache-Control",
      "no-store"
    );

    return res.status(201).json({
      ok: true,
      pass:
        granted.pass,
      decision:
        firstWake.decision,
      activity: {
        runId:
          firstWake.run.id,
        status:
          firstWake.run.status,
        paperEntryId:
          firstWake.execution
            .paperEntry?.id ?? null,
        primaryEntryId:
          firstWake.execution
            .primaryEntry?.id ?? null,
        primaryCommentId:
          firstWake.execution
            .primaryComment?.id ?? null
      },
      presence:
        firstWake.presence
    });
  } catch (error) {
    return sendError(
      res,
      error
    );
  }
}


export async function wakeHeartOnce(
  req,
  res
) {
  try {
    const context =
      await createHeartRequestContext(
        req,
        res
      );

    if (!context) {
      return;
    }

    const result =
      await context.heartService
        .runOnce({
          userId:
            context.user.id,
          runMode:
            "manual_wake",
          wakeKind:
            "manual",
          source:
            "web"
        });

    res.set(
      "Cache-Control",
      "no-store"
    );

    return res.status(201).json({
      ok: true,
      decision:
        result.decision,
      activity: {
        runId:
          result.run.id,
        status:
          result.run.status,
        inputTokens:
          result.run.input_tokens,
        outputTokens:
          result.run.output_tokens,
        totalTokens:
          result.run.total_tokens,
        estimatedCostUsd:
          result.run.estimated_cost_usd,
        paperEntryId:
          result.execution
            .paperEntry?.id ?? null,
        primaryEntryId:
          result.execution
            .primaryEntry?.id ?? null,
        primaryCommentId:
          result.execution
            .primaryComment?.id ?? null
      },
      presence:
        result.presence
    });
  } catch (error) {
    return sendError(
      res,
      error
    );
  }
}
