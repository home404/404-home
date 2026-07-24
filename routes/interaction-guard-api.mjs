import {
  createClient
} from "@supabase/supabase-js";

import {
  createMcpAuth
} from "../middleware/mcp-auth.mjs";

import {
  createHomeOrchestrationService,
  HomeOrchestrationError
} from "../services/home-orchestration-service.mjs";

import {
  startInteractionPreservingActivity
} from "../services/interaction-guard-service.mjs";


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
      "无法确定互动入口 API 公开地址"
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

  return {
    supabaseUrl,
    publishableKey,
    secretKey
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
      `${getPublicBaseUrl(req)}/api/home-orchestration`
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

  return {
    user: authResult.user,
    service:
      createHomeOrchestrationService({
        serviceClient
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
    "Interaction guard API failed:",
    error
  );

  return res.status(500).json({
    ok: false,
    error:
      "interaction_guard_api_internal_error"
  });
}


export async function startInteractionBridge(
  req,
  res
) {
  try {
    const context =
      await createRequestContext(req, res);

    if (!context) {
      return;
    }

    const result =
      await startInteractionPreservingActivity({
        orchestrationService:
          context.service,
        userId: context.user.id,
        channel:
          req.body?.channel ??
          "official_chat",
        source:
          req.body?.source ??
          "web",
        leaseSeconds:
          req.body?.leaseSeconds ?? null,
        contextSummary:
          req.body?.contextSummary ?? null,
        metadata:
          req.body?.metadata ?? {}
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
    /*
      互动会话与后台暂停已经先于 home_presence 更新完成。
      若只是旧数据库缺少某个展示字段，不应连带锁死卧室聊天。
      Worker 仍会读取 home_interaction_sessions 并给前台让路。
    */
    if (
      error instanceof HomeOrchestrationError &&
      error.code ===
        "interactive_presence_update_failed"
    ) {
      console.warn(
        "Interaction presence update degraded:",
        error.details ?? error.message
      );

      res.set(
        "Cache-Control",
        "no-store"
      );

      return res.status(201).json({
        ok: true,
        degraded: true,
        presenceDeferred: true,
        preservedActivityState: null,
        warning:
          "互动已经登记，首页状态稍后同步。"
      });
    }

    return sendError(res, error);
  }
}
