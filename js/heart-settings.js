"use strict";

const INTERVAL_OPTIONS = [
  15,
  20,
  30,
  40,
  50,
  60,
  90,
  120,
  180,
  240
];

const MODEL_INTERVAL_OPTIONS = [
  15,
  30,
  60,
  90,
  120,
  180,
  240,
  360,
  720,
  1440
];

const GRACE_OPTIONS = [
  0,
  5,
  10,
  15,
  20,
  30,
  45,
  60
];

const COMMON_TIMEZONES = [
  "Asia/Shanghai",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "Asia/Tokyo"
];

const POLICY_DEFAULTS = Object.freeze({
  naturalWakeEnabled: true,
  naturalWakeMinPerDay: 3,
  naturalWakeMaxPerDay: 6,
  minModelWakeIntervalMinutes: 120,
  dailyModelCallLimit: 6,
  dailyCostLimitUsd: 0.20
});

const elements = {
  form:
    document.getElementById("heartSettingsForm"),
  autoHeartbeatEnabled:
    document.getElementById("autoHeartbeatEnabled"),
  quietHoursEnabled:
    document.getElementById("quietHoursEnabled"),
  quietTimeFields:
    document.getElementById("quietTimeFields"),
  quietStart:
    document.getElementById("quietStart"),
  quietEnd:
    document.getElementById("quietEnd"),
  timezone:
    document.getElementById("timezone"),
  deviceTimezoneHint:
    document.getElementById("deviceTimezoneHint"),
  fixedIntervalFields:
    document.getElementById("fixedIntervalFields"),
  randomIntervalFields:
    document.getElementById("randomIntervalFields"),
  fixedInterval:
    document.getElementById("fixedInterval"),
  intervalMin:
    document.getElementById("intervalMin"),
  intervalMax:
    document.getElementById("intervalMax"),
  naturalWakeEnabled:
    document.getElementById("naturalWakeEnabled"),
  naturalWakeFields:
    document.getElementById("naturalWakeFields"),
  naturalWakeMinPerDay:
    document.getElementById("naturalWakeMinPerDay"),
  naturalWakeMaxPerDay:
    document.getElementById("naturalWakeMaxPerDay"),
  minModelWakeIntervalMinutes:
    document.getElementById("minModelWakeIntervalMinutes"),
  dailyModelCallLimit:
    document.getElementById("dailyModelCallLimit"),
  dailyCostLimitUsd:
    document.getElementById("dailyCostLimitUsd"),
  postChatGraceMinutes:
    document.getElementById("postChatGraceMinutes"),
  summary:
    document.querySelector(".schedule-summary"),
  summaryTitle:
    document.getElementById("summaryTitle"),
  summaryDetail:
    document.getElementById("summaryDetail"),
  message:
    document.getElementById("formMessage"),
  saveButton:
    document.getElementById("saveButton")
};

let authClient = null;
let currentSession = null;
let currentPreferences = null;
let currentNextHeartbeatAt = null;


function redirectToEntrance() {
  window.location.replace(
    "index.html?next=heart-settings.html"
  );
}


function setMessage(
  text,
  type = ""
) {
  elements.message.textContent =
    text || "";
  elements.message.className =
    `form-message${type ? ` is-${type}` : ""}`;
}


function addSelectOptions(
  select,
  values,
  formatter
) {
  select.textContent = "";

  for (const value of values) {
    const option =
      document.createElement("option");

    option.value = String(value);
    option.textContent = formatter(value);
    select.append(option);
  }
}


function ensureSelectValue(
  select,
  value,
  label = null
) {
  const textValue = String(value);

  if (
    !Array.from(select.options)
      .some(
        (option) =>
          option.value === textValue
      )
  ) {
    const option =
      document.createElement("option");

    option.value = textValue;
    option.textContent =
      label ?? textValue;
    select.append(option);
  }

  select.value = textValue;
}


function formatMinutes(value) {
  if (value === 1440) {
    return "24 小时";
  }

  if (
    value >= 60 &&
    value % 60 === 0
  ) {
    return `${value / 60} 小时`;
  }

  return `${value} 分钟`;
}


