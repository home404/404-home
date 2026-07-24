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
      "无法确定书房删除接口地址"
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


function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value ?? ""));
}


export function collectCommentTreeIds(
  comments,
  rootCommentId
) {
  const safeComments = Array.isArray(comments)
    ? comments
    : [];
  const rootId = String(
    rootCommentId ?? ""
  ).trim();
  const existingIds = new Set(
    safeComments
      .map((comment) =>
        String(comment?.id ?? "").trim()
      )
      .filter(Boolean)
  );

  if (!rootId || !existingIds.has(rootId)) {
    return [];
  }

  const childrenByParent = new Map();

  for (const comment of safeComments) {
    const id = String(
      comment?.id ?? ""
    ).trim();
    const parentId = String(
      comment?.parent_comment_id ??
      comment?.parentCommentId ??
      ""
    ).trim();

    if (!id || !parentId) {
      continue;
    }

    if (!childrenByParent.has(parentId)) {
      childrenByParent.set(parentId, []);
    }

    childrenByParent.get(parentId).push(id);
  }

  const result = [];
  const visited = new Set();
  const queue = [rootId];

  while (queue.length) {
    const currentId = queue.shift();

    if (
      !currentId ||
      visited.has(currentId) ||
      !existingIds.has(currentId)
    ) {
      continue;
    }

    visited.add(currentId);
    result.push(currentId);

    for (
      const childId of
      childrenByParent.get(currentId) ?? []
    ) {
      if (!visited.has(childId)) {
        queue.push(childId);
      }
    }
  }

  return result;
}


async function writeAudit({
  serviceClient,
  userId,
  commentId,
  entryId,
  deletedCount,
  success,
  errorCode = null
}) {
  try {
    const { error } = await serviceClient
      .from("study_audit_log")
      .insert({
        action: "delete_comment",
        target_type: "study_comment",
        target_id: commentId,
        actor_user_id: userId,
        actor: "xie_shi",
        source: "web",
        success,
        error_code: errorCode,
        details: {
          entryId,
          deletedCount
        }
      });

    if (error) {
      console.warn(
        "Study comment delete audit failed:",
        error.message
      );
    }
  } catch (error) {
    console.warn(
      "Study comment delete audit skipped:",
      error?.message ?? error
    );
  }
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
      `${getPublicBaseUrl(req)}/api/study`
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
      createServiceClient(config)
  };
}


function sendError(
  res,
  status,
  error,
  message
) {
  return res.status(status).json({
    ok: false,
    error,
    message
  });
}


export async function deleteStudyComment(
  req,
  res
) {
  try {
    const context =
      await createRequestContext(req, res);

    if (!context) {
      return;
    }

    const commentId = String(
      req.params.commentId ?? ""
    ).trim();

    if (!isUuid(commentId)) {
      return sendError(
        res,
        400,
        "invalid_comment_id",
        "评论编号不符合书房规则"
      );
    }

    const {
      data: targetComment,
      error: targetError
    } = await context.serviceClient
      .from("study_comments")
      .select([
        "id",
        "entry_id",
        "owner_user_id"
      ].join(", "))
      .eq("id", commentId)
      .eq(
        "owner_user_id",
        context.user.id
      )
      .maybeSingle();

    if (targetError) {
      console.error(
        "Read study comment before delete failed:",
        targetError.message
      );

      return sendError(
        res,
        500,
        "study_comment_read_failed",
        "删除前无法确认这条评论"
      );
    }

    if (!targetComment) {
      return sendError(
        res,
        404,
        "study_comment_not_found",
        "这条评论已经不存在了"
      );
    }

    const {
      data: entryComments,
      error: commentsError
    } = await context.serviceClient
      .from("study_comments")
      .select([
        "id",
        "parent_comment_id"
      ].join(", "))
      .eq(
        "entry_id",
        targetComment.entry_id
      )
      .eq(
        "owner_user_id",
        context.user.id
      );

    if (commentsError) {
      console.error(
        "Read study comment tree failed:",
        commentsError.message
      );

      return sendError(
        res,
        500,
        "study_comment_tree_read_failed",
        "无法确认这条评论下面的回复"
      );
    }

    const deleteIds =
      collectCommentTreeIds(
        entryComments,
        commentId
      );

    if (!deleteIds.length) {
      return sendError(
        res,
        404,
        "study_comment_not_found",
        "这条评论已经不存在了"
      );
    }

    const {
      data: deletedRows,
      error: deleteError
    } = await context.serviceClient
      .from("study_comments")
      .delete()
      .eq(
        "owner_user_id",
        context.user.id
      )
      .in("id", deleteIds)
      .select("id");

    if (deleteError) {
      await writeAudit({
        serviceClient:
          context.serviceClient,
        userId: context.user.id,
        commentId,
        entryId:
          targetComment.entry_id,
        deletedCount: 0,
        success: false,
        errorCode:
          "study_comment_delete_failed"
      });

      console.error(
        "Delete study comment failed:",
        deleteError.message
      );

      return sendError(
        res,
        500,
        "study_comment_delete_failed",
        "评论删除失败，内容仍然保留"
      );
    }

    const deletedIds = (
      deletedRows ?? []
    ).map((row) => row.id);

    await writeAudit({
      serviceClient:
        context.serviceClient,
      userId: context.user.id,
      commentId,
      entryId:
        targetComment.entry_id,
      deletedCount:
        deletedIds.length,
      success: true
    });

    res.set(
      "Cache-Control",
      "no-store"
    );

    return res.json({
      ok: true,
      entryId:
        targetComment.entry_id,
      deletedCount:
        deletedIds.length,
      deletedIds
    });
  } catch (error) {
    console.error(
      "Study comment delete API failed:",
      error
    );

    if (!res.headersSent) {
      return sendError(
        res,
        500,
        "study_comment_delete_internal_error",
        "书房删除接口暂时不可用"
      );
    }
  }
}
