const HOME_STATUS_LABELS = {
  sleeping: "睡眠中",
  awake: "刚刚醒过",
  living_room: "客厅在线",
  free_activity: "自由活动中"
};

function setText(id, text) {
  const element = document.getElementById(id);

  if (element) {
    element.textContent = text;
  }
}

function renderHomeDate() {
  const now = new Date();

  const dateText = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long"
  }).format(now);

  setText("homeDate", `欢迎回家 · ${dateText}`);
}

function renderHomeDashboard(data) {
  /*
   * 正式状态接口接通后，支持以下结构：
   *
   * homeStatus: {
   *   state: "sleeping" | "awake" |
   *          "living_room" | "free_activity"
   * }
   */
  const stateCode =
    data?.homeStatus?.state ??
    data?.home_status?.state ??
    null;

  if (stateCode && HOME_STATUS_LABELS[stateCode]) {
    setText(
      "home-status-title",
      HOME_STATUS_LABELS[stateCode]
    );
  }

  /*
   * 主动留言
   */
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

  /*
   * 当前活动
   */
  const currentActivity =
    data?.activity?.title ??
    data?.currentActivity?.title ??
    null;

  setText(
    "activityStatus",
    currentActivity || "当前没有活动"
  );

  /*
   * 最近完成事项
   */
  const recentItem =
    data?.recentItem?.title ??
    data?.recentCompleted?.title ??
    null;

  if (recentItem) {
    setText("recentStatus", recentItem);
    return;
  }

  /*
   * 当前数据库已经真实接通，
   * 在正式事项表建立前先显示这个真实结果。
   */
  if (data?.supabase?.connected === true) {
    setText("recentStatus", "云端数据库已接通");
    return;
  }

  setText("recentStatus", "暂无最近事项");
}

async function loadHomeDashboard() {
  renderHomeDate();

  try {
    const response = await fetch("/status", {
      method: "GET",
      headers: {
        Accept: "application/json"
      },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(
        `Home status request failed: ${response.status}`
      );
    }

    const data = await response.json();

    renderHomeDashboard(data);
  } catch (error) {
    console.error("Load home dashboard failed:", error);

    setText("recentStatus", "小窝暂时离线");
  }
}

document.addEventListener(
  "DOMContentLoaded",
  loadHomeDashboard
);