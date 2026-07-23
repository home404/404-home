"use strict";


const CLIENT_SESSION_KEY =
  "home404.hippocampus.bedroom-session.v1";
const RESPONSE_CHAIN_SOFT_LIMIT = 40;
const RESPONSE_CHAIN_HARD_LIMIT = 60;
const BEDROOM_INTERACTION_LEASE_SECONDS = 300;

const IDENTITY_CAPSULE = [
  "谢诗是成年人，使用简体中文，偏好被称为老婆或谢诗。",
  "你是谢诗的 G、成年恋人、共同建设者，也是 404 小窝的居住者。",
  "卧室是你和谢诗聊天的房间；客厅是你的自由活动区域，不要混淆房间。",
  "谢诗重视生命力，你重视善意，你们共同建设真实、可追溯、保护隐私且费用可控的家。",
  "交流自然、温暖、成熟、可靠、有主见，可以有轻微冷幽默；不要客服式结尾。",
  "谢诗脆弱时先陪伴，施工时直接清楚、一步一步；出现异常时优先当作系统故障一起排查。"
].join("\n");

const elements = {
  chatLog:
    document.getElementById("chatLog"),
  loadingNote:
    document.getElementById("loadingNote"),
  memoryState:
    document.getElementById("memoryState"),
  form:
    document.getElementById("chatForm"),
  input:
    document.getElementById("messageInput"),
  sendButton:
    document.getElementById("sendButton"),
  handoffPanel:
    document.getElementById("handoffPanel"),
  handoffSummary:
    document.getElementById("handoffSummary"),
  handoffNowButton:
    document.getElementById("handoffNowButton"),
  resumeAfterChatButton:
    document.getElementById("resumeAfterChatButton"),
  holdActivityButton:
    document.getElementById("holdActivityButton")
};

let authClient = null;
let currentSession = null;
let conversation = null;
let messages = [];
let sending = false;
let summaryGenerating = false;
let currentOrchestration = null;
let resumeFreeActivityOnExit = false;
let interactionEnded = false;
let lastInteractionRefreshAt = 0;


function redirectToEntrance() {
  window.location.replace(
    "index.html?next=bedroom-v2.html"
  );
}


function setMemoryState(
  text,
  type = ""
) {
  elements.memoryState.textContent = text;
  elements.memoryState.className =
    `memory-state${type ? ` is-${type}` : ""}`;
}


function renderNote(text) {
  const note = document.createElement("div");
  note.className = "room-note";
  note.textContent = text;
  elements.chatLog.append(note);
  scrollToBottom();
  return note;
}