function initializeStaticOptions() {
  const deviceTimezone =
    Intl.DateTimeFormat()
      .resolvedOptions()
      .timeZone ||
    "Asia/Shanghai";

  const timezones = [
    deviceTimezone,
    ...COMMON_TIMEZONES
  ].filter(
    (value, index, array) =>
      array.indexOf(value) === index
  );

  addSelectOptions(
    elements.timezone,
    timezones,
    (value) => value
  );

  elements.deviceTimezoneHint.textContent =
    `这台设备当前识别为 ${deviceTimezone}`;

  for (const select of [
    elements.fixedInterval,
    elements.intervalMin,
    elements.intervalMax
  ]) {
    addSelectOptions(
      select,
      INTERVAL_OPTIONS,
      (value) => `${value} 分钟`
    );
  }

  addSelectOptions(
    elements.minModelWakeIntervalMinutes,
    MODEL_INTERVAL_OPTIONS,
    formatMinutes
  );

  addSelectOptions(
    elements.postChatGraceMinutes,
    GRACE_OPTIONS,
    (value) =>
      value === 0
        ? "不缓冲"
        : `${value} 分钟`
  );
}


function getIntervalMode() {
  return document.querySelector(
    'input[name="intervalMode"]:checked'
  )?.value ?? "fixed";
}


function setIntervalMode(mode) {
  const target = document.querySelector(
    `input[name="intervalMode"][value="${mode}"]`
  );

  if (target) {
    target.checked = true;
  }

  renderIntervalMode();
}


function renderIntervalMode() {
  const random =
    getIntervalMode() === "random";

  elements.fixedIntervalFields.hidden =
    random;
  elements.randomIntervalFields.hidden =
    !random;
}


function renderQuietHoursState() {
  const enabled =
    elements.quietHoursEnabled.checked;

  for (const input of [
    elements.quietStart,
    elements.quietEnd
  ]) {
    input.disabled = !enabled;
  }
}


function renderNaturalWakeState() {
  const enabled =
    elements.naturalWakeEnabled.checked;

  for (const input of [
    elements.naturalWakeMinPerDay,
    elements.naturalWakeMaxPerDay,
    elements.minModelWakeIntervalMinutes
  ]) {
    input.disabled = !enabled;
  }
}


function formatNextHeartbeat(
  value,
  timezone
) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(
    "zh-CN",
    {
      timeZone: timezone,
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }
  ).format(date);
}


function renderSummary({
  preferences,
  nextHeartbeatAt,
  quietHoursActive = false
}) {
  const enabled =
    preferences.autoHeartbeatEnabled;

  elements.summary.classList.toggle(
    "is-off",
    !enabled
  );

  if (!enabled) {
    elements.summaryTitle.textContent =
      "自动心跳巡检已关闭";

    elements.summaryDetail.textContent =
      "手动唤醒和自由活动仍然可用；后台不会自行安排巡检。";

    return;
  }

  const intervalText =
    preferences.intervalMinMinutes ===
      preferences.intervalMaxMinutes
      ? `每隔 ${preferences.intervalMinMinutes} 分钟巡检一次`
      : `每隔 ${preferences.intervalMinMinutes}～${preferences.intervalMaxMinutes} 分钟随机巡检`;

  const naturalText =
    preferences.naturalWakeEnabled
      ? `自然醒来目标 ${preferences.naturalWakeMinPerDay}～${preferences.naturalWakeMaxPerDay} 次/日`
      : "自然醒来已关闭";

  const budgetText =
    `自动模型上限 ${preferences.dailyModelCallLimit} 次/日`;

  const nextText = formatNextHeartbeat(
    nextHeartbeatAt,
    preferences.timezone
  );

  elements.summaryTitle.textContent =
    quietHoursActive
      ? "G 正在休息时段"
      : "自动巡检已开启";

  elements.summaryDetail.textContent = [
    intervalText,
    naturalText,
    budgetText,
    preferences.quietHoursEnabled
      ? `休息时间 ${preferences.quietStart}–${preferences.quietEnd}`
      : "未设置自动休息时段",
    nextText
      ? `下一次巡检预计 ${nextText}`
      : "下一次巡检会在保存或 Worker 调度后写入"
  ].join(" · ");
}


