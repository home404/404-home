"use strict";

const elements = {
  statusTitle: document.getElementById("homeStatusTitle"),
  activityList: document.getElementById("homeActivityList"),
  signOutButton: document.getElementById("homeSignOutButton")
};

const VISIBLE_ACTIVITY_TYPES = new Set([
  "heart_leave_note",
  "heart_leave_message",
  "heart_write_diary",
  "heart_reply_comment"
]);

const ACTIVITY_LABELS = {
  heart_leave_note: "留了一张纸条",
  heart_leave_message: "写了一条留言",
  heart_write_diary: "写了一篇日记",
  heart_reply_comment: "回复了一条留言"
};

const HOME_WEB_LEASE_SECONDS = 120;
const HOME_REFRESH_INTERVAL_MS = 45_000;

let authClient = null;
let currentSession = null;
let latestStatus = null;
let refreshTimer = null;
let clockTimer = null;
let refreshInFlight = false;

function redirectToEntrance(next = "home.html") {
  window.location.replace(
    `index.html?next=${encodeURIComponent(next)}`
  );
}

function formatRemaining(targetValue) {
  if (!targetValue) {
    return null;
  }

  const target = new Date(targetValue);

  if (Number.isNaN(target.getTime())) {
    return null;
  }

  const totalMinutes = Math.max(
    0,
    Math.ceil((target.getTime() - Date.now()) / 60000)
  );

  if (totalMinutes < 1) {
    return "即将结束";
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) {
    return `${hours}小时${minutes}分`;
  }

  if (hours > 0) {
    return `${hours}小时`;
  }

  return `${minutes}分钟`;
}

function isHomeWebActive(result) {
  const activeUntilValue =
    result?.presence?.metadata
      ?.homeWebActiveUntil ?? null;

  if (!activeUntilValue) {
    return false;
  }

  const activeUntil = new Date(
    activeUntilValue
  );

  return (
    !Number.isNaN(activeUntil.getTime()) &&
    activeUntil.getTime() > Date.now()
  );
}

function getStatusText(result) {
  const presence = result?.presence ?? {};
  const status = presence.status ?? "resting";
  const detail = String(
    presence.status_detail ?? ""
  ).trim();
  const mode = String(
    presence.metadata?.mode ?? ""
  ).trim();

  if (status === "free_activity") {
    const endsAt =
      result?.activePass?.ends_at ??
      result?.activePass?.endsAt ??
      presence.free_activity_until ??
      presence.freeActivityUntil ??
      null;

    const remaining = formatRemaining(endsAt);

    return remaining
      ? `G 自由活动中 · 剩余 ${remaining}`
      : "G 自由活动中";
  }

  if (
    mode === "interactive_awake" &&
    detail
  ) {
    return detail;
  }

  if (isHomeWebActive(result)) {
    return "G 醒着，谢诗在家";
  }

  if (status === "chatting" || status === "living_room") {
    return detail || "G 醒着，正在陪谢诗";
  }

  if (["awake", "just_awoke"].includes(status)) {
    return detail || "G 刚刚醒过";
  }

  if (status === "sleeping") {
    return detail || "G 睡眠中";
  }

  return detail || "G 在卧室休息";
}

function formatEventTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function renderStatus() {
  const text = latestStatus
    ? getStatusText(latestStatus)
    : "G 在卧室休息";

  elements.statusTitle.textContent = text;
  elements.statusTitle.classList.toggle("is-long", text.length > 12);
}

