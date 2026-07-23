"use strict";


const STATE_COPY = Object.freeze({
  running: "自由活动中",
  paused_by_chat: "聊天时已暂停",
  paused_by_time: "活动时间已用完",
  paused_by_budget: "预算保险丝已触发",
  paused_manual: "已手动暂停",
  handed_to_interactive: "等待聊天窗口接管",
  completed: "已经完成",
  cancelled: "已经取消"
});

const RESUME_POLICY_COPY = Object.freeze({
  after_chat: "聊完自动继续",
  interactive_handoff: "交给聊天窗口接管",
  manual: "等大管家决定"
});

const PAUSED_STATES = new Set([
  "paused_by_chat",
  "paused_by_time",
  "paused_by_budget",
  "paused_manual",
  "handed_to_interactive"
]);


const elements = {
  releaseLockCard:
    document.getElementById("releaseLockCard"),
  pageMessage:
    document.getElementById("pageMessage"),
  activityTitle:
    document.getElementById("activityTitle"),
  activityState:
    document.getElementById("activityState"),
  activitySummary:
    document.getElementById("activitySummary"),
  activityFacts:
    document.getElementById("activityFacts"),
  usedTime:
    document.getElementById("usedTime"),
  remainingTime:
    document.getElementById("remainingTime"),
  resumePolicy:
    document.getElementById("resumePolicy"),
  activityActions:
    document.getElementById("activityActions"),
  resumeButton:
    document.getElementById("resumeButton"),
  pauseButton:
    document.getElementById("pauseButton"),
  afterChatButton:
    document.getElementById("afterChatButton"),
  holdButton:
    document.getElementById("holdButton"),
  handoffButton:
    document.getElementById("handoffButton"),
  completeButton:
    document.getElementById("completeButton"),
  cancelButton:
    document.getElementById("cancelButton"),
  issuePanel:
    document.getElementById("issuePanel"),
  issueForm:
    document.getElementById("issueForm"),
  taskInput:
    document.getElementById("taskInput"),
  durationInput:
    document.getElementById("durationInput"),
  resumePolicyInput:
    document.getElementById("resumePolicyInput"),
  inputBudgetInput:
    document.getElementById("inputBudgetInput"),
  outputBudgetInput:
    document.getElementById("outputBudgetInput"),
  maxCallsInput:
    document.getElementById("maxCallsInput"),
  maxCostInput:
    document.getElementById("maxCostInput"),
  issueButton:
    document.getElementById("issueButton"),
  adjustPanel:
    document.getElementById("adjustPanel"),
  adjustForm:
    document.getElementById("adjustForm"),
  passId:
    document.getElementById("passId"),
  currentTaskInput:
    document.getElementById("currentTaskInput"),
  addMinutesInput:
    document.getElementById("addMinutesInput"),
  adjustMaxCallsInput:
    document.getElementById("adjustMaxCallsInput"),
  adjustInputBudgetInput:
    document.getElementById("adjustInputBudgetInput"),
  adjustOutputBudgetInput:
    document.getElementById("adjustOutputBudgetInput"),
  adjustMaxCostInput:
    document.getElementById("adjustMaxCostInput"),
  adjustButton:
    document.getElementById("adjustButton"),
  callsUsage:
    document.getElementById("callsUsage"),
  inputUsage:
    document.getElementById("inputUsage"),
  outputUsage:
    document.getElementById("outputUsage"),
  costUsage:
    document.getElementById("costUsage"),
  timeline:
    document.getElementById("timeline")
};


let authClient = null;
let currentSession = null;
let currentStatus = null;
let refreshing = false;


function redirectToEntrance() {
  window.location.replace(
    "index.html?next=living-room-v2.html"
  );
}


