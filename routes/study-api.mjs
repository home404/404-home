import {
  randomUUID
} from "node:crypto";

import {
  createClient
} from "@supabase/supabase-js";

import {
  createMcpAuth
} from "../middleware/mcp-auth.mjs";

import {
  createStudyService,
  StudyServiceError
} from "../services/study-service.mjs";


/* ========================================
   基础工具
======================================== */

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
      "无法确定书房 API 公开地址"
    );
  }


  return `${protocol}://${host}`;
}


function getRequiredConfig() {
  const supabaseUrl =
    normalizeBaseUrl(
      process.env.SUPABASE_URL
    );

  const publishableKey =
    process.env.SUPABASE_PUBLISHABLE_KEY;

const secretKey =
  process.env.SUPABASE_SECRET_KEY ??
  null;


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


  return {
    supabaseUrl,
    publishableKey,
    secretKey
  };
}


function createAuditClient({
  supabaseUrl,
  secretKey
}) {
  if (!secretKey) {
    return null;
  }


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


function toPublicEntry(entry) {
  if (!entry) {
    return null;
  }


  return {
    id:
      entry.id,

    entryType:
      entry.entry_type,

    title:
      entry.title,

    body:
      entry.body,

    summary:
      entry.summary,

    mood:
      entry.mood,

    tags:
      entry.tags ?? [],

    createdBy:
      entry.created_by,

    source:
      entry.source,

    visibility:
      entry.visibility,

    createdAt:
      entry.created_at,

    updatedAt:
      entry.updated_at
  };
}


function toPublicEntrySummary(entry) {
  if (!entry) {
    return null;
  }


  return {
    id:
      entry.id,

    entryType:
      entry.entry_type,

    title:
      entry.title,

    summary:
      entry.summary,

    mood:
      entry.mood,

    tags:
      entry.tags ?? [],

    createdBy:
      entry.created_by,

    source:
      entry.source,

    visibility:
      entry.visibility,

    createdAt:
      entry.created_at,

    updatedAt:
      entry.updated_at
  };
}


function toPublicComment(comment) {
  if (!comment) {
    return null;
  }


  return {
    id:
      comment.id,

    entryId:
      comment.entry_id,

    parentCommentId:
      comment.parent_comment_id,

    author:
      comment.author,

    body:
      comment.body,

    source:
      comment.source,

    createdAt:
      comment.created_at,

    updatedAt:
      comment.updated_at
  };
}


function sendError(
  res,
  error
) {
  if (error instanceof StudyServiceError) {
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
    "Study API failed:",
    error
  );


  return res.status(500).json({
    ok: false,
    error:
      "study_api_internal_error"
  });
}


/* ========================================
   为每个请求建立正式书房上下文
======================================== */

async function createStudyRequestContext(
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


  const studyService =
    createStudyService({
      dataClient:
        authResult.dataClient,

      auditClient:
        createAuditClient({
          supabaseUrl,
          secretKey
        })
    });


  return {
    user:
      authResult.user,

    studyService,

    requestId:
      getRequestId(req)
  };
}


/* ========================================
   读取书房列表
======================================== */

export async function listStudyEntries(
  req,
  res
) {
  try {
    const context =
      await createStudyRequestContext(
        req,
        res
      );


    if (!context) {
      return;
    }


    const entryType =
      typeof req.query.entryType ===
      "string"
        ? req.query.entryType
        : undefined;

    const requestedLimit =
      Number(req.query.limit ?? 100);

    const limit =
      Number.isInteger(requestedLimit)
        ? requestedLimit
        : 100;


    const entries =
      await context.studyService
        .listEntries({
          entryType,
          limit
        });


    res.set(
      "Cache-Control",
      "no-store"
    );


    return res.json({
      ok: true,

      count:
        entries.length,

      entries:
        entries.map(
          toPublicEntrySummary
        )
    });
  } catch (error) {
    return sendError(
      res,
      error
    );
  }
}


/* ========================================
   读取单篇正文与评论
======================================== */

export async function getStudyEntry(
  req,
  res
) {
  try {
    const context =
      await createStudyRequestContext(
        req,
        res
      );


    if (!context) {
      return;
    }


    const result =
      await context.studyService
        .getEntry({
          entryId:
            req.params.entryId
        });


    res.set(
      "Cache-Control",
      "no-store"
    );


    return res.json({
      ok: true,

      entry:
        toPublicEntry(
          result.entry
        ),

      comments:
        result.comments.map(
          toPublicComment
        )
    });
  } catch (error) {
    return sendError(
      res,
      error
    );
  }
}


/* ========================================
   谢诗发表评论或回复
======================================== */

export async function addStudyComment(
  req,
  res
) {
  try {
    const context =
      await createStudyRequestContext(
        req,
        res
      );


    if (!context) {
      return;
    }


    const result =
      await context.studyService
        .addComment(
          {
            entryId:
              req.params.entryId,

            parentCommentId:
              req.body
                ?.parentCommentId ??
              null,

            body:
              req.body?.body,

            idempotencyKey:
              req.body
                ?.idempotencyKey
          },

          {
            userId:
              context.user.id,

            actor:
              "xie_shi",

            source:
              "web",

            requestId:
              context.requestId
          }
        );


    res.set(
      "Cache-Control",
      "no-store"
    );


    return res
      .status(
        result.created
          ? 201
          : 200
      )
      .json({
        ok: true,

        created:
          result.created,

        duplicate:
          result.duplicate,

        comment:
          toPublicComment(
            result.comment
          )
      });
  } catch (error) {
    return sendError(
      res,
      error
    );
  }
}