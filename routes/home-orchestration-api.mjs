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
      "无法确定全屋调度器 API 公开地址"
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
    "Home orchestration API failed:",
    error
  );

  return res.status(500).json({
    ok: false,
    error:
      "home_orchestration_api_internal_error"
  });
}


async function createRequestContext(
  req,
  res
) {
  const {
    supabaseUrl,
    publishableKey,
    secretKey
  } = getRequiredConfig();

  const auth = createMcpAuth({
    supabaseUrl,
    publishableKey,
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

  const serviceClient =
    createServiceClient({
      supabaseUrl,
      secretKey
    });

  return {
    user: authResult.user,
    service:
      createHomeOrchestrationService({
        serviceClient
      })
  };
}


export async function getOrchestrationStatus(
  req,
  res
) {
  try {
    const context =
      await createRequestContext(req, res);

    if (!context) {
      return;
    }

    const snapshot =
      await context.service
        .getRuntimeSnapshot({
          userId: context.user.id,
          quietHoursActive:
            String(
              req.query.quietHoursActive ??
              "false"
            ).toLowerCase() === "true",
          autoHeartbeatEnabled:
            String(
              req.query.autoHeartbeatEnabled ??
              "false"
            ).toLowerCase() === "true"
        });

    res.set(
      "Cache-Control",
      "no-store"
    );

    return res.json({
      ok: true,
      ...snapshot
    });
  } catch (error) {
    return sendError(res, error);
  }
}


export async function patchRuntimeSettings(
  req,
  res
) {
  try {
    const context =
      await createRequestContext(req, res);

    if (!context) {
      return;
    }

    const allowedFields = [
      "interactionLeaseSeconds",
      "heartbeatInputTokenBudget",
      "heartbeatMaxOutputTokens",
      "heartbeatReasoningEffort",
      "automaticHeartbeatReleaseEnabled",
      "autoResumeFreeActivityAfterChat"
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
      throw new HomeOrchestrationError(
        "empty_runtime_settings_patch",
        "没有收到可保存的八百库参数",
        400
      );
    }

    const result =
      await context.service.updateSettings({
        userId: context.user.id,
        patch
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
      await context.service
        .startInteraction({
          userId: context.user.id,
          channel:
            req.body?.channel ??
            "official_chat",
          source:
            req.body?.source ??
            "ios_shortcut",
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
    return sendError(res, error);
  }
}


export async function endInteractionBridge(
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
        .endInteraction({
          userId: context.user.id,
          channel:
            req.body?.channel ?? null,
          source:
            req.body?.source ??
            "ios_shortcut",
          postChatGraceMinutes:
            req.body
              ?.postChatGraceMinutes ?? 15,
          resumeFreeActivity:
            req.body
              ?.resumeFreeActivity ?? null
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


export async function pauseFreeActivity(
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
        .pauseFreeActivity({
          userId: context.user.id,
          reason:
            req.body?.reason ??
            "manual_pause",
          state:
            req.body?.state ??
            "paused_manual",
          resumePolicy:
            req.body?.resumePolicy ?? null
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


export async function resumeFreeActivity(
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
        .resumeFreeActivity({
          userId: context.user.id,
          activityPassId:
            req.body?.activityPassId ?? null
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


export async function patchFreeActivityProgress(
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
        "missing_activity_pass_id",
        "缺少活动通行证编号",
        400
      );
    }

    const result =
      await context.service
        .recordActivityUsage({
          userId: context.user.id,
          activityPassId,
          inputTokens:
            req.body?.inputTokens ?? 0,
          outputTokens:
            req.body?.outputTokens ?? 0,
          estimatedCostUsd:
            req.body?.estimatedCostUsd ?? 0,
          currentTask:
            req.body?.currentTask,
          progressSummary:
            req.body?.progressSummary,
          progressData:
            req.body?.progressData
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
