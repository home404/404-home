import { z } from "zod";


/* ========================================
   基础常量
======================================== */

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
  "version",
  "created_at",
  "updated_at"
].join(", ");


/* ========================================
   错误类型
======================================== */

export class StudyServiceError extends Error {
  constructor(
    code,
    message,
    status = 400,
    details = null
  ) {
    super(message);

    this.name = "StudyServiceError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}


/* ========================================
   输入规则
======================================== */

export const studyActorSchema = z.object({
  userId: z.string().uuid(),

  actor: z.enum([
    "xie_shi",
    "g",
    "system"
  ]),

  source: z.enum([
    "web",
    "mcp",
    "worker",
    "system"
  ]),

  requestId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .nullable()
});


export const listStudyEntriesSchema = z.object({
  entryType: z
    .enum([
      "diary",
      "message",
      "favorite",
      "note"
    ])
    .optional(),

  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(30),

  before: z
    .string()
    .datetime({ offset: true })
    .optional()
});


export const getStudyEntrySchema = z.object({
  entryId: z.string().uuid()
});


export const createStudyEntrySchema = z.object({
  entryType: z.enum([
    "diary",
    "message",
    "favorite",
    "note"
  ]),

  title: z
    .string()
    .trim()
    .min(1)
    .max(200),

  body: z
    .string()
    .trim()
    .max(50000)
    .default(""),

  summary: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .nullable(),

  mood: z
    .string()
    .trim()
    .max(200)
    .optional()
    .nullable(),

  tags: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(40)
    )
    .max(20)
    .default([]),

  visibility: z
    .enum([
      "home_private",
      "personal_private",
      "shared_copy"
    ])
    .default("home_private"),

  sourceRef: z
    .record(z.string(), z.unknown())
    .optional()
    .nullable(),

  idempotencyKey: z
    .string()
    .trim()
    .min(8)
    .max(200)
});


export const addStudyCommentSchema = z.object({
  entryId: z.string().uuid(),

  parentCommentId: z
    .string()
    .uuid()
    .optional()
    .nullable(),

  body: z
    .string()
    .trim()
    .min(1)
    .max(12000),

  idempotencyKey: z
    .string()
    .trim()
    .min(8)
    .max(200)
});


/* ========================================
   内部工具
======================================== */

function parseInput(schema, input, errorCode) {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new StudyServiceError(
      errorCode,
      "输入内容不符合书房规则",
      400,
      result.error.flatten()
    );
  }

  return result.data;
}


