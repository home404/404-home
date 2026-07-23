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
  createLivingRoomService
} from "../services/living-room-service.mjs";

import {
  finishFreeActivityPass,
  updateFreeActivitySafely
} from "../services/living-room-pass-lifecycle-service.mjs";


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
    ) || req.protocol || "http";
  const host =
    firstHeaderValue(
      req.headers["x-forwarded-host"]
    ) || req.get("host");

  if (!host) {
    throw new Error(
      "无法确定客厅 v2 API 公开地址"
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


async function createRequestContext(req, res) {
  const config = getRequiredConfig();
  const auth = createMcpAuth({
    supabaseUrl: config.supabaseUrl,
    publishableKey:
      config.publishableKey,
    resourceUrl:
      `${getPublicBaseUrl(req)}/api/living-room-v2`
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
    serviceClient,
    livingRoomService:
      createLivingRoomService({
        serviceClient
      }),
    orchestrationService:
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
    "Living room v2 API failed:",
    error
  );

  return res.status(500).json({
    ok: false,
    error:
      "living_room_v2_api_internal_error"
  });
}


export async function updateLivingRoomPassSafely(
  req,
  res
) {
  try {
    const context =
      await createRequestContext(req, res);

    if (!context) {
      return;
    }

    const activityPassId =
      req.params.activityPassId;

    if (!activityPassId) {
      throw new HomeOrchestrationError(
        "missing_living_room_v2_pass_id",
        "缺少活动通行证编号",
        400
      );
    }

    const result =
      await updateFreeActivitySafely({
        serviceClient:
          context.serviceClient,
        livingRoomService:
          context.livingRoomService,
        orchestrationService:
          context.orchestrationService,
        userId: context.user.id,
        activityPassId,
        patch: {
          addActiveMinutes:
            req.body?.addActiveMinutes ?? 0,
          inputTokenBudget:
            req.body?.inputTokenBudget,
          outputTokenBudget:
            req.body?.outputTokenBudget,
          maxCostUsd:
            req.body?.maxCostUsd,
          maxModelCalls:
            req.body?.maxModelCalls,
          currentTask:
            req.body?.currentTask,
          progressSummary:
            req.body?.progressSummary,
          resumePolicy:
            req.body?.resumePolicy
        },
        source: "living_room_v2_web"
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
    return sendError(res, error);
  }
}


export async function finishLivingRoomPass(
  req,
  res
) {
  try {
    const context =
      await createRequestContext(req, res);

    if (!context) {
      return;
    }

    const activityPassId =
      req.params.activityPassId;

    if (!activityPassId) {
      throw new HomeOrchestrationError(
        "missing_living_room_v2_pass_id",
        "缺少活动通行证编号",
        400
      );
    }

    const result =
      await finishFreeActivityPass({
        serviceClient:
          context.serviceClient,
        userId: context.user.id,
        activityPassId,
        finalState:
          req.body?.finalState ??
          "completed",
        summary:
          req.body?.summary ?? null,
        source:
          req.body?.source ??
          "living_room_v2_web"
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
    return sendError(res, error);
  }
}
