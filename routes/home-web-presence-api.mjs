import {
  createClient
} from "@supabase/supabase-js";

import {
  createMcpAuth
} from "../middleware/mcp-auth.mjs";


const DEFAULT_HOME_WEB_LEASE_SECONDS = 120;
const MIN_HOME_WEB_LEASE_SECONDS = 60;
const MAX_HOME_WEB_LEASE_SECONDS = 600;


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
      "无法确定网页在家租约 API 的公开地址"
    );
  }

  return `${protocol}://${host}`;
}


function clampInteger(
  value,
  minimum,
  maximum,
  fallback
) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(
    maximum,
    Math.max(
      minimum,
      Math.round(parsed)
    )
  );
}


function normalizeDate(value) {
  const date = value instanceof Date
    ? new Date(value.getTime())
    : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new TypeError(
      "网页在家租约收到无效时间"
    );
  }

  return date;
}


export function resolveHomeWebLease({
  now = new Date(),
  leaseSeconds = DEFAULT_HOME_WEB_LEASE_SECONDS,
  existingPausedUntil = null
} = {}) {
  const currentTime = normalizeDate(now);
  const resolvedLeaseSeconds = clampInteger(
    leaseSeconds,
    MIN_HOME_WEB_LEASE_SECONDS,
    MAX_HOME_WEB_LEASE_SECONDS,
    DEFAULT_HOME_WEB_LEASE_SECONDS
  );
  const activeUntil = new Date(
    currentTime.getTime() +
      resolvedLeaseSeconds * 1000
  );
  const existingPause = existingPausedUntil
    ? new Date(existingPausedUntil)
    : null;
  const heartbeatPausedUntil =
    existingPause &&
    !Number.isNaN(existingPause.getTime()) &&
    existingPause.getTime() > activeUntil.getTime()
      ? existingPause
      : activeUntil;

  return {
    leaseSeconds: resolvedLeaseSeconds,
    activeUntil:
      activeUntil.toISOString(),
    heartbeatPausedUntil:
      heartbeatPausedUntil.toISOString()
  };
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


async function requireData(
  promise,
  code,
  message
) {
  const {
    data,
    error
  } = await promise;

  if (error) {
    const wrapped = new Error(message);
    wrapped.code = code;
    wrapped.details = {
      databaseCode: error.code ?? null,
      databaseMessage:
        error.message ?? null
    };
    throw wrapped;
  }

  return data;
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

  return {
    user: authResult.user,
    serviceClient:
      createServiceClient({
        supabaseUrl,
        secretKey
      })
  };
}


async function ensurePresence({
  serviceClient,
  userId
}) {
  const existing = await requireData(
    serviceClient
      .from("home_presence")
      .select("*")
      .eq("owner_user_id", userId)
      .maybeSingle(),
    "home_web_presence_read_failed",
    "无法读取当前在家状态"
  );

  if (existing) {
    return existing;
  }

  return requireData(
    serviceClient
      .from("home_presence")
      .insert({
        owner_user_id: userId,
        status: "resting",
        status_detail:
          "G 在卧室休息",
        source: "web"
      })
      .select("*")
      .single(),
    "home_web_presence_create_failed",
    "无法建立当前在家状态"
  );
}


function sendError(res, error) {
  console.error(
    "Home web presence API failed:",
    error
  );

  return res.status(500).json({
    ok: false,
    error:
      error.code ??
      "home_web_presence_internal_error",
    message:
      error.message ??
      "无法登记网页在家状态",
    details:
      error.details ?? null
  });
}


export async function markHomeWebPresence(
  req,
  res
) {
  try {
    const context =
      await createRequestContext(req, res);

    if (!context) {
      return;
    }

    const presence = await ensurePresence({
      serviceClient:
        context.serviceClient,
      userId: context.user.id
    });
    const now = new Date();
    const lease = resolveHomeWebLease({
      now,
      leaseSeconds:
        req.body?.leaseSeconds ??
        DEFAULT_HOME_WEB_LEASE_SECONDS,
      existingPausedUntil:
        presence.heartbeat_paused_until
    });
    const metadata =
      presence.metadata &&
      typeof presence.metadata === "object" &&
      !Array.isArray(presence.metadata)
        ? presence.metadata
        : {};
    const updated = await requireData(
      context.serviceClient
        .from("home_presence")
        .update({
          last_user_seen_at:
            now.toISOString(),
          heartbeat_paused_until:
            lease.heartbeatPausedUntil,
          source: "web",
          metadata: {
            ...metadata,
            homeWebActiveUntil:
              lease.activeUntil,
            homeWebLastSeenAt:
              now.toISOString(),
            homeWebLeaseSeconds:
              lease.leaseSeconds,
            homeWebVersion:
              "home-web-presence-v0.1"
          }
        })
        .eq(
          "owner_user_id",
          context.user.id
        )
        .select("*")
        .single(),
      "home_web_presence_update_failed",
      "无法登记谢诗正在 404 小窝"
    );

    res.set(
      "Cache-Control",
      "no-store"
    );

    return res.json({
      ok: true,
      presence: updated,
      homeWeb: {
        active: true,
        activeUntil:
          lease.activeUntil,
        leaseSeconds:
          lease.leaseSeconds
      },
      modelCalled: false
    });
  } catch (error) {
    return sendError(res, error);
  }
}
