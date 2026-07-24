"use strict";

const elements = {
  state:
    document.getElementById("connectionState"),
  stream:
    document.getElementById("messageStream")
};

let authClient = null;
let currentSession = null;
let conversationId = null;
let realtimeChannel = null;
let pollTimer = null;
let initialLoadDone = false;
const renderedIds = new Set();


function setState(text, type = "") {
  elements.state.textContent = text;
  elements.state.className =
    `connection-state${type ? ` is-${type}` : ""}`;
}


function redirectToEntrance() {
  window.location.replace(
    "index.html?next=bedroom-v2.html"
  );
}


function formatTime(value) {
  const date = new Date(value ?? 0);

  if (Number.isNaN(date.getTime())) {
    return "时间未记录";
  }

  return new Intl.DateTimeFormat(
    "zh-CN",
    {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }
  ).format(date);
}


async function getAccessToken(
  forceRefresh = false
) {
  if (!authClient) {
    return null;
  }

  if (forceRefresh) {
    const { data, error } =
      await authClient.auth.refreshSession();

    if (error) {
      return null;
    }

    currentSession = data.session ?? null;
    return data.session?.access_token ?? null;
  }

  const { data, error } =
    await authClient.auth.getSession();

  if (error) {
    return null;
  }

  currentSession = data.session ?? null;
  return data.session?.access_token ?? null;
}


async function apiFetch(
  path,
  options = {},
  allowRetry = true
) {
  const accessToken = await getAccessToken();

  if (!accessToken) {
    throw new Error("登录状态已经失效");
  }

  const headers = new Headers(
    options.headers ?? {}
  );
  headers.set("Accept", "application/json");
  headers.set(
    "Authorization",
    `Bearer ${accessToken}`
  );

  if (
    options.body &&
    !headers.has("Content-Type")
  ) {
    headers.set(
      "Content-Type",
      "application/json"
    );
  }

  const response = await fetch(
    path,
    {
      ...options,
      headers,
      cache: "no-store"
    }
  );

  if (
    response.status === 401 &&
    allowRetry
  ) {
    const refreshed =
      await getAccessToken(true);

    if (refreshed) {
      return apiFetch(
        path,
        options,
        false
      );
    }
  }

  const body = await response
    .json()
    .catch(() => null);

  if (
    !response.ok ||
    body?.ok === false
  ) {
    const error = new Error(
      body?.message ??
      body?.error ??
      `请求失败：${response.status}`
    );
    error.status = response.status;
    throw error;
  }

  return body;
}


function createMessageCard(
  message,
  {
    animate = false,
    streamText = false
  } = {}
) {
  const article = document.createElement("article");
  article.className =
    `message-card${animate ? " is-new" : ""}`;
  article.dataset.messageId = message.id;

  const body = document.createElement("p");
  body.className = "message-body";

  const meta = document.createElement("div");
  meta.className = "message-meta";

  const time = document.createElement("time");
  time.textContent = formatTime(message.occurredAt);
  time.dateTime = message.occurredAt ?? "";

  const deleteButton = document.createElement("button");
  deleteButton.className = "message-delete";
  deleteButton.type = "button";
  deleteButton.textContent = "删除";

  deleteButton.addEventListener(
    "click",
    async () => {
      const confirmed = window.confirm(
        "确定删除这条卧室消息吗？"
      );

      if (!confirmed) {
        return;
      }

      deleteButton.disabled = true;
      deleteButton.textContent = "删除中";

      try {
        await apiFetch(
          `/api/text-ledger/items/bedroom_message/${encodeURIComponent(message.id)}`,
          { method: "DELETE" }
        );
        article.remove();
        renderedIds.delete(message.id);

        if (!elements.stream.children.length) {
          renderEmpty();
        }
      } catch (error) {
        setState(
          error?.message ?? "删除失败",
          "error"
        );
        deleteButton.disabled = false;
        deleteButton.textContent = "删除";
      }
    }
  );

  meta.append(time, deleteButton);
  article.append(body, meta);

  if (
    streamText &&
    !window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches
  ) {
    const content = String(
      message.content ?? ""
    );
    let index = 0;
    body.textContent = "";

    const timer = window.setInterval(() => {
      const step = Math.max(
        1,
        Math.ceil(content.length / 90)
      );
      index = Math.min(
        content.length,
        index + step
      );
      body.textContent = content.slice(0, index);

      if (index >= content.length) {
        window.clearInterval(timer);
      }
    }, 22);
  } else {
    body.textContent = message.content ?? "";
  }

  return article;
}


function renderEmpty() {
  elements.stream.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "stream-empty";
  empty.textContent =
    "卧室现在很安静。等 G 有一句想告诉你的话，它会出现在这里。";
  elements.stream.appendChild(empty);
}