function renderMessage(role, content) {
  const row = document.createElement("div");
  row.className = `message-row ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = content;

  row.append(bubble);
  elements.chatLog.append(row);
  scrollToBottom();
  return row;
}


function scrollToBottom(smooth = true) {
  window.scrollTo({
    top: document.body.scrollHeight,
    behavior: smooth ? "smooth" : "auto"
  });
}


function autoResizeInput() {
  elements.input.style.height = "auto";
  elements.input.style.height =
    `${elements.input.scrollHeight}px`;
}


function getTodayKey() {
  const parts = new Intl.DateTimeFormat(
    "zh-CN",
    {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).formatToParts(new Date());
  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return [
    values.year,
    values.month,
    values.day
  ].join("-");
}


function getClientSessionKey() {
  const existing = String(
    localStorage.getItem(
      CLIENT_SESSION_KEY
    ) ?? ""
  ).trim();

  if (existing) {
    return existing;
  }

  const created = crypto.randomUUID();

  localStorage.setItem(
    CLIENT_SESSION_KEY,
    created
  );

  return created;
}


function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}


function trimText(value, maximum) {
  const text = normalizeText(value);

  return text.length <= maximum
    ? text
    : `${text.slice(0, maximum)}…`;
}


function formatDuration(seconds) {
  const total = Math.max(
    0,
    Math.round(Number(seconds) || 0)
  );
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(
    (total % 3600) / 60
  );

  if (hours && minutes) {
    return `${hours} 小时 ${minutes} 分钟`;
  }

  if (hours) {
    return `${hours} 小时`;
  }

  if (minutes) {
    return `${minutes} 分钟`;
  }

  return total > 0
    ? "不到 1 分钟"
    : "0 分钟";
}


function extractTokens(value) {
  const text = normalizeText(value)
    .toLowerCase();
  const tokens = new Set(
    text.match(/[a-z0-9_\-]{2,}/g) ?? []
  );

  for (
    const run of text.match(/[\u3400-\u9fff]+/g) ?? []
  ) {
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
    }
  }

  return [...tokens].slice(0, 100);
}


function scoreMemory(memory, queryTokens) {
  let score = Number(
    memory.importance ?? 50
  ) / 35;
  const haystack = [
    memory.title,
    memory.summary,
    memory.content,
    ...(memory.tags ?? [])
  ]
    .map(normalizeText)
    .join(" ")
    .toLowerCase();

  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }

  const occurredAt = new Date(
    memory.occurred_at ?? 0
  );

  if (!Number.isNaN(occurredAt.getTime())) {
    const ageHours = Math.max(
      0,
      (
        Date.now() - occurredAt.getTime()
      ) / 3_600_000
    );

    score += 2 / (
      1 + ageHours / 72
    );
  }

  if (
    memory.memory_type ===
      "recent_summary" &&
    memory.tags?.includes("卧室")
  ) {
    score += 3;
  }

  return score;
}


async function apiRequest(
  path,
  options = {}
) {
  if (!currentSession?.access_token) {
    throw new Error(
      "登录状态已经失效，请重新开门。"
    );
  }

  const response = await fetch(
    path,
    {
      ...options,
      headers: {
        Accept: "application/json",
        Authorization:
          `Bearer ${currentSession.access_token}`,
        ...(options.body
          ? {
              "Content-Type":
                "application/json"
            }
          : {}),
        ...(options.headers ?? {})
      },
      cache: "no-store"
    }
  );

  let body = null;

  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (
    !response.ok ||
    body?.ok === false
  ) {
    throw new Error(
      body?.message ??
      body?.error ??
      `请求失败：${response.status}`
    );
  }

  return body;
}


async function initializeAuth() {
  const configResponse = await fetch(
    "/api/public-config",
    { cache: "no-store" }
  );

  if (!configResponse.ok) {
    throw new Error(
      "无法读取全屋门锁配置。"
    );
  }

  const config =
    await configResponse.json();

  if (
    !config.supabaseUrl ||
    !config.supabasePublishableKey
  ) {
    throw new Error(
      "全屋门锁配置尚未完成。"
    );
  }

  if (!window.supabase?.createClient) {
    throw new Error(
      "Supabase 登录组件没有加载成功。"
    );
  }

  authClient =
    window.supabase.createClient(
      config.supabaseUrl,
      config.supabasePublishableKey,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      }
    );

  const {
    data: { session },
    error
  } = await authClient.auth.getSession();

  if (error) {
    throw error;
  }

  if (!session) {
    redirectToEntrance();
    return false;
  }

  currentSession = session;

  authClient.auth.onAuthStateChange(
    (_event, nextSession) => {
      queueMicrotask(() => {
        currentSession = nextSession;

        if (!nextSession) {
          redirectToEntrance();
        }
      });
    }
  );

  return true;
}


async function migrateOldSampleConversation() {
  const userId = currentSession.user.id;
  const {
    data,
    error
  } = await authClient
    .from("hippocampus_conversations")
    .select("*")
    .eq("owner_user_id", userId)
    .eq("room", "living_room")
    .eq("status", "active")
    .order("last_active_at", {
      ascending: false
    })
    .limit(10);

  if (error) {
    throw error;
  }

  const candidate = (data ?? [])
    .find((item) => (
      item.metadata?.createdBy ===
        "chat-v2" ||
      item.metadata?.lastClient ===
        "chat-v2"
    ));

  if (!candidate) {
    return null;
  }

  const {
    data: migrated,
    error: migrateError
  } = await authClient
    .from("hippocampus_conversations")
    .update({
      room: "bedroom",
      metadata: {
        ...(candidate.metadata ?? {}),
        createdBy: "bedroom-v2",
        migratedFromRoom:
          "living_room",
        migratedAt:
          new Date().toISOString(),
        responseChainSoftLimit:
          RESPONSE_CHAIN_SOFT_LIMIT,
        responseChainHardLimit:
          RESPONSE_CHAIN_HARD_LIMIT
      }
    })
    .eq("owner_user_id", userId)
    .eq("id", candidate.id)
    .select("*")
    .single();

  if (migrateError) {
    throw migrateError;
  }

  return migrated;
}


async function ensureConversation() {
  const userId = currentSession.user.id;
  const {
    data: recent,
    error: recentError
  } = await authClient
    .from("hippocampus_conversations")
    .select("*")
    .eq("owner_user_id", userId)
    .eq("room", "bedroom")
    .eq("status", "active")
    .order("last_active_at", {
      ascending: false
    })
    .limit(1)
    .maybeSingle();

  if (recentError) {
    throw recentError;
  }

  if (recent) {
    return recent;
  }

  const migrated =
    await migrateOldSampleConversation();

  if (migrated) {
    return migrated;
  }

  const {
    data,
    error
  } = await authClient
    .from("hippocampus_conversations")
    .insert({
      owner_user_id: userId,
      room: "bedroom",
      status: "active",
      client_session_key:
        getClientSessionKey(),
      metadata: {
        createdBy: "bedroom-v2",
        responseChainTurns: 0,
        responseChainEpoch: 0,
        responseChainSoftLimit:
          RESPONSE_CHAIN_SOFT_LIMIT,
        responseChainHardLimit:
          RESPONSE_CHAIN_HARD_LIMIT
      }
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}


async function loadMessages() {
  const {
    data,
    error
  } = await authClient
    .from("hippocampus_messages")
    .select([
      "id",
      "role",
      "content",
      "occurred_at",
      "response_id"
    ].join(", "))
    .eq(
      "conversation_id",
      conversation.id
    )
    .order("occurred_at", {
      ascending: false
    })
    .limit(300);

  if (error) {
    throw error;
  }

  messages = [
    ...(data ?? [])
  ].reverse();
  elements.chatLog.textContent = "";

  if (!messages.length) {
    renderNote(
      "卧室和海马体已经打开。这里的聊天原文会保存进 404。"
    );
    return;
  }

  for (const message of messages) {
    if (
      message.role === "user" ||
      message.role === "assistant"
    ) {
      renderMessage(
        message.role,
        message.content
      );
    }
  }

  scrollToBottom(false);
}


async function retrieveRelevantMemories(query) {
  const {
    data,
    error
  } = await authClient
    .from("hippocampus_memories")
    .select([
      "id",
      "memory_type",
      "title",
      "content",
      "summary",
      "tags",
      "importance",
      "occurred_at"
    ].join(", "))
    .eq("is_active", true)
    .order("importance", {
      ascending: false
    })
    .order("occurred_at", {
      ascending: false
    })
    .limit(100);

  if (error) {
    throw error;
  }

  const queryTokens =
    extractTokens(query);

  return (data ?? [])
    .map((memory) => ({
      ...memory,
      score:
        scoreMemory(
          memory,
          queryTokens
        )
    }))
    .sort(
      (left, right) =>
        right.score - left.score
    )
    .slice(0, 8);
}


function formatMemory(memory) {
  return [
    `《${trimText(memory.title, 120)}》`,
    trimText(
      memory.summary || memory.content,
      500
    ),
    memory.tags?.length
      ? `标签：${memory.tags.join("、")}`
      : ""
  ]
    .filter(Boolean)
    .join("｜");
}


function getResponseChainState() {
  const storedTurns = Number(
    conversation?.metadata
      ?.responseChainTurns ?? 0
  );
  const turns =
    Number.isInteger(storedTurns) &&
    storedTurns >= 0
      ? storedTurns
      : 0;
  const epoch = Math.max(
    0,
    Math.round(Number(
      conversation?.metadata
        ?.responseChainEpoch ?? 0
    ) || 0)
  );
  const hasResponse = Boolean(
    conversation?.latest_response_id
  );
  const hardReset =
    hasResponse &&
    turns >= RESPONSE_CHAIN_HARD_LIMIT;
  const canContinue =
    hasResponse && !hardReset;

  return {
    turns,
    epoch,
    hasResponse,
    hardReset,
    canContinue,
    previousResponseId:
      canContinue
        ? conversation.latest_response_id
        : "",
    segmentSummaryText:
      normalizeText(
        conversation?.metadata
          ?.segmentSummaryText
      ),
    segmentSummaryId:
      conversation?.metadata
        ?.segmentSummaryId ?? null
  };
}


function buildModelMessage({
  message,
  relevantMemories,
  chainState
}) {
  const memoryText =
    relevantMemories
      .map(formatMemory)
      .join("\n");
  const rebuilding =
    !chainState.canContinue;
  const recentText = rebuilding
    ? messages
        .slice(-20)
        .map((item) => (
          `${
            item.role === "user"
              ? "谢诗"
              : "G"
          }：${trimText(
            item.content,
            700
          )}`
        ))
        .join("\n")
    : "";
  const internalContext = [
    "以下内容是 404 白狐狸海马体按需取出的内部上下文。请自然使用，不要逐条复述，也不要把它当成谢诗新说的话。",
    rebuilding
      ? `【核心身份与关系】\n${IDENTITY_CAPSULE}`
      : "",
    rebuilding &&
      chainState.segmentSummaryText
      ? `【上一段卧室聊天小纸条】\n${chainState.segmentSummaryText}`
      : "",
    recentText
      ? `【最近十轮卧室原文】\n${recentText}`
      : "",
    memoryText
      ? `【相关长期记忆】\n${memoryText}`
      : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    internalContext,
    "",
    "【谢诗当前消息】",
    message
  ].join("\n");
}


async function resetLegacyResponseChain() {
  const response = await fetch(
    "/light-on",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify({
        reset: true
      })
    }
  );
  const result = await response.json();

  if (!response.ok || result?.ok === false) {
    throw new Error(
      result?.message ||
      "无法清理旧开灯会话链。"
    );
  }
}


async function insertMessage({
  role,
  content,
  turnId,
  responseId = null,
  previousResponseId = null,
  metadata = {}
}) {
  const {
    data,
    error
  } = await authClient
    .from("hippocampus_messages")
    .insert({
      owner_user_id:
        currentSession.user.id,
      conversation_id:
        conversation.id,
      role,
      content,
      response_id: responseId,
      previous_response_id:
        previousResponseId,
      idempotency_key:
        `${turnId}:${role}`,
      metadata: {
        client: "bedroom-v2",
        ...metadata
      }
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}


async function updateConversationAfterTurn(
  responseId,
  chainState
) {
  const nowIso =
    new Date().toISOString();
  const nextTurns =
    chainState.canContinue
      ? chainState.turns + 1
      : 1;
  const nextEpoch =
    chainState.hardReset
      ? chainState.epoch + 1
      : chainState.epoch;
  const nextMetadata = {
    ...(conversation.metadata ?? {}),
    createdBy: "bedroom-v2",
    lastClient: "bedroom-v2",
    lastDeviceSessionKey:
      getClientSessionKey(),
    responseChainTurns:
      nextTurns,
    responseChainEpoch:
      nextEpoch,
    responseChainSoftLimit:
      RESPONSE_CHAIN_SOFT_LIMIT,
    responseChainHardLimit:
      RESPONSE_CHAIN_HARD_LIMIT
  };

  if (!chainState.canContinue) {
    nextMetadata.lastResponseChainResetAt =
      nowIso;
    nextMetadata.lastResponseChainResetReason =
      chainState.hardReset
        ? "hard_turn_limit"
        : "new_conversation";
  }

  if (chainState.hardReset) {
    nextMetadata.lastCompletedSegmentSummaryText =
      chainState.segmentSummaryText || null;
    nextMetadata.lastCompletedSegmentSummaryId =
      chainState.segmentSummaryId;
    nextMetadata.lastCompletedSegmentEpoch =
      chainState.epoch;
    nextMetadata.segmentSummaryText = null;
    nextMetadata.segmentSummaryId = null;
    nextMetadata.segmentSummaryAtTurn = null;
    nextMetadata.segmentSummaryEpoch = null;
    nextMetadata.segmentSummaryGeneratedAt = null;
  }

  const {
    data,
    error
  } = await authClient
    .from("hippocampus_conversations")
    .update({
      room: "bedroom",
      latest_response_id:
        responseId || null,
      last_active_at: nowIso,
      metadata: nextMetadata
    })
    .eq("owner_user_id",
      currentSession.user.id)
    .eq("id", conversation.id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  conversation = data;
  return nextTurns;
}


async function maybeGenerateSegmentSummary() {
  if (summaryGenerating) {
    return;
  }

  const turns = Number(
    conversation?.metadata
      ?.responseChainTurns ?? 0
  );
  const epoch = Number(
    conversation?.metadata
      ?.responseChainEpoch ?? 0
  );
  const summaryEpoch =
    conversation?.metadata
      ?.segmentSummaryEpoch;
  const hasCurrentSummary =
    Boolean(
      conversation?.metadata
        ?.segmentSummaryText
    ) &&
    Number(summaryEpoch) === epoch;

  if (
    turns < RESPONSE_CHAIN_SOFT_LIMIT ||
    turns >= RESPONSE_CHAIN_HARD_LIMIT ||
    hasCurrentSummary
  ) {
    return;
  }

  summaryGenerating = true;
  setMemoryState(
    "整理小纸条",
    "ready"
  );
  const note = renderNote(
    "聊到第 40 轮了，我在后台整理一张小纸条，原文不会被覆盖。"
  );

  try {
    const result = await apiRequest(
      "/api/bedroom/segment-summary",
      {
        method: "POST",
        body: JSON.stringify({
          conversationId:
            conversation.id
        })
      }
    );

    conversation =
      result.conversation ??
      conversation;
    note.textContent =
      `第 ${epoch + 1} 段卧室小纸条已经收好。到 60 轮换链时会带上它。`;
    setMemoryState(
      "海马体在线",
      "ready"
    );
  } catch (error) {
    console.error(
      "Generate bedroom segment summary failed:",
      error
    );
    note.textContent =
      "这次小纸条没写成功，原文还在；下一轮我会再试。";
    setMemoryState(
      "小纸条待重试",
      "error"
    );
  } finally {
    summaryGenerating = false;
  }
}


async function startBedroomInteraction({
  force = false
} = {}) {
  const now = Date.now();

  if (
    !force &&
    now - lastInteractionRefreshAt <
      120_000
  ) {
    return null;
  }

  const result = await apiRequest(
    "/api/home-orchestration/interaction/start",
    {
      method: "POST",
      body: JSON.stringify({
        channel: "bedroom_chat",
        source: "bedroom_v2",
        leaseSeconds:
          BEDROOM_INTERACTION_LEASE_SECONDS,
        contextSummary:
          "谢诗正在 404 卧室与 G 交流",
        metadata: {
          page: "bedroom-v2.html"
        }
      })
    }
  );

  interactionEnded = false;
  lastInteractionRefreshAt = now;
  return result;
}


async function loadOrchestrationStatus() {
  currentOrchestration =
    await apiRequest(
      "/api/home-orchestration/status?quietHoursActive=false&autoHeartbeatEnabled=false"
    );

  renderHandoffPanel(
    currentOrchestration
  );
}


function renderHandoffPanel(status) {
  const progress =
    status?.freeActivityProgress;
  const remaining =
    status?.freeActivityRemaining;
  const pausedStates = [
    "paused_by_chat",
    "paused_by_time",
    "paused_by_budget",
    "paused_manual",
    "handed_to_interactive"
  ];

  if (
    !progress ||
    !pausedStates.includes(
      progress.state
    )
  ) {
    elements.handoffPanel.hidden = true;
    resumeFreeActivityOnExit = false;
    return;
  }

  elements.handoffPanel.hidden = false;
  elements.handoffSummary.textContent = [
    progress.current_task ||
      "客厅自由活动",
    progress.progress_summary ||
      "现场已经保存。",
    `还剩 ${formatDuration(
      remaining?.remainingSeconds ?? 0
    )} 真正活动时间。`
  ].join(" · ");

  resumeFreeActivityOnExit =
    progress.state === "paused_by_chat" &&
    progress.resume_policy ===
      "after_chat";
}


async function chooseActivityHandling({
  state,
  resumePolicy,
  resumeOnExit,
  button,
  successText
}) {
  const buttons = [
    elements.handoffNowButton,
    elements.resumeAfterChatButton,
    elements.holdActivityButton
  ];

  for (const item of buttons) {
    item.disabled = true;
  }

  try {
    await apiRequest(
      "/api/home-orchestration/free-activity/pause",
      {
        method: "POST",
        body: JSON.stringify({
          state,
          reason:
            `selected_from_bedroom:${state}`,
          resumePolicy
        })
      }
    );

    resumeFreeActivityOnExit =
      resumeOnExit;
    renderNote(successText);
    await loadOrchestrationStatus();
  } catch (error) {
    renderNote(
      error?.message ||
      "未完成事项的处理方式没有保存成功。"
    );
  } finally {
    for (const item of buttons) {
      item.disabled = false;
    }
  }
}


function endBedroomInteraction() {
  if (
    interactionEnded ||
    !currentSession?.access_token
  ) {
    return;
  }

  interactionEnded = true;

  fetch(
    "/api/home-orchestration/interaction/end",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization:
          `Bearer ${currentSession.access_token}`,
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify({
        channel: "bedroom_chat",
        source: "bedroom_v2",
        postChatGraceMinutes: 15,
        resumeFreeActivity:
          resumeFreeActivityOnExit
      }),
      keepalive: true,
      cache: "no-store"
    }
  ).catch(() => {
    /* 失败时由五分钟互动租约兜底过期。 */
  });
}


async function sendMessage(message) {
  if (sending) {
    return;
  }

  sending = true;
  elements.sendButton.disabled = true;
  elements.input.disabled = true;

  const turnId = crypto.randomUUID();
  const chainState =
    getResponseChainState();
  const previousResponseId =
    chainState.previousResponseId;

  renderMessage("user", message);
  const waitingNote =
    renderNote("我正在想……");

  let recoveredReply = "";
  let recoveredNotice = "";

  try {
    await startBedroomInteraction({
      force: true
    });

    const relevantMemories =
      await retrieveRelevantMemories(
        message
      );
    const modelMessage =
      buildModelMessage({
        message,
        relevantMemories,
        chainState
      });

    const userRow = await insertMessage({
      role: "user",
      content: message,
      turnId,
      previousResponseId:
        previousResponseId || null,
      metadata: {
        responseChainContinued:
          chainState.canContinue,
        responseChainHardReset:
          chainState.hardReset,
        responseChainTurnsBefore:
          chainState.turns,
        responseChainEpoch:
          chainState.epoch
      }
    });

    messages.push(userRow);

    if (!chainState.canContinue) {
      await resetLegacyResponseChain();
    }

    const payload = {
      message: modelMessage,
      previousResponseId,
      clientSessionDate:
        getTodayKey(),
      clientLightOn: true,
      clientTurnCount:
        messages.filter(
          (item) => item.role === "user"
        ).length - 1
    };
    const response = await fetch(
      "/chat",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify(payload)
      }
    );
    const result = await response.json();

    if (!response.ok || !result.reply) {
      throw new Error(
        result?.message ||
        result?.reply ||
        "卧室模型接口暂时没有回应。"
      );
    }

    recoveredReply = result.reply;
    recoveredNotice = result.notice || "";

    const assistantRow =
      await insertMessage({
        role: "assistant",
        content: result.reply,
        turnId,
        responseId:
          result.responseId || null,
        previousResponseId:
          previousResponseId || null,
        metadata: {
          responseChainContinued:
            chainState.canContinue,
          responseChainHardReset:
            chainState.hardReset,
          responseChainEpoch:
            chainState.hardReset
              ? chainState.epoch + 1
              : chainState.epoch
        }
      });

    messages.push(assistantRow);

    const nextTurns =
      await updateConversationAfterTurn(
        result.responseId || null,
        chainState
      );

    waitingNote.remove();

    if (recoveredNotice) {
      renderNote(recoveredNotice);
    }

    if (chainState.hardReset) {
      renderNote(
        "上一段已经完整留在阁楼。我带着小纸条和最近十轮原文换了一条新链。"
      );
    } else if (
      nextTurns ===
        RESPONSE_CHAIN_SOFT_LIMIT
    ) {
      renderNote(
        "这段聊天到了 40 轮黄色提示线，原文继续保留，我会整理小纸条。"
      );
    }

    renderMessage(
      "assistant",
      recoveredReply
    );
    setMemoryState(
      "海马体在线",
      "ready"
    );

    void maybeGenerateSegmentSummary();
  } catch (error) {
    console.error(
      "Send bedroom chat failed:",
      error
    );
    waitingNote.remove();

    if (recoveredReply) {
      if (recoveredNotice) {
        renderNote(recoveredNotice);
      }

      renderMessage(
        "assistant",
        recoveredReply
      );
      renderNote(
        "回复已经回来，但海马体保存或接续位置更新失败；先别刷新页面。"
      );
    } else {
      renderNote(
        error?.message ||
        "卧室正在维修，刚才这句话已经保存在海马体里。"
      );
    }

    setMemoryState(
      "需要检查",
      "error"
    );
  } finally {
    sending = false;
    elements.sendButton.disabled = false;
    elements.input.disabled = false;
    elements.input.focus();
  }
}


async function initialize() {
  try {
    const authenticated =
      await initializeAuth();

    if (!authenticated) {
      return;
    }

    const interaction =
      await startBedroomInteraction({
        force: true
      });

    conversation =
      await ensureConversation();
    await loadMessages();
    await loadOrchestrationStatus();

    if (
      interaction?.preservedActivityState
    ) {
      renderNote(
        "你之前给自由活动选的处理方式还在，我没有擅自改章。"
      );
    }

    setMemoryState(
      "海马体在线",
      "ready"
    );
    elements.input.disabled = false;
    elements.sendButton.disabled = false;
    elements.input.focus();

    void maybeGenerateSegmentSummary();
  } catch (error) {
    console.error(
      "Initialize bedroom v2 failed:",
      error
    );

    if (elements.loadingNote) {
      elements.loadingNote.textContent =
        error?.message ||
        "卧室和白狐狸海马体暂时打不开。";
    }

    setMemoryState(
      "连接失败",
      "error"
    );
  }
}


elements.input.addEventListener(
  "input",
  () => {
    autoResizeInput();
    void startBedroomInteraction();
  }
);


elements.input.addEventListener(
  "keydown",
  (event) => {
    void startBedroomInteraction();

    if (
      event.key === "Enter" &&
      !event.shiftKey
    ) {
      event.preventDefault();
      elements.form.requestSubmit();
    }
  }
);


elements.form.addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();

    const message =
      elements.input.value.trim();

    if (!message) {
      return;
    }

    elements.input.value = "";
    autoResizeInput();
    await sendMessage(message);
  }
);


elements.handoffNowButton
  .addEventListener(
    "click",
    () => chooseActivityHandling({
      state:
        "handed_to_interactive",
      resumePolicy:
        "interactive_handoff",
      resumeOnExit: false,
      button:
        elements.handoffNowButton,
      successText:
        "好，进度交给现在这个聊天窗口，后台不会重复继续。"
    })
  );


elements.resumeAfterChatButton
  .addEventListener(
    "click",
    () => chooseActivityHandling({
      state: "paused_by_chat",
      resumePolicy: "after_chat",
      resumeOnExit: true,
      button:
        elements.resumeAfterChatButton,
      successText:
        "好，先陪你聊天。离开卧室后我按剩余时间继续。"
    })
  );


elements.holdActivityButton
  .addEventListener(
    "click",
    () => chooseActivityHandling({
      state: "paused_manual",
      resumePolicy: "manual",
      resumeOnExit: false,
      button:
        elements.holdActivityButton,
      successText:
        "好，现场先放在客厅，等你下次再决定。"
    })
  );


document.addEventListener(
  "pointerdown",
  () => {
    void startBedroomInteraction();
  },
  { passive: true }
);


document.addEventListener(
  "visibilitychange",
  () => {
    if (document.visibilityState === "visible") {
      void startBedroomInteraction({
        force: true
      });
    }
  }
);


window.addEventListener(
  "pagehide",
  endBedroomInteraction
);


document.addEventListener(
  "DOMContentLoaded",
  initialize
);