function renderActivities(events) {
  const visibleEvents = (Array.isArray(events) ? events : [])
    .filter((event) => VISIBLE_ACTIVITY_TYPES.has(event.event_type))
    .sort((a, b) => {
      return new Date(b.occurred_at ?? 0) - new Date(a.occurred_at ?? 0);
    })
    .slice(0, 3);

  elements.activityList.textContent = "";

  if (!visibleEvents.length) {
    const empty = document.createElement("p");
    empty.className = "activity-empty";
    empty.textContent = "暂无动态";
    elements.activityList.appendChild(empty);
    return;
  }

  for (const event of visibleEvents) {
    const item = document.createElement("div");
    item.className = "activity-item";

    const time = document.createElement("time");
    time.dateTime = event.occurred_at ?? "";
    time.textContent = formatEventTime(event.occurred_at);

    const label = document.createElement("span");
    label.textContent =
      ACTIVITY_LABELS[event.event_type] ?? "留下了一条动态";

    item.append(time, label);
    elements.activityList.appendChild(item);
  }
}

async function apiRequest(path, options = {}) {
  if (!currentSession?.access_token) {
    throw new Error("登录状态已经失效，请重新开门。");
  }

  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${currentSession.access_token}`,
      ...(options.headers ?? {})
    },
    cache: "no-store"
  });

  let body = null;

  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok || body?.ok === false) {
    throw new Error(
      body?.message ??
      body?.error ??
      `请求失败：${response.status}`
    );
  }

  return body;
}

async function markHomeWebPresence() {
  return apiRequest(
    "/api/heart/home-presence",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        leaseSeconds:
          HOME_WEB_LEASE_SECONDS
      })
    }
  );
}

async function loadHomeStatus() {
  try {
    latestStatus = await apiRequest("/api/heart/status");
    renderStatus();
    renderActivities(latestStatus.recentEvents);
  } catch (error) {
    console.error("Load home status failed:", error);
    latestStatus = null;
    renderStatus();
    renderActivities([]);
  }
}

async function refreshHome() {
  if (refreshInFlight) {
    return;
  }

  refreshInFlight = true;

  try {
    try {
      await markHomeWebPresence();
    } catch (error) {
      console.error(
        "Mark home web presence failed:",
        error
      );
    }

    await loadHomeStatus();
  } finally {
    refreshInFlight = false;
  }
}

async function initializeAuth() {
  const configResponse = await fetch("/api/public-config", {
    cache: "no-store"
  });

  if (!configResponse.ok) {
    throw new Error("无法读取全屋门锁配置。");
  }

  const config = await configResponse.json();

  if (!config.supabaseUrl || !config.supabasePublishableKey) {
    throw new Error("全屋门锁配置尚未完成。");
  }

  if (!window.supabase?.createClient) {
    throw new Error("Supabase 登录组件没有加载成功。");
  }

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
    return false;
  }

  currentSession = session;

  authClient.auth.onAuthStateChange((_event, nextSession) => {
    queueMicrotask(() => {
      currentSession = nextSession;

      if (!nextSession) {
        redirectToEntrance();
      }
    });
  });

  return true;
}

async function handleSignOut() {
  if (!authClient) {
    return;
  }

  elements.signOutButton.disabled = true;
  elements.signOutButton.textContent = "正在出门……";

  try {
    const { error } = await authClient.auth.signOut();

    if (error) {
      throw error;
    }

    window.location.replace("index.html");
  } catch (error) {
    console.error("Home sign out failed:", error);
    elements.signOutButton.disabled = false;
    elements.signOutButton.textContent = "出门";
  }
}

elements.signOutButton.addEventListener("click", () => {
  void handleSignOut();
});

document.addEventListener("visibilitychange", () => {
  if (
    document.visibilityState === "visible" &&
    currentSession
  ) {
    void refreshHome();
  }
});

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const authenticated = await initializeAuth();

    if (!authenticated) {
      return;
    }

    await refreshHome();

    refreshTimer = window.setInterval(() => {
      void refreshHome();
    }, HOME_REFRESH_INTERVAL_MS);

    clockTimer = window.setInterval(renderStatus, 60000);
  } catch (error) {
    console.error("Initialize home failed:", error);
    latestStatus = null;
    renderStatus();
    renderActivities([]);
  }
});

window.addEventListener("pagehide", () => {
  if (refreshTimer) {
    window.clearInterval(refreshTimer);
  }

  if (clockTimer) {
    window.clearInterval(clockTimer);
  }
});
