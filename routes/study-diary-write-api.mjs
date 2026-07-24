import {
  createHash,
  randomUUID
} from "node:crypto";

import {
  readFile
} from "node:fs/promises";

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


const LEGACY_DIARY_TARGETS = [
  {
    date: "2026-07-23",
    title: "小心脏第一次在云端醒来"
  },
  {
    date: "2026-07-24",
    title: "两扇门终于通了"
  }
];

const ENTRY_SELECT = [
  "id",
  "entry_type",
  "title",
  "body",
  "summary",
  "mood",
  "tags",
  "created_by",
  "source",
  "visibility",
  "source_ref",
  "owner_user_id",
  "idempotency_key",
  "created_at",
  "updated_at"
].join(", ");


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
      "无法确定书房写入 API 的公开地址"
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

  return {
    supabaseUrl,
    publishableKey,
    secretKey
  };
}


function createAdminClient({
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


function getRequestId(req) {
  const incomingId = firstHeaderValue(
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


function toPublicEntry(entry) {
  return {
    id: entry.id,
    entryType: entry.entry_type,
    title: entry.title,
    body: entry.body,
    summary: entry.summary,
    mood: entry.mood,
    tags: entry.tags ?? [],
    createdBy: entry.created_by,
    source: entry.source,
    visibility: entry.visibility,
    createdAt: entry.created_at,
    updatedAt: entry.updated_at
  };
}


function sendError(res, error) {
  if (error instanceof StudyServiceError) {
    return res
      .status(error.status)
      .json({
        ok: false,
        error: error.code,
        message: error.message,
        details: error.details ?? null
      });
  }

  console.error(
    "Study diary write API failed:",
    error
  );

  return res.status(500).json({
    ok: false,
    error: "study_diary_write_internal_error",
    message:
      error?.message ??
      "书房写入线路暂时不可用"
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
      `${getPublicBaseUrl(req)}/api/study`
  });

  const authResult = await auth.authenticate(req);

  if (!authResult.ok) {
    auth.sendUnauthorized(
      res,
      authResult.reason
    );
    return null;
  }

  const configuredOwnerId = String(
    process.env.HOME_OWNER_USER_ID ?? ""
  ).trim();

  if (
    configuredOwnerId &&
    authResult.user.id !== configuredOwnerId
  ) {
    res.status(403).json({
      ok: false,
      error: "study_owner_required",
      message: "只有屋主可以写入正式书房"
    });
    return null;
  }

  const adminClient = createAdminClient({
    supabaseUrl,
    secretKey
  });

  return {
    user: authResult.user,
    dataClient: authResult.dataClient,
    adminClient,
    requestId: getRequestId(req),
    studyService: createStudyService({
      dataClient: authResult.dataClient,
      auditClient: adminClient
    })
  };
}


export function buildLegacyDiaryIdempotencyKey(
  entry
) {
  const digest = createHash("sha256")
    .update(
      `${entry.date}\n${entry.title}`,
      "utf8"
    )
    .digest("hex")
    .slice(0, 20);

  return `legacy-diary-${entry.date}-${digest}`;
}


export function normalizeLegacyDiaryEntry(entry) {
  if (
    !entry ||
    typeof entry !== "object" ||
    typeof entry.date !== "string" ||
    typeof entry.title !== "string"
  ) {
    throw new Error("旧日记结构不完整");
  }

  const paragraphs = Array.isArray(entry.content)
    ? entry.content
        .map((item) => String(item ?? "").trim())
        .filter(Boolean)
    : [];

  if (paragraphs.length === 0) {
    throw new Error(
      `旧日记《${entry.title}》没有正文`
    );
  }

  const tags = Array.isArray(entry.tags)
    ? entry.tags
        .map((tag) => String(tag ?? "").trim())
        .filter(Boolean)
    : [];

  return {
    entryType: "diary",
    title: entry.title.trim(),
    body: paragraphs.join("\n\n"),
    summary:
      typeof entry.summary === "string"
        ? entry.summary.trim() || null
        : null,
    mood:
      typeof entry.mood === "string"
        ? entry.mood.trim() || null
        : null,
    tags: Array.from(new Set(tags)).slice(0, 20),
    visibility: "home_private",
    sourceRef: {
      legacyFile: "data/diary.json",
      legacyDate: entry.date,
      legacyTitle: entry.title
    },
    idempotencyKey:
      buildLegacyDiaryIdempotencyKey(entry),
    createdAt:
      `${entry.date}T12:00:00+08:00`
  };
}


export function selectLegacyDiaryTargets(
  document
) {
  const entries = Array.isArray(document?.entries)
    ? document.entries
    : [];

  return LEGACY_DIARY_TARGETS.map(
    (target) => {
      const entry = entries.find(
        (candidate) =>
          candidate?.date === target.date &&
          candidate?.title === target.title
      );

      if (!entry) {
        throw new Error(
          `没有在旧日记中找到 ${target.date}《${target.title}》`
        );
      }

      return normalizeLegacyDiaryEntry(entry);
    }
  );
}


async function loadLegacyDiaryTargets() {
  const fileUrl = new URL(
    "../data/diary.json",
    import.meta.url
  );

  const raw = await readFile(fileUrl, "utf8");
  const document = JSON.parse(raw);

  return selectLegacyDiaryTargets(document);
}


async function writeImportAudit({
  adminClient,
  userId,
  entry,
  created,
  requestId
}) {
  if (!adminClient) {
    return;
  }

  const { error } = await adminClient
    .from("study_audit_log")
    .insert({
      action: "import_legacy_diary",
      target_type: "study_entry",
      target_id: entry.id,
      actor_user_id: userId,
      actor: "g",
      source: "system",
      request_id: requestId,
      idempotency_key:
        entry.idempotency_key,
      success: true,
      details: {
        created,
        title: entry.title,
        legacyDate:
          entry.source_ref?.legacyDate ?? null
      }
    });

  if (error) {
    console.error(
      "Legacy diary import audit failed:",
      error.message
    );
  }
}


async function insertLegacyDiary({
  adminClient,
  userId,
  input,
  requestId
}) {
  const {
    data: existingEntry,
    error: existingError
  } = await adminClient
    .from("study_entries")
    .select(ENTRY_SELECT)
    .eq("owner_user_id", userId)
    .eq(
      "idempotency_key",
      input.idempotencyKey
    )
    .maybeSingle();

  if (existingError) {
    throw new Error(
      `无法检查《${input.title}》是否已经导入：${existingError.message}`
    );
  }

  if (existingEntry) {
    return {
      created: false,
      duplicate: true,
      entry: existingEntry
    };
  }

  const payload = {
    entry_type: "diary",
    title: input.title,
    body: input.body,
    summary: input.summary,
    mood: input.mood,
    tags: input.tags,
    created_by: "g",
    source: "system",
    visibility: input.visibility,
    source_ref: input.sourceRef,
    owner_user_id: userId,
    idempotency_key: input.idempotencyKey,
    created_at: input.createdAt,
    updated_at: input.createdAt
  };

  const {
    data: createdEntry,
    error: insertError
  } = await adminClient
    .from("study_entries")
    .insert(payload)
    .select(ENTRY_SELECT)
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      const {
        data: duplicateEntry
      } = await adminClient
        .from("study_entries")
        .select(ENTRY_SELECT)
        .eq("owner_user_id", userId)
        .eq(
          "idempotency_key",
          input.idempotencyKey
        )
        .maybeSingle();

      if (duplicateEntry) {
        return {
          created: false,
          duplicate: true,
          entry: duplicateEntry
        };
      }
    }

    throw new Error(
      `导入《${input.title}》失败：${insertError.message}`
    );
  }

  await writeImportAudit({
    adminClient,
    userId,
    entry: createdEntry,
    created: true,
    requestId
  });

  return {
    created: true,
    duplicate: false,
    entry: createdEntry
  };
}


export async function createDiaryEntry(
  req,
  res
) {
  try {
    const context = await createRequestContext(
      req,
      res
    );

    if (!context) {
      return;
    }

    const result = await context.studyService
      .createEntry(
        {
          entryType: "diary",
          title: req.body?.title,
          body: req.body?.body,
          summary: req.body?.summary,
          mood: req.body?.mood,
          tags: req.body?.tags ?? [],
          visibility:
            req.body?.visibility ??
            "home_private",
          sourceRef:
            req.body?.sourceRef ?? null,
          idempotencyKey:
            req.body?.idempotencyKey
        },
        {
          userId: context.user.id,
          actor: "xie_shi",
          source: "web",
          requestId: context.requestId
        }
      );

    res.set("Cache-Control", "no-store");

    return res
      .status(result.created ? 201 : 200)
      .json({
        ok: true,
        created: result.created,
        duplicate: result.duplicate,
        entry: toPublicEntry(result.entry)
      });
  } catch (error) {
    return sendError(res, error);
  }
}


export async function importLegacyDiaries(
  req,
  res
) {
  try {
    const context = await createRequestContext(
      req,
      res
    );

    if (!context) {
      return;
    }

    if (!context.adminClient) {
      return res.status(503).json({
        ok: false,
        error: "study_admin_client_unavailable",
        message:
          "缺少书房迁移所需的服务端密钥"
      });
    }

    const inputs = await loadLegacyDiaryTargets();
    const results = [];

    for (const input of inputs) {
      const result = await insertLegacyDiary({
        adminClient: context.adminClient,
        userId: context.user.id,
        input,
        requestId: context.requestId
      });

      results.push({
        created: result.created,
        duplicate: result.duplicate,
        entry: toPublicEntry(result.entry)
      });
    }

    res.set("Cache-Control", "no-store");

    return res.json({
      ok: true,
      count: results.length,
      createdCount:
        results.filter((item) => item.created)
          .length,
      duplicateCount:
        results.filter((item) => item.duplicate)
          .length,
      results
    });
  } catch (error) {
    return sendError(res, error);
  }
}
