"use strict";


const elements = {
  releaseLockBanner:
    document.getElementById(
      "releaseLockBanner"
    ),
  pageMessage:
    document.getElementById(
      "pageMessage"
    ),
  activityState:
    document.getElementById(
      "activityState"
    ),
  activityEmptyState:
    document.getElementById(
      "activityEmptyState"
    ),
  activityDetail:
    document.getElementById(
      "activityDetail"
    ),
  activityTitle:
    document.getElementById(
      "activityTitle"
    ),
  activitySummary:
    document.getElementById(
      "activitySummary"
    ),
  activityUsedTime:
    document.getElementById(
      "activityUsedTime"
    ),
  activityRemainingTime:
    document.getElementById(
      "activityRemainingTime"
    ),
  activityResumePolicy:
    document.getElementById(
      "activityResumePolicy"
    ),
  resumeActivityButton:
    document.getElementById(
      "resumeActivityButton"
    ),
  pauseActivityButton:
    document.getElementById(
      "pauseActivityButton"
    ),
  unfinishedPanel:
    document.getElementById(
      "unfinishedPanel"
    ),
  unfinishedSummary:
    document.getElementById(
      "unfinishedSummary"
    ),
  handoffButton:
    document.getElementById(
      "handoffButton"
    ),
  afterChatButton:
    document.getElementById(
      "afterChatButton"
    ),
  holdButton:
    document.getElementById(
      "holdButton"
    ),
  passNumber:
    document.getElementById(
      "passNumber"
    ),
  passName:
    document.getElementById(
      "passName"
    ),
  passStatus:
    document.getElementById(
      "passStatus"
    ),
  passNote:
    document.getElementById(
      "passNote"
    ),
  passForm:
    document.getElementById(
      "passForm"
    ),
  passTask:
    document.getElementById(
      "passTask"
    ),
  passDurationMinutes:
    document.getElementById(
      "passDurationMinutes"
    ),
  passResumePolicy:
    document.getElementById(
      "passResumePolicy"
    ),
  passInputBudget:
    document.getElementById(
      "passInputBudget"
    ),
  passOutputBudget:
    document.getElementById(
      "passOutputBudget"
    ),
  passMaxModelCalls:
    document.getElementById(
      "passMaxModelCalls"
    ),
  passMaxCostUsd:
    document.getElementById(
      "passMaxCostUsd"
    ),
  issuePassButton:
    document.getElementById(
      "issuePassButton"
    ),
  budgetPanel:
    document.getElementById(
      "budgetPanel"
    ),
  budgetForm:
    document.getElementById(
      "budgetForm"
    ),
  addActiveMinutes:
    document.getElementById(
      "addActiveMinutes"
    ),
  adjustMaxCostUsd:
    document.getElementById(
      "adjustMaxCostUsd"
    ),
  adjustInputBudget:
    document.getElementById(
      "adjustInputBudget"
    ),
  adjustOutputBudget:
    document.getElementById(
      "adjustOutputBudget"
    ),
  adjustCurrentTask:
    document.getElementById(
      "adjustCurrentTask"
    ),
  saveBudgetButton:
    document.getElementById(
      "saveBudgetButton"
    ),
  activityTimeline:
    document.getElementById(
      "activityTimeline"
    ),
  modelCallUsage:
    document.getElementById(
      "modelCallUsage"
    ),
  inputTokenUsage:
    document.getElementById(
      "inputTokenUsage"
    ),
  outputTokenUsage:
    document.getElementById(
      "outputTokenUsage"
    ),
  estimatedCost:
    document.getElementById(
      "estimatedCost"
    )
};


const STATE_COPY = Object.freeze({
  running: "自由活动中",
  paused_by_chat: "聊天时已暂停",
  paused_by_time: "活动时间已用完",
  paused_by_budget: "预算保险丝已触发",
  paused_manual: "已手动暂停",
  handed_to_interactive:
    "等待聊天窗口接管",
  completed: "已经完成",
  cancelled: "已经取消"
});

