import crypto from "node:crypto";

import {
  createClient
} from "@supabase/supabase-js";

import {
  createHomeOrchestrationService,
  HomeOrchestrationError
} from "../services/home-orchestration-service.mjs";

import {
  startInteractionPreservingActivity
} from "../services/interaction-guard-service.mjs";

import {
  endInteractionWithClock
} from "../services/activity-clock-service.mjs";


const OFFICIAL_APP_FALLBACK_LEASE_SECONDS =
  2 * 60 * 60;


function normalizeText(value) {
  return String(value ?? "")
    .trim();
}


function safeTokenEqual(
  provided,
  expected
) {
  const left = Buffer.from(
    normalizeText(provided),
    "utf8"
  );
  const right = Buffer.from(
    normalizeText(expected),
    "utf8"
  );

  if (
    !left.length ||
    left.length !== right.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    left,
    right
  );
}


function readBearerToken(req) {
  const authorization = normalizeText(
    req.headers.authorization
  );

  if (!authorization) {
    return "";
  }

  const match = /^Bearer\s+(.+)$/i.exec(
    authorization
  );

  return match?.[1]?.trim() ?? "";
}


function getConfig() {
  const supabaseUrl = normalizeText(
    process.env.SUPABASE_URL
  ).replace(/\/+$/, "");
  const secretKey = normalizeText(
    process.env.SUPABASE_SECRET_KEY
  );
  const bridgeToken = normalizeText(
    process.env.BRIDGE_SHORTCUT_TOKEN
  );
  const ownerUserId = normalizeText(
    process.env.HOME_OWNER_USER_ID
  );

  if (!supabaseUrl) {
    throw new Error("缺少 SUPABASE_URL");
  }

  if (!secretKey) {
    throw new Error(
      "缺少 SUPABASE_SECRET_KEY"
    );
  }

  if (!bridgeToken) {
    throw new Error(
      "缺少 BRIDGE_SHORTCUT_TOKEN"
    );
  }

  if (!ownerUserId) {
    throw new Error(
      "缺少 HOME_OWNER_USER_ID"
    );
  }

  return {
    supabaseUrl,
    secretKey,
    bridgeToken,
    ownerUserId
  };
}


function createService(config) {
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
    serviceClient,
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
    "Shortcut bridge API failed:",
    error
  );

  return res.status(500).json({
    ok: false,
    error:
      "shortcut_bridge_internal_error"
  });
}


function authenticateBridge(req, res) {
  const config = getConfig();
  const provided = readBearerToken(req);

  if (
    !safeTokenEqual(
      provided,
      config.bridgeToken
    )
  ) {
    res.set(
      "WWW-Authenticate",
      'Bearer realm="404 shortcut bridge"'
    );
    res.status(401).json({
      ok: false,
      error:
        "shortcut_bridge_unauthorized"
    });
    return null;
  }

  return config;
}


export async function startOfficialChatBridge(
  req,
  res
) {
  try {
    const config = authenticateBridge(
      req,
      res
    );

    if (!config) {
      return;
    }

    const {
      orchestrationService
    } = createService(config);
    const result =
      await startInteractionPreservingActivity({
        orchestrationService,
        userId: config.ownerUserId,
        channel: "official_chat",
        source: "ios_shortcut",
        leaseSeconds:
          req.body?.leaseSeconds ??
          OFFICIAL_APP_FALLBACK_LEASE_SECONDS,
        contextSummary:
          req.body?.contextSummary ?? null,
        metadata: {
          shortcutAction:
            "chatgpt_app_opened",
          device:
            req.body?.device ??
            "iphone",
          leaseMode:
            "app_open_close_with_fallback"
        }
      });

    res.set(
      "Cache-Control",
      "no-store"
    );

    return res.status(201).json({
      ok: true,
      state: "interactive_awake",
      expiresAt:
        result.session.expires_at,
      freeActivityPaused:
        result.pausedActivity
          ?.progress?.state ===
          "paused_by_chat",
      preservedActivityState:
        result.preservedActivityState,
      modelCalled: false
    });
  } catch (error) {
    return sendError(res, error);
  }
}


export async function endOfficialChatBridge(
  req,
  res
) {
  try {
    const config = authenticateBridge(
      req,
      res
    );

    if (!config) {
      return;
    }

    const {
      serviceClient,
      orchestrationService
    } = createService(config);
    const result =
      await endInteractionWithClock({
        serviceClient,
        orchestrationService,
        userId: config.ownerUserId,
        channel: "official_chat",
        source: "ios_shortcut",
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
      state:
        result.resumedActivity?.progress
          ?.state === "running"
          ? "free_activity_running"
          : "post_chat_grace",
      graceUntil:
        result.graceUntil,
      freeActivityResumed:
        result.resumedActivity?.progress
          ?.state === "running",
      activityClockAligned:
        result.activityClockAligned,
      modelCalled: false
    });
  } catch (error) {
    return sendError(res, error);
  }
}