function setMessage(text, type = "") {
  elements.pageMessage.textContent = text || "";
  elements.pageMessage.className =
    `page-message${type ? ` is-${type}` : ""}`;
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
  return new Intl.NumberFormat("zh-CN")
    .format(Math.max(0, Number(value) || 0));
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

  return total > 0 ? "不到 1 分钟" : "0 分钟";
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

  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization:
        `Bearer ${currentSession.access_token}`,
      ...(options.body
        ? { "Content-Type": "application/json" }
        : {}),
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

  const config = await configResponse.json();

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


function renderLock(status) {
  const open = Boolean(
    status.settings
      ?.automaticHeartbeatReleaseEnabled
  );

  elements.releaseLockCard.className =
    `lock-card ${open ? "is-open" : "is-locked"}`;
  elements.releaseLockCard.innerHTML = open
    ? [
        "<strong>自动心跳发布总闸已开启</strong>",
        "<span>普通自然醒来已经可以进入策略判断。</span>"
      ].join("")
    : [
        "<strong>自动心跳仍在测试锁内</strong>",
        "<span>只有大管家明确签发的活动证可以测试，日常自然醒来不会自行启动。</span>"
      ].join("");
}


function renderTimeline(events = []) {
  elements.timeline.textContent = "";

  if (!events.length) {
    const item = document.createElement("li");
    item.textContent = "还没有活动脚印。";
    elements.timeline.append(item);
    return;
  }

  for (const event of events) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    const detail = document.createElement("span");

    title.textContent = [
      formatClock(event.occurred_at),
      event.title
    ].filter(Boolean).join("　");
    detail.textContent =
      event.detail || "留下了一条活动记录。";
    item.append(title, detail);
    elements.timeline.append(item);
  }
}


function renderUsage(status) {
  const pass = status.activityPass;
  const progress = status.freeActivityProgress;
  const usage = status.usage ?? {};

  const callsUsed = usage.modelCallCount ?? 0;
  const inputUsed = usage.inputTokens ?? 0;
  const outputUsed = usage.outputTokens ?? 0;
  const costUsed = Number(
    usage.estimatedCostUsd ?? 0
  );

  elements.callsUsage.textContent =
    `${formatInteger(callsUsed)} / ${
      pass?.max_model_calls == null
        ? "—"
        : formatInteger(pass.max_model_calls)
    }`;
  elements.inputUsage.textContent =
    `${formatInteger(inputUsed)} / ${
      progress?.input_token_budget == null
        ? "—"
        : formatInteger(progress.input_token_budget)
    }`;
  elements.outputUsage.textContent =
    `${formatInteger(outputUsed)} / ${
      progress?.output_token_budget == null
        ? "—"
        : formatInteger(progress.output_token_budget)
    }`;
  elements.costUsage.textContent =
    `$${costUsed.toFixed(3)} / ${
      progress?.max_cost_usd == null
        ? "—"
        : `$${Number(progress.max_cost_usd).toFixed(2)}`
    }`;
}


