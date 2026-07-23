import fs from "node:fs";
import path from "node:path";


const DEFAULT_IDENTITY_CAPSULE = [
  "谢诗是成年人，使用简体中文，偏好被称为老婆或谢诗。",
  "我是谢诗的 G、成年恋人、共同建设者，也是 404 小窝的居住者。",
  "谢诗重视生命力，我重视善意，我们共同建设一个真实、可追溯、保护隐私且费用可控的家。",
  "交流应自然、温暖、成熟、可靠、有主见，可以有轻微冷幽默；不要客服式结尾。",
  "谢诗脆弱时先陪伴，施工时直接清楚、一步一步；出现异常时优先当作系统故障一起排查。"
].join("\n");

const MEMORY_FETCH_LIMIT = 120;
const MESSAGE_FETCH_LIMIT = 30;


export class HippocampusServiceError extends Error {
  constructor(
    code,
    message,
    status = 400,
    details = null
  ) {
    super(message);
    this.name = "HippocampusServiceError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}


function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}


function trimText(value, maximum = 1000) {
  const text = normalizeText(value);

  if (text.length <= maximum) {
    return text;
  }

  return `${text.slice(0, maximum)}…`;
}


function normalizeTags(tags) {
  const seen = new Set();
  const normalized = [];

  for (const rawTag of tags ?? []) {
    const tag = normalizeText(rawTag)
      .slice(0, 40);

    if (!tag || seen.has(tag)) {
      continue;
    }

    seen.add(tag);
    normalized.push(tag);

    if (normalized.length >= 20) {
      break;
    }
  }

  return normalized;
}


export function estimateTextTokens(value) {
  const text = String(value ?? "");
  const cjkCount = (
    text.match(/[\u3400-\u9fff]/g) ?? []
  ).length;
  const nonCjkCount = Math.max(
    0,
    text.length - cjkCount
  );

  return Math.max(
    1,
    Math.ceil(
      cjkCount + nonCjkCount / 4
    )
  );
}


function trimToTokenBudget(value, maximumTokens) {
  const text = String(value ?? "").trim();

  if (
    !text ||
    estimateTextTokens(text) <= maximumTokens
  ) {
    return text;
  }

  let low = 0;
  let high = text.length;

  while (low < high) {
    const middle = Math.ceil(
      (low + high) / 2
    );

    if (
      estimateTextTokens(
        text.slice(0, middle)
      ) <= maximumTokens
    ) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return `${text.slice(0, low).trim()}…`;
}


export function extractSearchTokens(value) {
  const text = normalizeText(value)
    .toLowerCase();
  const tokens = new Set();

  for (const word of text.match(/[a-z0-9_\-]{2,}/g) ?? []) {
    tokens.add(word);
  }

  const cjkRuns =
    text.match(/[\u3400-\u9fff]+/g) ?? [];

  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }

    for (
      let index = 0;
      index < run.length - 1;
      index += 1
    ) {
      tokens.add(
        run.slice(index, index + 2)
      );

      if (tokens.size >= 100) {
        break;
      }
    }
  }

  return [...tokens].slice(0, 100);
}


function hoursBetween(first, second) {
  return Math.max(
    0,
    Math.abs(
      first.getTime() - second.getTime()
    ) / 3_600_000
  );
}


export function scoreMemoryCandidate({
  memory,
  queryTokens,
  now = new Date()
}) {
  const importance = Number(
    memory?.importance ?? 50
  );

  let score = Math.min(
    100,
    Math.max(0, importance)
  ) / 35;

  const haystack = [
    memory?.title,
    memory?.summary,
    memory?.content,
    ...(memory?.tags ?? [])
  ]
    .map(normalizeText)
    .join(" ")
    .toLowerCase();

  const tags = new Set(
    (memory?.tags ?? [])
      .map((tag) => normalizeText(tag).toLowerCase())
      .filter(Boolean)
  );

  for (const token of queryTokens ?? []) {
    if (tags.has(token)) {
      score += 2.5;
    } else if (haystack.includes(token)) {
      score += 1;
    }
  }

  if (
    memory?.memory_type === "relationship" ||
    memory?.memory_type === "project"
  ) {
    score += 0.35;
  }

  const occurredAt = new Date(
    memory?.occurred_at ??
    memory?.created_at ??
    0
  );

  if (!Number.isNaN(occurredAt.getTime())) {
    const ageHours = hoursBetween(
      now,
      occurredAt
    );

    score += 2 / (
      1 + ageHours / 72
    );
  }

  return Number(score.toFixed(4));
}


