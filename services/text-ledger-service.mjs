const SOURCE_TYPES = Object.freeze({
  STUDY_ENTRY: "study_entry",
  STUDY_COMMENT: "study_comment",
  BEDROOM_MESSAGE: "bedroom_message",
  MEMORY: "memory",
  HOME_EVENT: "home_event"
});

const SOURCE_TYPE_SET = new Set(
  Object.values(SOURCE_TYPES)
);

const STUDY_ENTRY_LABELS = Object.freeze({
  diary: "书房日记",
  message: "历史消息",
  favorite: "收藏",
  note: "小纸条"
});


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

  if (!SOURCE_TYPE_SET.has(sourceType)) {
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
  summary = "",
  author = "",
  tags = [],
  occurredAt,
  state = null,
  metadata = {}
}) {
  const fullBody = normalizeText(body || summary);

  return {
    sourceType,
    sourceId,
    sourceLabel,
    title: normalizeText(title) || sourceLabel,
    preview: trimText(fullBody, 360),
    author: normalizeText(author),
    tags: Array.isArray(tags)
      ? tags.filter(Boolean).slice(0, 20)
      : [],
    occurredAt: occurredAt ?? null,
    archived: Boolean(state?.archived_at),
    archivedAt: state?.archived_at ?? null,
    canArchive: true,
    canDelete: true,
    metadata
  };
}


export function collectCommentTreeIds(
  comments,
  rootCommentId
) {
  const rows = Array.isArray(comments)
    ? comments
    : [];
  const rootId = normalizeText(rootCommentId);
  const existing = new Set(
    rows.map((row) => normalizeText(row.id))
      .filter(Boolean)
  );

  if (!existing.has(rootId)) {
    return [];
  }

  const children = new Map();

  for (const row of rows) {
    const id = normalizeText(row.id);
    const parentId = normalizeText(
      row.parent_comment_id
    );

    if (!id || !parentId) {
      continue;
    }

    if (!children.has(parentId)) {
      children.set(parentId, []);
    }

    children.get(parentId).push(id);
  }

  const queue = [rootId];
  const visited = new Set();
  const result = [];

  while (queue.length) {
    const current = queue.shift();

    if (
      !current ||
      visited.has(current) ||
      !existing.has(current)
    ) {
      continue;
    }

    visited.add(current);
    result.push(current);

    for (const child of children.get(current) ?? []) {
      queue.push(child);
    }
  }

  return result;
}


