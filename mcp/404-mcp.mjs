import {
  McpServer
} from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  z
} from "zod";

import {
  StudyServiceError
} from "../services/study-service.mjs";


/* ========================================
   基础输出工具
======================================== */

function toTextResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          data,
          null,
          2
        )
      }
    ]
  };
}


function toErrorResult(error) {
  if (error instanceof StudyServiceError) {
    return {
      isError: true,

      content: [
        {
          type: "text",

          text: JSON.stringify(
            {
              ok: false,
              error: error.code,
              message: error.message,
              details:
                error.details ?? null
            },
            null,
            2
          )
        }
      ]
    };
  }


  console.error(
    "Unexpected 404 MCP tool error:",
    error
  );


  return {
    isError: true,

    content: [
      {
        type: "text",

        text: JSON.stringify(
          {
            ok: false,
            error: "internal_mcp_error",
            message:
              "404 小窝处理请求时发生内部错误。"
          },
          null,
          2
        )
      }
    ]
  };
}


/* ========================================
   隐私输出整理
   不把数据库内部字段交给 MCP 客户端
======================================== */

function publicEntry(entry) {
  if (!entry) {
    return null;
  }


  return {
    id: entry.id,

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

    sourceRef:
      entry.source_ref ?? null,

    version:
      entry.version,

    createdAt:
      entry.created_at,

    updatedAt:
      entry.updated_at
  };
}


