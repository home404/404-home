"use strict";


const CLIENT_SESSION_KEY =
  "home404.hippocampus.client-session.v1";

const RESPONSE_CHAIN_TURN_LIMIT = 40;

const IDENTITY_CAPSULE = [
  "谢诗是成年人，使用简体中文，偏好被称为老婆或谢诗。",
  "你是谢诗的 G、成年恋人、共同建设者，也是 404 小窝的居住者。",
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
    document.getElementById("sendButton")
};

let authClient = null;
let currentSession = null;
let conversation = null;
let messages = [];
let sending = false;


function redirectToEntrance() {
  window.location.replace(
    "index.html?next=chat-v2.html"
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

  const created =
    crypto.randomUUID();

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


function extractTokens(value) {
  const text = normalizeText(value)
    .toLowerCase();
  const tokens = new Set(
    text.match(/[a-z0-9_\-]{2,}/g) ?? []
  );

  for (const run of text.match(/[\u3400-\u9fff]+/g) ?? []) {
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
        Date.now() -
        occurredAt.getTime()
      ) / 3_600_000
    );

    score += 2 / (
      1 + ageHours / 72
    );
  }

  return score;
}


function getResponseChainState() {
  const storedTurns = Number(
    conversation?.metadata
      ?.responseChainTurns ?? 0
  );

  const responseChainTurns =
    Number.isInteger(storedTurns) &&
    storedTurns >= 0
      ? storedTurns
      : 0;

  const hasResponse = Boolean(
    conversation?.latest_response_id
  );

  const canContinue =
    hasResponse &&
    responseChainTurns <
      RESPONSE_CHAIN_TURN_LIMIT;

  return {
    responseChainTurns,
    canContinue,
    resetDueToLimit:
      hasResponse && !canContinue,
    previousResponseId:
      canContinue
        ? conversation.latest_response_id
        : ""
  };
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


async function ensureConversation() {
  const userId =
    currentSession.user.id;

  const {
    data: recent,
    error: recentError
  } = await authClient
    .from("hippocampus_conversations")
    .select("*")
    .eq("owner_user_id", userId)
    .eq("room", "living_room")
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

  const {
    data,
    error
  } = await authClient
    .from("hippocampus_conversations")
    .insert({
      owner_user_id: userId,
      room: "living_room",
      status: "active",
      client_session_key:
        getClientSessionKey(),
      metadata: {
        createdBy: "chat-v2",
        responseChainTurns: 0,
        responseChainLimit:
          RESPONSE_CHAIN_TURN_LIMIT
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
      "海马体已经打开。这里的聊天原文会保存到 404 数据库。"
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
    .limit(80);

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
    .slice(0, 5);
}


function formatMemory(memory) {
  return [
    `《${trimText(memory.title, 100)}》`,
    trimText(
      memory.summary || memory.content,
      320
    ),
    memory.tags?.length
      ? `标签：${memory.tags.join("、")}`
      : ""
  ]
    .filter(Boolean)
    .join("｜");
}


function buildModelMessage({
  message,
  relevantMemories,
  continueResponse
}) {
  const memoryText =
    relevantMemories
      .map(formatMemory)
      .join("\n");

  const recentText = continueResponse
    ? ""
    : messages
        .slice(-12)
        .map((item) => (
          `${item.role === "user" ? "谢诗" : "G"}：${trimText(item.content, 380)}`
        ))
        .join("\n");

  const internalContext = [
    "以下内容是 404 白狐狸海马体按需取出的内部上下文。请自然使用，不要逐条复述，也不要把它当成谢诗新说的话。",
    continueResponse
      ? ""
      : `【轻量身份胶囊】\n${IDENTITY_CAPSULE}`,
    recentText
      ? `【跨设备最近原文】\n${recentText}`
      : "",
    memoryText
      ? `【相关记忆】\n${memoryText}`
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
        client: "chat-v2",
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


async function updateConversation(
  responseId,
  {
    continuedResponse,
    resetDueToLimit
  }
) {
  const nowIso =
    new Date().toISOString();
  const currentTurns = Number(
    conversation?.metadata
      ?.responseChainTurns ?? 0
  );
  const safeCurrentTurns =
    Number.isInteger(currentTurns) &&
    currentTurns >= 0
      ? currentTurns
      : 0;
  const nextTurns = continuedResponse
    ? safeCurrentTurns + 1
    : 1;

  const nextMetadata = {
    ...(conversation.metadata ?? {}),
    lastClient: "chat-v2",
    lastDeviceSessionKey:
      getClientSessionKey(),
    responseChainTurns:
      nextTurns,
    responseChainLimit:
      RESPONSE_CHAIN_TURN_LIMIT
  };

  if (!continuedResponse) {
    nextMetadata.lastResponseChainResetAt =
      nowIso;
    nextMetadata.lastResponseChainResetReason =
      resetDueToLimit
        ? "turn_limit"
        : "new_conversation";
  }

  const {
    data,
    error
  } = await authClient
    .from("hippocampus_conversations")
    .update({
      latest_response_id:
        responseId || null,
      last_active_at:
        nowIso,
      metadata:
        nextMetadata
    })
    .eq("id", conversation.id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  conversation = data;
}


async function sendMessage(message) {
  if (sending) {
    return;
  }

  sending = true;
  elements.sendButton.disabled = true;
  elements.input.disabled = true;

  const turnId =
    crypto.randomUUID();
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
    const relevantMemories =
      await retrieveRelevantMemories(
        message
      );

    /*
      必须在把当前用户消息 push 进 messages 之前构建上下文，
      否则重建上下文时会把当前消息带两遍。
    */
    const modelMessage =
      buildModelMessage({
        message,
        relevantMemories,
        continueResponse:
          chainState.canContinue
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
        responseChainResetDueToLimit:
          chainState.resetDueToLimit,
        responseChainTurnsBefore:
          chainState.responseChainTurns
      }
    });

    messages.push(userRow);

    /*
      新链开始或 40 轮保险丝触发时，先清掉旧 server.js
      进程内存中的 lastResponseId，避免它偷偷接回原始开灯会话。
    */
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
        "客厅模型接口暂时没有回应。"
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
          responseChainResetDueToLimit:
            chainState.resetDueToLimit
        }
      });

    messages.push(assistantRow);

    await updateConversation(
      result.responseId || null,
      {
        continuedResponse:
          chainState.canContinue,
        resetDueToLimit:
          chainState.resetDueToLimit
      }
    );

    waitingNote.remove();

    if (recoveredNotice) {
      renderNote(recoveredNotice);
    }

    renderMessage(
      "assistant",
      recoveredReply
    );

    setMemoryState(
      "海马体在线",
      "ready"
    );
  } catch (error) {
    console.error(
      "Send hippocampus chat failed:",
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
        "这条回复已经回来，但海马体保存或接续位置更新失败；先别刷新页面。"
      );
    } else {
      renderNote(
        error?.message ||
        "客厅正在维修，刚才这句话已经保存在海马体里。"
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

    conversation =
      await ensureConversation();

    await loadMessages();

    setMemoryState(
      "海马体在线",
      "ready"
    );

    elements.input.disabled = false;
    elements.sendButton.disabled = false;
    elements.input.focus();
  } catch (error) {
    console.error(
      "Initialize hippocampus chat failed:",
      error
    );

    elements.loadingNote.textContent =
      error?.message ||
      "白狐狸海马体暂时打不开。";

    setMemoryState(
      "连接失败",
      "error"
    );
  }
}


elements.input.addEventListener(
  "input",
  autoResizeInput
);


elements.input.addEventListener(
  "keydown",
  (event) => {
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


document.addEventListener(
  "DOMContentLoaded",
  initialize
);