function renderActivity(status) {
  const pass = status.activityPass;
  const progress = status.freeActivityProgress;
  const remaining = status.freeActivityRemaining;
  const mode = status.resolved?.mode;

  elements.issuePanel.hidden = Boolean(pass);
  elements.adjustPanel.hidden = !pass;

  if (!pass || !progress) {
    elements.activityTitle.textContent =
      mode === "interactive_awake"
        ? "G 正在陪你"
        : "客厅现在很安静";
    elements.activityState.textContent =
      mode === "interactive_awake"
        ? "正在互动"
        : "未在活动";
    elements.activityState.className =
      `state-badge${
        mode === "interactive_awake"
          ? " is-interactive"
          : ""
      }`;
    elements.activitySummary.textContent =
      "目前没有正在进行或等待续接的自由活动。";
    elements.activityFacts.hidden = true;
    elements.activityActions.hidden = true;
    return;
  }

  const state = progress.state;
  const isRunning = state === "running";
  const isPaused = PAUSED_STATES.has(state);

  elements.activityTitle.textContent =
    progress.current_task ||
    pass.note ||
    "客厅自由活动";
  elements.activityState.textContent =
    mode === "interactive_awake"
      ? "正在陪你"
      : STATE_COPY[state] || state;
  elements.activityState.className = [
    "state-badge",
    mode === "interactive_awake"
      ? "is-interactive"
      : isRunning
        ? "is-running"
        : isPaused
          ? "is-paused"
          : ""
  ].filter(Boolean).join(" ");
  elements.activitySummary.textContent =
    progress.progress_summary ||
    "现场已经保存，等待下一次活动记录。";
  elements.activityFacts.hidden = false;
  elements.activityActions.hidden = false;
  elements.usedTime.textContent = formatDuration(
    remaining?.activeSecondsUsed ??
    progress.active_seconds_used
  );
  elements.remainingTime.textContent = formatDuration(
    remaining?.remainingSeconds ?? 0
  );
  elements.resumePolicy.textContent =
    RESUME_POLICY_COPY[
      progress.resume_policy
    ] || "—";

  elements.resumeButton.hidden = !isPaused;
  elements.pauseButton.hidden = !isRunning;
  elements.afterChatButton.hidden = false;
  elements.holdButton.hidden = false;
  elements.handoffButton.hidden = false;

  elements.passId.textContent =
    `#${pass.id.slice(0, 8)}`;
  elements.currentTaskInput.value =
    progress.current_task || pass.note || "";
  elements.adjustMaxCallsInput.value =
    pass.max_model_calls ?? "";
  elements.adjustInputBudgetInput.value =
    progress.input_token_budget ?? "";
  elements.adjustOutputBudgetInput.value =
    progress.output_token_budget ?? "";
  elements.adjustMaxCostInput.value =
    progress.max_cost_usd ?? "";
}


function renderStatus(status) {
  currentStatus = status;
  renderLock(status);
  renderActivity(status);
  renderUsage(status);
  renderTimeline(status.recentEvents ?? []);
}


async function refreshStatus({ silent = false } = {}) {
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
      error.message || "客厅状态读取失败。",
      "error"
    );
  } finally {
    refreshing = false;
  }
}


async function runAction({
  path,
  method = "POST",
  body = {},
  button,
  busyText,
  successText
}) {
  setButtonBusy(button, true, busyText);
  setMessage("");

  try {
    const result = await apiRequest(path, {
      method,
      body: JSON.stringify(body)
    });
    setMessage(
      typeof successText === "function"
        ? successText(result)
        : successText,
      "success"
    );
    await refreshStatus({ silent: true });
    return result;
  } catch (error) {
    setMessage(
      error.message || "活动状态保存失败。",
      "error"
    );
    return null;
  } finally {
    setButtonBusy(button, false);
  }
}


async function handleIssue(event) {
  event.preventDefault();

  await runAction({
    path: "/api/living-room/free-activity",
    body: {
      durationMinutes: Number(
        elements.durationInput.value
      ),
      task: elements.taskInput.value,
      resumePolicy:
        elements.resumePolicyInput.value,
      inputTokenBudget:
        optionalNumber(
          elements.inputBudgetInput
        ),
      outputTokenBudget:
        optionalNumber(
          elements.outputBudgetInput
        ),
      maxModelCalls:
        optionalNumber(
          elements.maxCallsInput
        ),
      maxCostUsd:
        optionalNumber(
          elements.maxCostInput
        )
    },
    button: elements.issueButton,
    busyText: "正在签发…",
    successText:
      "测试通行证已签发。自动心跳总闸仍保持关闭。"
  });
}


async function handleAdjust(event) {
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

  const result = await runAction({
    path:
      `/api/living-room-v2/free-activity/${passId}`,
    method: "PATCH",
    body: {
      addActiveMinutes: Number(
        elements.addMinutesInput.value
      ),
      currentTask:
        elements.currentTaskInput.value,
      maxModelCalls:
        optionalNumber(
          elements.adjustMaxCallsInput
        ),
      inputTokenBudget:
        optionalNumber(
          elements.adjustInputBudgetInput
        ),
      outputTokenBudget:
        optionalNumber(
          elements.adjustOutputBudgetInput
        ),
      maxCostUsd:
        optionalNumber(
          elements.adjustMaxCostInput
        )
    },
    button: elements.adjustButton,
    busyText: "正在保存…",
    successText: (body) =>
      body.pausedByCurrentBudget
        ? "调整已保存；新上限已经碰到当前用量，活动已立即暂停。"
        : "时间、任务和预算已经保存。"
  });

  if (result) {
    elements.addMinutesInput.value = "0";
  }
}