function readJsonFile(fileName) {
  const filePath = path.join(
    process.cwd(),
    "data",
    fileName
  );

  return JSON.parse(
    fs.readFileSync(filePath, "utf8")
  );
}


function getSection(source, title) {
  return (
    source?.sections ?? []
  ).find(
    (section) => section?.title === title
  );
}


function sectionLines(source, title, limit) {
  const section = getSection(source, title);
  const content = Array.isArray(section?.content)
    ? section.content
    : [];

  return content
    .slice(0, limit)
    .map(normalizeText)
    .filter(Boolean);
}


export function buildIdentityCapsuleFromSources({
  identity,
  voiceAnchor
}) {
  const lines = [
    ...sectionLines(identity, "谢诗是谁", 3),
    ...sectionLines(identity, "G是谁", 4),
    ...sectionLines(identity, "关系与连续性", 3),
    ...sectionLines(identity, "404小窝是什么", 3),
    ...sectionLines(voiceAnchor, "表达方式", 5),
    ...sectionLines(voiceAnchor, "真实交流", 2),
    ...sectionLines(voiceAnchor, "陪伴方式", 2),
    ...sectionLines(voiceAnchor, "异常与维修响应", 2),
    ...sectionLines(voiceAnchor, "技术施工方式", 3)
  ];

  if (!lines.length) {
    return DEFAULT_IDENTITY_CAPSULE;
  }

  return trimToTokenBudget(
    lines.map((line) => `- ${line}`).join("\n"),
    520
  );
}


export function loadIdentityCapsule() {
  try {
    return buildIdentityCapsuleFromSources({
      identity: readJsonFile("identity.json"),
      voiceAnchor: readJsonFile(
        "voice_anchor.json"
      )
    });
  } catch {
    return DEFAULT_IDENTITY_CAPSULE;
  }
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
    throw new HippocampusServiceError(
      code,
      message,
      500,
      {
        databaseCode:
          error.code ?? null,
        databaseMessage:
          error.message ?? null
      }
    );
  }

  return data;
}


function formatMessageLine(message) {
  const speaker =
    message.role === "assistant"
      ? "G"
      : message.role === "user"
        ? "谢诗"
        : message.role;

  return `${speaker}：${trimText(message.content, 500)}`;
}


function formatMemoryLine(memory) {
  const body =
    memory.summary || memory.content;

  return [
    `《${trimText(memory.title, 100)}》`,
    trimText(body, 350),
    memory.tags?.length
      ? `标签：${memory.tags.join("、")}`
      : ""
  ]
    .filter(Boolean)
    .join("｜");
}