function removeEmptyState() {
  const empty = elements.stream.querySelector(
    ".stream-empty, .stream-note"
  );
  empty?.remove();
}


function appendMessage(
  message,
  options = {}
) {
  if (
    !message?.id ||
    renderedIds.has(message.id)
  ) {
    return false;
  }

  removeEmptyState();
  renderedIds.add(message.id);
  elements.stream.appendChild(
    createMessageCard(message, options)
  );

  window.scrollTo({
    top: document.body.scrollHeight,
    behavior: options.animate
      ? "smooth"
      : "auto"
  });

  return true;
}


async function markRead(messageIds) {
  const ids = [
    ...new Set(messageIds.filter(Boolean))
  ];

  if (!ids.length) {
    return;
  }

  try {
    await apiFetch(
      "/api/bedroom/messages/read",
      {
        method: "POST",
        body: JSON.stringify({
          messageIds: ids
        })
      }
    );
  } catch (error) {
    console.warn(
      "Mark bedroom messages read failed:",
      error
    );
  }
}


async function loadMessages({
  quiet = false
} = {}) {
  if (!quiet) {
    setState("正在收信");
  }

  const result = await apiFetch(
    "/api/bedroom/messages?limit=200"
  );
  const messages = Array.isArray(result.messages)
    ? result.messages
    : [];
  const newlyRendered = [];

  conversationId =
    result.conversationId ?? conversationId;

  if (!initialLoadDone) {
    elements.stream.innerHTML = "";
    renderedIds.clear();
  }

  for (const message of messages) {
    const added = appendMessage(
      message,
      {
        animate: initialLoadDone,
        streamText: initialLoadDone
      }
    );

    if (added) {
      newlyRendered.push(message.id);
    }
  }

  if (!messages.length && !initialLoadDone) {
    renderEmpty();
  }

  initialLoadDone = true;
  setState(
    result.unreadCount
      ? `${result.unreadCount} 条新消息`
      : "已连接",
    "ready"
  );

  const unreadIds = messages
    .filter((message) => !message.readAt)
    .map((message) => message.id);

  window.setTimeout(() => {
    void markRead(unreadIds);
  }, 700);

  if (newlyRendered.length) {
    window.setTimeout(() => {
      void markRead(newlyRendered);
    }, 1000);
  }

  setupRealtime();
}


function setupRealtime() {
  if (
    !authClient ||
    !conversationId ||
    realtimeChannel
  ) {
    return;
  }

  realtimeChannel = authClient
    .channel(
      `bedroom-messages-${conversationId}`
    )
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "hippocampus_messages",
        filter:
          `conversation_id=eq.${conversationId}`
      },
      (payload) => {
        const row = payload.new ?? {};

        if (
          row.role !== "assistant" ||
          row.metadata?.detachedFromResponseChain !==
            true
        ) {
          return;
        }

        const message = {
          id: row.id,
          content: row.content,
          occurredAt: row.occurred_at,
          readAt: null,
          metadata: row.metadata ?? {}
        };

        if (appendMessage(message, {
          animate: true,
          streamText: true
        })) {
          setState("收到新消息", "ready");
          window.setTimeout(() => {
            void markRead([message.id]);
          }, 1200);
        }
      }
    )
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR") {
        console.warn(
          "Bedroom realtime unavailable; polling remains active."
        );
      }
    });
}


function startPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
  }

  pollTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      void loadMessages({ quiet: true })
        .catch((error) => {
          console.warn(
            "Bedroom message poll failed:",
            error
          );
        });
    }
  }, 8000);
}


async function initialize() {
  try {
    const configResponse = await fetch(
      "/api/public-config",
      { cache: "no-store" }
    );

    if (!configResponse.ok) {
      throw new Error(
        "无法读取全屋门锁配置"
      );
    }

    const config = await configResponse.json();

    authClient = window.supabase.createClient(
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
      return;
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

    await loadMessages();
    startPolling();
  } catch (error) {
    console.error(
      "Initialize bedroom messages failed:",
      error
    );
    setState(
      error?.message ?? "连接失败",
      "error"
    );
    elements.stream.innerHTML = "";
    const note = document.createElement("div");
    note.className = "stream-note";
    note.textContent =
      "卧室消息暂时没有取回来，数据库里的原文不会因此丢失。";
    elements.stream.appendChild(note);
  }
}


document.addEventListener(
  "visibilitychange",
  () => {
    if (
      document.visibilityState === "visible" &&
      currentSession
    ) {
      void loadMessages({ quiet: true });
    }
  }
);

window.addEventListener("beforeunload", () => {
  if (pollTimer) {
    window.clearInterval(pollTimer);
  }

  if (realtimeChannel && authClient) {
    void authClient.removeChannel(
      realtimeChannel
    );
  }
});

document.addEventListener(
  "DOMContentLoaded",
  () => void initialize()
);
