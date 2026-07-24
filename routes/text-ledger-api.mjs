import {
  createClient
} from "@supabase/supabase-js";

import {
  createMcpAuth
} from "../middleware/mcp-auth.mjs";

import {
  createTextLedgerCompositeService
} from "../services/text-ledger-composite-service.mjs";


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
      "无法确定文字总账 API 地址"
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
      `${getPublicBaseUrl(req)}/api/text-ledger`
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
      createTextLedgerCompositeService({
        serviceClient
      })
  };
}


function sendError(res, error) {
  console.error(
    "Text ledger API failed:",
    error
  );

  return res
    .status(error?.status ?? 500)
    .json({
      ok: false,
      error:
        error?.code ??
        "text_ledger_internal_error",
      message:
        error?.message ??
        "文字总账暂时打不开",
      details:
        error?.details ?? null
    });
}


export async function listTextItems(
  req,
  res
) {
  try {
    const context =
      await createRequestContext(req, res);

    if (!context) {
      return;
    }

    const items = await context.service
      .listItems({
        userId: context.user.id,
        sourceType:
          req.query.sourceType ?? null,
        archived:
          String(req.query.archived ?? "false") ===
          "true",
        limit: Number(req.query.limit ?? 100)
      });

    res.set(
      "Cache-Control",
      "no-store"
    );

    return res.json({
      ok: true,
      count: items.length,
      items
    });
  } catch (error) {
    return sendError(res, error);
  }
}


export async function getTextItem(
  req,
  res
) {
  try {
    const context =
      await createRequestContext(req, res);

    if (!context) {
      return;
    }

    const item = await context.service
      .getItem({
        userId: context.user.id,
        sourceType:
          req.params.sourceType,
        sourceId:
          req.params.sourceId
      });

    res.set(
      "Cache-Control",
      "no-store"
    );

    return res.json({
      ok: true,
      item
    });
  } catch (error) {
    return sendError(res, error);
  }
}


export async function patchTextItemArchive(
  req,
  res
) {
  try {
    const context =
      await createRequestContext(req, res);

    if (!context) {
      return;
    }

    const result = await context.service
      .setArchived({
        userId: context.user.id,
        sourceType:
          req.params.sourceType,
        sourceId:
          req.params.sourceId,
        archived:
          Boolean(req.body?.archived)
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


export async function deleteTextItem(
  req,
  res
) {
  try {
    const context =
      await createRequestContext(req, res);

    if (!context) {
      return;
    }

    const result = await context.service
      .deleteItem({
        userId: context.user.id,
        sourceType:
          req.params.sourceType,
        sourceId:
          req.params.sourceId
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