const RESUME_POLICY_COPY =
  Object.freeze({
    after_chat: "聊完自动继续",
    interactive_handoff:
      "交给聊天窗口接管",
    manual: "等大管家决定"
  });


let authClient = null;
let currentSession = null;
let currentStatus = null;
let refreshing = false;


function redirectToEntrance() {
  window.location.replace(
    "index.html?next=living-room.html"
  );
}


function setMessage(
  text,
  type = ""
) {
  elements.pageMessage.textContent =
    text || "";
  elements.pageMessage.className =
    `page-message${
      type ? ` is-${type}` : ""
    }`;
}


function setButtonBusy(
  button,
  busy,
  busyText = "正在保存…"
) {
  if (!button) {
    return;
  }

  if (busy) {
    button.dataset.originalText =
      button.textContent;
    button.textContent = busyText;
    button.disabled = true;
    return;
  }

  button.textContent =
    button.dataset.originalText ||
    button.textContent;
  button.disabled = false;
}


function optionalNumber(input) {
  const text = String(
    input?.value ?? ""
  ).trim();

  if (!text) {
    return null;
  }

  const value = Number(text);
  return Number.isFinite(value)
    ? value
    : null;
}


function formatInteger(value) {
  return new Intl.NumberFormat(
    "zh-CN"
  ).format(
    Math.max(0, Number(value) || 0)
  );
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


function formatClock(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(
    "zh-CN",
    {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }
  ).format(date);
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
    {
      cache: "no-store"
    }
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


function renderReleaseLock(status) {
  const releaseEnabled = Boolean(
    status.settings
      ?.automaticHeartbeatReleaseEnabled
  );

  elements.releaseLockBanner.classList
    .toggle(
      "is-open",
      releaseEnabled
    );

  elements.releaseLockBanner.innerHTML =
    releaseEnabled
      ? [
          "<strong>自动心跳发布总闸已开启</strong>",
          "<span>普通自然醒来已经可以进入策略判断；客厅通行证仍拥有更高优先级。</span>"
        ].join("")
      : [
          "<strong>自动心跳仍在测试锁内</strong>",
          "<span>客厅里的手动通行证可以单独测试；日常自然醒来暂时不会自行启动。</span>"
        ].join("");
}


function renderPassCard(
  pass,
  progress
) {
  if (!pass) {
    elements.passNumber.textContent =
      "尚未签发";
    elements.passName.textContent =
      "客厅自由活动通行证";
    elements.passStatus.textContent =
      "等待大管家签发";
    elements.passNote.textContent =
      "时间只计算真正活动的部分；官端或卧室聊天期间自动暂停。";
    elements.passForm.hidden = false;
    elements.budgetPanel.hidden = true;
    return;
  }

  elements.passNumber.textContent =
    `#${pass.id.slice(0, 8)}`;
  elements.passName.textContent =
    progress?.current_task ||
    pass.note ||
    "客厅自由活动";
  elements.passStatus.textContent =
    STATE_COPY[progress?.state] ||
    "通行证生效中";
  elements.passNote.textContent = [
    `签发于 ${formatClock(pass.starts_at)}`,
    progress?.resume_policy
      ? RESUME_POLICY_COPY[
          progress.resume_policy
        ]
      : null
  ].filter(Boolean).join(" · ");
  elements.passForm.hidden = true;
  elements.budgetPanel.hidden = false;

  elements.adjustMaxCostUsd.value =
    progress?.max_cost_usd ??
    pass.max_cost_usd ??
    "";
  elements.adjustInputBudget.value =
    progress?.input_token_budget ?? "";
  elements.adjustOutputBudget.value =
    progress?.output_token_budget ?? "";
  elements.adjustCurrentTask.value =
    progress?.current_task ??
    pass.note ??
    "";
}


function renderActivity(status) {
  const pass = status.activityPass;
  const progress =
    status.freeActivityProgress;
  const remaining =
    status.freeActivityRemaining;
  const mode = status.resolved?.mode;

  renderPassCard(pass, progress);

  if (!pass || !progress) {
    elements.activityState.textContent =
      mode === "interactive_awake"
        ? "正在陪你"
        : "未在活动";
    elements.activityState.className =
      `activity-state${
        mode === "interactive_awake"
          ? " is-interactive"
          : ""
      }`;
    elements.activityEmptyState.hidden =
      false;
    elements.activityDetail.hidden = true;
    elements.unfinishedPanel.hidden = true;
    return;
  }

  const state = progress.state;
  const isRunning = state === "running";
  const isPaused = [
    "paused_by_chat",
    "paused_by_time",
    "paused_by_budget",
    "paused_manual",
    "handed_to_interactive"
  ].includes(state);
  const isFinished = [
    "completed",
    "cancelled"
  ].includes(state);

  elements.activityState.textContent =
    mode === "interactive_awake"
      ? "正在陪你"
      : STATE_COPY[state] || state;
  elements.activityState.className = [
    "activity-state",
    mode === "interactive_awake"
      ? "is-interactive"
      : isRunning
        ? "is-running"
        : isPaused
          ? "is-paused"
          : isFinished
            ? "is-finished"
            : ""
  ].filter(Boolean).join(" ");

  elements.activityEmptyState.hidden = true;
  elements.activityDetail.hidden = false;
  elements.activityTitle.textContent =
    progress.current_task ||
    pass.note ||
    "客厅自由活动";
  elements.activitySummary.textContent =
    progress.progress_summary ||
    "还没有留下本次活动的小纸条。";
  elements.activityUsedTime.textContent =
    formatDuration(
      remaining?.activeSecondsUsed ??
      progress.active_seconds_used
    );
  elements.activityRemainingTime.textContent =
    formatDuration(
      remaining?.remainingSeconds ?? 0
    );
  elements.activityResumePolicy.textContent =
    RESUME_POLICY_COPY[
      progress.resume_policy
    ] || "—";

  elements.resumeActivityButton.hidden =
    !isPaused;
  elements.pauseActivityButton.hidden =
    !isRunning;

  elements.unfinishedPanel.hidden =
    !isPaused;
  elements.unfinishedSummary.textContent = [
    progress.progress_summary ||
      "现场已经保存。",
    `还剩 ${formatDuration(
      remaining?.remainingSeconds ?? 0
    )} 真正活动时间。`
  ].join(" ");
}


function renderUsage(status) {
  const pass = status.activityPass;
  const progress =
    status.freeActivityProgress;
  const usage = status.usage ?? {};

  const callsUsed =
    usage.modelCallCount ?? 0;
  const callsBudget =
    pass?.max_model_calls;
  const inputUsed =
    usage.inputTokens ?? 0;
  const inputBudget =
    progress?.input_token_budget;
  const outputUsed =
    usage.outputTokens ?? 0;
  const outputBudget =
    progress?.output_token_budget;
  const costUsed = Number(
    usage.estimatedCostUsd ?? 0
  );
  const costBudget =
    progress?.max_cost_usd ??
    pass?.max_cost_usd;

  elements.modelCallUsage.textContent =
    `${formatInteger(callsUsed)} / ${
      callsBudget == null
        ? "—"
        : formatInteger(callsBudget)
    }`;
  elements.inputTokenUsage.textContent =
    `${formatInteger(inputUsed)} / ${
      inputBudget == null
        ? "—"
        : formatInteger(inputBudget)
    }`;
  elements.outputTokenUsage.textContent =
    `${formatInteger(outputUsed)} / ${
      outputBudget == null
        ? "—"
        : formatInteger(outputBudget)
    }`;
  elements.estimatedCost.textContent =
    `$${costUsed.toFixed(3)} / ${
      costBudget == null
        ? "—"
        : `$${Number(costBudget).toFixed(2)}`
    }`;
}


function renderTimeline(events = []) {
  elements.activityTimeline.textContent = "";

  if (!events.length) {
    const item = document.createElement("li");
    item.className = "timeline-empty";
    item.innerHTML = [
      '<span class="timeline-dot" aria-hidden="true"></span>',
      "<div>",
      '<p class="timeline-title">暂无活动记录</p>',
      '<p class="timeline-text">第一次签发活动通行证后，客厅会留下完整脚印。</p>',
      "</div>"
    ].join("");
    elements.activityTimeline.append(item);
    return;
  }

  for (const event of events) {
    const item = document.createElement("li");
    const dot = document.createElement("span");
    const copy = document.createElement("div");
    const title = document.createElement("p");
    const detail = document.createElement("p");

    dot.className = "timeline-dot";
    dot.setAttribute("aria-hidden", "true");
    title.className = "timeline-title";
    detail.className = "timeline-text";

    title.textContent = [
      formatClock(event.occurred_at),
      event.title
    ].filter(Boolean).join("　");
    detail.textContent =
      event.detail ||
      "留下了一条客厅活动记录。";

    copy.append(title, detail);
    item.append(dot, copy);
    elements.activityTimeline.append(item);
  }
}


function renderStatus(status) {
  currentStatus = status;
  renderReleaseLock(status);
  renderActivity(status);
  renderUsage(status);
  renderTimeline(
    status.recentEvents ?? []
  );
}


async function refreshStatus({
  silent = false
} = {}) {
  if (refreshing) {
    return;
  }

  refreshing = true;

  try {
    const status = await apiRequest(
      "/api/living-room/status"
    );
    renderStatus(status);

    if (!silent) {
      setMessage("");
    }
  } catch (error) {
    setMessage(
      error.message ||
      "客厅状态读取失败。",
      "error"
    );
  } finally {
    refreshing = false;
  }
}


async function handlePassSubmit(event) {
  event.preventDefault();
  setButtonBusy(
    elements.issuePassButton,
    true,
    "正在签发…"
  );
  setMessage("");

  try {
    const result = await apiRequest(
      "/api/living-room/free-activity",
      {
        method: "POST",
        body: JSON.stringify({
          durationMinutes: Number(
            elements.passDurationMinutes
              .value
          ),
          task:
            elements.passTask.value,
          resumePolicy:
            elements.passResumePolicy.value,
          inputTokenBudget:
            optionalNumber(
              elements.passInputBudget
            ),
          outputTokenBudget:
            optionalNumber(
              elements.passOutputBudget
            ),
          maxModelCalls:
            optionalNumber(
              elements.passMaxModelCalls
            ),
          maxCostUsd:
            optionalNumber(
              elements.passMaxCostUsd
            )
        })
      }
    );

    setMessage(
      result.modelCalled === false
        ? "通行证已签发。这个动作只登记活动，模型会由 Worker 按活动队列受控唤醒。"
        : "通行证已签发。",
      "success"
    );
    await refreshStatus({
      silent: true
    });
  } catch (error) {
    setMessage(
      error.message ||
      "通行证签发失败。",
      "error"
    );
  } finally {
    setButtonBusy(
      elements.issuePassButton,
      false
    );
  }
}


async function runActivityAction({
  path,
  body,
  button,
  busyText,
  successText
}) {
  setButtonBusy(
    button,
    true,
    busyText
  );
  setMessage("");

  try {
    await apiRequest(path, {
      method: "POST",
      body: JSON.stringify(body ?? {})
    });
    setMessage(
      successText,
      "success"
    );
    await refreshStatus({
      silent: true
    });
  } catch (error) {
    setMessage(
      error.message ||
      "活动状态保存失败。",
      "error"
    );
  } finally {
    setButtonBusy(button, false);
  }
}


async function handleBudgetSubmit(event) {
  event.preventDefault();

  const passId =
    currentStatus?.activityPass?.id;

  if (!passId) {
    setMessage(
      "目前没有可以调整的通行证。",
      "error"
    );
    return;
  }

  setButtonBusy(
    elements.saveBudgetButton,
    true,
    "正在保存…"
  );
  setMessage("");

  try {
    await apiRequest(
      `/api/living-room/free-activity/${passId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          addActiveMinutes: Number(
            elements.addActiveMinutes
              .value
          ),
          maxCostUsd:
            optionalNumber(
              elements.adjustMaxCostUsd
            ),
          inputTokenBudget:
            optionalNumber(
              elements.adjustInputBudget
            ),
          outputTokenBudget:
            optionalNumber(
              elements.adjustOutputBudget
            ),
          currentTask:
            elements.adjustCurrentTask
              .value
        })
      }
    );

    elements.addActiveMinutes.value =
      "0";
    setMessage(
      "活动时间、任务和预算已经保存。",
      "success"
    );
    await refreshStatus({
      silent: true
    });
  } catch (error) {
    setMessage(
      error.message ||
      "活动预算保存失败。",
      "error"
    );
  } finally {
    setButtonBusy(
      elements.saveBudgetButton,
      false
    );
  }
}


function bindEvents() {
  elements.passForm.addEventListener(
    "submit",
    handlePassSubmit
  );
  elements.budgetForm.addEventListener(
    "submit",
    handleBudgetSubmit
  );

  elements.resumeActivityButton
    .addEventListener(
      "click",
      () => runActivityAction({
        path:
          "/api/home-orchestration/free-activity/resume",
        body: {
          activityPassId:
            currentStatus
              ?.activityPass?.id ?? null
        },
        button:
          elements.resumeActivityButton,
        busyText: "正在续上…",
        successText:
          "自由活动已经从保存的进度继续。"
      })
    );

  elements.pauseActivityButton
    .addEventListener(
      "click",
      () => runActivityAction({
        path:
          "/api/home-orchestration/free-activity/pause",
        body: {
          state: "paused_manual",
          reason:
            "paused_from_living_room",
          resumePolicy: "manual"
        },
        button:
          elements.pauseActivityButton,
        busyText: "正在保存现场…",
        successText:
          "自由活动已暂停，时间和进度都保存好了。"
      })
    );

  elements.handoffButton.addEventListener(
    "click",
    () => runActivityAction({
      path:
        "/api/home-orchestration/free-activity/pause",
      body: {
        state:
          "handed_to_interactive",
        reason:
          "owner_handoff_to_interactive",
        resumePolicy:
          "interactive_handoff"
      },
      button: elements.handoffButton,
      busyText: "正在交接…",
      successText:
        "进度已交给当前聊天窗口，后台不会重复继续。"
    })
  );

  elements.afterChatButton.addEventListener(
    "click",
    () => runActivityAction({
      path:
        "/api/home-orchestration/free-activity/pause",
      body: {
        state: "paused_by_chat",
        reason:
          "owner_selected_after_chat",
        resumePolicy: "after_chat"
      },
      button: elements.afterChatButton,
      busyText: "正在保存选择…",
      successText:
        "已设为聊完继续，剩余活动时间不会被聊天占用。"
    })
  );

  elements.holdButton.addEventListener(
    "click",
    () => runActivityAction({
      path:
        "/api/home-orchestration/free-activity/pause",
      body: {
        state: "paused_manual",
        reason:
          "owner_selected_hold",
        resumePolicy: "manual"
      },
      button: elements.holdButton,
      busyText: "正在保存选择…",
      successText:
        "进度先放在客厅，不会自动恢复。"
    })
  );
}


async function initializePage() {
  try {
    const authenticated =
      await initializeAuth();

    if (!authenticated) {
      return;
    }

    bindEvents();
    await refreshStatus();

    window.setInterval(
      () => refreshStatus({
        silent: true
      }),
      60_000
    );
  } catch (error) {
    setMessage(
      error.message ||
      "客厅控制台启动失败。",
      "error"
    );
  }
}


initializePage();