function normalizeTags(tags) {
  return Array.from(
    new Set(
      tags
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );
}


function isUniqueViolation(error) {
  return error?.code === "23505";
}


/* ========================================
   正式书房服务
======================================== */

export function createStudyService({
  dataClient,
  auditClient
}) {
  if (!dataClient) {
    throw new Error(
      "createStudyService 缺少 dataClient"
    );
  }


  /* --------------------------------------
     审计日志
  -------------------------------------- */

  async function writeAudit({
    action,
    targetType,
    targetId = null,
    actor,
    idempotencyKey = null,
    success,
    errorCode = null,
    details = {}
  }) {
    if (!auditClient) {
      console.warn(
        "Study audit skipped: auditClient unavailable"
      );

      return;
    }

    const { error } = await auditClient
      .from("study_audit_log")
      .insert({
        action,
        target_type: targetType,
        target_id: targetId,
        actor_user_id: actor.userId,
        actor: actor.actor,
        source: actor.source,
        request_id: actor.requestId ?? null,
        idempotency_key:
          idempotencyKey ?? null,
        success,
        error_code: errorCode,
        details
      });

    if (error) {
      console.error(
        "Study audit write failed:",
        error.message
      );
    }
  }


  /* --------------------------------------
     查看书房状态
  -------------------------------------- */

  async function getStatus() {
    const {
      count,
      error
    } = await dataClient
      .from("study_entries")
      .select(
        "id",
        {
          count: "exact",
          head: true
        }
      );

    if (error) {
      throw new StudyServiceError(
        "study_status_failed",
        "无法读取书房状态",
        500
      );
    }

    return {
      entryCount: count ?? 0
    };
  }


  /* --------------------------------------
     查看内容列表
  -------------------------------------- */

  async function listEntries(rawInput = {}) {
    const input = parseInput(
      listStudyEntriesSchema,
      rawInput,
      "invalid_list_input"
    );

    let query = dataClient
      .from("study_entries")
      .select([
        "id",
        "entry_type",
        "title",
        "summary",
        "mood",
        "tags",
        "created_by",
        "source",
        "visibility",
        "source_ref",
        "created_at",
        "updated_at"
      ].join(", "))
      .order(
        "created_at",
        {
          ascending: false
        }
      )
      .limit(input.limit);

    if (input.entryType) {
      query = query.eq(
        "entry_type",
        input.entryType
      );
    }

    if (input.before) {
      query = query.lt(
        "created_at",
        input.before
      );
    }

    const {
      data,
      error
    } = await query;

    if (error) {
      console.error(
        "List study entries failed:",
        error.message
      );

      throw new StudyServiceError(
        "study_list_failed",
        "无法读取书房内容",
        500
      );
    }

    return data ?? [];
  }


  /* --------------------------------------
     查看单篇内容与评论
  -------------------------------------- */

  async function getEntry(rawInput) {
    const input = parseInput(
      getStudyEntrySchema,
      rawInput,
      "invalid_entry_input"
    );

    const {
      data: entry,
      error: entryError
    } = await dataClient
      .from("study_entries")
      .select(ENTRY_SELECT)
      .eq("id", input.entryId)
      .maybeSingle();

    if (entryError) {
      console.error(
        "Get study entry failed:",
        entryError.message
      );

      throw new StudyServiceError(
        "study_entry_read_failed",
        "无法读取这条书房内容",
        500
      );
    }

    if (!entry) {
      throw new StudyServiceError(
        "study_entry_not_found",
        "没有找到这条书房内容",
        404
      );
    }

    const {
      data: comments,
      error: commentsError
    } = await dataClient
      .from("study_comments")
      .select([
        "id",
        "entry_id",
        "parent_comment_id",
        "author",
        "body",
        "source",
        "owner_user_id",
        "created_at",
        "updated_at"
      ].join(", "))
      .eq("entry_id", input.entryId)
      .order(
        "created_at",
        {
          ascending: true
        }
      );

    if (commentsError) {
      console.error(
        "Get study comments failed:",
        commentsError.message
      );

      throw new StudyServiceError(
        "study_comments_read_failed",
        "正文已找到，但评论读取失败",
        500
      );
    }

    return {
      entry,
      comments: comments ?? []
    };
  }


  /* --------------------------------------
     新建日记、留言、收藏、小纸条
  -------------------------------------- */

  async function createEntry(
    rawInput,
    rawActor
  ) {
    const input = parseInput(
      createStudyEntrySchema,
      rawInput,
      "invalid_create_entry_input"
    );

    const actor = parseInput(
      studyActorSchema,
      rawActor,
      "invalid_study_actor"
    );

    const {
      data: existingEntry,
      error: existingError
    } = await dataClient
      .from("study_entries")
      .select(ENTRY_SELECT)
      .eq(
        "idempotency_key",
        input.idempotencyKey
      )
      .maybeSingle();

    if (existingError) {
      throw new StudyServiceError(
        "idempotency_check_failed",
        "无法检查是否重复写入",
        500
      );
    }

    if (existingEntry) {
      return {
        created: false,
        duplicate: true,
        entry: existingEntry
      };
    }

    const insertPayload = {
      entry_type: input.entryType,
      title: input.title,
      body: input.body,
      summary: input.summary ?? null,
      mood: input.mood ?? null,
      tags: normalizeTags(input.tags),
      created_by: actor.actor,
      source: actor.source,
      visibility: input.visibility,
      source_ref: input.sourceRef ?? null,
      owner_user_id: actor.userId,
      idempotency_key:
        input.idempotencyKey
    };

    const {
      data: createdEntry,
      error: insertError
    } = await dataClient
      .from("study_entries")
      .insert(insertPayload)
      .select(ENTRY_SELECT)
      .single();

    if (insertError) {
      if (isUniqueViolation(insertError)) {
        const {
          data: duplicateEntry
        } = await dataClient
          .from("study_entries")
          .select(ENTRY_SELECT)
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

      await writeAudit({
        action: "create_entry",
        targetType: "study_entry",
        actor,
        idempotencyKey:
          input.idempotencyKey,
        success: false,
        errorCode:
          "study_entry_create_failed",
        details: {
          entryType: input.entryType,
          databaseCode:
            insertError.code ?? null
        }
      });

      console.error(
        "Create study entry failed:",
        insertError.message
      );

      throw new StudyServiceError(
        "study_entry_create_failed",
        "书房内容写入失败",
        500
      );
    }

    await writeAudit({
      action: "create_entry",
      targetType: "study_entry",
      targetId: createdEntry.id,
      actor,
      idempotencyKey:
        input.idempotencyKey,
      success: true,
      details: {
        entryType:
          createdEntry.entry_type,
        title: createdEntry.title
      }
    });

    return {
      created: true,
      duplicate: false,
      entry: createdEntry
    };
  }


  /* --------------------------------------
     新建评论或回复
  -------------------------------------- */

  async function addComment(
    rawInput,
    rawActor
  ) {
    const input = parseInput(
      addStudyCommentSchema,
      rawInput,
      "invalid_comment_input"
    );

    const actor = parseInput(
      studyActorSchema,
      rawActor,
      "invalid_study_actor"
    );

    if (
      actor.actor !== "xie_shi" &&
      actor.actor !== "g"
    ) {
      throw new StudyServiceError(
        "invalid_comment_author",
        "只有谢诗或 G 可以发表评论",
        403
      );
    }

    const {
      data: entry,
      error: entryError
    } = await dataClient
      .from("study_entries")
      .select("id")
      .eq("id", input.entryId)
      .maybeSingle();

    if (entryError) {
      throw new StudyServiceError(
        "comment_entry_check_failed",
        "无法确认评论对应的内容",
        500
      );
    }

    if (!entry) {
      throw new StudyServiceError(
        "study_entry_not_found",
        "评论对应的内容不存在",
        404
      );
    }

    if (input.parentCommentId) {
      const {
        data: parentComment,
        error: parentError
      } = await dataClient
        .from("study_comments")
        .select("id, entry_id")
        .eq(
          "id",
          input.parentCommentId
        )
        .maybeSingle();

      if (parentError) {
        throw new StudyServiceError(
          "parent_comment_check_failed",
          "无法确认被回复的评论",
          500
        );
      }

      if (
        !parentComment ||
        parentComment.entry_id !==
          input.entryId
      ) {
        throw new StudyServiceError(
          "invalid_parent_comment",
          "被回复的评论不属于这篇内容",
          400
        );
      }
    }

    const {
      data: existingComment,
      error: existingError
    } = await dataClient
      .from("study_comments")
      .select("*")
      .eq(
        "idempotency_key",
        input.idempotencyKey
      )
      .maybeSingle();

    if (existingError) {
      throw new StudyServiceError(
        "comment_idempotency_check_failed",
        "无法检查评论是否重复",
        500
      );
    }

    if (existingComment) {
      return {
        created: false,
        duplicate: true,
        comment: existingComment
      };
    }

    const {
      data: createdComment,
      error: insertError
    } = await dataClient
      .from("study_comments")
      .insert({
        entry_id: input.entryId,
        parent_comment_id:
          input.parentCommentId ?? null,
        author: actor.actor,
        body: input.body,
        source: actor.source,
        owner_user_id: actor.userId,
        idempotency_key:
          input.idempotencyKey
      })
      .select("*")
      .single();

    if (insertError) {
      await writeAudit({
        action: "create_comment",
        targetType: "study_comment",
        actor,
        idempotencyKey:
          input.idempotencyKey,
        success: false,
        errorCode:
          "study_comment_create_failed",
        details: {
          entryId: input.entryId,
          databaseCode:
            insertError.code ?? null
        }
      });

      console.error(
        "Create study comment failed:",
        insertError.message
      );

      throw new StudyServiceError(
        "study_comment_create_failed",
        "评论写入失败",
        500
      );
    }

    await writeAudit({
      action: "create_comment",
      targetType: "study_comment",
      targetId: createdComment.id,
      actor,
      idempotencyKey:
        input.idempotencyKey,
      success: true,
      details: {
        entryId: input.entryId,
        parentCommentId:
          input.parentCommentId ?? null
      }
    });

    return {
      created: true,
      duplicate: false,
      comment: createdComment
    };
  }


  return {
    getStatus,
    listEntries,
    getEntry,
    createEntry,
    addComment
  };
}