const EXTRA_SOURCE_TYPES = Object.freeze({
  CHAT_MESSAGE: "chat_message",
  ACTIVITY_PASS: "activity_pass",
  ACTIVITY_PROGRESS: "activity_progress",
  ACTIVITY_RUN: "activity_run"
});

const EXTRA_SOURCE_TYPE_SET = new Set(
  Object.values(EXTRA_SOURCE_TYPES)
);


function normalizeText(value) {
  return String(value ?? "").trim();
}


function trimText(value, maximum = 360) {
  const text = normalizeText(value);

  return text.length <= maximum
    ? text
    : `${text.slice(0, maximum)}…`;
}


function assertSourceType(value) {
  const sourceType = normalizeText(value);

  if (!EXTRA_SOURCE_TYPE_SET.has(sourceType)) {
    const error = new Error("不认识这种文字来源");
    error.code = "invalid_text_source_type";
    error.status = 400;
    throw error;
  }

  return sourceType;
}


function assertUuid(value) {
  const id = normalizeText(value);

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    const error = new Error("文字编号不符合规则");
    error.code = "invalid_text_item_id";
    error.status = 400;
    throw error;
  }

  return id;
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


function stateKey(sourceType, sourceId) {
  return `${sourceType}:${sourceId}`;
}


function toLedgerItem({
  sourceType,
  sourceId,
  sourceLabel,
  title,
  body,
  author = "",
  occurredAt,
  state = null,
  metadata = {}
}) {
  return {
    sourceType,
    sourceId,
    sourceLabel,
    title: normalizeText(title) || sourceLabel,
    preview: trimText(body, 360),
    author: normalizeText(author),
    tags: [],
    occurredAt: occurredAt ?? null,
    archived: Boolean(state?.archived_at),
    archivedAt: state?.archived_at ?? null,
    canArchive: true,
    canDelete: true,
    metadata
  };
}


function roleLabel(role) {
  if (role === "user") {
    return "谢诗说";
  }

  if (role === "assistant") {
    return "G 说";
  }

  if (role === "system") {
    return "系统上下文";
  }

  return "工具记录";
}


function roomLabel(room) {
  if (room === "bedroom") {
    return "卧室历史聊天";
  }

  if (room === "living_room") {
    return "旧客厅聊天";
  }

  return "聊天原文";
}