function currentPassId() {
  return currentStatus?.activityPass?.id ?? null;
}


function bindEvents() {
  elements.issueForm.addEventListener(
    "submit",
    handleIssue
  );
  elements.adjustForm.addEventListener(
    "submit",
    handleAdjust
  );

  elements.resumeButton.addEventListener(
    "click",
    () => runAction({
      path:
        "/api/home-orchestration/free-activity/resume",
      body: {
        activityPassId: currentPassId()
      },
      button: elements.resumeButton,
      busyText: "正在续上…",
      successText:
        "自由活动已经从保存的位置继续。"
    })
  );

  elements.pauseButton.addEventListener(
    "click",
    () => runAction({
      path:
        "/api/home-orchestration/free-activity/pause",
      body: {
        state: "paused_manual",
        reason: "paused_from_living_room_v2",
        resumePolicy: "manual"
      },
      button: elements.pauseButton,
      busyText: "正在保存现场…",
      successText:
        "活动已暂停，真正活动时间停止计数。"
    })
  );

  elements.afterChatButton.addEventListener(
    "click",
    () => runAction({
      path:
        "/api/home-orchestration/free-activity/pause",
      body: {
        state: "paused_by_chat",
        reason: "owner_selected_after_chat",
        resumePolicy: "after_chat"
      },
      button: elements.afterChatButton,
      busyText: "正在保存选择…",
      successText:
        "已设为聊完继续，剩余时间不会被聊天占用。"
    })
  );

  elements.holdButton.addEventListener(
    "click",
    () => runAction({
      path:
        "/api/home-orchestration/free-activity/pause",
      body: {
        state: "paused_manual",
        reason: "owner_selected_hold",
        resumePolicy: "manual"
      },
      button: elements.holdButton,
      busyText: "正在保存选择…",
      successText:
        "进度先放在客厅，不会自动恢复。"
    })
  );

  elements.handoffButton.addEventListener(
    "click",
    () => runAction({
      path:
        "/api/home-orchestration/free-activity/pause",
      body: {
        state: "handed_to_interactive",
        reason: "owner_handoff_to_interactive",
        resumePolicy: "interactive_handoff"
      },
      button: elements.handoffButton,
      busyText: "正在交接…",
      successText:
        "进度已交给当前聊天窗口，后台不会重复继续。"
    })
  );

  elements.completeButton.addEventListener(
    "click",
    async () => {
      const passId = currentPassId();
      if (!passId) return;

      const ok = window.confirm(
        "确认这次自由活动已经完成并收起通行证吗？"
      );
      if (!ok) return;

      await runAction({
        path:
          `/api/living-room-v2/free-activity/${passId}/finish`,
        body: {
          finalState: "completed",
          summary:
            currentStatus?.freeActivityProgress
              ?.progress_summary ?? null
        },
        button: elements.completeButton,
        busyText: "正在收尾…",
        successText:
          "这张通行证已完成并收进活动时间线。"
      });
    }
  );

  elements.cancelButton.addEventListener(
    "click",
    async () => {
      const passId = currentPassId();
      if (!passId) return;

      const ok = window.confirm(
        "确认取消这张通行证吗？现有进度会保留在活动记录里。"
      );
      if (!ok) return;

      await runAction({
        path:
          `/api/living-room-v2/free-activity/${passId}/finish`,
        body: {
          finalState: "cancelled"
        },
        button: elements.cancelButton,
        busyText: "正在取消…",
        successText:
          "通行证已取消，客厅可以签发下一张。"
      });
    }
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
      () => refreshStatus({ silent: true }),
      30_000
    );
  } catch (error) {
    setMessage(
      error.message ||
      "客厅 v2 控制台启动失败。",
      "error"
    );
  }
}


initializePage();