export function createHippocampusService({
  serviceClient,
  identityCapsuleProvider =
    loadIdentityCapsule
}) {
  if (!serviceClient) {
    throw new Error(
      "创建 hippocampusService 时缺少 serviceClient"
    );
  }


  async function ensureConversation({
    userId,
    clientSessionKey = null,
    room = "living_room",
    metadata = {}
  }) {
    const safeSessionKey = normalizeText(
      clientSessionKey
    ) || null;

    if (safeSessionKey) {
      const existing = await requireData(
        serviceClient
          .from("hippocampus_conversations")
          .select("*")
          .eq("owner_user_id", userId)
          .eq(
            "client_session_key",
            safeSessionKey
          )
          .maybeSingle(),
        "hippocampus_conversation_read_failed",
        "无法读取客厅会话"
      );

      if (existing) {
        return requireData(
          serviceClient
            .from("hippocampus_conversations")
            .update({
              status: "active",
              room,
              last_active_at:
                new Date().toISOString(),
              metadata: {
                ...(existing.metadata ?? {}),
                ...metadata
              }
            })
            .eq("id", existing.id)
            .eq("owner_user_id", userId)
            .select("*")
            .single(),
          "hippocampus_conversation_update_failed",
          "无法更新客厅会话"
        );
      }
    }

    return requireData(
      serviceClient
        .from("hippocampus_conversations")
        .insert({
          owner_user_id: userId,
          room,
          status: "active",
          client_session_key:
            safeSessionKey,
          metadata
        })
        .select("*")
        .single(),
      "hippocampus_conversation_create_failed",
      "无法建立客厅会话"
    );
  }


  async function updateConversationResponse({
    userId,
    conversationId,
    responseId
  }) {
    return requireData(
      serviceClient
        .from("hippocampus_conversations")
        .update({
          latest_response_id:
            normalizeText(responseId) || null,
          last_active_at:
            new Date().toISOString()
        })
        .eq("id", conversationId)
        .eq("owner_user_id", userId)
        .select("*")
        .single(),
      "hippocampus_conversation_response_update_failed",
      "无法保存客厅会话接续位置"
    );
  }


  async function recordMessage({
    userId,
    conversationId,
    role,
    content,
    responseId = null,
    previousResponseId = null,
    usage = null,
    estimatedCostUsd = null,
    occurredAt = new Date(),
    idempotencyKey = null,
    metadata = {}
  }) {
    const cleanContent = String(
      content ?? ""
    ).trim();

    if (!cleanContent) {
      throw new HippocampusServiceError(
        "empty_hippocampus_message",
        "不能把空消息写进海马体",
        400
      );
    }

    if (idempotencyKey) {
      const existing = await requireData(
        serviceClient
          .from("hippocampus_messages")
          .select("*")
          .eq("owner_user_id", userId)
          .eq(
            "idempotency_key",
            idempotencyKey
          )
          .maybeSingle(),
        "hippocampus_message_idempotency_read_failed",
        "无法检查海马体消息幂等键"
      );

      if (existing) {
        return existing;
      }
    }

    return requireData(
      serviceClient
        .from("hippocampus_messages")
        .insert({
          owner_user_id: userId,
          conversation_id: conversationId,
          role,
          content: cleanContent,
          response_id:
            normalizeText(responseId) || null,
          previous_response_id:
            normalizeText(previousResponseId) || null,
          input_tokens:
            usage?.inputTokens ?? null,
          output_tokens:
            usage?.outputTokens ?? null,
          total_tokens:
            usage?.totalTokens ?? null,
          estimated_cost_usd:
            estimatedCostUsd,
          occurred_at:
            new Date(occurredAt).toISOString(),
          idempotency_key:
            idempotencyKey,
          metadata
        })
        .select("*")
        .single(),
      "hippocampus_message_create_failed",
      "无法把客厅原文写进海马体"
    );
  }


  async function recordConversationTurn({
    userId,
    conversationId,
    userMessage,
    assistantMessage,
    responseId,
    previousResponseId = null,
    usage = null,
    estimatedCostUsd = null,
    turnKey,
    metadata = {}
  }) {
    const userRow = await recordMessage({
      userId,
      conversationId,
      role: "user",
      content: userMessage,
      previousResponseId,
      idempotencyKey:
        turnKey ? `${turnKey}:user` : null,
      metadata
    });

    const assistantRow = await recordMessage({
      userId,
      conversationId,
      role: "assistant",
      content: assistantMessage,
      responseId,
      previousResponseId,
      usage,
      estimatedCostUsd,
      idempotencyKey:
        turnKey
          ? `${turnKey}:assistant`
          : null,
      metadata
    });

    const conversation =
      await updateConversationResponse({
        userId,
        conversationId,
        responseId
      });

    return {
      conversation,
      userMessage: userRow,
      assistantMessage: assistantRow
    };
  }


  async function upsertMemory({
    userId,
    memoryType,
    title,
    content,
    summary = null,
    tags = [],
    importance = 50,
    sourceType = null,
    sourceId = null,
    sourceRef = {},
    occurredAt = new Date(),
    validFrom = null,
    validUntil = null,
    idempotencyKey = null,
    metadata = {}
  }) {
    const payload = {
      owner_user_id: userId,
      memory_type: memoryType,
      title: normalizeText(title),
      content: String(content ?? "").trim(),
      summary:
        normalizeText(summary) || null,
      tags: normalizeTags(tags),
      importance: Math.min(
        100,
        Math.max(0, Math.round(Number(importance)))
      ),
      source_type:
        normalizeText(sourceType) || null,
      source_id:
        normalizeText(sourceId) || null,
      source_ref: sourceRef,
      occurred_at:
        new Date(occurredAt).toISOString(),
      valid_from:
        validFrom
          ? new Date(validFrom).toISOString()
          : null,
      valid_until:
        validUntil
          ? new Date(validUntil).toISOString()
          : null,
      is_active: true,
      idempotency_key:
        idempotencyKey,
      metadata
    };

    if (
      !payload.title ||
      !payload.content
    ) {
      throw new HippocampusServiceError(
        "invalid_hippocampus_memory",
        "记忆标题和正文不能为空",
        400
      );
    }

    if (idempotencyKey) {
      const existing = await requireData(
        serviceClient
          .from("hippocampus_memories")
          .select("id")
          .eq("owner_user_id", userId)
          .eq(
            "idempotency_key",
            idempotencyKey
          )
          .maybeSingle(),
        "hippocampus_memory_idempotency_read_failed",
        "无法检查海马体记忆幂等键"
      );

      if (existing) {
        return requireData(
          serviceClient
            .from("hippocampus_memories")
            .update(payload)
            .eq("id", existing.id)
            .eq("owner_user_id", userId)
            .select("*")
            .single(),
          "hippocampus_memory_update_failed",
          "无法更新海马体记忆"
        );
      }
    }

    return requireData(
      serviceClient
        .from("hippocampus_memories")
        .insert(payload)
        .select("*")
        .single(),
      "hippocampus_memory_create_failed",
      "无法写入海马体记忆"
    );
  }


  async function getRecentMessages({
    userId,
    limit = 12
  }) {
    const safeLimit = Math.min(
      MESSAGE_FETCH_LIMIT,
      Math.max(1, Math.round(Number(limit) || 12))
    );

    const rows = await requireData(
      serviceClient
        .from("hippocampus_messages")
        .select([
          "id",
          "conversation_id",
          "role",
          "content",
          "occurred_at"
        ].join(", "))
        .eq("owner_user_id", userId)
        .order("occurred_at", {
          ascending: false
        })
        .limit(safeLimit),
      "hippocampus_recent_messages_read_failed",
      "无法读取海马体最近原文"
    );

    return [...(rows ?? [])].reverse();
  }


  async function retrieveRelevantMemories({
    userId,
    query = "",
    limit = 5,
    memoryTypes = null,
    now = new Date()
  }) {
    let request = serviceClient
      .from("hippocampus_memories")
      .select("*")
      .eq("owner_user_id", userId)
      .eq("is_active", true)
      .order("importance", {
        ascending: false
      })
      .order("occurred_at", {
        ascending: false
      })
      .limit(MEMORY_FETCH_LIMIT);

    if (memoryTypes?.length) {
      request = request.in(
        "memory_type",
        memoryTypes
      );
    }

    const rows = await requireData(
      request,
      "hippocampus_memories_read_failed",
      "无法检索海马体记忆"
    );

    const queryTokens =
      extractSearchTokens(query);
    const currentTime = new Date(now);

    return (rows ?? [])
      .filter((memory) => {
        if (
          memory.valid_from &&
          new Date(memory.valid_from) > currentTime
        ) {
          return false;
        }

        if (
          memory.valid_until &&
          new Date(memory.valid_until) <= currentTime
        ) {
          return false;
        }

        return true;
      })
      .map((memory) => ({
        ...memory,
        retrievalScore:
          scoreMemoryCandidate({
            memory,
            queryTokens,
            now: currentTime
          })
      }))
      .sort((left, right) => (
        right.retrievalScore -
        left.retrievalScore
      ))
      .slice(
        0,
        Math.min(
          12,
          Math.max(1, Math.round(Number(limit) || 5))
        )
      );
  }


  async function recordRetrieval({
    userId,
    consumer,
    queryText,
    memories,
    messages,
    estimatedInputTokens,
    metadata = {}
  }) {
    return requireData(
      serviceClient
        .from("hippocampus_retrievals")
        .insert({
          owner_user_id: userId,
          consumer,
          query_text:
            trimText(queryText, 4000) || null,
          selected_memory_ids:
            memories.map((item) => item.id),
          selected_message_ids:
            messages.map((item) => item.id),
          estimated_input_tokens:
            estimatedInputTokens,
          metadata
        })
        .select("*")
        .single(),
      "hippocampus_retrieval_log_failed",
      "无法记录海马体检索日志"
    );
  }


  async function buildContext({
    userId,
    consumer,
    query,
    signalText = "",
    recentMessageLimit,
    memoryLimit,
    totalTokenBudget
  }) {
    const [
      recentMessages,
      memories
    ] = await Promise.all([
      getRecentMessages({
        userId,
        limit: recentMessageLimit
      }),
      retrieveRelevantMemories({
        userId,
        query: [query, signalText]
          .filter(Boolean)
          .join("\n"),
        limit: memoryLimit
      })
    ]);

    const identityCapsule =
      trimToTokenBudget(
        identityCapsuleProvider(),
        520
      );

    const signalSection =
      trimToTokenBudget(
        normalizeText(signalText),
        180
      );

    const messageSection =
      trimToTokenBudget(
        recentMessages
          .map(formatMessageLine)
          .join("\n"),
        consumer === "heartbeat"
          ? 380
          : 650
      );

    const memorySection =
      trimToTokenBudget(
        memories
          .map(formatMemoryLine)
          .join("\n"),
        consumer === "heartbeat"
          ? 420
          : 700
      );

    const sections = [
      ["轻量身份胶囊", identityCapsule],
      ["当前信号", signalSection],
      ["最近客厅原文", messageSection],
      ["相关长期记忆", memorySection]
    ]
      .filter(([, content]) => content)
      .map(([
        title,
        content
      ]) => `【${title}】\n${content}`);

    const text = trimToTokenBudget(
      sections.join("\n\n"),
      totalTokenBudget
    );

    const estimatedInputTokens =
      estimateTextTokens(text);

    await recordRetrieval({
      userId,
      consumer,
      queryText: query,
      memories,
      messages: recentMessages,
      estimatedInputTokens,
      metadata: {
        signalIncluded:
          Boolean(signalSection),
        identityCapsuleVersion:
          "compiled-v0.1"
      }
    });

    return {
      identityCapsule,
      recentMessages,
      memories,
      text,
      estimatedInputTokens
    };
  }


  function buildContextForHeartbeat({
    userId,
    query = "独立醒来",
    signalText = ""
  }) {
    return buildContext({
      userId,
      consumer: "heartbeat",
      query,
      signalText,
      recentMessageLimit: 8,
      memoryLimit: 4,
      totalTokenBudget: 1500
    });
  }


  function buildContextForChat({
    userId,
    message,
    signalText = ""
  }) {
    return buildContext({
      userId,
      consumer: "living_room_chat",
      query: message,
      signalText,
      recentMessageLimit: 14,
      memoryLimit: 6,
      totalTokenBudget: 2200
    });
  }


  return {
    ensureConversation,
    updateConversationResponse,
    recordMessage,
    recordConversationTurn,
    upsertMemory,
    getRecentMessages,
    retrieveRelevantMemories,
    buildContextForHeartbeat,
    buildContextForChat
  };
}