function renderPreferences(result) {
  const preferences =
    result.preferences;

  currentPreferences = preferences;
  currentNextHeartbeatAt =
    result.nextHeartbeatAt ?? null;

  elements.autoHeartbeatEnabled.checked =
    preferences.autoHeartbeatEnabled;

  elements.quietHoursEnabled.checked =
    preferences.quietHoursEnabled;

  elements.quietStart.value =
    preferences.quietStart;
  elements.quietEnd.value =
    preferences.quietEnd;

  ensureSelectValue(
    elements.timezone,
    preferences.timezone
  );

  const fixed =
    preferences.intervalMinMinutes ===
      preferences.intervalMaxMinutes;

  if (fixed) {
    ensureSelectValue(
      elements.fixedInterval,
      preferences.intervalMinMinutes,
      `${preferences.intervalMinMinutes} 分钟`
    );
    setIntervalMode("fixed");
  } else {
    ensureSelectValue(
      elements.intervalMin,
      preferences.intervalMinMinutes,
      `${preferences.intervalMinMinutes} 分钟`
    );
    ensureSelectValue(
      elements.intervalMax,
      preferences.intervalMaxMinutes,
      `${preferences.intervalMaxMinutes} 分钟`
    );
    setIntervalMode("random");
  }

  elements.naturalWakeEnabled.checked =
    preferences.naturalWakeEnabled;

  elements.naturalWakeMinPerDay.value =
    String(
      preferences.naturalWakeMinPerDay
    );

  elements.naturalWakeMaxPerDay.value =
    String(
      preferences.naturalWakeMaxPerDay
    );

  ensureSelectValue(
    elements.minModelWakeIntervalMinutes,
    preferences.minModelWakeIntervalMinutes,
    formatMinutes(
      preferences.minModelWakeIntervalMinutes
    )
  );

  elements.dailyModelCallLimit.value =
    String(
      preferences.dailyModelCallLimit
    );

  elements.dailyCostLimitUsd.value =
    Number(
      preferences.dailyCostLimitUsd
    ).toFixed(2);

  ensureSelectValue(
    elements.postChatGraceMinutes,
    preferences.postChatGraceMinutes,
    preferences.postChatGraceMinutes === 0
      ? "不缓冲"
      : `${preferences.postChatGraceMinutes} 分钟`
  );

  renderQuietHoursState();
  renderNaturalWakeState();
  renderSummary(result);
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


function explainPolicyDatabaseError(error) {
  const message = String(
    error?.message ?? ""
  );

  if (
    error?.code === "42703" ||
    message.includes(
      "natural_wake_enabled"
    )
  ) {
    return new Error(
      "自然醒来字段还没有装进数据库，请先执行 20260723_01_heartbeat_model_wake_policy.sql。"
    );
  }

  return error;
}


async function loadPolicyPreferences() {
  const userId =
    currentSession?.user?.id;

  if (!userId) {
    throw new Error(
      "无法确认当前屋主。"
    );
  }

  const {
    data,
    error
  } = await authClient
    .from("heartbeat_preferences")
    .select([
      "natural_wake_enabled",
      "natural_wake_min_per_day",
      "natural_wake_max_per_day",
      "min_model_wake_interval_minutes",
      "daily_model_call_limit",
      "daily_cost_limit_usd"
    ].join(", "))
    .eq("owner_user_id", userId)
    .single();

  if (error) {
    throw explainPolicyDatabaseError(
      error
    );
  }

  return {
    naturalWakeEnabled:
      data?.natural_wake_enabled ??
      POLICY_DEFAULTS
        .naturalWakeEnabled,
    naturalWakeMinPerDay: Number(
      data?.natural_wake_min_per_day ??
      POLICY_DEFAULTS
        .naturalWakeMinPerDay
    ),
    naturalWakeMaxPerDay: Number(
      data?.natural_wake_max_per_day ??
      POLICY_DEFAULTS
        .naturalWakeMaxPerDay
    ),
    minModelWakeIntervalMinutes: Number(
      data?.min_model_wake_interval_minutes ??
      POLICY_DEFAULTS
        .minModelWakeIntervalMinutes
    ),
    dailyModelCallLimit: Number(
      data?.daily_model_call_limit ??
      POLICY_DEFAULTS
        .dailyModelCallLimit
    ),
    dailyCostLimitUsd: Number(
      data?.daily_cost_limit_usd ??
      POLICY_DEFAULTS
        .dailyCostLimitUsd
    )
  };
}


async function savePolicyPreferences(
  policyPatch
) {
  const userId =
    currentSession?.user?.id;

  if (!userId) {
    throw new Error(
      "无法确认当前屋主。"
    );
  }

  const {
    data,
    error
  } = await authClient
    .from("heartbeat_preferences")
    .update({
      natural_wake_enabled:
        policyPatch.naturalWakeEnabled,
      natural_wake_min_per_day:
        policyPatch.naturalWakeMinPerDay,
      natural_wake_max_per_day:
        policyPatch.naturalWakeMaxPerDay,
      min_model_wake_interval_minutes:
        policyPatch
          .minModelWakeIntervalMinutes,
      daily_model_call_limit:
        policyPatch.dailyModelCallLimit,
      daily_cost_limit_usd:
        policyPatch.dailyCostLimitUsd
    })
    .eq("owner_user_id", userId)
    .select([
      "natural_wake_enabled",
      "natural_wake_min_per_day",
      "natural_wake_max_per_day",
      "min_model_wake_interval_minutes",
      "daily_model_call_limit",
      "daily_cost_limit_usd"
    ].join(", "))
    .single();

  if (error) {
    throw explainPolicyDatabaseError(
      error
    );
  }

  return {
    naturalWakeEnabled:
      data.natural_wake_enabled,
    naturalWakeMinPerDay: Number(
      data.natural_wake_min_per_day
    ),
    naturalWakeMaxPerDay: Number(
      data.natural_wake_max_per_day
    ),
    minModelWakeIntervalMinutes: Number(
      data.min_model_wake_interval_minutes
    ),
    dailyModelCallLimit: Number(
      data.daily_model_call_limit
    ),
    dailyCostLimitUsd: Number(
      data.daily_cost_limit_usd
    )
  };
}


async function loadPreferences() {
  /*
    先通过正式 API 读取旧作息。
    这一步也会确保偏好行已经存在。
  */
  const baseResult = await apiRequest(
    "/api/heart/preferences"
  );

  const policyPreferences =
    await loadPolicyPreferences();

  renderPreferences({
    ...baseResult,
    preferences: {
      ...baseResult.preferences,
      ...policyPreferences
    }
  });

  setMessage("");
}


function collectPatch() {
  const random =
    getIntervalMode() === "random";

  const intervalMinMinutes = Number(
    random
      ? elements.intervalMin.value
      : elements.fixedInterval.value
  );

  const intervalMaxMinutes = Number(
    random
      ? elements.intervalMax.value
      : elements.fixedInterval.value
  );

  if (
    intervalMinMinutes >
      intervalMaxMinutes
  ) {
    throw new Error(
      "最短巡检间隔不能大于最长巡检间隔。"
    );
  }

  if (
    elements.quietHoursEnabled.checked &&
    elements.quietStart.value ===
      elements.quietEnd.value
  ) {
    throw new Error(
      "休息开始时间和结束时间不能相同。"
    );
  }

  const naturalWakeMinPerDay = Number(
    elements.naturalWakeMinPerDay.value
  );

  const naturalWakeMaxPerDay = Number(
    elements.naturalWakeMaxPerDay.value
  );

  if (
    !Number.isInteger(
      naturalWakeMinPerDay
    ) ||
    !Number.isInteger(
      naturalWakeMaxPerDay
    ) ||
    naturalWakeMinPerDay < 0 ||
    naturalWakeMaxPerDay > 24
  ) {
    throw new Error(
      "自然醒来目标必须是 0～24 之间的整数。"
    );
  }

  if (
    naturalWakeMinPerDay >
      naturalWakeMaxPerDay
  ) {
    throw new Error(
      "每天最少自然醒来目标不能大于最多目标。"
    );
  }

  const dailyModelCallLimit = Number(
    elements.dailyModelCallLimit.value
  );

  if (
    !Number.isInteger(
      dailyModelCallLimit
    ) ||
    dailyModelCallLimit < 0 ||
    dailyModelCallLimit > 100
  ) {
    throw new Error(
      "每日模型调用上限必须是 0～100 之间的整数。"
    );
  }

  const dailyCostLimitUsd = Number(
    elements.dailyCostLimitUsd.value
  );

  if (
    !Number.isFinite(
      dailyCostLimitUsd
    ) ||
    dailyCostLimitUsd < 0 ||
    dailyCostLimitUsd > 100
  ) {
    throw new Error(
      "每日费用上限必须是 0～100 美元之间的数字。"
    );
  }

  return {
    basePatch: {
      autoHeartbeatEnabled:
        elements
          .autoHeartbeatEnabled
          .checked,
      timezone:
        elements.timezone.value,
      quietHoursEnabled:
        elements
          .quietHoursEnabled
          .checked,
      quietStart:
        elements.quietStart.value,
      quietEnd:
        elements.quietEnd.value,
      intervalMinMinutes,
      intervalMaxMinutes,
      postChatGraceMinutes: Number(
        elements
          .postChatGraceMinutes
          .value
      )
    },
    policyPatch: {
      naturalWakeEnabled:
        elements
          .naturalWakeEnabled
          .checked,
      naturalWakeMinPerDay,
      naturalWakeMaxPerDay,
      minModelWakeIntervalMinutes:
        Number(
          elements
            .minModelWakeIntervalMinutes
            .value
        ),
      dailyModelCallLimit,
      dailyCostLimitUsd:
        Number(
          dailyCostLimitUsd.toFixed(2)
        )
    }
  };
}


async function handleSubmit(event) {
  event.preventDefault();

  elements.saveButton.disabled = true;
  elements.saveButton.textContent =
    "正在保存……";

  setMessage(
    "正在把新作息和预算写进数据库。"
  );

  try {
    const {
      basePatch,
      policyPatch
    } = collectPatch();

    const [
      baseResult,
      savedPolicy
    ] = await Promise.all([
      apiRequest(
        "/api/heart/preferences",
        {
          method: "PATCH",
          body: JSON.stringify(
            basePatch
          )
        }
      ),
      savePolicyPreferences(
        policyPatch
      )
    ]);

    renderPreferences({
      ...baseResult,
      preferences: {
        ...baseResult.preferences,
        ...savedPolicy
      }
    });

    setMessage(
      "作息与预算已经保存。以后到点先巡检，只有通过策略才会真正叫醒模型。",
      "success"
    );
  } catch (error) {
    console.error(
      "Save heart preferences failed:",
      error
    );

    setMessage(
      error?.message ??
        "作息与预算保存失败。",
      "error"
    );
  } finally {
    elements.saveButton.disabled = false;
    elements.saveButton.textContent =
      "保存作息与预算";
  }
}


for (const input of document.querySelectorAll(
  'input[name="intervalMode"]'
)) {
  input.addEventListener(
    "change",
    renderIntervalMode
  );
}


elements.quietHoursEnabled.addEventListener(
  "change",
  renderQuietHoursState
);


elements.naturalWakeEnabled.addEventListener(
  "change",
  renderNaturalWakeState
);


elements.form.addEventListener(
  "submit",
  handleSubmit
);


document.addEventListener(
  "DOMContentLoaded",
  async () => {
    initializeStaticOptions();
    renderIntervalMode();
    renderQuietHoursState();
    renderNaturalWakeState();

    try {
      const authenticated =
        await initializeAuth();

      if (authenticated) {
        await loadPreferences();
      }
    } catch (error) {
      console.error(
        "Initialize heart settings failed:",
        error
      );

      elements.summary.classList.add(
        "is-off"
      );

      elements.summaryTitle.textContent =
        "小心脏设置暂时离线";

      elements.summaryDetail.textContent =
        error?.message ??
        "无法读取当前作息。";

      setMessage(
        error?.message ??
          "无法读取当前作息。",
        "error"
      );
    }
  }
);