export function createTextLedgerExtraService({
  serviceClient
}) {
  if (!serviceClient) {
    throw new Error(
      "创建 textLedgerExtraService 时缺少 serviceClient"
    );
  }

  async function loadStates(userId) {
    const rows = await requireData(
      serviceClient
        .from("text_item_states")
        .select("source_type, source_id, archived_at")
        .eq("owner_user_id", userId),
      "text_states_read_failed",
      "无法读取文字归档状态"
    );

    return new Map(
      (rows ?? []).map((row) => [
        stateKey(row.source_type, row.source_id),
        row
      ])
    );
  }


  async function listItems({
    userId,
    sourceType = null,
    archived = false,
    limit = 100
  }) {
    const safeLimit = Math.min(
      250,
      Math.max(1, Number(limit) || 100)
    );
    const filterType = sourceType
      ? assertSourceType(sourceType)
      : null;
    const states = await loadStates(userId);

    const conversations = await requireData(
      serviceClient
        .from("hippocampus_conversations")
        .select("id, room")
        .eq("owner_user_id", userId),
      "text_conversations_read_failed",
      "无法读取聊天原文目录"
    );
    const conversationMap = new Map(
      (conversations ?? []).map((row) => [
        row.id,
        row.room
      ])
    );

    const [messages, passes, progressRows, runRows] =
      await Promise.all([
        !filterType || filterType === EXTRA_SOURCE_TYPES.CHAT_MESSAGE
          ? requireData(
              serviceClient
                .from("hippocampus_messages")
                .select([
                  "id",
                  "conversation_id",
                  "role",
                  "content",
                  "occurred_at",
                  "metadata"
                ].join(", "))
                .eq("owner_user_id", userId)
                .order("occurred_at", {
                  ascending: false
                })
                .limit(safeLimit),
              "text_chat_messages_read_failed",
              "无法读取聊天原文"
            )
          : Promise.resolve([]),
        !filterType || filterType === EXTRA_SOURCE_TYPES.ACTIVITY_PASS
          ? requireData(
              serviceClient
                .from("activity_passes")
                .select([
                  "id",
                  "note",
                  "status",
                  "starts_at",
                  "created_at"
                ].join(", "))
                .eq("owner_user_id", userId)
                .not("note", "is", null)
                .order("created_at", {
                  ascending: false
                })
                .limit(safeLimit),
              "text_activity_passes_read_failed",
              "无法读取活动通行证文字"
            )
          : Promise.resolve([]),
        !filterType || filterType === EXTRA_SOURCE_TYPES.ACTIVITY_PROGRESS
          ? requireData(
              serviceClient
                .from("free_activity_progress")
                .select([
                  "activity_pass_id",
                  "current_task",
                  "progress_summary",
                  "state",
                  "updated_at"
                ].join(", "))
                .eq("owner_user_id", userId)
                .order("updated_at", {
                  ascending: false
                })
                .limit(safeLimit),
              "text_activity_progress_read_failed",
              "无法读取自由活动进度文字"
            )
          : Promise.resolve([]),
        !filterType || filterType === EXTRA_SOURCE_TYPES.ACTIVITY_RUN
          ? requireData(
              serviceClient
                .from("activity_runs")
                .select([
                  "id",
                  "short_note",
                  "result_summary",
                  "error_message",
                  "run_mode",
                  "started_at",
                  "completed_at"
                ].join(", "))
                .eq("owner_user_id", userId)
                .order("started_at", {
                  ascending: false
                })
                .limit(safeLimit),
              "text_activity_runs_read_failed",
              "无法读取自由活动结果文字"
            )
          : Promise.resolve([])
      ]);

    const items = [];

    for (const message of messages ?? []) {
      if (
        message.metadata?.detachedFromResponseChain === true
      ) {
        continue;
      }

      const room = conversationMap.get(
        message.conversation_id
      );

      items.push(toLedgerItem({
        sourceType: EXTRA_SOURCE_TYPES.CHAT_MESSAGE,
        sourceId: message.id,
        sourceLabel: roomLabel(room),
        title: roleLabel(message.role),
        body: message.content,
        author: message.role,
        occurredAt: message.occurred_at,
        state: states.get(stateKey(
          EXTRA_SOURCE_TYPES.CHAT_MESSAGE,
          message.id
        )),
        metadata: {
          room,
          role: message.role,
          conversationId:
            message.conversation_id
        }
      }));
    }

    for (const pass of passes ?? []) {
      if (!normalizeText(pass.note)) {
        continue;
      }

      items.push(toLedgerItem({
        sourceType: EXTRA_SOURCE_TYPES.ACTIVITY_PASS,
        sourceId: pass.id,
        sourceLabel: "活动通行证",
        title: "谢诗留下的活动说明",
        body: pass.note,
        author: "xie_shi",
        occurredAt:
          pass.created_at ?? pass.starts_at,
        state: states.get(stateKey(
          EXTRA_SOURCE_TYPES.ACTIVITY_PASS,
          pass.id
        )),
        metadata: {
          status: pass.status
        }
      }));
    }

    for (const progress of progressRows ?? []) {
      const body = [
        normalizeText(progress.current_task),
        normalizeText(progress.progress_summary)
      ].filter(Boolean).join("\n\n");

      if (!body) {
        continue;
      }

      items.push(toLedgerItem({
        sourceType: EXTRA_SOURCE_TYPES.ACTIVITY_PROGRESS,
        sourceId: progress.activity_pass_id,
        sourceLabel: "自由活动进度",
        title:
          normalizeText(progress.current_task) ||
          "自由活动进度",
        body,
        author: "g",
        occurredAt: progress.updated_at,
        state: states.get(stateKey(
          EXTRA_SOURCE_TYPES.ACTIVITY_PROGRESS,
          progress.activity_pass_id
        )),
        metadata: {
          state: progress.state
        }
      }));
    }

    for (const run of runRows ?? []) {
      const body = [
        normalizeText(run.short_note),
        normalizeText(run.result_summary),
        normalizeText(run.error_message)
      ].filter(Boolean).join("\n\n");

      if (!body) {
        continue;
      }

      items.push(toLedgerItem({
        sourceType: EXTRA_SOURCE_TYPES.ACTIVITY_RUN,
        sourceId: run.id,
        sourceLabel: "活动运行记录",
        title:
          normalizeText(run.short_note) ||
          "一次活动结果",
        body,
        author: "system",
        occurredAt:
          run.completed_at ?? run.started_at,
        state: states.get(stateKey(
          EXTRA_SOURCE_TYPES.ACTIVITY_RUN,
          run.id
        )),
        metadata: {
          runMode: run.run_mode
        }
      }));
    }

    return items
      .filter((item) => item.archived === Boolean(archived))
      .sort((left, right) => (
        new Date(right.occurredAt ?? 0) -
        new Date(left.occurredAt ?? 0)
      ))
      .slice(0, safeLimit);
  }


  async function getItem({
    userId,
    sourceType,
    sourceId
  }) {
    const type = assertSourceType(sourceType);
    const id = assertUuid(sourceId);
    let row = null;

    if (type === EXTRA_SOURCE_TYPES.CHAT_MESSAGE) {
      row = await requireData(
        serviceClient
          .from("hippocampus_messages")
          .select("*")
          .eq("owner_user_id", userId)
          .eq("id", id)
          .maybeSingle(),
        "text_chat_message_read_failed",
        "无法读取这条聊天原文"
      );
    } else if (type === EXTRA_SOURCE_TYPES.ACTIVITY_PASS) {
      row = await requireData(
        serviceClient
          .from("activity_passes")
          .select("*")
          .eq("owner_user_id", userId)
          .eq("id", id)
          .maybeSingle(),
        "text_activity_pass_read_failed",
        "无法读取这张活动通行证"
      );
    } else if (type === EXTRA_SOURCE_TYPES.ACTIVITY_PROGRESS) {
      row = await requireData(
        serviceClient
          .from("free_activity_progress")
          .select("*")
          .eq("owner_user_id", userId)
          .eq("activity_pass_id", id)
          .maybeSingle(),
        "text_activity_progress_item_read_failed",
        "无法读取这段自由活动进度"
      );
    } else if (type === EXTRA_SOURCE_TYPES.ACTIVITY_RUN) {
      row = await requireData(
        serviceClient
          .from("activity_runs")
          .select("*")
          .eq("owner_user_id", userId)
          .eq("id", id)
          .maybeSingle(),
        "text_activity_run_read_failed",
        "无法读取这次活动结果"
      );
    }

    if (!row) {
      const error = new Error("这条文字已经不存在了");
      error.code = "text_item_not_found";
      error.status = 404;
      throw error;
    }

    return {
      sourceType: type,
      sourceId: id,
      row
    };
  }


  async function setArchived({
    userId,
    sourceType,
    sourceId,
    archived
  }) {
    const type = assertSourceType(sourceType);
    const id = assertUuid(sourceId);

    await getItem({
      userId,
      sourceType: type,
      sourceId: id
    });

    if (!archived) {
      await requireData(
        serviceClient
          .from("text_item_states")
          .delete()
          .eq("owner_user_id", userId)
          .eq("source_type", type)
          .eq("source_id", id)
          .select("id"),
        "text_unarchive_failed",
        "无法取消归档"
      );

      return {
        sourceType: type,
        sourceId: id,
        archived: false,
        archivedAt: null
      };
    }

    const archivedAt = new Date().toISOString();

    await requireData(
      serviceClient
        .from("text_item_states")
        .upsert({
          owner_user_id: userId,
          source_type: type,
          source_id: id,
          archived_at: archivedAt
        }, {
          onConflict:
            "owner_user_id,source_type,source_id"
        })
        .select("id")
        .single(),
      "text_archive_failed",
      "无法归档这条文字"
    );

    return {
      sourceType: type,
      sourceId: id,
      archived: true,
      archivedAt
    };
  }


  async function deleteItem({
    userId,
    sourceType,
    sourceId
  }) {
    const type = assertSourceType(sourceType);
    const id = assertUuid(sourceId);

    await getItem({
      userId,
      sourceType: type,
      sourceId: id
    });

    let deletedCount = 1;

    if (type === EXTRA_SOURCE_TYPES.CHAT_MESSAGE) {
      await Promise.all([
        serviceClient
          .from("hippocampus_memories")
          .delete()
          .eq("owner_user_id", userId)
          .eq("source_id", id),
        serviceClient
          .from("hippocampus_retrievals")
          .delete()
          .eq("owner_user_id", userId)
          .contains("selected_message_ids", [id])
      ]);

      const rows = await requireData(
        serviceClient
          .from("hippocampus_messages")
          .delete()
          .eq("owner_user_id", userId)
          .eq("id", id)
          .select("id"),
        "text_chat_message_delete_failed",
        "无法删除这条聊天原文"
      );
      deletedCount = rows?.length ?? 0;
    } else if (type === EXTRA_SOURCE_TYPES.ACTIVITY_PASS) {
      await requireData(
        serviceClient
          .from("activity_passes")
          .update({ note: null })
          .eq("owner_user_id", userId)
          .eq("id", id)
          .select("id")
          .single(),
        "text_activity_pass_clear_failed",
        "无法清除活动通行证文字"
      );
    } else if (type === EXTRA_SOURCE_TYPES.ACTIVITY_PROGRESS) {
      await requireData(
        serviceClient
          .from("free_activity_progress")
          .update({
            current_task: null,
            progress_summary: null
          })
          .eq("owner_user_id", userId)
          .eq("activity_pass_id", id)
          .select("activity_pass_id")
          .single(),
        "text_activity_progress_clear_failed",
        "无法清除自由活动进度文字"
      );
    } else if (type === EXTRA_SOURCE_TYPES.ACTIVITY_RUN) {
      await requireData(
        serviceClient
          .from("activity_runs")
          .update({
            short_note: null,
            result_summary: null,
            error_message: null
          })
          .eq("owner_user_id", userId)
          .eq("id", id)
          .select("id")
          .single(),
        "text_activity_run_clear_failed",
        "无法清除活动运行文字"
      );
    }

    await serviceClient
      .from("text_item_states")
      .delete()
      .eq("owner_user_id", userId)
      .eq("source_type", type)
      .eq("source_id", id);

    if (!deletedCount) {
      const error = new Error(
        "删除没有生效，文字仍然保留"
      );
      error.code = "text_item_delete_noop";
      error.status = 409;
      throw error;
    }

    return {
      sourceType: type,
      sourceId: id,
      deletedCount
    };
  }


  return {
    listItems,
    getItem,
    setArchived,
    deleteItem
  };
}


export {
  EXTRA_SOURCE_TYPES
};