export function createTextLedgerService({
  serviceClient
}) {
  if (!serviceClient) {
    throw new Error(
      "创建 textLedgerService 时缺少 serviceClient"
    );
  }

  async function loadStates(userId) {
    const rows = await requireData(
      serviceClient
        .from("text_item_states")
        .select([
          "source_type",
          "source_id",
          "archived_at"
        ].join(", "))
        .eq("owner_user_id", userId),
      "text_states_read_failed",
      "无法读取文字归档状态"
    );

    return new Map(
      (rows ?? []).map((row) => [
        stateKey(
          row.source_type,
          row.source_id
        ),
        row
      ])
    );
  }


  async function loadBedroomConversationIds(
    userId
  ) {
    const rows = await requireData(
      serviceClient
        .from("hippocampus_conversations")
        .select("id")
        .eq("owner_user_id", userId)
        .eq("room", "bedroom"),
      "bedroom_conversations_read_failed",
      "无法读取卧室消息目录"
    );

    return (rows ?? []).map((row) => row.id);
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
    const bedroomConversationIds =
      await loadBedroomConversationIds(userId);

    const [
      studyEntries,
      studyComments,
      memories,
      homeEvents,
      bedroomMessages
    ] = await Promise.all([
      !filterType || filterType === SOURCE_TYPES.STUDY_ENTRY
        ? requireData(
            serviceClient
              .from("study_entries")
              .select([
                "id",
                "entry_type",
                "title",
                "body",
                "summary",
                "tags",
                "created_by",
                "created_at"
              ].join(", "))
              .eq("owner_user_id", userId)
              .order("created_at", {
                ascending: false
              })
              .limit(safeLimit),
            "text_study_entries_read_failed",
            "无法读取书房文字"
          )
        : Promise.resolve([]),
      !filterType || filterType === SOURCE_TYPES.STUDY_COMMENT
        ? requireData(
            serviceClient
              .from("study_comments")
              .select([
                "id",
                "entry_id",
                "author",
                "body",
                "created_at"
              ].join(", "))
              .eq("owner_user_id", userId)
              .order("created_at", {
                ascending: false
              })
              .limit(safeLimit),
            "text_study_comments_read_failed",
            "无法读取书房评论"
          )
        : Promise.resolve([]),
      !filterType || filterType === SOURCE_TYPES.MEMORY
        ? requireData(
            serviceClient
              .from("hippocampus_memories")
              .select([
                "id",
                "memory_type",
                "title",
                "content",
                "summary",
                "tags",
                "occurred_at"
              ].join(", "))
              .eq("owner_user_id", userId)
              .order("occurred_at", {
                ascending: false
              })
              .limit(safeLimit),
            "text_memories_read_failed",
            "无法读取海马体记忆"
          )
        : Promise.resolve([]),
      !filterType || filterType === SOURCE_TYPES.HOME_EVENT
        ? requireData(
            serviceClient
              .from("home_events")
              .select([
                "id",
                "actor",
                "event_type",
                "room",
                "title",
                "detail",
                "occurred_at"
              ].join(", "))
              .eq("owner_user_id", userId)
              .eq("is_user_visible", true)
              .order("occurred_at", {
                ascending: false
              })
              .limit(safeLimit),
            "text_home_events_read_failed",
            "无法读取全屋活动文字"
          )
        : Promise.resolve([]),
      (!filterType || filterType === SOURCE_TYPES.BEDROOM_MESSAGE) &&
        bedroomConversationIds.length
        ? requireData(
            serviceClient
              .from("hippocampus_messages")
              .select([
                "id",
                "content",
                "role",
                "occurred_at",
                "metadata"
              ].join(", "))
              .eq("owner_user_id", userId)
              .eq("role", "assistant")
              .in(
                "conversation_id",
                bedroomConversationIds
              )
              .order("occurred_at", {
                ascending: false
              })
              .limit(safeLimit),
            "text_bedroom_messages_read_failed",
            "无法读取卧室消息"
          )
        : Promise.resolve([])
    ]);

    const entryTitleMap = new Map(
      (studyEntries ?? []).map((entry) => [
        entry.id,
        entry.title
      ])
    );
    const items = [];

    for (const entry of studyEntries ?? []) {
      items.push(toLedgerItem({
        sourceType: SOURCE_TYPES.STUDY_ENTRY,
        sourceId: entry.id,
        sourceLabel:
          STUDY_ENTRY_LABELS[entry.entry_type] ??
          "书房内容",
        title: entry.title,
        body: entry.body,
        summary: entry.summary,
        author: entry.created_by,
        tags: entry.tags,
        occurredAt: entry.created_at,
        state: states.get(stateKey(
          SOURCE_TYPES.STUDY_ENTRY,
          entry.id
        )),
        metadata: {
          entryType: entry.entry_type
        }
      }));
    }

    for (const comment of studyComments ?? []) {
      items.push(toLedgerItem({
        sourceType: SOURCE_TYPES.STUDY_COMMENT,
        sourceId: comment.id,
        sourceLabel: "书房评论",
        title:
          entryTitleMap.get(comment.entry_id) ??
          "书房评论",
        body: comment.body,
        author: comment.author,
        occurredAt: comment.created_at,
        state: states.get(stateKey(
          SOURCE_TYPES.STUDY_COMMENT,
          comment.id
        )),
        metadata: {
          entryId: comment.entry_id
        }
      }));
    }

    for (const memory of memories ?? []) {
      items.push(toLedgerItem({
        sourceType: SOURCE_TYPES.MEMORY,
        sourceId: memory.id,
        sourceLabel: "海马体记忆",
        title: memory.title,
        body: memory.content,
        summary: memory.summary,
        tags: memory.tags,
        occurredAt: memory.occurred_at,
        state: states.get(stateKey(
          SOURCE_TYPES.MEMORY,
          memory.id
        )),
        metadata: {
          memoryType: memory.memory_type
        }
      }));
    }

    for (const event of homeEvents ?? []) {
      items.push(toLedgerItem({
        sourceType: SOURCE_TYPES.HOME_EVENT,
        sourceId: event.id,
        sourceLabel: "全屋活动",
        title: event.title,
        body: event.detail,
        author: event.actor,
        occurredAt: event.occurred_at,
        state: states.get(stateKey(
          SOURCE_TYPES.HOME_EVENT,
          event.id
        )),
        metadata: {
          eventType: event.event_type,
          room: event.room
        }
      }));
    }

    for (const message of bedroomMessages ?? []) {
      items.push(toLedgerItem({
        sourceType: SOURCE_TYPES.BEDROOM_MESSAGE,
        sourceId: message.id,
        sourceLabel: "卧室消息",
        title: "G 发来的消息",
        body: message.content,
        author: "g",
        occurredAt: message.occurred_at,
        state: states.get(stateKey(
          SOURCE_TYPES.BEDROOM_MESSAGE,
          message.id
        )),
        metadata: message.metadata ?? {}
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

    if (type === SOURCE_TYPES.STUDY_ENTRY) {
      row = await requireData(
        serviceClient
          .from("study_entries")
          .select("*")
          .eq("owner_user_id", userId)
          .eq("id", id)
          .maybeSingle(),
        "text_study_entry_read_failed",
        "无法读取这条书房文字"
      );
    } else if (type === SOURCE_TYPES.STUDY_COMMENT) {
      row = await requireData(
        serviceClient
          .from("study_comments")
          .select("*")
          .eq("owner_user_id", userId)
          .eq("id", id)
          .maybeSingle(),
        "text_study_comment_read_failed",
        "无法读取这条评论"
      );
    } else if (type === SOURCE_TYPES.BEDROOM_MESSAGE) {
      row = await requireData(
        serviceClient
          .from("hippocampus_messages")
          .select("*")
          .eq("owner_user_id", userId)
          .eq("id", id)
          .eq("role", "assistant")
          .maybeSingle(),
        "text_bedroom_message_read_failed",
        "无法读取这条卧室消息"
      );
    } else if (type === SOURCE_TYPES.MEMORY) {
      row = await requireData(
        serviceClient
          .from("hippocampus_memories")
          .select("*")
          .eq("owner_user_id", userId)
          .eq("id", id)
          .maybeSingle(),
        "text_memory_read_failed",
        "无法读取这条海马体记忆"
      );
    } else if (type === SOURCE_TYPES.HOME_EVENT) {
      row = await requireData(
        serviceClient
          .from("home_events")
          .select("*")
          .eq("owner_user_id", userId)
          .eq("id", id)
          .maybeSingle(),
        "text_home_event_read_failed",
        "无法读取这条全屋活动"
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
    const item = await getItem({
      userId,
      sourceType: type,
      sourceId: id
    });
    let deletedCount = 0;

    if (type === SOURCE_TYPES.STUDY_ENTRY) {
      await Promise.all([
        serviceClient
          .from("hippocampus_memories")
          .delete()
          .eq("owner_user_id", userId)
          .eq("source_id", id),
        serviceClient
          .from("hippocampus_messages")
          .delete()
          .eq("owner_user_id", userId)
          .contains("metadata", {
            studyEntryId: id
          })
      ]);

      const rows = await requireData(
        serviceClient
          .from("study_entries")
          .delete()
          .eq("owner_user_id", userId)
          .eq("id", id)
          .select("id"),
        "text_study_entry_delete_failed",
        "无法删除这条书房文字"
      );
      deletedCount = rows?.length ?? 0;
    } else if (type === SOURCE_TYPES.STUDY_COMMENT) {
      const comments = await requireData(
        serviceClient
          .from("study_comments")
          .select("id, parent_comment_id")
          .eq("owner_user_id", userId)
          .eq("entry_id", item.row.entry_id),
        "text_comment_tree_read_failed",
        "无法确认评论下面的回复"
      );
      const ids = collectCommentTreeIds(
        comments,
        id
      );
      const rows = await requireData(
        serviceClient
          .from("study_comments")
          .delete()
          .eq("owner_user_id", userId)
          .in("id", ids)
          .select("id"),
        "text_study_comment_delete_failed",
        "无法删除这条评论"
      );
      deletedCount = rows?.length ?? 0;
    } else if (type === SOURCE_TYPES.BEDROOM_MESSAGE) {
      await serviceClient
        .from("bedroom_message_reads")
        .delete()
        .eq("owner_user_id", userId)
        .eq("message_id", id);

      const rows = await requireData(
        serviceClient
          .from("hippocampus_messages")
          .delete()
          .eq("owner_user_id", userId)
          .eq("id", id)
          .select("id"),
        "text_bedroom_message_delete_failed",
        "无法删除这条卧室消息"
      );
      deletedCount = rows?.length ?? 0;
    } else if (type === SOURCE_TYPES.MEMORY) {
      const rows = await requireData(
        serviceClient
          .from("hippocampus_memories")
          .delete()
          .eq("owner_user_id", userId)
          .eq("id", id)
          .select("id"),
        "text_memory_delete_failed",
        "无法删除这条海马体记忆"
      );
      deletedCount = rows?.length ?? 0;
    } else if (type === SOURCE_TYPES.HOME_EVENT) {
      const rows = await requireData(
        serviceClient
          .from("home_events")
          .delete()
          .eq("owner_user_id", userId)
          .eq("id", id)
          .select("id"),
        "text_home_event_delete_failed",
        "无法删除这条全屋活动"
      );
      deletedCount = rows?.length ?? 0;
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
  SOURCE_TYPES
};
