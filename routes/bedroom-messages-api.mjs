import {
  createClient
} from "@supabase/supabase-js";

import {
  createMcpAuth
} from "../middleware/mcp-auth.mjs";


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
      "无法确定卧室消息 API 地址"
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
      `${getPublicBaseUrl(req)}/api/bedroom/messages`
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
    config
  };
}


async function requireData(
  promise,
  code,
  message
) {
  const { data, error } = await promise;

  if (error) {
    const wrapped = new Error(message);
    wrapped.code = code;
    wrapped.status = 500;
    wrapped.details = {
      databaseCode: error.code ?? null,
      databaseMessage: error.message ?? null
    };
    throw wrapped;
  }

  return data;
}


function sendError(res, error) {
  console.error(
    "Bedroom messages API failed:",
    error
  );

  return res
    .status(error?.status ?? 500)
    .json({
      ok: false,
      error:
        error?.code ??
        "bedroom_messages_internal_error",
      message:
        error?.message ??
        "卧室消息暂时取不回来",
      details:
        error?.details ?? null
    });
}


async function getBedroomConversation({
  serviceClient,
  userId
}) {
  return requireData(
    serviceClient
      .from("hippocampus_conversations")
      .select("id, last_active_at")
      .eq("owner_user_id", userId)
      .eq("room", "bedroom")
      .eq("status", "active")
      .order("last_active_at", {
        ascending: false
      })
      .limit(1)
      .maybeSingle(),
    "bedroom_message_conversation_read_failed",
    "无法读取卧室消息目录"
  );
}


export async function listBedroomMessages(
  req,
  res
) {
  try {
    const context =
      await createRequestContext(req, res);

    if (!context) {
      return;
    }

    const conversation =
      await getBedroomConversation({
        serviceClient:
          context.serviceClient,
        userId: context.user.id
      });

    if (!conversation) {
      return res.json({
        ok: true,
        conversationId: null,
        count: 0,
        unreadCount: 0,
        messages: []
      });
    }

    const safeLimit = Math.min(
      300,
      Math.max(
        1,
        Number(req.query.limit ?? 120) || 120
      )
    );

    const messages = await requireData(
      context.serviceClient
        .from("hippocampus_messages")
        .select([
          "id",
          "content",
          "occurred_at",
          "metadata"
        ].join(", "))
        .eq(
          "owner_user_id",
          context.user.id
        )
        .eq(
          "conversation_id",
          conversation.id
        )
        .eq("role", "assistant")
        .contains("metadata", {
          detachedFromResponseChain: true
        })
        .order("occurred_at", {
          ascending: false
        })
        .limit(safeLimit),
      "bedroom_messages_read_failed",
      "无法读取卧室发来的消息"
    );

    const orderedMessages = [
      ...(messages ?? [])
    ].reverse();
    const messageIds = orderedMessages
      .map((message) => message.id);
    let readRows = [];

    if (messageIds.length) {
      readRows = await requireData(
        context.serviceClient
          .from("bedroom_message_reads")
          .select("message_id, read_at")
          .eq(
            "owner_user_id",
            context.user.id
          )
          .in("message_id", messageIds),
        "bedroom_message_reads_read_failed",
        "无法读取卧室消息已读状态"
      );
    }

    const readMap = new Map(
      (readRows ?? []).map((row) => [
        row.message_id,
        row.read_at
      ])
    );
    const resultMessages =
      orderedMessages.map((message) => ({
        id: message.id,
        content: message.content,
        occurredAt: message.occurred_at,
        readAt:
          readMap.get(message.id) ?? null,
        source:
          message.metadata?.source ??
          message.metadata?.client ??
          "bedroom",
        metadata: message.metadata ?? {}
      }));

    res.set(
      "Cache-Control",
      "no-store"
    );

    return res.json({
      ok: true,
      conversationId: conversation.id,
      count: resultMessages.length,
      unreadCount:
        resultMessages.filter(
          (message) => !message.readAt
        ).length,
      messages: resultMessages
    });
  } catch (error) {
    return sendError(res, error);
  }
}


export async function markBedroomMessagesRead(
  req,
  res
) {
  try {
    const context =
      await createRequestContext(req, res);

    if (!context) {
      return;
    }

    const messageIds = Array.isArray(
      req.body?.messageIds
    )
      ? [
          ...new Set(
            req.body.messageIds
              .map((value) =>
                String(value ?? "").trim()
              )
              .filter((value) =>
                /^[0-9a-f-]{36}$/i.test(value)
              )
          )
        ].slice(0, 300)
      : [];

    if (!messageIds.length) {
      return res.json({
        ok: true,
        markedRead: 0
      });
    }

    const ownedMessages = await requireData(
      context.serviceClient
        .from("hippocampus_messages")
        .select("id")
        .eq(
          "owner_user_id",
          context.user.id
        )
        .eq("role", "assistant")
        .in("id", messageIds),
      "bedroom_message_ownership_read_failed",
      "无法确认卧室消息归属"
    );
    const ownedIds = (ownedMessages ?? [])
      .map((row) => row.id);
    const nowIso = new Date().toISOString();

    if (ownedIds.length) {
      await requireData(
        context.serviceClient
          .from("bedroom_message_reads")
          .upsert(
            ownedIds.map((messageId) => ({
              owner_user_id:
                context.user.id,
              message_id: messageId,
              read_at: nowIso
            })),
            {
              onConflict:
                "owner_user_id,message_id"
            }
          )
          .select("message_id"),
        "bedroom_messages_mark_read_failed",
        "无法标记卧室消息为已读"
      );
    }

    res.set(
      "Cache-Control",
      "no-store"
    );

    return res.json({
      ok: true,
      markedRead: ownedIds.length,
      readAt: nowIso
    });
  } catch (error) {
    return sendError(res, error);
  }
}
