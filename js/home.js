"use strict";

const HOME_STATUS_LABELS = {
  sleeping: "睡眠中",
  awake: "刚刚醒过",
  living_room: "客厅在线",
  free_activity: "自由活动中"
};

const homeAuthElements = {
  account: document.getElementById("homeAccount"),
  email: document.getElementById("homeAccountEmail"),
  signOutButton:
    document.getElementById("homeSignOutButton")
};

let homeAuthClient = null;
let homeSession = null;

function setText(id, text) {
  const element = document.getElementById(id);

  if (element) {
    element.textContent = text;
  }
}

function redirectToEntrance(
  next = "home.html"
) {
  const target =
    `index.html?next=${encodeURIComponent(next)}`;

  window.location.replace(target);
}

function renderHomeDate() {
  const now = new Date();

  const dateText = new Intl.DateTimeFormat(
    "zh-CN",
    {
      month: "long",
      day: "numeric",
      weekday: "long"
    }
  ).format(now);

  setText(
    "homeDate",
    `欢迎回家 · ${dateText}`
  );
}

function renderHomeDashboard(data) {
  const stateCode =
    data?.homeStatus?.state ??
    data?.home_status?.state ??
    null;

  if (
    stateCode &&
    HOME_STATUS_LABELS[stateCode]
  ) {
    setText(
      "home-status-title",
      HOME_STATUS_LABELS[stateCode]
    );
  }

  const unreadCount = Number(
    data?.heartbeat?.unreadCount ??
    data?.heartbeatUnreadCount ??
    0
  );

  setText(
    "heartbeatStatus",
    unreadCount > 0
      ? `有 ${unreadCount} 条未读留言`
      : "暂无留言"
  );

  const currentActivity =
    data?.activity?.title ??
    data?.currentActivity?.title ??
    null;

  setText(
    "activityStatus",
    currentActivity ||
      "当前没有活动"
  );

  const recentItem =
    data?.recentItem?.title ??
    data?.recentCompleted?.title ??
    null;

  if (recentItem) {
    setText(
      "recentStatus",
      recentItem
    );
    return;
  }

  if (data?.supabase?.connected === true) {
    setText(
      "recentStatus",
      "云端数据库已接通"
    );
    return;
  }

  setText(
    "recentStatus",
    "暂无最近事项"
  );
}

async function loadHomeDashboard() {
  renderHomeDate();

  try {
    const response = await fetch(
      "/status",
      {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        cache: "no-store"
      }
    );

    if (!response.ok) {
      throw new Error(
        `Home status request failed: ${response.status}`
      );
    }

    const data = await response.json();

    renderHomeDashboard(data);
  } catch (error) {
    console.error(
      "Load home dashboard failed:",
      error
    );

    setText(
      "recentStatus",
      "小窝暂时离线"
    );
  }
}

function renderHomeSession(session) {
  homeSession = session ?? null;

  if (!homeSession) {
    redirectToEntrance();
    return;
  }

  homeAuthElements.email.textContent =
    homeSession.user?.email ??
    "屋主已登录";

  homeAuthElements.account.hidden = false;
}

async function initializeHomeAuth() {
  try {
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

    homeAuthClient =
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
    } =
      await homeAuthClient.auth.getSession();

    if (error) {
      throw error;
    }

    if (!session) {
      redirectToEntrance();
      return false;
    }

    renderHomeSession(session);

    homeAuthClient.auth.onAuthStateChange(
      (_event, nextSession) => {
        queueMicrotask(() => {
          renderHomeSession(nextSession);
        });
      }
    );

    return true;
  } catch (error) {
    console.error(
      "Home auth initialization failed:",
      error
    );

    setText(
      "recentStatus",
      error?.message ??
        "全屋门锁暂时离线"
    );

    return false;
  }
}

async function handleHomeSignOut() {
  if (!homeAuthClient) {
    return;
  }

  homeAuthElements.signOutButton.disabled =
    true;

  homeAuthElements.signOutButton.textContent =
    "正在退出……";

  try {
    const { error } =
      await homeAuthClient.auth.signOut();

    if (error) {
      throw error;
    }

    window.location.replace("index.html");
  } catch (error) {
    console.error(
      "Home sign out failed:",
      error
    );

    homeAuthElements.signOutButton.disabled =
      false;

    homeAuthElements.signOutButton.textContent =
      "退出失败，重试";
  }
}

homeAuthElements.signOutButton.addEventListener(
  "click",
  () => {
    void handleHomeSignOut();
  }
);

document.addEventListener(
  "DOMContentLoaded",
  async () => {
    const authenticated =
      await initializeHomeAuth();

    if (authenticated) {
      await loadHomeDashboard();
    }
  }
);
