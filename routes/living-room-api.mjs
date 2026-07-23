import {
  createClient
} from "@supabase/supabase-js";

import {
  createMcpAuth
} from "../middleware/mcp-auth.mjs";

import {
  HomeOrchestrationError
} from "../services/home-orchestration-service.mjs";

import {
  createLivingRoomService
} from "../services/living-room-service.mjs";


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
      "无法确定客厅 API 公开地址"
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
      `${getPublicBaseUrl(req)}/api/living-room`
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

  return {
    user: authResult.user,
    service:
      createLivingRoomService({
        serviceClient:
          createServiceClient(config)
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
    "Living room API failed:",
    error
  );

  return res.status(500).json({
    ok: false,
    error:
      "living_room_api_internal_error"
  });
}


export async function getLivingRoomStatus(
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
      await context.service
        .getLivingRoomStatus({
          userId: context.user.id
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


export async function grantLivingRoomPass(
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
      await context.service
        .grantFreeActivity({
          userId: context.user.id,
          durationMinutes:
            req.body?.durationMinutes ??
            120,
          task:
            req.body?.task ?? null,
          note:
            req.body?.note ?? null,
          resumePolicy:
            req.body?.resumePolicy ??
            "after_chat",
          inputTokenBudget:
            req.body?.inputTokenBudget ??
            null,
          outputTokenBudget:
            req.body?.outputTokenBudget ??
            null,
          maxCostUsd:
            req.body?.maxCostUsd ?? null,
          maxModelCalls:
            req.body?.maxModelCalls ??
            null
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


export async function updateLivingRoomPass(
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
        "missing_living_room_pass_id",
        "缺少活动通行证编号",
        400
      );
    }

    const result =
      await context.service
        .updateFreeActivity({
          userId: context.user.id,
          activityPassId,
          addActiveMinutes:
            req.body?.addActiveMinutes ??
            0,
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