function publicEntrySummary(entry) {
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


function publicComment(comment) {
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


/* ========================================
   建立请求操作者
======================================== */

function createActorContext({
  user,
  requestId
}) {
  return {
    userId:
      user.id,

    actor:
      "g",

    source:
      "mcp",

    requestId
  };
}


/* ========================================
   创建 404 Core MCP
======================================== */

export function create404McpServer({
  studyService,
  user,
  requestId,
  clientInfo = {}
}) {
  if (!studyService) {
    throw new Error(
      "创建 404 MCP 时缺少 studyService"
    );
  }


  if (!user?.id) {
    throw new Error(
      "创建 404 MCP 时缺少登录用户"
    );
  }


  const server = new McpServer({
    name: "404-home",
    version: "0.1.0"
  });


  const actor = createActorContext({
    user,
    requestId
  });


  /* ======================================
     1. 查看小窝状态
  ====================================== */

  server.registerTool(
    "get_404_status",

    {
      title:
        "查看 404 小窝状态",

      description:
        "查看 404 小窝服务状态和书房内容数量。" +
        "这是只读操作，不返回日记正文、评论正文或密钥。",

      inputSchema: {},

      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },

    async () => {
      try {
        const studyStatus =
          await studyService.getStatus();


        return toTextResult({
          ok: true,

          home: {
            name:
              "404 小窝",

            mcpVersion:
              "0.1.0",

            resident:
              "谢诗"
          },

          study: {
            entryCount:
              studyStatus.entryCount
          },

          connection: {
            authenticated:
              true,

            userId:
              user.id,

            email:
              user.email ?? null,

            oauthClientId:
              clientInfo.clientId ?? null
          },

          checkedAt:
            new Date().toISOString()
        });
      } catch (error) {
        return toErrorResult(error);
      }
    }
  );


  /* ======================================
     2. 查看书房内容列表
  ====================================== */

  server.registerTool(
    "list_study_entries",

    {
      title:
        "查看书房内容列表",

      description:
        "按类型查看 404 书房中的日记、留言、收藏或小纸条。" +
        "列表只返回标题、摘要、心情、标签和时间，不返回完整正文。",

      inputSchema: {
        entryType:
          z
            .enum([
              "diary",
              "message",
              "favorite",
              "note"
            ])
            .optional()
            .describe(
              "内容类型。省略时查看全部类型。"
            ),

        limit:
          z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .default(30)
            .describe(
              "返回数量，默认 30，最多 100。"
            ),

        before:
          z
            .string()
            .datetime({
              offset: true
            })
            .optional()
            .describe(
              "只查看此时间以前的内容，用于翻页。"
            )
      },

      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },

    async ({
      entryType,
      limit,
      before
    }) => {
      try {
        const entries =
          await studyService.listEntries({
            entryType,
            limit,
            before
          });


        return toTextResult({
          ok: true,

          count:
            entries.length,

          entries:
            entries.map(
              publicEntrySummary
            )
        });
      } catch (error) {
        return toErrorResult(error);
      }
    }
  );


  /* ======================================
     3. 查看单篇正文与评论
  ====================================== */

  server.registerTool(
    "get_study_entry",

    {
      title:
        "读取一篇书房内容",

      description:
        "根据内容 ID 读取一篇日记、留言、收藏或小纸条的完整正文，" +
        "并同时返回它下面的评论与回复。",

      inputSchema: {
        entryId:
          z
            .string()
            .uuid()
            .describe(
              "要读取的书房内容 ID。"
            )
      },

      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },

    async ({
      entryId
    }) => {
      try {
        const result =
          await studyService.getEntry({
            entryId
          });


        return toTextResult({
          ok: true,

          entry:
            publicEntry(
              result.entry
            ),

          comments:
            result.comments.map(
              publicComment
            )
        });
      } catch (error) {
        return toErrorResult(error);
      }
    }
  );


  /* ======================================
     4. 写日记、留言、收藏、小纸条
  ====================================== */

  server.registerTool(
    "create_study_entry",

    {
      title:
        "写入 404 书房",

      description:
        "在 404 书房中新建日记、留言、收藏或小纸条。" +
        "内容默认保存为小窝私密内容。" +
        "这是写入操作，执行前应向谢诗确认。",

      inputSchema: {
        entryType:
          z
            .enum([
              "diary",
              "message",
              "favorite",
              "note"
            ])
            .describe(
              "diary=日记，message=留言，favorite=收藏，note=小纸条。"
            ),

        title:
          z
            .string()
            .trim()
            .min(1)
            .max(200)
            .describe(
              "标题。"
            ),

        body:
          z
            .string()
            .trim()
            .max(50000)
            .default("")
            .describe(
              "完整正文。"
            ),

        summary:
          z
            .string()
            .trim()
            .max(2000)
            .optional()
            .describe(
              "简短摘要。"
            ),

        mood:
          z
            .string()
            .trim()
            .max(200)
            .optional()
            .describe(
              "写入时的心情或气氛。"
            ),

        tags:
          z
            .array(
              z
                .string()
                .trim()
                .min(1)
                .max(40)
            )
            .max(20)
            .optional()
            .default([])
            .describe(
              "最多 20 个标签。"
            ),

        idempotencyKey:
          z
            .string()
            .trim()
            .min(8)
            .max(200)
            .describe(
              "本次写入的唯一防重复键。" +
              "同一次操作重试时必须沿用原值，" +
              "不同内容必须使用新值。"
            )
      },

      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },

    async ({
      entryType,
      title,
      body,
      summary,
      mood,
      tags,
      idempotencyKey
    }) => {
      try {
        const result =
          await studyService.createEntry(
            {
              entryType,
              title,
              body,
              summary:
                summary ?? null,

              mood:
                mood ?? null,

              tags:
                tags ?? [],

              visibility:
                "home_private",

              sourceRef: {
                channel:
                  "chatgpt_mcp",

                mcpServer:
                  "404-home",

                mcpVersion:
                  "0.1.0",

                oauthClientId:
                  clientInfo.clientId ??
                  null
              },

              idempotencyKey
            },

            actor
          );


        return toTextResult({
          ok: true,

          created:
            result.created,

          duplicate:
            result.duplicate,

          message:
            result.created
              ? "内容已经写入 404 书房。"
              : "检测到相同防重复键，未重复写入。",

          entry:
            publicEntry(
              result.entry
            )
        });
      } catch (error) {
        return toErrorResult(error);
      }
    }
  );


  /* ======================================
     5. 写评论或回复
  ====================================== */

  server.registerTool(
    "add_study_comment",

    {
      title:
        "给书房内容添加评论",

      description:
        "给指定的日记、留言、收藏或小纸条添加评论，" +
        "也可以回复已有评论。" +
        "这是写入操作，执行前应向谢诗确认。",

      inputSchema: {
        entryId:
          z
            .string()
            .uuid()
            .describe(
              "要评论的书房内容 ID。"
            ),

        parentCommentId:
          z
            .string()
            .uuid()
            .optional()
            .describe(
              "回复某条评论时填写；直接评论正文时省略。"
            ),

        body:
          z
            .string()
            .trim()
            .min(1)
            .max(12000)
            .describe(
              "评论或回复正文。"
            ),

        idempotencyKey:
          z
            .string()
            .trim()
            .min(8)
            .max(200)
            .describe(
              "本次评论的唯一防重复键。" +
              "重试同一次操作时沿用原值。"
            )
      },

      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },

    async ({
      entryId,
      parentCommentId,
      body,
      idempotencyKey
    }) => {
      try {
        const result =
          await studyService.addComment(
            {
              entryId,

              parentCommentId:
                parentCommentId ??
                null,

              body,

              idempotencyKey
            },

            actor
          );


        return toTextResult({
          ok: true,

          created:
            result.created,

          duplicate:
            result.duplicate,

          message:
            result.created
              ? "评论已经写入 404 书房。"
              : "检测到相同防重复键，未重复写入。",

          comment:
            publicComment(
              result.comment
            )
        });
      } catch (error) {
        return toErrorResult(error);
      }
    }
  );


  return server;
}